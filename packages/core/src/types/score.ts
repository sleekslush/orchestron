export type ScoreID = string;
export type MovementID = string;
export type SectionID = string;

export interface Program {
  maxSpendDollars?: number;
  maxMovements?: number;
  maxDurationMs?: number;
  maxNestingDepth?: number;
  persistSession?: boolean;
  perSection?: Record<SectionID, SectionBudget>;
}

export interface SectionBudget {
  maxSpendDollars?: number;
  maxMovements?: number;
}

export interface Goal {
  description: string;
  strategy: 'llm_judge';
}

export interface Transition {
  to: MovementID | '__end__' | '__fail__';
  on: 'success' | 'failure' | 'any';
}

export interface OutputConfig {
  mode: 'text' | 'structured';
  schema?: Record<string, unknown>;
}

export type MovementPrompt = string | { initial: string; subsequent: string };

/**
 * Per-harness model configuration used when a movement or score needs
 * different model/provider values for different harnesses.
 */
export interface HarnessModelConfig {
  provider: string;
  model: string;
}

export interface Movement {
  id: MovementID;
  name: string;
  section: SectionID;
  description?: string;
  harness?: string;
  subscore?: {
    scoreId: ScoreID;
    contextMapping: Record<string, string>;
  };
  prompt?: MovementPrompt;
  output?: OutputConfig;
  goal: Goal;
  transitions: Transition[];
  budget?: MovementBudget;
  retryOnFailure?: boolean;
  /**
   * Model to use for this movement.
   *
   * - Flat string: backward-compatible, used for all harnesses.
   * - Per-harness map: keyed by harness type (e.g. \`pi\`, \`opencode\`).
   *   The conductor selects the entry matching the movement's resolved harness.
   */
  model?: string | Record<string, HarnessModelConfig>;
  /** Provider name. Only used when \`model\` is a flat string. */
  provider?: string;
}

export interface MovementBudget {
  maxSpendDollars?: number;
  maxRetries?: number;
  timeoutMs?: number;
}

export interface Score {
  id: ScoreID;
  name: string;
  description?: string;
  version: string;
  evaluator?: EvaluatorConfig;
  movements: Movement[];
  startMovement: MovementID;
  program?: Program;
  /**
   * Optional score-level model defaults, keyed by harness type.
   * Movements inherit these unless they specify their own \`model\`.
   */
  models?: Record<string, HarnessModelConfig>;
  metadata?: Record<string, unknown>;
}

export interface EvaluatorConfig {
  harness?: string;
  model?: string;
  provider?: string;
  prompt?: string;
}
