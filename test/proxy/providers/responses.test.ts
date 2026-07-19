import { describe, it, expect } from "vitest";
import { ResponsesProvider } from "../../../src/proxy/providers/responses.js";
import { detectProvider } from "../../../src/proxy/providers/index.js";
import type { SSEEvent } from "../../../src/proxy/sse-parser.js";

const provider = new ResponsesProvider();

describe("ResponsesProvider", () => {
  describe("matchesRequest", () => {
    it("should match /v1/responses", () => {
      expect(
        provider.matchesRequest("https://api.openai.com/v1/responses"),
      ).toBe(true);
    });

    it("should not match chat completions", () => {
      expect(
        provider.matchesRequest("https://api.openai.com/v1/chat/completions"),
      ).toBe(false);
    });

    it("should win auto-detection over the OpenAI Bearer sk- rule", () => {
      const headers = new Headers({ authorization: "Bearer sk-test" });
      const detected = detectProvider(
        "https://upstream.example/v1/responses",
        headers,
        "auto",
      );
      expect(detected.name).toBe("responses");
    });
  });

  describe("request text extraction", () => {
    it("should extract string input and instructions", () => {
      const body = {
        model: "gpt-5-mini",
        instructions: "Be terse",
        input: "Email john@example.com",
      };
      expect(provider.extractRequestText(body)).toEqual([
        "Be terse",
        "Email john@example.com",
      ]);
    });

    it("should extract message-array input with content parts", () => {
      const body = {
        model: "gpt-5-mini",
        input: [
          { type: "message", role: "user", content: "plain string" },
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "part one" },
              { type: "input_image", image_url: "ignored" },
              { type: "output_text", text: "part two" },
            ],
          },
        ],
      };
      expect(provider.extractRequestText(body)).toEqual([
        "plain string",
        "part one",
        "part two",
      ]);
    });

    it("should rebuild request body in extraction order", () => {
      const body = {
        model: "gpt-5-mini",
        instructions: "A",
        input: [{ type: "message", role: "user", content: "B" }],
      };
      const rebuilt = provider.rebuildRequestBody(body, ["A2", "B2"]) as any;
      expect(rebuilt.instructions).toBe("A2");
      expect(rebuilt.input[0].content).toBe("B2");
      // Original untouched
      expect((body.input[0] as any).content).toBe("B");
    });
  });

  describe("response text extraction", () => {
    const responseBody = {
      id: "resp_1",
      object: "response",
      output: [
        {
          type: "message",
          id: "item_1",
          role: "assistant",
          content: [{ type: "output_text", text: "hello" }],
        },
        { type: "function_call", id: "item_2", arguments: '{"q":"secret"}' },
      ],
    };

    it("should extract output_text parts", () => {
      expect(provider.extractResponseText(responseBody)).toEqual(["hello"]);
    });

    it("should rebuild output_text parts", () => {
      const rebuilt = provider.rebuildResponseBody(responseBody, ["HELLO"]) as any;
      expect(rebuilt.output[0].content[0].text).toBe("HELLO");
    });

    it("should extract and rebuild function_call arguments", () => {
      expect(provider.extractResponseToolCalls(responseBody)).toEqual([
        '{"q":"secret"}',
      ]);
      const rebuilt = provider.rebuildResponseToolCalls(responseBody, [
        '{"q":"real"}',
      ]) as any;
      expect(rebuilt.output[1].arguments).toBe('{"q":"real"}');
    });

    it("should return empty for error bodies without output", () => {
      expect(provider.extractResponseText({ error: { message: "x" } })).toEqual([]);
    });
  });

  describe("rehydrateBufferedSSE", () => {
    // Frame sequence captured live from upstream.example /v1/responses,
    // with the text split into two deltas and a placeholder to rehydrate.
    const P = '<PII type="EMAIL" id="1"/>';
    const full = `contact ${P} now`;
    const item = "item_dcf40748f8efc5fc7359ea3b";

    function ev(type: string, data: object): SSEEvent {
      return { event: type, data: JSON.stringify({ type, ...data }) };
    }

    const events: SSEEvent[] = [
      ev("response.created", { response: { id: "resp_1", status: "in_progress", output: [] } }),
      ev("response.output_item.added", {
        item: { content: [{ text: "", type: "output_text" }], id: item, role: "assistant", type: "message" },
        output_index: 0,
      }),
      ev("response.content_part.added", {
        content_index: 0, item_id: item, part: { text: "", type: "output_text" },
      }),
      ev("response.output_text.delta", { content_index: 0, item_id: item, delta: `contact ${P.slice(0, 10)}` }),
      ev("response.output_text.delta", { content_index: 0, item_id: item, delta: `${P.slice(10)} now` }),
      ev("response.output_text.done", { content_index: 0, item_id: item, text: full }),
      ev("response.content_part.done", {
        content_index: 0, item_id: item, part: { text: full, type: "output_text" },
      }),
      ev("response.output_item.done", {
        item: { content: [{ text: full, type: "output_text" }], id: item, role: "assistant", type: "message" },
      }),
      ev("response.completed", {
        response: {
          id: "resp_1", status: "completed",
          output: [{ type: "message", id: item, content: [{ type: "output_text", text: full }] }],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      }),
      { event: "message", data: "[DONE]" },
    ];

    const rehydrate = async (text: string): Promise<string> =>
      text.replaceAll(P, "john@example.com");

    it("should collapse deltas and rewrite every text-bearing frame", async () => {
      const out = await provider.rehydrateBufferedSSE(events, rehydrate);

      // Two deltas collapsed into one; total frames = input - 1
      expect(out).toHaveLength(events.length - 1);

      const byType = (t: string) =>
        out.filter((e) => JSON.parse(e.data === "[DONE]" ? "{}" : e.data).type === t);

      const deltas = byType("response.output_text.delta");
      expect(deltas).toHaveLength(1);
      expect(JSON.parse(deltas[0]!.data).delta).toBe("contact john@example.com now");

      expect(JSON.parse(byType("response.output_text.done")[0]!.data).text).toBe(
        "contact john@example.com now",
      );
      expect(
        JSON.parse(byType("response.content_part.done")[0]!.data).part.text,
      ).toBe("contact john@example.com now");
      expect(
        JSON.parse(byType("response.output_item.done")[0]!.data).item.content[0].text,
      ).toBe("contact john@example.com now");
      expect(
        JSON.parse(byType("response.completed")[0]!.data).response.output[0].content[0].text,
      ).toBe("contact john@example.com now");

      // No placeholder may survive anywhere in the stream
      expect(out.map((e) => e.data).join("\n")).not.toContain("<PII");

      // [DONE] and event ordering preserved
      expect(out[out.length - 1]!.data).toBe("[DONE]");
      expect(JSON.parse(out[0]!.data).type).toBe("response.created");
    });

    it("should rewrite function_call argument frames", async () => {
      const argEvents: SSEEvent[] = [
        ev("response.function_call_arguments.delta", { item_id: "fc_1", delta: `{"to":"` }),
        ev("response.function_call_arguments.delta", { item_id: "fc_1", delta: `${P}"}` }),
        ev("response.function_call_arguments.done", { item_id: "fc_1", arguments: `{"to":"${P}"}` }),
      ];
      const out = await provider.rehydrateBufferedSSE(argEvents, rehydrate);
      expect(out).toHaveLength(2);
      expect(JSON.parse(out[0]!.data).delta).toBe('{"to":"john@example.com"}');
      expect(JSON.parse(out[1]!.data).arguments).toBe('{"to":"john@example.com"}');
    });
  });
});
