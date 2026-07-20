import { describe, it, expect } from "vitest";
import { OpenAIProvider } from "../../../src/proxy/providers/openai.js";

describe("OpenAIProvider", () => {
  const provider = new OpenAIProvider();

  describe("matchesRequest", () => {
    it("should match the Chat Completions route on a compatible upstream", () => {
      expect(
        provider.matchesRequest(
          "https://upstream.example/v1/chat/completions",
          new Headers({ Authorization: "Bearer test-token" }),
        ),
      ).toBe(true);
    });

    it("should not claim the Anthropic Messages route", () => {
      expect(
        provider.matchesRequest(
          "https://upstream.example/v1/messages",
          new Headers({ Authorization: "Bearer test-token" }),
        ),
      ).toBe(false);
    });

    it("should match OpenAI API URLs", () => {
      expect(
        provider.matchesRequest(
          "https://api.openai.com/v1/chat/completions",
          new Headers(),
        ),
      ).toBe(true);
    });

    it("should match requests with OpenAI-style bearer token", () => {
      const headers = new Headers({ Authorization: "Bearer sk-abc123" });
      expect(
        provider.matchesRequest("https://custom-api.example.com/v1", headers),
      ).toBe(true);
    });

    it("should not match unrelated URLs without OpenAI headers", () => {
      expect(
        provider.matchesRequest(
          "https://example.com/api",
          new Headers(),
        ),
      ).toBe(false);
    });
  });

  describe("extractRequestText", () => {
    it("should extract string content from messages", () => {
      const body = {
        model: "gpt-4",
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "Hello world" },
        ],
      };

      const texts = provider.extractRequestText(body);
      expect(texts).toEqual(["You are helpful.", "Hello world"]);
    });

    it("should extract text from array content (multimodal)", () => {
      const body = {
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is in this image?" },
              { type: "image_url", image_url: { url: "data:..." } },
            ],
          },
        ],
      };

      const texts = provider.extractRequestText(body);
      expect(texts).toEqual(["What is in this image?"]);
    });

    it("should handle null content", () => {
      const body = {
        model: "gpt-4",
        messages: [{ role: "assistant", content: null }],
      };

      const texts = provider.extractRequestText(body);
      expect(texts).toEqual([]);
    });

    it("should handle missing messages", () => {
      const texts = provider.extractRequestText({ model: "gpt-4" });
      expect(texts).toEqual([]);
    });

    it("extracts content text parts before JSON tool argument string leaves", () => {
      const body = {
        model: "gpt-4o",
        messages: [
          { role: "system", content: "system prompt" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "first text part" },
              { type: "image_url", image_url: { url: "data:..." } },
              { type: "text", text: "second text part" },
            ],
            tool_calls: [
              {
                function: {
                  arguments: JSON.stringify({
                    first: "first argument",
                    nested: { second: "second argument" },
                    values: ["third argument", 7, false, null],
                  }),
                },
              },
              { function: { arguments: JSON.stringify({ last: "last argument" }) } },
            ],
          },
          {
            role: "assistant",
            content: "third text part",
            tool_calls: [{ function: { arguments: JSON.stringify({ fourth: "fourth argument" }) } }],
          },
        ],
      };

      expect(provider.extractRequestText(body)).toEqual([
        "system prompt",
        "first text part",
        "second text part",
        "first argument",
        "second argument",
        "third argument",
        "last argument",
        "third text part",
        "fourth argument",
      ]);
    });

    it("ignores missing and malformed historical tool calls", () => {
      const body = {
        model: "gpt-4",
        messages: [
          { role: "assistant", content: null },
          { role: "assistant", content: [], tool_calls: [null, {}, { function: null }, { function: {} }, { function: { arguments: 42 } }, { function: { arguments: '{"valid":"true"}' } }] },
        ],
      };

      expect(provider.extractRequestText(body)).toEqual(["true"]);
    });

    it("falls back to the complete string for malformed JSON tool arguments", () => {
      const body = {
        model: "gpt-4",
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [{ function: { arguments: "not-json secret value" } }],
          },
        ],
      };

      expect(provider.extractRequestText(body)).toEqual(["not-json secret value"]);
    });
  });

  describe("rebuildRequestBody", () => {
    it("should replace text in messages", () => {
      const body = {
        model: "gpt-4",
        messages: [
          { role: "user", content: "Email john@example.com" },
        ],
      };

      const result = provider.rebuildRequestBody(body, [
        'Email <PII type="EMAIL" id="1"/>',
      ]) as any;

      expect(result.messages[0].content).toBe(
        'Email <PII type="EMAIL" id="1"/>',
      );
      expect(result.model).toBe("gpt-4");
    });

    it("should not mutate original body", () => {
      const body = {
        model: "gpt-4",
        messages: [{ role: "user", content: "original" }],
      };

      provider.rebuildRequestBody(body, ["modified"]);
      expect(body.messages[0].content).toBe("original");
    });

    it("rebuilds JSON tool argument string leaves in extraction order without mutating the original", () => {
      const body = {
        model: "gpt-4",
        messages: [
          {
            role: "assistant",
            content: "original content",
            tool_calls: [
              {
                function: {
                  arguments: JSON.stringify({
                    command: "echo original",
                    nested: { values: ["second original", 42, false, null] },
                  }),
                },
              },
              { function: {} },
              { function: { arguments: JSON.stringify({ third: "third original" }) } },
            ],
          },
        ],
      };

      const result = provider.rebuildRequestBody(body, [
        "anonymized content",
        'echo <PII type="API_KEY" id="1"/>',
        "second anonymized",
        "third anonymized",
      ]) as any;

      expect(result.messages[0].content).toBe("anonymized content");
      expect(JSON.parse(result.messages[0].tool_calls[0].function.arguments)).toEqual({
        command: 'echo <PII type="API_KEY" id="1"/>',
        nested: { values: ["second anonymized", 42, false, null] },
      });
      expect(result.messages[0].tool_calls[1].function.arguments).toBeUndefined();
      expect(JSON.parse(result.messages[0].tool_calls[2].function.arguments)).toEqual({
        third: "third anonymized",
      });
      expect(body.messages[0].content).toBe("original content");
      expect(body.messages[0].tool_calls[0].function.arguments).toBe(JSON.stringify({
        command: "echo original",
        nested: { values: ["second original", 42, false, null] },
      }));
      expect(body.messages[0].tool_calls[2].function.arguments).toBe(JSON.stringify({ third: "third original" }));
    });

    it("preserves valid JSON lexical primitives while rebuilding string leaves", () => {
      const fakeApiKey = "sk-abcdefghijklmnopqrstuvwxyz";
      const placeholder = '<PII type="API_KEY" id="1"/>';
      const argumentsText = `{
  "\\u0061pi_key" : "${fakeApiKey}",
  "large":9007199254740993,
  "negative_zero":-0,
  "exponent":1.2300e+04,
  "decimal":0.0100,
  "enabled":true,
  "empty":null,
  "escaped":"\\u0061\\n"
}`;
      const body = {
        model: "gpt-4",
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [{ function: { arguments: argumentsText } }],
          },
        ],
      };

      expect(provider.extractRequestText(body)).toEqual([fakeApiKey, "a\n"]);

      const result = provider.rebuildRequestBody(body, [
        placeholder,
        "anonymized\nvalue",
      ]) as any;
      const expectedArguments = argumentsText
        .replace(`"${fakeApiKey}"`, JSON.stringify(placeholder))
        .replace('"\\u0061\\n"', JSON.stringify("anonymized\nvalue"));

      expect(result.messages[0].tool_calls[0].function.arguments).toBe(expectedArguments);
      expect(body.messages[0].tool_calls[0].function.arguments).toBe(argumentsText);
    });

    it("redacts deeply nested JSON string values without whole-string fallback", () => {
      const fakeApiKey = "sk-abcdefghijklmnopqrstuvwxyz";
      const placeholder = '<PII type="API_KEY" id="1"/>';
      const depth = 5000;
      const argumentsText = `${"[".repeat(depth)}${JSON.stringify(fakeApiKey)}${"]".repeat(depth)}`;
      const body = {
        model: "gpt-4",
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [{ function: { arguments: argumentsText } }],
          },
        ],
      };

      expect(provider.extractRequestText(body)).toEqual([fakeApiKey]);

      const result = provider.rebuildRequestBody(body, [placeholder]) as any;
      const rebuiltArguments = result.messages[0].tool_calls[0].function.arguments;
      expect(rebuiltArguments).not.toContain(fakeApiKey);
      expect(rebuiltArguments).toContain(JSON.stringify(placeholder));
      expect(() => JSON.parse(rebuiltArguments)).not.toThrow();
    });

    it("leaves missing and malformed historical tool calls untouched", () => {
      const body = {
        model: "gpt-4",
        messages: [
          { role: "assistant", content: null, tool_calls: [null, {}, { function: null }, { function: {} }, { function: { arguments: 42 } }, { function: { arguments: "original" } }] },
        ],
      };

      const result = provider.rebuildRequestBody(body, ["anonymized"]) as any;
      expect(result.messages[0].tool_calls[5].function.arguments).toBe("anonymized");
      expect(body.messages[0].tool_calls[5].function.arguments).toBe("original");
    });
  });

  describe("extractResponseText", () => {
    it("should extract content from choices", () => {
      const body = {
        choices: [
          { message: { role: "assistant", content: "Hello!" } },
        ],
      };

      const texts = provider.extractResponseText(body);
      expect(texts).toEqual(["Hello!"]);
    });

    it("should handle multiple choices", () => {
      const body = {
        choices: [
          { message: { role: "assistant", content: "Response 1" } },
          { message: { role: "assistant", content: "Response 2" } },
        ],
      };

      const texts = provider.extractResponseText(body);
      expect(texts).toEqual(["Response 1", "Response 2"]);
    });
  });

  describe("extractSSEDelta", () => {
    it("should extract delta content", () => {
      const data = {
        choices: [{ delta: { content: "Hello" } }],
      };

      expect(provider.extractSSEDelta(data)).toBe("Hello");
    });

    it("should return null for empty delta", () => {
      const data = {
        choices: [{ delta: {} }],
      };

      expect(provider.extractSSEDelta(data)).toBeNull();
    });

    it("should return null for null content", () => {
      const data = {
        choices: [{ delta: { content: null } }],
      };

      expect(provider.extractSSEDelta(data)).toBeNull();
    });

    it("should return null for empty content (finish_reason frames)", () => {
      const data = {
        choices: [{ delta: { content: "" }, finish_reason: "stop" }],
      };

      expect(provider.extractSSEDelta(data)).toBeNull();
    });
  });

  describe("rebuildSSEDelta", () => {
    it("should replace delta content", () => {
      const data = {
        choices: [{ delta: { content: "anonymized" } }],
      };

      const result = provider.rebuildSSEDelta(data, "rehydrated") as any;
      expect(result.choices[0].delta.content).toBe("rehydrated");
    });
  });

  describe("isStreamingRequest", () => {
    it("should detect streaming requests", () => {
      expect(provider.isStreamingRequest({ stream: true })).toBe(true);
      expect(provider.isStreamingRequest({ stream: false })).toBe(false);
      expect(provider.isStreamingRequest({})).toBe(false);
    });
  });

  describe("extractResponseToolCalls", () => {
    it("should extract tool call arguments from choices", () => {
      const body = {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "send_email",
                    arguments: '{"to":"<PII type=\\"EMAIL\\" id=\\"1\\"/>"}',
                  },
                },
              ],
            },
          },
        ],
      };

      const args = provider.extractResponseToolCalls(body);
      expect(args).toEqual([
        '{"to":"<PII type=\\"EMAIL\\" id=\\"1\\"/>"}',
      ]);
    });

    it("should extract multiple tool calls across choices", () => {
      const body = {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "fn1", arguments: '{"a":1}' },
                },
                {
                  id: "call_2",
                  type: "function",
                  function: { name: "fn2", arguments: '{"b":2}' },
                },
              ],
            },
          },
        ],
      };

      const args = provider.extractResponseToolCalls(body);
      expect(args).toEqual(['{"a":1}', '{"b":2}']);
    });

    it("should return empty array when no tool calls", () => {
      const body = {
        choices: [
          { message: { role: "assistant", content: "Hello" } },
        ],
      };

      expect(provider.extractResponseToolCalls(body)).toEqual([]);
    });
  });

  describe("rebuildResponseToolCalls", () => {
    it("should replace tool call arguments", () => {
      const body = {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "send_email",
                    arguments: '{"to":"<PII type=\\"EMAIL\\" id=\\"1\\"/>"}',
                  },
                },
              ],
            },
          },
        ],
      };

      const result = provider.rebuildResponseToolCalls(body, [
        '{"to":"john@example.com"}',
      ]) as any;

      expect(result.choices[0].message.tool_calls[0].function.arguments).toBe(
        '{"to":"john@example.com"}',
      );
    });

    it("should not mutate original body", () => {
      const body = {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "fn", arguments: "original" },
                },
              ],
            },
          },
        ],
      };

      provider.rebuildResponseToolCalls(body, ["modified"]);
      expect(body.choices[0].message.tool_calls![0].function.arguments).toBe(
        "original",
      );
    });
  });

  describe("extractSSEToolCallDeltas", () => {
    it("should extract tool call argument deltas", () => {
      const data = {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '{"to":"' } },
              ],
            },
          },
        ],
      };

      expect(provider.extractSSEToolCallDeltas(data)).toEqual([
        { index: 0, arguments: '{"to":"' },
      ]);
    });

    it("should handle multiple tool calls in one chunk", () => {
      const data = {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: "partial0" } },
                { index: 1, function: { arguments: "partial1" } },
              ],
            },
          },
        ],
      };

      expect(provider.extractSSEToolCallDeltas(data)).toEqual([
        { index: 0, arguments: "partial0" },
        { index: 1, arguments: "partial1" },
      ]);
    });

    it("should return null for first chunk with only id/name", () => {
      const data = {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", type: "function", function: { name: "send_email" } },
              ],
            },
          },
        ],
      };

      expect(provider.extractSSEToolCallDeltas(data)).toBeNull();
    });

    it("should return null when no tool calls in delta", () => {
      const data = {
        choices: [{ delta: { content: "Hello" } }],
      };

      expect(provider.extractSSEToolCallDeltas(data)).toBeNull();
    });
  });

  describe("rebuildSSEToolCallDeltas", () => {
    it("should replace arguments for specific indices", () => {
      const data = {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: "anonymized" } },
              ],
            },
          },
        ],
      };

      const result = provider.rebuildSSEToolCallDeltas(
        data,
        new Map([[0, "rehydrated"]]),
      ) as any;

      expect(result.choices[0].delta.tool_calls[0].function.arguments).toBe(
        "rehydrated",
      );
    });

    it("should not mutate original data", () => {
      const data = {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: "original" } },
              ],
            },
          },
        ],
      };

      provider.rebuildSSEToolCallDeltas(data, new Map([[0, "modified"]]));
      expect(data.choices[0].delta.tool_calls[0].function.arguments).toBe(
        "original",
      );
    });
  });
});
