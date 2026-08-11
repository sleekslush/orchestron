import { nanoid } from 'nanoid';
import type { ConcertID, MovementID } from '../types/concert.js';
import type { SessionTrace } from '../types/session-trace.js';
import type { ConcertStore } from './concert-store.js';

export class TraceService {
  private tracesDir: string;
  private store: ConcertStore;

  constructor(tracesDir: string, store: ConcertStore) {
    this.tracesDir = tracesDir;
    this.store = store;
  }

  /**
   * Record a per-attempt session trace row. Always recorded, regardless of
   * whether the attempt's session was persistent (cumulative) or fresh; the
   * on-disk attempt dir + metadata.json remain the authoritative index.
   */
  async recordAttempt(input: {
    concertId: ConcertID;
    movementId: MovementID;
    sessionKey?: string;
    sessionId?: string;
    attemptIndex: number;
    harness: string;
    mode: 'cumulative' | 'fresh';
    /**
     * Directory path of this attempt's recording, relative to tracesDir (e.g.
     * `movements/m/attempt-0`). It is a DIRECTORY — the authoritative index is
     * the on-disk attempt dir + metadata.json, not a single trace file.
     */
    filePath: string;
    status: 'completed' | 'failed' | 'rejected';
    eventCount: number;
    startedAt: Date;
    endedAt: Date;
  }): Promise<string | undefined> {
    try {
      const traceId = nanoid(12);
      const format: SessionTrace['format'] =
        input.harness === 'pi'
          ? 'pi-jsonl'
          : input.harness === 'opencode'
            ? 'opencode-json'
            : 'orchestron-trace';
      const trace: SessionTrace = {
        id: traceId,
        concertId: input.concertId,
        movementId: input.movementId,
        sessionId: input.sessionId ?? input.sessionKey ?? '',
        sessionKey: input.sessionKey,
        attemptIndex: input.attemptIndex,
        harness: input.harness,
        mode: input.mode,
        filePath: input.filePath,
        startedAt: input.startedAt,
        completedAt: input.endedAt,
        eventCount: input.eventCount,
        status: input.status === 'failed' ? 'failed' : 'completed',
        format,
      };
      await this.store.createSessionTrace(trace);
      return traceId;
    } catch (err) {
      console.error('Failed to record session attempt trace:', err);
      return undefined;
    }
  }
}
