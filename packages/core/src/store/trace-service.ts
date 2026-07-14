import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type { HarnessAdapter } from '../types/adapter.js';
import type { ConcertID, MovementID } from '../types/concert.js';
import type { SessionTrace, SessionTraceEvent } from '../types/session-trace.js';
import type { ConcertStore } from './concert-store.js';

export class TraceService {
  private tracesDir: string;
  private store: ConcertStore;

  constructor(tracesDir: string, store: ConcertStore) {
    this.tracesDir = tracesDir;
    this.store = store;
  }

  async recordFromAdapter(
    adapter: HarnessAdapter,
    sessionId: string | undefined,
    concertId: ConcertID,
    movementId: MovementID,
    movementStatus: string,
  ): Promise<string | undefined> {
    if (!sessionId || !adapter.getSessionTraceEvents) return;

    try {
      const events = await adapter.getSessionTraceEvents(sessionId);
      if (events.length === 0) return;

      const traceId = nanoid(12);
      const dir = join(this.tracesDir, concertId);
      const filePath = `${traceId}.jsonl`;

      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, filePath),
        events.map((e) => JSON.stringify(e)).join('\n') + '\n',
      );

      const trace: SessionTrace = {
        id: traceId,
        concertId,
        movementId,
        sessionId,
        filePath: join(concertId, filePath),
        startedAt: events[0]?.timestamp ? new Date(events[0].timestamp) : new Date(),
        completedAt: new Date(),
        eventCount: events.length,
        status: movementStatus === 'completed' ? 'completed' : 'failed',
        format: 'orchestron-trace',
      };

      await this.store.createSessionTrace(trace);
      return traceId;
    } catch (err) {
      console.error('Failed to record session trace:', err);
      return undefined;
    }
  }

  async readTurns(trace: SessionTrace): Promise<SessionTraceEvent[]> {
    const filePath = join(this.tracesDir, trace.filePath);
    if (!existsSync(filePath)) return [];

    const content = await readFile(filePath, 'utf-8');
    return content
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as SessionTraceEvent;
        } catch {
          return undefined;
        }
      })
      .filter((e): e is SessionTraceEvent => e !== undefined);
  }
}
