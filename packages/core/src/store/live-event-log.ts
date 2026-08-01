import { createWriteStream, existsSync, mkdirSync, statSync, watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { WriteStream } from 'node:fs';
import type { ConcertEvent, ConcertID } from '../types/index.js';

/**
 * Append-only JSONL live event log for realtime concert observation.
 *
 * Events are written to `traces/<concertId>/live.jsonl` as they are emitted.
 * Cross-process consumers can tail the same file to observe progress without
 * polling SQLite.
 *
 * Offset semantics: `readSince` offsets and the returned `bytesRead` values
 * are JS string code-unit (UTF-16) offsets into the decoded file content, sorted
 * so they double as resume points for `watch`. The log lines are JSON, which
 * ASCII-encodes to the same value in bytes, so for the JSONL payloads this is
 * self-consistent; non-ASCII payloads would diverge from true byte offsets.
 */
export class LiveEventLog {
  private tracesDir: string;
  private streams = new Map<string, WriteStream>();
  private closed = new Set<string>();

  constructor(tracesDir: string) {
    this.tracesDir = tracesDir;
  }

  private getPath(concertId: ConcertID): string {
    return join(this.tracesDir, concertId, 'live.jsonl');
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

  /** Append a single event to the live log for the concert. */
  async append(concertId: ConcertID, event: ConcertEvent): Promise<void> {
    if (this.closed.has(concertId)) return;

    const stream = this.ensureStream(concertId);
    const line = JSON.stringify(event) + '\n';

    return new Promise((resolve, reject) => {
      const writable = stream.write(line, (err) => {
        if (err) reject(err);
        else resolve();
      });
      if (!writable) {
        stream.once('drain', resolve);
      }
    });
  }

  /** Read all events currently in the live log. */
  async read(concertId: ConcertID): Promise<ConcertEvent[]> {
    const filePath = this.getPath(concertId);
    if (!existsSync(filePath)) return [];

    const content = await readFile(filePath, 'utf-8');
    return this.parseLines(content);
  }

  /**
   * Read events from the live log starting at a UTF-16 code-unit offset (see
   * class docs). Returns the newly parsed events and the new code-unit offset.
   */
  async readSince(
    concertId: ConcertID,
    offset: number,
  ): Promise<{ events: ConcertEvent[]; bytesRead: number }> {
    const filePath = this.getPath(concertId);
    if (!existsSync(filePath)) {
      return { events: [], bytesRead: offset };
    }

    const content = await readFile(filePath, 'utf-8');
    const chunk = content.slice(offset);
    const events = this.parseLines(chunk);
    return { events, bytesRead: content.length };
  }

  /** Tail the live log, yielding batches of new events as they are appended. */
  async *watch(
    concertId: ConcertID,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<ConcertEvent[]> {
    const filePath = this.getPath(concertId);
    let offset = 0;

    const initial = await this.readSince(concertId, offset);
    offset = initial.bytesRead;
    if (initial.events.length > 0) {
      yield initial.events;
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
      if (result.events.length > 0) {
        yield result.events;
      }
    }
  }

  /** Close the write stream for a concert. */
  async close(concertId: ConcertID): Promise<void> {
    this.closed.add(concertId);
    const stream = this.streams.get(concertId);
    if (!stream) return;
    this.streams.delete(concertId);

    return new Promise((resolve) => {
      stream.end(() => resolve());
    });
  }

  /** Close all open write streams. */
  async dispose(): Promise<void> {
    const ids = Array.from(this.streams.keys());
    await Promise.all(ids.map((id) => this.close(id)));
  }

  private parseLines(content: string): ConcertEvent[] {
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          const parsed = JSON.parse(line) as ConcertEvent;
          if (parsed.timestamp && typeof parsed.timestamp === 'string') {
            parsed.timestamp = new Date(parsed.timestamp);
          }
          return parsed;
        } catch {
          return undefined;
        }
      })
      .filter((e): e is ConcertEvent => e !== undefined);
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
