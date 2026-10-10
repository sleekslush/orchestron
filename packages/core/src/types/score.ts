export type ScoreID = string;
export type MovementID = string;
export type SectionID = string;

export interface Program {
  maxSpendDollars?: number;
  maxMovements?: number;
  maxDurationMs?: number;
  maxNestingDepth?: number;
  /**
   * Whether a re-visited movement reuses its prior harness session within a
   * single concert (a retry, or a transition that loops back). `true`
   * (default): the agent sees its own previous turns as context on re-visits.
   * `false`: every execution of the movement runs in a brand-new session with
   * no memory of prior turns.
   *
   * Reuse is scoped to one concert run and held in memory only; it is not
   * shared across concerts, and it does not control disk recording. Session
   * transcripts are recorded to disk in both modes: fresh movements keep a
   * per-attempt snapshot, cumulative movements additionally aggregate a final
   * copy.
   */
  reuseSession?: boolean;
  /**
   * @deprecated Legacy alias for `reuseSession`. Still read (with a deprecation
   * warning) for backward compatibility with existing scores; new scores
   * should use `reuseSession`. When both are set, `reuseSession` wins. Scheduled
   * for removal in 0.2.0 so the misleading name does not become permanent.
   */
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

/**
 * A movement is either a stochastic harness session (`harness`, the default)
 * or a deterministic argv execution (`run`).
 */
export type MovementKind = 'harness' | 'run';

/**
 * Outcome an exit code maps to for a `run` movement. It reuses the existing
 * transition taxonomy: `success`, `failure`, and `rejection`. For a run
 * movement `rejection` is a control-flow outcome (the step's post-condition was
 * not met and an alternate deterministic path applies), not a judged goal
 * rejection.
 */
export type RunOutcome = 'success' | 'failure' | 'rejection';

/**
 * Exit-code → outcome map for a `run` movement. Keys are numeric exit codes
 * (as strings when parsed from YAML, numbers in object literals) or the literal
 * `default`. When omitted, `0 → success` and every other code → `failure`.
 */
export type MovementOutcomes = Record<string, RunOutcome>;

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
  /**
   * Movement kind. `harness` (default, and used when omitted) runs a prompt
   * through a harness session and is evaluated against a goal. `run` executes
   * a bounded argv command and maps its exit code to an outcome.
   */
  type?: MovementKind;
  harness?: string;
  subscore?: {
    scoreId: ScoreID;
    contextMapping: Record<string, string>;
  };
  prompt?: MovementPrompt;
  output?: OutputConfig;
  /**
   * Goal for a `harness` movement. Required for harness movements; rejected on
   * `run` movements (the exit-code outcomes map is the evaluation).
   */
  goal?: Goal;
  /**
   * Argv command for a `run` movement, executed with `execve` semantics:
   * per-element templating, no word splitting, no globbing, no shell. A leading
   * `~/` in an element expands to the home directory.
   */
  command?: string[];
  /**
   * Exit-code → outcome map for a `run` movement. Keys are numeric exit codes
   * or `default`. Omitted means `0 → success`, otherwise `failure`.
   */
  outcomes?: MovementOutcomes;
  /** Working directory override for a `run` movement. Templated; leading `~/` expands. */
  cwd?: string;
  /**
   * Environment overrides for a `run` movement, layered over the Conductor
   * process environment. Values are templated but receive no `~/` expansion.
   */
  env?: Record<string, string>;
  transitions: Transition[];
  budget?: MovementBudget;
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
  /**
   * Absolute skill paths this movement's session needs. When omitted, the
   * score-level \`skills\` default applies. An empty array explicitly specifies
   * no skills for this movement. Relative paths are rejected.
   */
  skills?: string[];
  /**
   * Per-movement override of the score-level `reuseSession` setting.
   *
   * - Omitted: inherit the score-resolved value.
   * - `true`: this movement's re-visits reuse its prior session
   *   (`cumulative`), regardless of the score default.
   * - `false`: every execution of this movement starts a brand-new session
   *   (`fresh`), regardless of the score default.
   *
   * The override applies to this movement and its re-visits only; sibling and
   * other movements are unaffected. Like the score-level setting, reuse is
   * scoped to one concert and held in memory only, and it does not control
   * disk recording. The deprecated `persistSession` alias does **not** apply
   * at the movement level.
   *
   * Subscore movements delegate to a child concert and create no parent
   * session, so this field is a no-op for them.
   */
  reuseSession?: boolean;
}

export interface MovementBudget {
  maxSpendDollars?: number;
  maxRetries?: number;
  timeoutMs?: number;
}

export interface RequiredContextEntry {
  key: string;
  description: string;
}

/**
 * A single required-context input, expressed either as a flat dot-path key
 * (no description) or an object carrying the key plus a human-readable
 * description. Object entries power richer `orchestron start <id> --help`
 * output; both forms behave identically for enforcement.
 */
export type RequiredContext = Array<string | RequiredContextEntry>;

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
   * Dot-path keys (e.g. `ticket`, `project.name`) that must resolve to a
   * non-null value in the shared context when a concert starts. A concert
   * whose required key is missing fails immediately, before any movement
   * executes. Each entry is either a flat key (no description) or a
   * `{ key, description }` object whose description is shown in start help.
   */
  requiredContext?: RequiredContext;
  /**
   * Optional score-level model defaults, keyed by harness type.
   * Movements inherit these unless they specify their own \`model\`.
   */
  models?: Record<string, HarnessModelConfig>;
  /**
   * Absolute skill paths every session in this score loads by default. Movement
   * and evaluator sessions use their own \`skills\` list when present, otherwise
   * this shared default. An empty array specifies no skills. Loading is
   * additive — the harness still auto-discovers its own skills. Relative paths
   * are rejected.
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
   * How many bounded self-repair attempts to make when the evaluator returns
   * non-empty output that cannot be parsed. Each attempt re-prompts the judge
   * to re-emit only schema JSON (extra model call on the failure path).
   * Default `1`; `0` disables the repair pass entirely.
   */
  maxRepairAttempts?: number;
  /**
   * Absolute skill paths the evaluator session needs. When omitted, the
   * score-level \`skills\` default applies. An empty array explicitly specifies
   * no skills for the evaluator session. Relative paths are rejected.
   */
  skills?: string[];
}
