/**
 * Rehydra Proxy Server
 * Standalone HTTP server that proxies LLM API requests with
 * automatic PII anonymization and rehydration.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createRehydraProxy } from "./rehydra-proxy.js";
import type { RehydraProxyConfig } from "./types.js";

/**
 * Configuration for the standalone proxy server
 */
export interface RehydraProxyServerConfig extends RehydraProxyConfig {
  /** Port to listen on */
  port: number;
  /** Host to bind to (default: "127.0.0.1") */
  host?: string;
  /** Readiness predicate for required dependencies (default: ready) */
  isReady?: () => boolean;
}

export type ProxyRouteClassification =
  | "health"
  | "proxy"
  | "not-found"
  | "method-not-allowed";

export type RehydraProxyHandler = (request: Request) => Promise<Response>;

export interface ProxyRequestListenerConfig {
  host: string;
  port: number;
  getHandler: () => RehydraProxyHandler;
  isReady?: () => boolean;
}

const SUPPORTED_PROXY_ROUTES = new Map<string, string>([
  ["/v1/models", "GET"],
  ["/v1/chat/completions", "POST"],
  ["/v1/messages", "POST"],
  ["/v1/responses", "POST"],
]);

export function classifyProxyRoute(
  method: string,
  pathname: string,
): ProxyRouteClassification {
  if (pathname === "/healthz") {
    return method === "GET" ? "health" : "method-not-allowed";
  }

  const expectedMethod = SUPPORTED_PROXY_ROUTES.get(pathname);
  if (expectedMethod === undefined) return "not-found";
  return method === expectedMethod ? "proxy" : "method-not-allowed";
}

function writeJSON(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createProxyRequestListener(
  config: ProxyRequestListenerConfig,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req: IncomingMessage, res: ServerResponse): void => {
    void (async (): Promise<void> => {
      const pathname = new URL(req.url ?? "/", "http://proxy.local").pathname;
      const route = classifyProxyRoute(req.method ?? "GET", pathname);
      const ready = config.isReady?.() ?? true;

      if (route === "health") {
        writeJSON(
          res,
          ready ? 200 : 503,
          ready
            ? { status: "ok", ready: true }
            : { status: "unavailable", ready: false },
        );
        return;
      }
      if (route === "not-found") {
        writeJSON(res, 404, { error: "not_found" });
        return;
      }
      if (route === "method-not-allowed") {
        writeJSON(res, 405, { error: "method_not_allowed" });
        return;
      }
      if (!ready) {
        writeJSON(res, 503, { error: "proxy_not_ready" });
        return;
      }

      const abortController = new AbortController();
      const abortUpstream = (): void => abortController.abort();
      const abortOnPrematureClose = (): void => {
        if (!res.writableEnded) abortUpstream();
      };
      req.once("aborted", abortUpstream);
      res.once("close", abortOnPrematureClose);

      try {
        const webRequest = incomingMessageToRequest(
          req,
          config.host,
          config.port,
          abortController.signal,
        );
        const webResponse = await config.getHandler()(webRequest);
        await writeResponse(res, webResponse);
      } catch (error) {
        if (!abortController.signal.aborted && !res.headersSent) {
          writeJSON(res, 502, {
            error: "proxy_error",
            message: error instanceof Error ? error.message : "Unknown proxy error",
          });
        }
      } finally {
        req.off("aborted", abortUpstream);
        res.off("close", abortOnPrematureClose);
      }
    })();
  };
}

/**
 * A running Rehydra proxy server
 */
export interface RehydraProxyServer {
  /** The underlying HTTP server */
  server: Server;
  /** The port the server is listening on */
  port: number;
  /** The host the server is bound to */
  host: string;
  /** Gracefully close the server */
  close(): Promise<void>;
}

/**
 * Creates and starts a standalone HTTP proxy server that anonymizes
 * LLM API requests and rehydrates responses.
 *
 * @example
 * ```typescript
 * const proxy = await createRehydraProxyServer({
 *   port: 8080,
 *   upstream: 'https://api.openai.com',
 *   keyProvider: new ConfigKeyProvider(process.env.PII_KEY!),
 *   piiStorageProvider: new SQLitePIIStorageProvider('proxy.db'),
 * });
 *
 * console.log(`Proxy running on http://${proxy.host}:${proxy.port}`);
 *
 * // Point your OpenAI client at the proxy:
 * const openai = new OpenAI({ baseURL: `http://localhost:${proxy.port}/v1` });
 *
 * // Stop the server
 * await proxy.close();
 * ```
 */
export async function createRehydraProxyServer(
  config: RehydraProxyServerConfig,
): Promise<RehydraProxyServer> {
  const host = config.host ?? "127.0.0.1";
  const proxy = createRehydraProxy(config);

  const server = createServer(createProxyRequestListener({
    host,
    port: config.port,
    getHandler: () => proxy,
    isReady: config.isReady,
  }));

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(config.port, host, () => {
      resolve();
    });
  });

  return {
    server,
    port: config.port,
    host,
    async close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => {
          if (err !== undefined) reject(err);
          else resolve();
        });
      });
    },
  };
}

/**
 * Convert a Node.js IncomingMessage to a Web API Request
 */
export function incomingMessageToRequest(
  req: IncomingMessage,
  host: string,
  port: number,
  signal?: AbortSignal,
): Request {
  const url = `http://${host}:${port}${req.url ?? "/"}`;
  const headers = new Headers();

  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) {
      if (Array.isArray(value)) {
        for (const v of value) {
          headers.append(key, v);
        }
      } else {
        headers.set(key, value);
      }
    }
  }

  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";

  return new Request(url, {
    method,
    headers,
    body: hasBody ? nodeStreamToReadableStream(req) : undefined,
    signal,
    // @ts-expect-error - duplex is needed for streaming request bodies
    duplex: hasBody ? "half" : undefined,
  });
}

/**
 * Convert a Node.js Readable stream to a Web API ReadableStream
 */
function nodeStreamToReadableStream(nodeStream: IncomingMessage): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller): void {
      nodeStream.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
      });
      nodeStream.on("end", () => {
        controller.close();
      });
      nodeStream.on("error", (err: Error) => {
        controller.error(err);
      });
    },
  });
}

/**
 * Write a Web API Response to a Node.js ServerResponse
 */
export async function writeResponse(
  res: ServerResponse,
  webResponse: Response,
): Promise<void> {
  // Copy status and headers
  const headers: Record<string, string> = {};
  webResponse.headers.forEach((value, key) => {
    headers[key] = value;
  });

  res.writeHead(webResponse.status, headers);

  if (webResponse.body === null) {
    res.end();
    return;
  }

  // Stream the response body
  const reader = webResponse.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } finally {
    reader.releaseLock();
    res.end();
  }
}
