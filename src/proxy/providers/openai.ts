/**
 * OpenAI Content Provider
 * Handles OpenAI Chat Completions API format.
 */

import type {
  LLMContentProvider,
  ToolCallDelta,
  ToolCallInfo,
  ToolResultMessage,
} from "./types.js";

interface OpenAIMessage {
  role: string;
  content: string | OpenAIContentPart[] | null;
  name?: string;
  tool_calls?: unknown;
}

interface OpenAIContentPart {
  type: string;
  text?: string;
  image_url?: unknown;
}

interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  [key: string]: unknown;
}

interface OpenAIToolCall {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIChatResponse {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

interface OpenAIStreamToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAIStreamChunk {
  choices: Array<{
    delta: {
      content?: string | null;
      tool_calls?: OpenAIStreamToolCallDelta[];
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

function hasStringToolCallArguments(
  toolCall: unknown,
): toolCall is { function: { arguments: string } } {
  if (typeof toolCall !== "object" || toolCall === null) return false;

  const functionCall = (toolCall as { function?: unknown }).function;
  if (typeof functionCall !== "object" || functionCall === null) return false;

  return typeof (functionCall as { arguments?: unknown }).arguments === "string";
}

function transformToolCallArgumentString(
  argumentsText: string,
  transform: (text: string) => string,
): string {
  try {
    JSON.parse(argumentsText);
    return transformJSONStringValueTokens(argumentsText, transform);
  } catch {
    return transform(argumentsText);
  }
}

function transformJSONStringValueTokens(
  json: string,
  transform: (text: string) => string,
): string {
  const output: string[] = [];
  let cursor = 0;

  while (cursor < json.length) {
    const start = json.indexOf('"', cursor);
    if (start === -1) {
      output.push(json.slice(cursor));
      break;
    }

    output.push(json.slice(cursor, start));
    let end = start + 1;
    while (end < json.length) {
      if (json[end] === "\\") {
        end += 2;
      } else if (json[end] === '"') {
        end++;
        break;
      } else {
        end++;
      }
    }

    const token = json.slice(start, end);
    let afterToken = end;
    while (isJSONWhitespace(json[afterToken])) afterToken++;

    if (json[afterToken] === ":") {
      output.push(token);
    } else {
      const value = JSON.parse(token) as string;
      output.push(JSON.stringify(transform(value)));
    }
    cursor = end;
  }

  return output.join("");
}

function isJSONWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\n" || char === "\r" || char === "\t";
}

export class OpenAIProvider implements LLMContentProvider {
  readonly name = "openai";

  matchesRequest(url: string, headers: Headers): boolean {
    const pathname = new URL(url).pathname;
    if (pathname === "/v1/chat/completions") return true;
    if (pathname === "/v1/messages") return false;
    if (url.includes("api.openai.com")) return true;
    const auth = headers.get("authorization");
    if (auth !== null && auth.startsWith("Bearer sk-")) return true;
    return false;
  }

  extractRequestText(body: unknown): string[] {
    const req = body as OpenAIChatRequest;
    if (req.messages === undefined || !Array.isArray(req.messages)) return [];

    const texts: string[] = [];
    for (const message of req.messages) {
      if (typeof message.content === "string") {
        texts.push(message.content);
      } else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === "text" && typeof part.text === "string") {
            texts.push(part.text);
          }
        }
      }

      const toolCalls = message.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const toolCall of toolCalls) {
          if (hasStringToolCallArguments(toolCall)) {
            transformToolCallArgumentString(
              toolCall.function.arguments,
              (text) => {
                texts.push(text);
                return text;
              },
            );
          }
        }
      }
    }

    return texts;
  }

  rebuildRequestBody(body: unknown, anonymizedTexts: string[]): unknown {
    const req = structuredClone(body) as OpenAIChatRequest;
    let idx = 0;

    for (const message of req.messages) {
      if (typeof message.content === "string") {
        message.content = anonymizedTexts[idx++]!;
      } else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === "text" && typeof part.text === "string") {
            part.text = anonymizedTexts[idx++]!;
          }
        }
      }

      const toolCalls = message.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const toolCall of toolCalls) {
          if (hasStringToolCallArguments(toolCall)) {
            toolCall.function.arguments = transformToolCallArgumentString(
              toolCall.function.arguments,
              () => anonymizedTexts[idx++]!,
            );
          }
        }
      }
    }

    return req;
  }

  extractResponseText(body: unknown): string[] {
    const res = body as OpenAIChatResponse;
    if (res.choices === undefined || !Array.isArray(res.choices)) return [];

    const texts: string[] = [];
    for (const choice of res.choices) {
      if (typeof choice.message?.content === "string") {
        texts.push(choice.message.content);
      }
    }
    return texts;
  }

  rebuildResponseBody(body: unknown, rehydratedTexts: string[]): unknown {
    const res = structuredClone(body) as OpenAIChatResponse;
    let idx = 0;

    for (const choice of res.choices) {
      if (typeof choice.message?.content === "string") {
        choice.message.content = rehydratedTexts[idx++]!;
      }
    }
    return res;
  }

  extractSSEDelta(data: unknown): string | null {
    const chunk = data as OpenAIStreamChunk;
    const content = chunk.choices?.[0]?.delta?.content;
    // Empty content carries no text to rehydrate but may carry metadata
    // (e.g. finish_reason) — treat as "not ours" so the frame passes through.
    if (content === undefined || content === null || content === "") return null;
    return typeof content === "string" ? content : null;
  }

  rebuildSSEDelta(data: unknown, rehydratedText: string): unknown {
    const chunk = structuredClone(data) as OpenAIStreamChunk;
    if (chunk.choices?.[0]?.delta !== undefined) {
      chunk.choices[0].delta.content = rehydratedText;
    }
    return chunk;
  }

  isStreamingRequest(body: unknown): boolean {
    const req = body as OpenAIChatRequest;
    return req.stream === true;
  }

  extractResponseToolCalls(body: unknown): string[] {
    const res = body as OpenAIChatResponse;
    if (res.choices === undefined || !Array.isArray(res.choices)) return [];

    const args: string[] = [];
    for (const choice of res.choices) {
      const toolCalls = choice.message?.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          if (typeof tc.function?.arguments === "string") {
            args.push(tc.function.arguments);
          }
        }
      }
    }
    return args;
  }

  rebuildResponseToolCalls(body: unknown, rehydratedArgs: string[]): unknown {
    const res = structuredClone(body) as OpenAIChatResponse;
    let idx = 0;

    for (const choice of res.choices) {
      const toolCalls = choice.message?.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          if (typeof tc.function?.arguments === "string") {
            tc.function.arguments = rehydratedArgs[idx++]!;
          }
        }
      }
    }
    return res;
  }

  extractSSEToolCallDeltas(data: unknown): ToolCallDelta[] | null {
    const chunk = data as OpenAIStreamChunk;
    const toolCalls = chunk.choices?.[0]?.delta?.tool_calls;
    if (!Array.isArray(toolCalls)) return null;

    const deltas: ToolCallDelta[] = [];
    for (const tc of toolCalls) {
      const args = tc.function?.arguments;
      if (typeof args === "string" && args.length > 0) {
        deltas.push({ index: tc.index, arguments: args });
      }
    }
    return deltas.length > 0 ? deltas : null;
  }

  rebuildSSEToolCallDeltas(
    data: unknown,
    rehydratedArgs: Map<number, string>,
  ): unknown {
    const chunk = structuredClone(data) as OpenAIStreamChunk;
    const toolCalls = chunk.choices?.[0]?.delta?.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        const rehydrated = rehydratedArgs.get(tc.index);
        if (rehydrated !== undefined && tc.function !== undefined) {
          tc.function.arguments = rehydrated;
        }
      }
    }
    return chunk;
  }

  // ── Tool execution loop methods ──────────────────────────────────

  hasResponseToolCalls(body: unknown): boolean {
    const res = body as OpenAIChatResponse;
    if (!Array.isArray(res.choices)) return false;
    return res.choices.some(
      (c) =>
        Array.isArray(c.message?.tool_calls) &&
        c.message.tool_calls.length > 0,
    );
  }

  extractResponseToolCallInfo(body: unknown): ToolCallInfo[] {
    const res = body as OpenAIChatResponse;
    const infos: ToolCallInfo[] = [];
    for (const choice of res.choices ?? []) {
      for (const tc of choice.message?.tool_calls ?? []) {
        infos.push({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        });
      }
    }
    return infos;
  }

  extractMessages(body: unknown): unknown[] {
    const req = body as OpenAIChatRequest;
    return req.messages ?? [];
  }

  buildToolLoopBody(
    originalBody: unknown,
    currentMessages: unknown[],
    assistantResponse: unknown,
    toolResults: ToolResultMessage[],
  ): unknown {
    const res = assistantResponse as OpenAIChatResponse;
    const assistantMsg = res.choices[0]!.message;

    const newMessages = [
      ...currentMessages,
      assistantMsg,
      ...toolResults.map((tr) => ({
        role: "tool" as const,
        tool_call_id: tr.toolCallId,
        content: tr.content,
      })),
    ];

    return {
      ...(originalBody as Record<string, unknown>),
      messages: newMessages,
      stream: false,
    };
  }

  injectSystemInstruction(body: unknown, instruction: string): unknown {
    const req = structuredClone(body) as OpenAIChatRequest;
    // Prepend as the first system message
    req.messages = [
      { role: "system", content: instruction },
      ...(req.messages ?? []),
    ];
    return req;
  }
}
