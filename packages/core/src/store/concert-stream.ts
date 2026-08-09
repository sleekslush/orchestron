import { createWriteStream, existsSync, mkdirSync, statSync, watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { WriteStream } from 'node:fs';
import type { ConcertEvent, ConcertID } from '../types/index.js';

/**
 * Envelope for one line of the unified per-concert stream.
 *
 * Every line is an envelope; `data` is ALWAYS the original emitted/received
 * object verbatim — the raw SDK event for `source: 'sdk'` records, the
 * {@link ConcertEvent} as emitted for `source: 'concert'` records. Envelope
 * metadata (ts, source, type, concert, movement, attempt, harness) is stamped
 * outside the object and never injected into it. Synthetic records (e.g.
 * `user.prompt`, which pi never emits as an event) are flagged `synthetic: true`.
 *
 * No sequence number: line order is the order. Offsets are JS string
 * code-unit (UTF-16) offsets used purely as resume points for incremental
 * reads; the JSON payloads are ASCII so this matches byte offsets in practice.
 */
export interface StreamRecord {
  ts: string;
  source: 'concert' | 'sdk';
  type: string;
  concertId: string;
  movementId?: string;
  attempt?: number;
  harness?: string;
  synthetic?: boolean;
  /** SDK session id when known at record time (opencode always; pi at export). */
  sessionId?: string;
  data: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Map a stream record back to a ConcertEvent (used by CLI/plugin consumers). */
export function streamRecordToEvent(record: StreamRecord): ConcertEvent | undefined {
  if (record.source !== 'concert') return undefined;
  const event = record.data as ConcertEvent;
  if (!event || typeof event.type !== 'string') return undefined;
  if (typeof event.timestamp === 'string') {
    return { ...event, timestamp: new Date(event.timestamp) };
  }
  return event;
}

/** Filter a stream to its concert-event records, restored to ConcertEvents. */
export function streamRecordsToEvents(records: StreamRecord[]): ConcertEvent[] {
  return records
    .map(streamRecordToEvent)
    .filter((e): e is ConcertEvent => e !== undefined);
}

/**
 * Append-only JSONL stream for realtime concert observation.
 *
 * One file per concert: `concerts/<concertId>/stream.jsonl`. Concert events and
 * verbatim raw SDK events from every harness interleave in this single file.
 * All appends for a concert go through one {@link WriteStream}; node serializes
 * write() calls in invocation order, so line order on disk is strict and never
 * interleaved even without awaiting each append.
 *
 * Cross-process consumers can tail the same file to observe progress without
 * polling SQLite. Offset semantics: `readSince`
 * offsets and the returned `bytesRead` values are UTF-16 code-unit offsets into
 * the decoded file content, sorted so they double as resume points for `watch`.
 */
export class ConcertStream {
  private tracesDir: string;
  private streams = new Map<string, WriteStream>();
  private pending = new Map<string, Promise<void>>();
  private closed = new Set<string>();

  constructor(tracesDir: string) {
    this.tracesDir = tracesDir;
  }

  private getPath(concertId: ConcertID): string {
    return join(this.tracesDir, concertId, 'stream.jsonl');
  }

  private ensureStream(concertId: ConcertID): WriteStream {
    const cached = this.streams.get(concertId);
    if (cached) return cached;

    const filePath = this.getPath(concertId);
    mkdirSync(dirname(filePath), { recursive: true });
    const stream = createWriteStream(filePath, { flags: 'a' });
    this.streams.set(concertId, stream);
    return stream;
  }

  /**
   * Append one envelope line to the concert stream. JSON.stringify is the
   * fidelity boundary: if serialization throws (cyclic refs, BigInt, ...) the
   * error is logged loudly and the line is skipped — recording never crashes
   * the caller. Writes are queued per concert in invocation order.
   */
  append(concertId: ConcertID, record: StreamRecord): Promise<void> {
    if (this.closed.has(concertId)) return Promise.resolve();

    let line: string;
    try {
      line = JSON.stringify(record) + '\n';
    } catch (err) {
      console.error(
        `ConcertStream: failed to serialize record type='${record.type}' for concert '${concertId}'; line skipped.`,
        err,
      );
      return Promise.resolve();
    }

    const stream = this.ensureStream(concertId);
    const prev = this.pending.get(concertId) ?? Promise.resolve();
    const next = prev.then(
      () =>
        new Promise<void>((resolve, reject) => {
          stream.write(line, (err) => {
            if (err) reject(err);
            else resolve();
          });
        }),
    );
    this.pending.set(
      concertId,
      next.catch(() => {}),
    );
    return next;
  }

  /** Resolve once every queued append for the concert has hit disk. */
  async flush(concertId: ConcertID): Promise<void> {
    await this.pending.get(concertId);
  }

  /** Read all envelope records currently in the concert stream. */
  async read(concertId: ConcertID): Promise<StreamRecord[]> {
    const filePath = this.getPath(concertId);
    if (!existsSync(filePath)) return [];

    const content = await readFile(filePath, 'utf-8');
    return this.parseLines(content);
  }

  /** Read concert events from the stream (source: 'concert' records only). */
  async readEvents(concertId: ConcertID): Promise<ConcertEvent[]> {
    const records = await this.read(concertId);
    return streamRecordsToEvents(records);
  }

  /**
   * Read records from the concert stream starting at a UTF-16 code-unit offset
   * (see class docs). Returns the newly parsed records and the new offset.
   */
  async readSince(
    concertId: ConcertID,
    offset: number,
  ): Promise<{ records: StreamRecord[]; bytesRead: number }> {
    const filePath = this.getPath(concertId);
    if (!existsSync(filePath)) {
      return { records: [], bytesRead: offset };
    }

    const content = await readFile(filePath, 'utf-8');
    const chunk = content.slice(offset);
    const records = this.parseLines(chunk);
    return { records, bytesRead: content.length };
  }

  /** Tail the concert stream, yielding batches of new records as appended. */
  async *watch(
    concertId: ConcertID,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<StreamRecord[]> {
    const filePath = this.getPath(concertId);
    let offset = 0;

    const initial = await this.readSince(concertId, offset);
    offset = initial.bytesRead;
    if (initial.records.length > 0) {
      yield initial.records;
    }

    const outerSignal = options?.signal;
    while (true) {
      if (outerSignal?.aborted) break;

      // Wait until the file grows beyond the current offset. fs.watch can miss
      // appends through an already-open stream on some platforms, so also poll
      // the file size as a fallback.
      await this.waitForChange(filePath, outerSignal, offset);
      if (outerSignal?.aborted) break;

      const result = await this.readSince(concertId, offset);
      offset = result.bytesRead;
      if (result.records.length > 0) {
        yield result.records;
      }
    }
  }

  /** Close the write stream for a concert. */
  async close(concertId: ConcertID): Promise<void> {
    this.closed.add(concertId);
    await this.pending.get(concertId);
    const stream = this.streams.get(concertId);
    if (!stream) return;
    this.streams.delete(concertId);
    this.pending.delete(concertId);

    return new Promise((resolve) => {
      stream.end(() => resolve());
    });
  }

  /** Close all open write streams. */
  async dispose(): Promise<void> {
    const ids = Array.from(this.streams.keys());
    await Promise.all(ids.map((id) => this.close(id)));
  }

  private parseLines(content: string): StreamRecord[] {
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          const parsed = JSON.parse(line) as StreamRecord;
          if (
            parsed &&
            typeof parsed.ts === 'string' &&
            typeof parsed.type === 'string' &&
            (parsed.source === 'concert' || parsed.source === 'sdk')
          ) {
            return parsed;
          }
          return undefined;
        } catch {
          return undefined;
        }
      })
      .filter((r): r is StreamRecord => r !== undefined);
  }

  private async waitForChange(
    filePath: string,
    signal?: AbortSignal,
    offset = 0,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const dir = dirname(filePath);
      let settled = false;
      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
      };
      const settle = () => {
        if (settled) return;
        settled = true;
        watcher.close();
        clearInterval(poll);
        cleanup();
        resolve();
      };

      const watcher = watch(
        dir,
        { persistent: false, recursive: false },
        () => settle(),
      );

      // Poll fallback in case fs.watch misses the append.
      const fileSize = () => {
        try {
          return existsSync(filePath) ? statSync(filePath).size : 0;
        } catch {
          return 0;
        }
      };
      const poll = setInterval(() => {
        if (fileSize() > offset) settle();
      }, 150);
      poll.unref?.();

      const onAbort = () => resolve();
      signal?.addEventListener('abort', onAbort, { once: true });

      (watcher as unknown as import('node:events').EventEmitter).on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        watcher.close();
        clearInterval(poll);
        cleanup();
        reject(err);
      });
    });
  }
}