import type { ConcertID, MovementID } from './concert.js';

export interface SessionTrace {
  id: string;
  concertId: ConcertID;
  movementId: MovementID;
  sessionId: string;
  filePath: string;
  startedAt: Date;
  completedAt?: Date;
  eventCount: number;
  status: 'completed' | 'failed';
  format: 'pi-jsonl' | 'orchestron-trace';
}

export type SessionTraceEvent =
  | { type: 'prompt'; content: string; timestamp: string }
  | { type: 'tool_execution_start'; toolName: string; args?: Record<string, unknown>; timestamp: string }
  | { type: 'tool_execution_end'; toolName: string; isError: boolean; result?: unknown; error?: string; timestamp: string }
  | { type: 'text_delta'; delta: string; timestamp: string }
  | { type: 'response'; content: string; timestamp: string };
