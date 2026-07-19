import { createServer, request as httpRequest, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import {
  classifyProxyRoute,
  createProxyRequestListener,
  incomingMessageToRequest,
} from "../../src/proxy/proxy-server.js";

describe("classifyProxyRoute", () => {
  it.each([
    ["GET", "/healthz", "health"],
    ["GET", "/v1/models", "proxy"],
    ["POST", "/v1/chat/completions", "proxy"],
    ["POST", "/v1/messages", "proxy"],
    ["POST", "/v1/responses", "proxy"],
    ["POST", "/v1/unknown", "not-found"],
    ["GET", "/v1/messages", "method-not-allowed"],
    ["GET", "/v1/responses", "method-not-allowed"],
    ["POST", "/v1/models", "method-not-allowed"],
  ])("classifies %s %s as %s", (method, pathname, expected) => {
    expect(classifyProxyRoute(method, pathname)).toBe(expected);
  });
});

describe("incomingMessageToRequest", () => {
  function fakeReq(headers: Record<string, string>): IncomingMessage {
    return { url: "/v1/models", method: "GET", headers } as unknown as IncomingMessage;
  }

  it("should build the request URL from the client Host header", () => {
    const request = incomingMessageToRequest(fakeReq({ host: "virtual.example" }), "127.0.0.1", 8787);
    expect(new URL(request.url).hostname).toBe("virtual.example");
  });

  it("should fall back to the bind address without a Host header", () => {
    const request = incomingMessageToRequest(fakeReq({}), "127.0.0.1", 8787);
    expect(request.url).toBe("http://127.0.0.1:8787/v1/models");
  });

  it("should fall back to the bind address for an unparsable Host header", () => {
    const request = incomingMessageToRequest(fakeReq({ host: "bad host" }), "127.0.0.1", 8787);
    expect(request.url).toBe("http://127.0.0.1:8787/v1/models");
  });
});

describe("createProxyRequestListener", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  async function start(isReady: () => boolean): Promise<{
    baseUrl: string;
    handler: ReturnType<typeof vi.fn>;
  }> {
    const handler = vi.fn(async () => new Response("upstream", { status: 200 }));
    server = createServer(createProxyRequestListener({
      host: "127.0.0.1",
      port: 0,
      getHandler: () => handler,
      isReady,
    }));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing port");
    return { baseUrl: `http://127.0.0.1:${address.port}`, handler };
  }

  it("serves health locally without invoking the upstream handler", async () => {
    const { baseUrl, handler } = await start(() => true);
    const response = await fetch(`${baseUrl}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", ready: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it("reports unavailable while required components are not ready", async () => {
    const { baseUrl, handler } = await start(() => false);
    const response = await fetch(`${baseUrl}/healthz`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable", ready: false });
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects unsupported and wrong-method routes locally", async () => {
    const { baseUrl, handler } = await start(() => true);

    expect((await fetch(`${baseUrl}/v1/unknown`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${baseUrl}/v1/messages`)).status).toBe(405);
    expect((await fetch(`${baseUrl}/v1/responses`)).status).toBe(405);
    expect(handler).not.toHaveBeenCalled();
  });

  it("forwards only admitted API routes when ready", async () => {
    const { baseUrl, handler } = await start(() => true);

    expect((await fetch(`${baseUrl}/v1/models`)).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("cancels upstream work when the downstream client disconnects", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const handler = vi.fn(async (request: Request) => {
      upstreamSignal = request.signal;
      return new Promise<Response>((resolve) => {
        request.signal.addEventListener(
          "abort",
          () => resolve(new Response("cancelled", { status: 499 })),
          { once: true },
        );
      });
    });
    server = createServer(createProxyRequestListener({
      host: "127.0.0.1",
      port: 0,
      getHandler: () => handler,
    }));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing port");

    const clientRequest = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      path: "/v1/messages",
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    clientRequest.on("error", () => undefined);
    clientRequest.end(JSON.stringify({ model: "test", messages: [] }));

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    clientRequest.destroy();

    await vi.waitFor(() => expect(upstreamSignal?.aborted).toBe(true));
  });
});
