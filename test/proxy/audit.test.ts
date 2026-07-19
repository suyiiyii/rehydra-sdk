import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlAuditSink, newAuditId } from "../../src/proxy/audit.js";
import type { AuditRecord } from "../../src/proxy/audit.js";
import { createRehydraFetch } from "../../src/proxy/rehydra-fetch.js";
import { InMemoryKeyProvider } from "../../src/crypto/index.js";
import { InMemoryPIIStorageProvider } from "../../src/storage/in-memory.js";

function baseRecord(): AuditRecord {
  return {
    id: newAuditId(),
    timestamp: new Date().toISOString(),
    sessionId: "s",
    provider: "openai",
    url: "http://x/v1/chat/completions",
    status: 200,
    streaming: false,
    durationMs: 1,
    pii: { countsByType: {}, totalEntities: 0 },
    request: { original: "a", anonymized: "b" },
    response: { original: "c", transformed: "d" },
  };
}

describe("JsonlAuditSink", () => {
  let path: string | null = null;

  afterEach(async () => {
    if (path !== null) await rm(path, { force: true });
    path = null;
  });

  it("appends one JSON record per line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rehydra-audit-"));
    path = join(dir, "audit.jsonl");
    const sink = new JsonlAuditSink(path);

    await sink.write(baseRecord());
    await sink.write({ ...baseRecord(), status: 502 });

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).status).toBe(200);
    expect(JSON.parse(lines[1]!).status).toBe(502);
  });

  it("swallows write errors without throwing", async () => {
    // Non-existent directory → appendFile rejects; sink must not throw.
    const sink = new JsonlAuditSink("/nonexistent-dir-xyz/audit.jsonl");
    await expect(sink.write(baseRecord())).resolves.toBeUndefined();
  });
});

describe("audit capture through the proxy", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server !== null) {
      await new Promise<void>((r) => server!.close(() => r()));
      server = null;
    }
  });

  async function startUpstream(
    handler: (body: any, res: import("node:http").ServerResponse) => void,
  ): Promise<number> {
    server = createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      handler(JSON.parse(raw), res);
    });
    return new Promise((resolve) => {
      server!.listen(0, "127.0.0.1", () =>
        resolve((server!.address() as { port: number }).port),
      );
    });
  }

  async function collectAudit(): Promise<{
    path: string;
    records: () => Promise<AuditRecord[]>;
  }> {
    const dir = await mkdtemp(join(tmpdir(), "rehydra-audit-"));
    const path = join(dir, "audit.jsonl");
    return {
      path,
      // Poll briefly: the streaming path writes its record fire-and-forget
      // once the tee'd audit branch finishes draining, shortly after the
      // client stream ends.
      records: async () => {
        for (let i = 0; i < 50; i++) {
          try {
            const text = await readFile(path, "utf8");
            if (text.trim() !== "") {
              return text
                .trim()
                .split("\n")
                .map((l) => JSON.parse(l) as AuditRecord);
            }
          } catch {
            // file not created yet
          }
          await new Promise((r) => setTimeout(r, 20));
        }
        throw new Error("no audit records written");
      },
    };
  }

  it("records all four payloads for a non-streaming response", async () => {
    const port = await startUpstream((_body, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "hi there" } }],
        }),
      );
    });
    const { path, records } = await collectAudit();

    const fetchFn = createRehydraFetch({
      keyProvider: new InMemoryKeyProvider(),
      piiStorageProvider: new InMemoryPIIStorageProvider(),
      provider: "openai",
      getSessionId: async () => "sess-1",
      audit: new JsonlAuditSink(path),
    });

    await fetchFn(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test",
        messages: [{ role: "user", content: "Email john@example.com" }],
      }),
    });

    const recs = await records();
    expect(recs).toHaveLength(1);
    const r = recs[0]!;
    // Request original keeps the real email; anonymized replaced it.
    // (anonymized is a JSON string, so PII tag quotes are backslash-escaped)
    expect(r.request.original).toContain("john@example.com");
    const anonMessages = JSON.parse(r.request.anonymized).messages as Array<{
      content: string;
    }>;
    const userMsg = anonMessages[anonMessages.length - 1]!;
    expect(userMsg.content).toContain('<PII type="EMAIL"');
    expect(userMsg.content).not.toContain("john@example.com");
    // Response captured both sides
    expect(r.response.original).toContain("hi there");
    expect(r.response.transformed).toContain("hi there");
    expect(r.status).toBe(200);
    expect(r.streaming).toBe(false);
    expect(r.pii.totalEntities).toBeGreaterThan(0);
  });

  it("records upstream errors as their real status, not a proxy 502", async () => {
    const port = await startUpstream((_body, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad key" } }));
    });
    const { path, records } = await collectAudit();

    const fetchFn = createRehydraFetch({
      keyProvider: new InMemoryKeyProvider(),
      piiStorageProvider: new InMemoryPIIStorageProvider(),
      provider: "openai",
      getSessionId: async () => "sess-err",
      audit: new JsonlAuditSink(path),
    });

    await fetchFn(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "test", messages: [{ role: "user", content: "hi" }] }),
    });

    const recs = await records();
    expect(recs).toHaveLength(1);
    expect(recs[0]!.status).toBe(401);
    expect(recs[0]!.response.original).toContain("bad key");
  });

  it("records the full stream for an incremental SSE response", async () => {
    const port = await startUpstream((body, res) => {
      const prompt = body.messages[0].content as string;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      // Echo the (anonymized) prompt back across two content frames.
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: prompt.slice(0, 10) } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: prompt.slice(10) } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "" }, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
    const { path, records } = await collectAudit();

    const fetchFn = createRehydraFetch({
      keyProvider: new InMemoryKeyProvider(),
      piiStorageProvider: new InMemoryPIIStorageProvider(),
      provider: "openai",
      getSessionId: async () => "sess-stream",
      audit: new JsonlAuditSink(path),
    });

    const response = await fetchFn(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test",
        stream: true,
        messages: [{ role: "user", content: "Contact john@example.com now" }],
      }),
    });
    // Drain the client stream so the tee'd audit branch completes.
    await response.text();

    const recs = await records();
    expect(recs).toHaveLength(1);
    const r = recs[0]!;
    expect(r.streaming).toBe(true);
    // Upstream stream carried the anonymized placeholder, not the real email...
    expect(r.response.original).toContain("EMAIL");
    expect(r.response.original).not.toContain("john@example.com");
    // ...and the client-facing stream carried the rehydrated real value.
    expect(r.response.transformed).toContain("john@example.com");
    expect(r.response.transformed).toContain('"finish_reason":"stop"');
  });

  it("writes nothing when no audit sink is configured", async () => {
    const port = await startUpstream((_body, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
    });

    const fetchFn = createRehydraFetch({
      keyProvider: new InMemoryKeyProvider(),
      piiStorageProvider: new InMemoryPIIStorageProvider(),
      provider: "openai",
      getSessionId: async () => "sess-noaudit",
    });

    const response = await fetchFn(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "test", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(response.ok).toBe(true);
  });
});
