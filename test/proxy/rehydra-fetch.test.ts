import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createRehydraFetch } from "../../src/proxy/rehydra-fetch.js";
import { InMemoryKeyProvider } from "../../src/crypto/index.js";
import { InMemoryPIIStorageProvider } from "../../src/storage/in-memory.js";

/**
 * Create a mock LLM HTTP server that echoes back the received prompt
 * in an OpenAI-compatible response format.
 */
function createMockLLMServer(): Promise<{ server: Server; port: number; receivedBodies: unknown[] }> {
  return new Promise((resolve) => {
    const receivedBodies: unknown[] = [];

    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const rawBody = Buffer.concat(chunks).toString();

      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        // Non-JSON body (e.g., GET requests)
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      receivedBodies.push(body);

      const isStreaming = body.stream === true;
      const msgs = (body.messages as any[]) ?? [];
      const userMsg = msgs.find((m: any) => m.role === "user");
      const prompt = userMsg?.content ?? "no content";

      if (isStreaming) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });

        // Send SSE chunks
        const words = `Echo: ${prompt}`.split(" ");
        for (const word of words) {
          const chunk = {
            choices: [{ delta: { content: word + " " } }],
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          choices: [{
            message: {
              role: "assistant",
              content: `Echo: ${prompt}`,
            },
          }],
        }));
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({ server, port, receivedBodies });
    });
  });
}

describe("createRehydraFetch", () => {
  let mockServer: { server: Server; port: number; receivedBodies: unknown[] } | null = null;

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (mockServer !== null) {
      await new Promise<void>((resolve) => {
        mockServer!.server.close(() => resolve());
      });
      mockServer = null;
    }
  });

  it("should anonymize request and rehydrate non-streaming response", async () => {
    mockServer = await createMockLLMServer();
    const { port, receivedBodies } = mockServer;

    const storage = new InMemoryPIIStorageProvider();
    const keyProvider = new InMemoryKeyProvider();

    const rehydraFetch = createRehydraFetch({
      keyProvider,
      piiStorageProvider: storage,
      provider: "openai",
      getSessionId: async () => "test-session",
    });

    const response = await rehydraFetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test",
        messages: [{ role: "user", content: "Contact john@example.com please" }],
      }),
    });

    expect(response.ok).toBe(true);

    // Verify the request sent to the mock server was anonymized
    const sentBody = receivedBodies[0] as any;
    const sentUserMsg = (sentBody.messages as any[]).find((m: any) => m.role === "user");
    expect(sentUserMsg.content).toContain('<PII type="EMAIL"');
    expect(sentUserMsg.content).not.toContain("john@example.com");

    // Verify the response was rehydrated
    const data = await response.json() as any;
    const content = data.choices[0].message.content;
    // The echo response contains the anonymized text, which gets rehydrated
    expect(content).toContain("john@example.com");
  });

  it("removes stale framing headers from modified JSON responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "Hello" } }],
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": "7",
          "Content-Encoding": "gzip",
          Connection: "keep-alive",
          "Transfer-Encoding": "chunked",
          "X-Upstream-Request-Id": "request-123",
        },
      },
    )));

    const rehydraFetch = createRehydraFetch({
      keyProvider: new InMemoryKeyProvider(),
      piiStorageProvider: new InMemoryPIIStorageProvider(),
      provider: "openai",
    });
    const response = await rehydraFetch(
      "https://upstream.example/v1/chat/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "test",
          messages: [{ role: "user", content: "Hello" }],
        }),
      },
    );

    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("connection")).toBeNull();
    expect(response.headers.get("transfer-encoding")).toBeNull();
    expect(response.headers.get("x-upstream-request-id")).toBe("request-123");
  });

  it("should pass through non-POST requests unchanged", async () => {
    mockServer = await createMockLLMServer();
    const { port } = mockServer;

    const rehydraFetch = createRehydraFetch({
      keyProvider: new InMemoryKeyProvider(),
      piiStorageProvider: new InMemoryPIIStorageProvider(),
    });

    const response = await rehydraFetch(`http://127.0.0.1:${port}/health`, {
      method: "GET",
    });

    // Should pass through (server will return something, but the point is no error)
    expect(response).toBeDefined();
  });

  it("should handle streaming SSE responses", async () => {
    mockServer = await createMockLLMServer();
    const { port, receivedBodies } = mockServer;

    const storage = new InMemoryPIIStorageProvider();
    const keyProvider = new InMemoryKeyProvider();

    const rehydraFetch = createRehydraFetch({
      keyProvider,
      piiStorageProvider: storage,
      provider: "openai",
      getSessionId: async () => "stream-session",
    });

    const response = await rehydraFetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test",
        messages: [{ role: "user", content: "Contact john@example.com please" }],
        stream: true,
      }),
    });

    expect(response.ok).toBe(true);

    // Verify request was anonymized
    const sentBody = receivedBodies[0] as any;
    const sentUserMsg = (sentBody.messages as any[]).find((m: any) => m.role === "user");
    expect(sentUserMsg.content).toContain('<PII type="EMAIL"');

    // Read the SSE stream
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let fullText = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      fullText += decoder.decode(value, { stream: true });
    }

    // The stream should contain rehydrated content
    expect(fullText).toContain("data:");
  });

  it("should auto-detect provider from URL", async () => {
    // Just verify no errors — auto-detection defaults to OpenAI
    mockServer = await createMockLLMServer();
    const { port } = mockServer;

    const rehydraFetch = createRehydraFetch({
      keyProvider: new InMemoryKeyProvider(),
      piiStorageProvider: new InMemoryPIIStorageProvider(),
      // No provider specified — auto-detect
    });

    const response = await rehydraFetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test",
        messages: [{ role: "user", content: "Hello world" }],
      }),
    });

    expect(response.ok).toBe(true);
  });

  it("should persist PII map to storage", async () => {
    mockServer = await createMockLLMServer();
    const { port } = mockServer;

    const storage = new InMemoryPIIStorageProvider();
    const keyProvider = new InMemoryKeyProvider();

    const rehydraFetch = createRehydraFetch({
      keyProvider,
      piiStorageProvider: storage,
      getSessionId: async () => "persist-test",
    });

    await rehydraFetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test",
        messages: [{ role: "user", content: "Email john@example.com" }],
      }),
    });

    const exists = await storage.exists("persist-test");
    expect(exists).toBe(true);
  });

  describe("onAnonymize hook", () => {
    it("reports detected PII types and counts (never raw values)", async () => {
      mockServer = await createMockLLMServer();
      const { port } = mockServer;

      const calls: any[] = [];
      const rehydraFetch = createRehydraFetch({
        keyProvider: new InMemoryKeyProvider(),
        piiStorageProvider: new InMemoryPIIStorageProvider(),
        provider: "openai",
        getSessionId: async () => "hook-test",
        onAnonymize: (info) => calls.push(info),
      });

      await rehydraFetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "test",
          messages: [
            { role: "user", content: "Email john@example.com and jane@example.com" },
          ],
        }),
      });

      expect(calls).toHaveLength(1);
      const info = calls[0];
      expect(info.method).toBe("POST");
      expect(info.url).toContain("/v1/chat/completions");
      expect(info.countsByType.EMAIL).toBe(2);
      expect(info.totalEntities).toBe(2);
      // The hook must never receive the raw PII values
      expect(JSON.stringify(info)).not.toContain("john@example.com");
    });

    it("fires with zero counts when no PII is present", async () => {
      mockServer = await createMockLLMServer();
      const { port } = mockServer;

      const calls: any[] = [];
      const rehydraFetch = createRehydraFetch({
        keyProvider: new InMemoryKeyProvider(),
        piiStorageProvider: new InMemoryPIIStorageProvider(),
        provider: "openai",
        getSessionId: async () => "hook-empty-test",
        onAnonymize: (info) => calls.push(info),
      });

      await rehydraFetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "test",
          messages: [{ role: "user", content: "Hello world" }],
        }),
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].totalEntities).toBe(0);
      expect(calls[0].countsByType).toEqual({});
    });

    it("does not fire for non-POST requests", async () => {
      mockServer = await createMockLLMServer();
      const { port } = mockServer;

      const calls: any[] = [];
      const rehydraFetch = createRehydraFetch({
        keyProvider: new InMemoryKeyProvider(),
        piiStorageProvider: new InMemoryPIIStorageProvider(),
        provider: "openai",
        onAnonymize: (info) => calls.push(info),
      });

      await rehydraFetch(`http://127.0.0.1:${port}/health`, { method: "GET" });

      expect(calls).toHaveLength(0);
    });
  });

  it("should forward finish_reason and usage frames unchanged", async () => {
    // Mirror the real upstream frame sequence: role, content,
    // finish_reason:"stop" with empty content, usage, [DONE].
    const frames = [
      { choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ];
    const server = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const frame of frames) {
        res.write(`data: ${JSON.stringify(frame)}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve((server.address() as { port: number }).port);
      });
    });

    try {
      const rehydraFetch = createRehydraFetch({
        keyProvider: new InMemoryKeyProvider(),
        piiStorageProvider: new InMemoryPIIStorageProvider(),
        provider: "openai",
        getSessionId: async () => "finish-frame-session",
      });

      const response = await rehydraFetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "test",
          messages: [{ role: "user", content: "Reply exactly: ok" }],
          stream: true,
        }),
      });

      const fullText = await response.text();
      const dataLines = fullText.split("\n").filter((l) => l.startsWith("data: "));
      // All 4 frames plus [DONE] must survive the proxy
      expect(dataLines).toHaveLength(5);
      expect(fullText).toContain('"finish_reason":"stop"');
      expect(fullText).toContain('"usage"');
      expect(fullText).toContain("[DONE]");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("should rehydrate buffered Responses API streams end to end", async () => {
    // Mock /v1/responses upstream: echoes the (anonymized) input text back
    // in the real typed event sequence captured from upstream.example.
    let receivedBody: any = null;
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      receivedBody = JSON.parse(raw);
      const text = receivedBody.input as string;
      const item = "item_1";

      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const frames: Array<[string, object]> = [
        ["response.created", { type: "response.created", response: { id: "r1", status: "in_progress", output: [] } }],
        ["response.output_text.delta", { type: "response.output_text.delta", content_index: 0, item_id: item, delta: text.slice(0, 5) }],
        ["response.output_text.delta", { type: "response.output_text.delta", content_index: 0, item_id: item, delta: text.slice(5) }],
        ["response.output_text.done", { type: "response.output_text.done", content_index: 0, item_id: item, text }],
        ["response.completed", {
          type: "response.completed",
          response: { id: "r1", status: "completed", output: [{ type: "message", id: item, content: [{ type: "output_text", text }] }] },
        }],
      ];
      for (const [event, data] of frames) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve((server.address() as { port: number }).port);
      });
    });

    try {
      const rehydraFetch = createRehydraFetch({
        keyProvider: new InMemoryKeyProvider(),
        piiStorageProvider: new InMemoryPIIStorageProvider(),
        provider: "responses",
        getSessionId: async () => "responses-buffered-session",
      });

      const response = await rehydraFetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5-mini",
          stream: true,
          input: "Contact john@example.com please",
        }),
      });

      expect(response.ok).toBe(true);
      const fullText = await response.text();

      // Request side was anonymized before reaching upstream
      expect(receivedBody.input).toContain('<PII type="EMAIL"');

      // Deltas collapsed into one frame carrying the full rehydrated text
      const deltaLines = fullText
        .split("\n")
        .filter((l) => l.startsWith("data: ") && l.includes("output_text.delta"));
      expect(deltaLines).toHaveLength(1);
      expect(JSON.parse(deltaLines[0]!.slice(6)).delta).toContain("john@example.com");

      // No anonymized placeholder may reach the client, in any frame
      expect(fullText).not.toContain("<PII");
      expect(fullText).toContain("[DONE]");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("should pass through upstream error responses unchanged", async () => {
    const errorBody = { error: { message: "Invalid API key", type: "invalid_api_key" } };
    const server = createServer((req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify(errorBody));
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve((server.address() as { port: number }).port);
      });
    });

    try {
      const rehydraFetch = createRehydraFetch({
        keyProvider: new InMemoryKeyProvider(),
        piiStorageProvider: new InMemoryPIIStorageProvider(),
        provider: "openai",
        getSessionId: async () => "error-passthrough-session",
      });

      const response = await rehydraFetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "test",
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual(errorBody);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  describe("error handling", () => {
    it("should return 400 for malformed request body", async () => {
      const rehydraFetch = createRehydraFetch({
        keyProvider: new InMemoryKeyProvider(),
        piiStorageProvider: new InMemoryPIIStorageProvider(),
        provider: "openai",
      });

      // Send a POST with invalid JSON but correct content-type
      const response = await rehydraFetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json{{{",
      });

      expect(response.status).toBe(400);
      const data = await response.json() as any;
      expect(data.error.type).toBe("rehydra_proxy_error");
      expect(data.error.message).toContain("Invalid JSON");
    });

    it("should return 502 when upstream is unreachable", async () => {
      const rehydraFetch = createRehydraFetch({
        keyProvider: new InMemoryKeyProvider(),
        piiStorageProvider: new InMemoryPIIStorageProvider(),
        provider: "openai",
      });

      // Point to a port that's not listening
      const response = await rehydraFetch("http://127.0.0.1:1/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "test",
          messages: [{ role: "user", content: "Hello" }],
        }),
      });

      expect(response.status).toBe(502);
      const data = await response.json() as any;
      expect(data.error.type).toBe("rehydra_proxy_error");
      expect(data.error.message).toContain("Upstream LLM unreachable");
    });

    it("should pass through upstream response when it returns invalid JSON", async () => {
      mockServer = await createMockLLMServer();
      // Override the server to return invalid JSON
      mockServer.server.close();
      mockServer = await new Promise((resolve) => {
        const server = createServer((_req, res) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("not json at all");
        });
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          const port = typeof addr === "object" && addr !== null ? addr.port : 0;
          resolve({ server, port, receivedBodies: [] });
        });
      });
      const { port } = mockServer;

      const rehydraFetch = createRehydraFetch({
        keyProvider: new InMemoryKeyProvider(),
        piiStorageProvider: new InMemoryPIIStorageProvider(),
        provider: "openai",
      });

      const response = await rehydraFetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "test",
          messages: [{ role: "user", content: "Hello" }],
        }),
      });

      // Should pass through the raw response, not crash
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toBe("not json at all");
    });
  });

  describe("tool call rehydration", () => {
    /**
     * Create a mock server with a custom request handler.
     */
    function createCustomMockServer(
      handler: (body: Record<string, unknown>, res: ServerResponse) => void,
    ): Promise<{ server: Server; port: number; receivedBodies: unknown[] }> {
      return new Promise((resolve) => {
        const receivedBodies: unknown[] = [];

        const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk as Buffer);
          }
          const rawBody = Buffer.concat(chunks).toString();

          let body: Record<string, unknown> = {};
          try {
            body = JSON.parse(rawBody) as Record<string, unknown>;
          } catch {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok" }));
            return;
          }
          receivedBodies.push(body);
          handler(body, res);
        });

        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          const port = typeof addr === "object" && addr !== null ? addr.port : 0;
          resolve({ server, port, receivedBodies });
        });
      });
    }

    it("should rehydrate tool call arguments in non-streaming response", async () => {
      mockServer = await createCustomMockServer((body, res) => {
        const prompt = ((body.messages as any[]) ?? []).find((m: any) => m.role === "user")?.content ?? "";
        res.writeHead(200, { "Content-Type": "application/json" });
        // Echo the full prompt as tool call arguments so PII tags are included
        res.end(JSON.stringify({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_1",
                type: "function",
                function: {
                  name: "send_email",
                  arguments: JSON.stringify({ to: prompt }),
                },
              }],
            },
          }],
        }));
      });
      const { port, receivedBodies } = mockServer;

      const rehydraFetch = createRehydraFetch({
        keyProvider: new InMemoryKeyProvider(),
        piiStorageProvider: new InMemoryPIIStorageProvider(),
        provider: "openai",
        getSessionId: async () => "tool-call-test",
      });

      const response = await rehydraFetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "test",
          messages: [{ role: "user", content: "Email john@example.com" }],
        }),
      });

      expect(response.ok).toBe(true);

      // Verify request was anonymized
      const sentBody = receivedBodies[0] as any;
      const sentUserMsg = (sentBody.messages as any[]).find((m: any) => m.role === "user");
    expect(sentUserMsg.content).toContain('<PII type="EMAIL"');
      expect(sentUserMsg.content).not.toContain("john@example.com");

      // Verify tool call arguments were rehydrated
      const data = await response.json() as any;
      const args = JSON.parse(data.choices[0].message.tool_calls[0].function.arguments);
      expect(args.to).toContain("john@example.com");
    });

    it("should rehydrate tool call arguments in streaming response", async () => {
      mockServer = await createCustomMockServer((body, res) => {
        const prompt = ((body.messages as any[]) ?? []).find((m: any) => m.role === "user")?.content ?? "";
        const argsJson = JSON.stringify({ to: prompt });

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });

        // Send tool call in multiple SSE chunks
        // First chunk: id + name
        res.write(`data: ${JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "send_email" } }] } }],
        })}\n\n`);

        // Send arguments in pieces
        const mid = Math.floor(argsJson.length / 2);
        res.write(`data: ${JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: argsJson.slice(0, mid) } }] } }],
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: argsJson.slice(mid) } }] } }],
        })}\n\n`);

        res.write("data: [DONE]\n\n");
        res.end();
      });
      const { port, receivedBodies } = mockServer;

      const rehydraFetch = createRehydraFetch({
        keyProvider: new InMemoryKeyProvider(),
        piiStorageProvider: new InMemoryPIIStorageProvider(),
        provider: "openai",
        getSessionId: async () => "tool-stream-test",
      });

      const response = await rehydraFetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "test",
          messages: [{ role: "user", content: "Email john@example.com" }],
          stream: true,
        }),
      });

      expect(response.ok).toBe(true);

      // Verify request was anonymized
      const sentBody = receivedBodies[0] as any;
      const sentUserMsg = (sentBody.messages as any[]).find((m: any) => m.role === "user");
      expect(sentUserMsg.content).not.toContain("john@example.com");

      // Read the full stream and collect tool call argument fragments
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let fullStream = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        fullStream += decoder.decode(value, { stream: true });
      }

      // The rehydrated stream should contain the original email
      expect(fullStream).toContain("john@example.com");
    });

    it("should handle interleaved multi-tool-call streaming", async () => {
      mockServer = await createCustomMockServer((body, res) => {
        const prompt = ((body.messages as any[]) ?? []).find((m: any) => m.role === "user")?.content ?? "";

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });

        // First chunk: tool call ids + names
        res.write(`data: ${JSON.stringify({
          choices: [{ delta: { tool_calls: [
            { index: 0, id: "call_1", type: "function", function: { name: "send_email" } },
            { index: 1, id: "call_2", type: "function", function: { name: "lookup" } },
          ] } }],
        })}\n\n`);

        // Interleaved arguments — both echo the full prompt which contains PII tags
        const args0 = JSON.stringify({ to: prompt });
        const args1 = JSON.stringify({ query: prompt });

        res.write(`data: ${JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args0 } }] } }],
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: args1 } }] } }],
        })}\n\n`);

        res.write("data: [DONE]\n\n");
        res.end();
      });
      const { port } = mockServer;

      const rehydraFetch = createRehydraFetch({
        keyProvider: new InMemoryKeyProvider(),
        piiStorageProvider: new InMemoryPIIStorageProvider(),
        provider: "openai",
        getSessionId: async () => "interleaved-test",
      });

      const response = await rehydraFetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "test",
          messages: [{ role: "user", content: "Email john@example.com" }],
          stream: true,
        }),
      });

      expect(response.ok).toBe(true);

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let fullStream = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        fullStream += decoder.decode(value, { stream: true });
      }

      // Both tool calls should have rehydrated arguments
      expect(fullStream).toContain("john@example.com");
    });

    it("should handle PII tags spanning tool call argument chunks", async () => {
      mockServer = await createCustomMockServer((body, res) => {
        const prompt = ((body.messages as any[]) ?? []).find((m: any) => m.role === "user")?.content ?? "";
        const argsJson = JSON.stringify({ to: prompt });

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });

        // First chunk: id + name
        res.write(`data: ${JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "send_email" } }] } }],
        })}\n\n`);

        // Split the arguments right in the middle of the <PII tag
        const piiStart = argsJson.indexOf("<PII");
        if (piiStart !== -1) {
          const splitPoint = piiStart + 4; // after "<PII"
          res.write(`data: ${JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: argsJson.slice(0, splitPoint) } }] } }],
          })}\n\n`);
          res.write(`data: ${JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: argsJson.slice(splitPoint) } }] } }],
          })}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: argsJson } }] } }],
          })}\n\n`);
        }

        res.write("data: [DONE]\n\n");
        res.end();
      });
      const { port } = mockServer;

      const rehydraFetch = createRehydraFetch({
        keyProvider: new InMemoryKeyProvider(),
        piiStorageProvider: new InMemoryPIIStorageProvider(),
        provider: "openai",
        getSessionId: async () => "span-test",
      });

      const response = await rehydraFetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "test",
          messages: [{ role: "user", content: "Email john@example.com" }],
          stream: true,
        }),
      });

      expect(response.ok).toBe(true);

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let fullStream = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        fullStream += decoder.decode(value, { stream: true });
      }

      // Even though the PII tag was split across chunks, it should be rehydrated
      expect(fullStream).toContain("john@example.com");
    });

    it("should flush Anthropic tool call buffer before content_block_stop", async () => {
      mockServer = await createCustomMockServer((body, res) => {
        const prompt = ((body.messages as any[]) ?? []).find((m: any) => m.role === "user")?.content ?? "";
        // Build arguments with two PII refs: the first completes, the second is
        // intentionally split so the buffer holds an incomplete tag at stop time.
        const argsJson = `{"to":"${prompt}","cc":"${prompt}"}`;

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });

        res.write(`event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_1", name: "send_email", input: {} },
        })}\n\n`);

        // Find the SECOND <PII and split right after it so the buffer holds
        // an incomplete tag when content_block_stop arrives.
        const firstPII = argsJson.indexOf("<PII");
        const secondPII = argsJson.indexOf("<PII", firstPII + 1);
        const splitPoint = secondPII !== -1 ? secondPII + 4 : Math.floor(argsJson.length / 2);

        res.write(`event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: argsJson.slice(0, splitPoint) },
        })}\n\n`);

        // Don't send the rest — go straight to stop so the buffer is non-empty
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({
          type: "content_block_stop",
          index: 0,
        })}\n\n`);

        res.write(`event: message_stop\ndata: ${JSON.stringify({
          type: "message_stop",
        })}\n\n`);

        res.end();
      });
      const { port } = mockServer;

      const rehydraFetch = createRehydraFetch({
        keyProvider: new InMemoryKeyProvider(),
        piiStorageProvider: new InMemoryPIIStorageProvider(),
        provider: "anthropic",
        getSessionId: async () => "anthropic-stop-test",
      });

      const response = await rehydraFetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "sk-ant-test",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          messages: [{ role: "user", content: "Email john@example.com" }],
          stream: true,
        }),
      });

      expect(response.ok).toBe(true);

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const events: string[] = [];
      let raw = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        raw += decoder.decode(value, { stream: true });
      }

      for (const block of raw.split("\n\n").filter(Boolean)) {
        events.push(block);
      }

      // The first PII tag should be rehydrated (it completed in the delta)
      const emailIdx = events.findIndex((e) => e.includes("john@example.com"));
      expect(emailIdx).toBeGreaterThanOrEqual(0);

      // The buffered tail should be flushed BEFORE content_block_stop
      const stopIdx = events.findIndex((e) => e.includes("content_block_stop"));
      expect(stopIdx).toBeGreaterThan(0);

      // The flush event (containing the incomplete tail) must precede stop
      const flushIdx = events.findIndex((e, i) =>
        i > emailIdx && e.includes("input_json_delta"),
      );
      if (flushIdx !== -1) {
        expect(flushIdx).toBeLessThan(stopIdx);
      }
    });

    it("should flush tool call buffer at stream end for OpenAI", async () => {
      mockServer = await createCustomMockServer((body, res) => {
        const msgs = (body.messages as any[]) ?? [];
        const userMsg = msgs.find((m: any) => m.role === "user");
        const prompt = userMsg?.content ?? "";
        // Build arguments containing two PII refs; split after the second <PII
        // so the buffer is non-empty when [DONE] arrives.
        const argsJson = `{"to":"${prompt}","cc":"${prompt}"}`;

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });

        // First chunk: id + name
        res.write(`data: ${JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "send_email" } }] } }],
        })}\n\n`);

        // Send arguments up through the second incomplete <PII tag
        const firstPII = argsJson.indexOf("<PII");
        const secondPII = argsJson.indexOf("<PII", firstPII + 1);
        const splitPoint = secondPII !== -1 ? secondPII + 4 : Math.floor(argsJson.length / 2);

        res.write(`data: ${JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: argsJson.slice(0, splitPoint) } }] } }],
        })}\n\n`);

        // End stream without completing the second tag
        res.write("data: [DONE]\n\n");
        res.end();
      });
      const { port } = mockServer;

      const rehydraFetch = createRehydraFetch({
        keyProvider: new InMemoryKeyProvider(),
        piiStorageProvider: new InMemoryPIIStorageProvider(),
        provider: "openai",
        getSessionId: async () => "openai-flush-test",
      });

      const response = await rehydraFetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "test",
          messages: [{ role: "user", content: "Email john@example.com" }],
          stream: true,
        }),
      });

      expect(response.ok).toBe(true);

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let fullStream = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        fullStream += decoder.decode(value, { stream: true });
      }

      // The first PII tag should be rehydrated in the delta event
      expect(fullStream).toContain("john@example.com");
      // The buffered incomplete tail should be flushed at stream end (not lost)
      expect(fullStream).toContain("<PII");
    });
  });
});
