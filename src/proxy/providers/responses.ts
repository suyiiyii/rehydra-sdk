/**
 * OpenAI Responses API Content Provider
 * Handles the /v1/responses format (typed input items, typed SSE events).
 *
 * Streaming uses buffered mode (rehydrateBufferedSSE): the full event stream
 * is collected, text deltas are collapsed into a single delta per content
 * part, and every text-bearing frame is rewritten with rehydrated text.
 */

import type { LLMContentProvider } from "./types.js";
import type { SSEEvent } from "../sse-parser.js";
import { isSSEDone } from "../sse-parser.js";

interface ResponsesContentPart {
  type: string;
  text?: string;
}

interface ResponsesInputItem {
  type?: string;
  role?: string;
  content?: string | ResponsesContentPart[];
  arguments?: string;
  output?: string;
}

interface ResponsesRequest {
  model: string;
  input?: string | ResponsesInputItem[];
  instructions?: string;
  stream?: boolean;
  [key: string]: unknown;
}

interface ResponsesOutputItem {
  type: string;
  content?: ResponsesContentPart[];
  arguments?: string;
  [key: string]: unknown;
}

interface ResponsesResponse {
  output?: ResponsesOutputItem[];
  [key: string]: unknown;
}

interface ResponsesStreamEvent {
  type?: string;
  delta?: string;
  text?: string;
  arguments?: string;
  item_id?: string;
  content_index?: number;
  part?: ResponsesContentPart;
  item?: ResponsesOutputItem;
  response?: ResponsesResponse;
  [key: string]: unknown;
}

const TEXT_PART_TYPES = new Set(["input_text", "output_text"]);

export class ResponsesProvider implements LLMContentProvider {
  readonly name = "responses";

  matchesRequest(url: string): boolean {
    return new URL(url).pathname === "/v1/responses";
  }

  extractRequestText(body: unknown): string[] {
    const req = body as ResponsesRequest;
    const texts: string[] = [];

    if (typeof req.instructions === "string") {
      texts.push(req.instructions);
    }
    if (typeof req.input === "string") {
      texts.push(req.input);
    } else if (Array.isArray(req.input)) {
      for (const item of req.input) {
        if (typeof item.content === "string") {
          texts.push(item.content);
        } else if (Array.isArray(item.content)) {
          for (const part of item.content) {
            if (TEXT_PART_TYPES.has(part.type) && typeof part.text === "string") {
              texts.push(part.text);
            }
          }
        }
      }
    }
    return texts;
  }

  rebuildRequestBody(body: unknown, anonymizedTexts: string[]): unknown {
    const req = structuredClone(body) as ResponsesRequest;
    let idx = 0;

    if (typeof req.instructions === "string") {
      req.instructions = anonymizedTexts[idx++]!;
    }
    if (typeof req.input === "string") {
      req.input = anonymizedTexts[idx++]!;
    } else if (Array.isArray(req.input)) {
      for (const item of req.input) {
        if (typeof item.content === "string") {
          item.content = anonymizedTexts[idx++]!;
        } else if (Array.isArray(item.content)) {
          for (const part of item.content) {
            if (TEXT_PART_TYPES.has(part.type) && typeof part.text === "string") {
              part.text = anonymizedTexts[idx++]!;
            }
          }
        }
      }
    }
    return req;
  }

  extractResponseText(body: unknown): string[] {
    const res = body as ResponsesResponse;
    if (!Array.isArray(res.output)) return [];

    const texts: string[] = [];
    for (const item of res.output) {
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part.type === "output_text" && typeof part.text === "string") {
            texts.push(part.text);
          }
        }
      }
    }
    return texts;
  }

  rebuildResponseBody(body: unknown, rehydratedTexts: string[]): unknown {
    const res = structuredClone(body) as ResponsesResponse;
    if (!Array.isArray(res.output)) return res;

    let idx = 0;
    for (const item of res.output) {
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part.type === "output_text" && typeof part.text === "string") {
            part.text = rehydratedTexts[idx++]!;
          }
        }
      }
    }
    return res;
  }

  extractResponseToolCalls(body: unknown): string[] {
    const res = body as ResponsesResponse;
    if (!Array.isArray(res.output)) return [];

    const args: string[] = [];
    for (const item of res.output) {
      if (item.type === "function_call" && typeof item.arguments === "string") {
        args.push(item.arguments);
      }
    }
    return args;
  }

  rebuildResponseToolCalls(body: unknown, rehydratedArgs: string[]): unknown {
    const res = structuredClone(body) as ResponsesResponse;
    if (!Array.isArray(res.output)) return res;

    let idx = 0;
    for (const item of res.output) {
      if (item.type === "function_call" && typeof item.arguments === "string") {
        item.arguments = rehydratedArgs[idx++]!;
      }
    }
    return res;
  }

  extractSSEDelta(data: unknown): string | null {
    const event = data as ResponsesStreamEvent;
    if (event.type === "response.output_text.delta") {
      // Empty deltas carry nothing to rehydrate — pass the frame through.
      return typeof event.delta === "string" && event.delta !== ""
        ? event.delta
        : null;
    }
    return null;
  }

  rebuildSSEDelta(data: unknown, rehydratedText: string): unknown {
    const event = structuredClone(data) as ResponsesStreamEvent;
    if (typeof event.delta === "string") {
      event.delta = rehydratedText;
    }
    return event;
  }

  isStreamingRequest(body: unknown): boolean {
    const req = body as ResponsesRequest;
    return req.stream === true;
  }

  injectSystemInstruction(body: unknown, instruction: string): unknown {
    const req = structuredClone(body) as ResponsesRequest;
    req.instructions =
      typeof req.instructions === "string"
        ? `${instruction}\n\n${req.instructions}`
        : instruction;
    return req;
  }

  async rehydrateBufferedSSE(
    events: SSEEvent[],
    rehydrateText: (text: string) => Promise<string>,
  ): Promise<SSEEvent[]> {
    // Pass 1: accumulate text/argument deltas per content stream so all
    // deltas can be collapsed into one frame with the full rehydrated text.
    const textDeltas = new Map<string, string>();
    const argDeltas = new Map<string, string>();
    const parsedEvents: unknown[] = [];

    for (const event of events) {
      if (isSSEDone(event.data)) {
        parsedEvents.push(null);
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        parsedEvents.push(null);
        continue;
      }
      parsedEvents.push(parsed);

      const e = parsed as ResponsesStreamEvent;
      const key = `${e.item_id ?? ""}:${e.content_index ?? 0}`;
      if (e.type === "response.output_text.delta" && typeof e.delta === "string") {
        textDeltas.set(key, (textDeltas.get(key) ?? "") + e.delta);
      } else if (
        e.type === "response.function_call_arguments.delta" &&
        typeof e.delta === "string"
      ) {
        argDeltas.set(key, (argDeltas.get(key) ?? "") + e.delta);
      }
    }

    // Pass 2: emit events in order; first delta of each stream carries the
    // full rehydrated text, later deltas of that stream are dropped.
    const emittedTextDelta = new Set<string>();
    const emittedArgDelta = new Set<string>();
    const result: SSEEvent[] = [];

    for (let i = 0; i < events.length; i++) {
      const event = events[i]!;
      const parsed = parsedEvents[i];
      if (parsed === null) {
        result.push(event);
        continue;
      }

      const e = structuredClone(parsed) as ResponsesStreamEvent;
      const key = `${e.item_id ?? ""}:${e.content_index ?? 0}`;

      switch (e.type) {
        case "response.output_text.delta": {
          if (emittedTextDelta.has(key)) continue;
          emittedTextDelta.add(key);
          e.delta = await rehydrateText(textDeltas.get(key) ?? "");
          break;
        }
        case "response.function_call_arguments.delta": {
          if (emittedArgDelta.has(key)) continue;
          emittedArgDelta.add(key);
          e.delta = await rehydrateText(argDeltas.get(key) ?? "");
          break;
        }
        case "response.output_text.done": {
          if (typeof e.text === "string" && e.text !== "") {
            e.text = await rehydrateText(e.text);
          }
          break;
        }
        case "response.function_call_arguments.done": {
          if (typeof e.arguments === "string" && e.arguments !== "") {
            e.arguments = await rehydrateText(e.arguments);
          }
          break;
        }
        case "response.content_part.done": {
          if (typeof e.part?.text === "string" && e.part.text !== "") {
            e.part.text = await rehydrateText(e.part.text);
          }
          break;
        }
        case "response.output_item.done": {
          if (e.item !== undefined) {
            await rehydrateOutputItem(e.item, rehydrateText);
          }
          break;
        }
        case "response.completed": {
          if (Array.isArray(e.response?.output)) {
            for (const item of e.response.output) {
              await rehydrateOutputItem(item, rehydrateText);
            }
          }
          break;
        }
        default:
          break;
      }

      result.push({ event: event.event, data: JSON.stringify(e) });
    }

    return result;
  }
}

/** Rehydrate all text and function-call arguments inside one output item. */
async function rehydrateOutputItem(
  item: ResponsesOutputItem,
  rehydrateText: (text: string) => Promise<string>,
): Promise<void> {
  if (item.type === "message" && Array.isArray(item.content)) {
    for (const part of item.content) {
      if (part.type === "output_text" && typeof part.text === "string" && part.text !== "") {
        part.text = await rehydrateText(part.text);
      }
    }
  } else if (item.type === "function_call" && typeof item.arguments === "string" && item.arguments !== "") {
    item.arguments = await rehydrateText(item.arguments);
  }
}
