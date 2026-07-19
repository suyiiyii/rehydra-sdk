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

import { appendFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { basename, dirname, join } from "node:path";
import zlib from "node:zlib";

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

export interface JsonlAuditSinkOptions {
  /**
   * Rotate the log hourly (UTC) and compress rotated files to zstd level 19.
   * A rotated hour is only written when it received at least one record.
   * Requires Node.js >= 22.15 (native zstd in node:zlib).
   */
  compress?: boolean;
}

/** UTC hour bucket of a Date, e.g. "2026-07-20T02". */
function hourOf(date: Date): string {
  return date.toISOString().slice(0, 13);
}

/**
 * Append-only JSONL audit sink: one JSON record per line. Zero dependencies,
 * crash-safe (append), and queryable with jq or by importing into SQLite.
 * Write failures are logged to stderr and swallowed so auditing can never
 * take the proxy down.
 *
 * With `compress: true`, the first write of a new UTC hour renames the
 * current file to `<name>-<hour>.jsonl` and compresses it in the background
 * to `<name>-<hour>.jsonl.zst`; the raw file is deleted only after the
 * compressed copy decompresses back to the exact original byte count.
 * Hours without requests produce no file at all. Leftover uncompressed
 * rotations (e.g. after a crash) are swept on the first write.
 */
export class JsonlAuditSink implements AuditSink {
  private readonly compress: boolean;
  /** Serializes rotation + append so a record can never straddle files. */
  private queue: Promise<void> = Promise.resolve();
  /** In-flight background compressions (rotation does not wait on these). */
  private readonly compressions = new Set<Promise<void>>();
  /** UTC hour of the records in the current file. */
  private currentHour: string | undefined;
  private swept = false;

  constructor(
    private readonly filePath: string,
    options: JsonlAuditSinkOptions = {},
  ) {
    this.compress = options.compress ?? false;
    if (this.compress && typeof zlib.createZstdCompress !== "function") {
      throw new Error(
        "audit compression requires Node.js with zstd support (>= 22.15)",
      );
    }
  }

  async write(record: AuditRecord): Promise<void> {
    const task = this.queue.then(async () => {
      if (this.compress) {
        await this.rotateIfNeeded(hourOf(new Date()));
      }
      await appendFile(this.filePath, JSON.stringify(record) + "\n");
    });
    // Never throw and never poison the queue.
    this.queue = task.catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[rehydra] audit write failed: ${msg}\n`);
    });
    return this.queue;
  }

  /** Wait for queued writes and background compressions (tests, shutdown). */
  async flush(): Promise<void> {
    await this.queue;
    await Promise.all([...this.compressions]);
  }

  private rotatedPath(hour: string): string {
    const base = basename(this.filePath).replace(/\.jsonl$/, "");
    return join(dirname(this.filePath), `${base}-${hour}.jsonl`);
  }

  private async rotateIfNeeded(nowHour: string): Promise<void> {
    if (!this.swept) {
      this.swept = true;
      await this.sweep(nowHour);
    }
    if (this.currentHour !== undefined && this.currentHour !== nowHour) {
      // The current file has at least one record from a previous hour.
      await rename(this.filePath, this.rotatedPath(this.currentHour));
      this.compressInBackground(this.rotatedPath(this.currentHour));
    }
    this.currentHour = nowHour;
  }

  /**
   * Startup recovery: compress leftover rotated files and rotate a stale
   * current file (its mtime hour tells which bucket its records belong to).
   */
  private async sweep(nowHour: string): Promise<void> {
    const dir = dirname(this.filePath);
    const base = basename(this.filePath).replace(/\.jsonl$/, "");
    const leftover = new RegExp(`^${base}-\\d{4}-\\d{2}-\\d{2}T\\d{2}\\.jsonl$`);
    try {
      for (const name of await readdir(dir)) {
        if (leftover.test(name)) {
          this.compressInBackground(join(dir, name));
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[rehydra] audit sweep failed: ${msg}\n`);
    }
    try {
      const fileHour = hourOf((await stat(this.filePath)).mtime);
      if (fileHour !== nowHour) {
        await rename(this.filePath, this.rotatedPath(fileHour));
        this.compressInBackground(this.rotatedPath(fileHour));
      }
    } catch {
      // No current file yet — nothing to rotate.
    }
  }

  private compressInBackground(rawPath: string): void {
    const task = (async () => {
      const zstPath = `${rawPath}.zst`;
      // Single-threaded on purpose: ZSTD_c_nbWorkers > 0 makes the streaming
      // compressor fail with "stream.push() after EOF" on multi-chunk input
      // in Node 22 (fixed in 24). Background compression can afford it.
      await pipeline(
        createReadStream(rawPath),
        zlib.createZstdCompress({
          params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 },
        }),
        createWriteStream(zstPath),
      );
      // Delete the raw file only after the compressed copy proves complete.
      const rawSize = (await stat(rawPath)).size;
      let decompressedSize = 0;
      await pipeline(
        createReadStream(zstPath),
        zlib.createZstdDecompress(),
        async (source): Promise<void> => {
          for await (const chunk of source) {
            decompressedSize += (chunk as Buffer).length;
          }
        },
      );
      if (decompressedSize !== rawSize) {
        throw new Error(
          `verification mismatch for ${zstPath}: raw ${rawSize} bytes, decompressed ${decompressedSize}`,
        );
      }
      await unlink(rawPath);
    })().catch(async (err) => {
      // Keep the raw file on any failure; it is retried by the next sweep.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[rehydra] audit compress failed for ${rawPath}: ${msg}\n`);
      await unlink(`${rawPath}.zst`).catch(() => {});
    });
    this.compressions.add(task);
    void task.finally(() => this.compressions.delete(task));
  }
}

/** Generate a record id without external deps. */
export function newAuditId(): string {
  return `req_${Date.now().toString(36)}_${globalThis.crypto.randomUUID().slice(0, 8)}`;
}
