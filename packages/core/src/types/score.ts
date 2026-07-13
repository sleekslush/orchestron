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
  on: 'success' | 'failure' | 'skip';
}

export interface OutputConfig {
  mode: 'text' | 'structured';
  schema?: Record<string, unknown>;
}

export type MovementPrompt = string | { initial: string; subsequent: string };

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
  model?: string;
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
  program: Program;
  metadata?: Record<string, unknown>;
}

export interface EvaluatorConfig {
  harness?: string;
  model?: string;
  prompt?: string;
}
