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
  /**
   * Outcome that routes to this transition target.
   *
   * - `success`: the harness produced an output and the goal was achieved.
   * - `failure`: a technical execution failure (harness/adapter error, timeout,
   *   crash), regardless of goal evaluation.
   * - `rejection`: the harness produced a valid output but the evaluator judged
   *   the goal was not achieved.
   * - `any`: matches any of the above.
   */
  on: 'success' | 'failure' | 'rejection' | 'any';
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
  /** Harness-specific options, passed through to the adapter on execute
   *  (e.g. Pi `thinkingLevel`, Opencode `variant`). Structural validation
   *  only — each adapter decides which keys it honors. */
  options?: Record<string, unknown>;
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
  /**
   * Optional names of skills (markdown + frontmatter instruction blocks) to
   * load into this movement's session at creation time, before execution.
   * Skills augment — never replace — whatever skills the harness auto-loads.
   * Skill names resolve against the movement's skills directory (see
   * `resolveSkillsDir`). An unresolvable name is a hard failure.
   */
  skills?: string[];
  /**
   * Retry on a technical execution failure (harness/adapter error, timeout,
   * crash). Independent of `retryOnRejection`: a goal rejection is not a
   * technical failure and is only retried when `retryOnRejection` is set.
   */
  retryOnFailure?: boolean;
  /**
   * Retry when the harness produced a valid output but the evaluator judged
   * the movement's goal was not achieved (a rejection). Independent of
   * `retryOnFailure`, which covers technical failures.
   */
  retryOnRejection?: boolean;
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
  /**
   * Optional score-level default skills (names) that every movement inherits.
   *
   * Each movement's *effective* skills resolve as
   * \`movement.skills ?? score.skills\`: the default is inherited only when a
   * movement declares no \`skills\` at all. An explicit movement-level list
   * fully **replaces** the default (no merging). A movement that wants no
   * skills — even when a default exists — must set \`skills: []\` explicitly.
   * Skill names resolve against the movement's skills directory, exactly like
   * movement-level skills (see \`resolveSkillsDir\`).
   */
  skills?: string[];
  metadata?: Record<string, unknown>;
}

export interface EvaluatorConfig {
  harness?: string;
  model?: string;
  provider?: string;
  prompt?: string;
  /**
   * Behavior when the evaluator model returns output that cannot be parsed into
   * a valid GoalEvaluation. `failed` (default) degrades to an `achieved: false`
   * evaluation so the concert never crashes; `passed` opts into an `achieved:
   * true` fallback (never a safe default); `retry` throws a retryable error for
   * hosts that handle retryable evaluator failures.
   */
  defaultOnParseFailure?: 'failed' | 'passed' | 'retry';
  /**
   * Configurable structurizer / second-model pass (issue #133). When the judge
   * model is known-flaky (e.g. small flash-tier models) and its output cannot
   * be parsed into a valid GoalEvaluation, the raw judge output is routed to
   * this separate extraction model to be converted into strict JSON. This
   * decouples judgment (cheap model) from formatting (any model that reliably
   * emits JSON). Only invoked on the recovery path when the judge's output is
   * unparseable. If unset, unparseable output falls back to
   * `defaultOnParseFailure`.
   *
   * Note: the structurizer pass is biased toward `achieved: false` — its prompt
   * instructs the structurizer to set `achieved` to `false` when the judge text
   * is ambiguous, so an unclear judge routes the movement to its non-success
   * transition rather than passing it.
   */
  structurizer?: { model: string; provider?: string };
  /**
   * How many bounded self-repair attempts to make when the evaluator returns
   * non-empty output that cannot be parsed. Each attempt re-prompts the judge
   * to re-emit only schema JSON (extra model call on the failure path).
   * Default `1`; `0` disables the repair pass entirely.
   */
  maxRepairAttempts?: number;
}
