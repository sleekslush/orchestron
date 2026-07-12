export type ScoreID = string;
export type MovementID = string;
export type SectionID = string;

export interface Program {
  maxSpend?: number;
  maxTokens?: number;
  maxMovements?: number;
  maxDurationMs?: number;
  maxNestingDepth?: number;
  perSection?: Record<SectionID, SectionBudget>;
}

export interface SectionBudget {
  maxSpend?: number;
  maxTokens?: number;
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
  prompt?: string;
  output?: OutputConfig;
  goal: Goal;
  transitions: Transition[];
  budget?: MovementBudget;
  retryOnFailure?: boolean;
}

export interface MovementBudget {
  maxSpend?: number;
  maxTokens?: number;
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
