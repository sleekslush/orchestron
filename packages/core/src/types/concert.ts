import type { ScoreID, MovementID } from './score.js';
export type { MovementID };

export type ConcertID = string;

export type ConcertStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type MovementStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'skipped';

export interface ResourceUsage {
  spend?: number;
  tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ConcertContext {
  shared: Record<string, unknown>;
}

export interface Concert {
  id: ConcertID;
  scoreId: ScoreID;
  status: ConcertStatus;
  startedAt: Date;
  completedAt?: Date;
  currentMovement: MovementID | null;
  history: MovementRecord[];
  context: ConcertContext;
  usage: ResourceUsage;
  triggeredBy: 'cli' | 'api' | 'harness' | 'agent';
  parentConcertId?: ConcertID;
  childConcertIds: ConcertID[];
  nestingDepth?: number;
  explicitHarness?: string;
}

export interface MovementRecord {
  movementId: MovementID;
  movementName: string;
  status: MovementStatus;
  output: string;
  structured?: Record<string, unknown>;
  summary: string;
  goalEvaluation: GoalEvaluation;
  usage: ResourceUsage;
  durationMs: number;
  startedAt: Date;
  completedAt?: Date;
  error?: SerializedError;
  traceId?: string;
  model?: string;
  provider?: string;
}

export interface GoalEvaluation {
  achieved: boolean;
  confidence: number;
  summary: string;
  evidence?: string;
}

export interface SerializedError {
  code: string;
  message: string;
  retryable: boolean;
  concertId?: ConcertID;
  movementId?: MovementID;
}

export interface ConcertFilter {
  status?: ConcertStatus;
  scoreId?: ScoreID;
  limit?: number;
  offset?: number;
}
