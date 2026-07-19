import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { createRehydraProxy } from "../../src/proxy/rehydra-proxy.js";
import { InMemoryKeyProvider } from "../../src/crypto/index.js";
import { InMemoryPIIStorageProvider } from "../../src/storage/in-memory.js";

/**
 * Create a minimal upstream server that identifies itself in the
 * assistant message content, so tests can assert which upstream
 * actually served a proxied request.
 */
function createUpstreamServer(name: string): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: `served-by-${name}` } }],
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function makeProxy(upstreamConfig: { upstream?: string; upstreams?: Record<string, string> }) {
  return createRehydraProxy({
    ...upstreamConfig,
    keyProvider: new InMemoryKeyProvider(),
    piiStorageProvider: new InMemoryPIIStorageProvider(),
    provider: "auto",
    getSessionId: async () => "test-session",
  });
}

function chatRequest(host: string): Request {
  return new Request(`http://${host}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "test",
      messages: [{ role: "user", content: "hello" }],
    }),
  });
}

describe("createRehydraProxy host-based upstream routing", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.map(
        (s) => new Promise<void>((resolve) => s.close(() => resolve())),
      ),
    );
    servers.length = 0;
  });

  async function twoUpstreams(): Promise<{ urlA: string; urlB: string }> {
    const a = await createUpstreamServer("A");
    const b = await createUpstreamServer("B");
    servers.push(a.server, b.server);
    return { urlA: a.url, urlB: b.url };
  }

  it("should route requests to the upstream matching the request hostname", async () => {
    const { urlA, urlB } = await twoUpstreams();
    const proxy = makeProxy({
      upstreams: { "a.example": urlA, "b.example": urlB },
    });

    const fromA = await (await proxy(chatRequest("a.example"))).text();
    const fromB = await (await proxy(chatRequest("b.example"))).text();

    expect(fromA).toContain("served-by-A");
    expect(fromB).toContain("served-by-B");
  });

  it("should match hosts case-insensitively and ignore ports on both sides", async () => {
    const { urlA } = await twoUpstreams();
    const proxy = makeProxy({
      upstreams: { "C.Example:9999": urlA },
    });

    const response = await proxy(chatRequest("c.example:8787"));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("served-by-A");
  });

  it("should reject unknown hosts with 502 and not hit any upstream", async () => {
    const { urlA } = await twoUpstreams();
    const proxy = makeProxy({ upstreams: { "a.example": urlA } });

    const response = await proxy(chatRequest("unknown.example"));

    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("no_upstream_for_host");
    expect(body.error.message).toContain("unknown.example");
  });

  it("should fall back to the '*' entry for unmatched hosts", async () => {
    const { urlA, urlB } = await twoUpstreams();
    const proxy = makeProxy({
      upstreams: { "a.example": urlA, "*": urlB },
    });

    const response = await proxy(chatRequest("anything.example"));

    expect(await response.text()).toContain("served-by-B");
  });

  it("should keep single-upstream behavior when no map is configured", async () => {
    const { urlA } = await twoUpstreams();
    const proxy = makeProxy({ upstream: urlA });

    const response = await proxy(chatRequest("any-host.example"));

    expect(await response.text()).toContain("served-by-A");
  });

  it("should throw at creation when neither upstream nor upstreams is set", () => {
    expect(() => makeProxy({})).toThrow(
      "createRehydraProxy requires `upstream` or `upstreams`",
    );
  });
});
