/**
 * Request/response audit trail.
 *
 * Records every request that passes through the proxy, capturing all four
 * payloads (request before/after anonymization, response before/after
 * rehydration) plus metadata, for security auditing.
 *
 * WARNING: audit records contain the ORIGINAL, un-anonymized request and
 * response bodies — real PII, API keys, everything. The audit file is the
 * single most sensitive artifact the proxy produces. Protect it accordingly.
 */

import { appendFile } from "node:fs/promises";

/** One audited request/response cycle. */
export interface AuditRecord {
  /** Unique record id. */
  id: string;
  /** ISO-8601 capture time. */
  timestamp: string;
  /** Session id used for PII map persistence. */
  sessionId: string;
  /** Resolved provider name (openai / anthropic / responses). */
  provider: string;
  /** Request URL as seen by the proxy. */
  url: string;
  /** HTTP status returned to the client. */
  status: number;
  /** Whether the response was streamed (SSE). */
  streaming: boolean;
  /** End-to-end proxy duration in milliseconds. */
  durationMs: number;
  /** Detected PII summary (types + counts, matches onAnonymize). */
  pii: { countsByType: Record<string, number>; totalEntities: number };
  /** Request body before and after anonymization (raw strings). */
  request: { original: string; anonymized: string };
  /** Response body before and after rehydration (raw strings). */
  response: { original: string; transformed: string };
  /** Error message when the request failed before/without an upstream reply. */
  error?: string;
}

/** A sink that persists audit records. Writes must never throw. */
export interface AuditSink {
  write(record: AuditRecord): Promise<void>;
}

/**
 * Append-only JSONL audit sink: one JSON record per line. Zero dependencies,
 * crash-safe (append), and queryable with jq or by importing into SQLite.
 * Write failures are logged to stderr and swallowed so auditing can never
 * take the proxy down.
 */
export class JsonlAuditSink implements AuditSink {
  constructor(private readonly filePath: string) {}

  async write(record: AuditRecord): Promise<void> {
    try {
      await appendFile(this.filePath, JSON.stringify(record) + "\n");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[rehydra] audit write failed: ${msg}\n`);
    }
  }
}

/** Generate a record id without external deps. */
export function newAuditId(): string {
  return `req_${Date.now().toString(36)}_${globalThis.crypto.randomUUID().slice(0, 8)}`;
}
