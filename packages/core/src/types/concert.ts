import type { ScoreID, MovementID } from './score.js';
import type { SpendSource } from '../cost/types.js';
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
  | 'rejected'
  | 'skipped';

export interface ResourceUsage {
  spend?: number;
  tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  /**
   * Whether `spend` is harness-measured (`'measured'`) or derived from a
   * pricing source (`'estimated'`). Absent when spend is unknown.
   */
  spendSource?: SpendSource;
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
  /** Hosting process ID (written by the conductor on start / recover). */
  processId?: number;
  /** Hostname of the machine hosting the conductor process. */
  hostname?: string;
  /**
   * Last time the hosting process reported itself alive. Written on a fixed
   * interval by the conductor; readers derive staleness from it to detect
   * processes that died without finalizing the concert.
   */
  lastHeartbeatAt?: Date;
  /** Isolated git worktree metadata, persisted so it survives restarts and is discoverable. */
  worktree?: ConcertWorktree;
}

/**
 * Persisted reference to the isolated git worktree a concert runs in (when
 * started with `worktree`). Stored on the concert record so it can be
 * re-hydrated after a restart and listed/cleaned by the CLI.
 */
export interface ConcertWorktree {
  path: string;
  branch: string;
  /** Absolute base directory the worktree was created from. */
  baseDir: string;
  /** When true the worktree is kept on disk after the concert finishes. */
  keep?: boolean;
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
