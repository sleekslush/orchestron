import type { ConcertID, MovementID } from './concert.js';

export interface SessionTrace {
  id: string;
  concertId: ConcertID;
  movementId: MovementID;
  sessionId: string;
  /** Pool key (`<concertId>:<movementId>`) the record was recorded against. */
  sessionKey?: string;
  /** Attempt index this trace records (0 = first execute call). */
  attemptIndex?: number;
  /** Harness that recorded the session ('pi', 'opencode', ...). */
  harness?: string;
  /** Cumulative (retries share one session) or fresh (per-attempt sessions). */
  mode?: 'cumulative' | 'fresh';
  filePath: string;
  startedAt: Date;
  completedAt?: Date;
  eventCount: number;
  status: 'completed' | 'failed';
  format: 'pi-jsonl' | 'opencode-json' | 'orchestron-trace';
}
