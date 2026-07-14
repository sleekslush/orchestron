# YAML Reference

Complete field-by-field reference for Orchestron score YAML.

## Top-level Fields

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `id` | Yes | string | Unique score identifier. Lowercase letters, numbers, hyphens, underscores. Must match the `scoreId` parameter. |
| `name` | Yes | string | Human-readable name. |
| `version` | Yes | string | Semantic version (e.g., `1.0.0`). |
| `description` | No | string | What this workflow does. |
| `startMovement` | Yes | string | `id` of the first movement to run. |
| `program` | Yes | object | Execution constraints and global settings. Can be empty `{}`. |
| `evaluator` | No | object | Configures the evaluator that judges whether movement goals are achieved. |
| `movements` | Yes | array | Non-empty list of movements. |
| `metadata` | No | object | Arbitrary key-value data attached to the score. |

## `program` Fields

| Field | Type | Description |
|-------|------|-------------|
| `maxSpendDollars` | number | Total budget for the concert in dollars. |
| `maxMovements` | number | Maximum number of movements that may execute across the entire concert. |
| `maxDurationMs` | number | Maximum total duration in milliseconds. |
| `maxNestingDepth` | number | Maximum depth of subscore nesting. Default is `5`. |
| `persistSession` | boolean | Whether to persist harness sessions across movements. Default is `true` when the harness supports it. |
| `perSection` | object | Section-level budgets keyed by `section` id. Each value is `{ maxSpendDollars?, maxMovements? }`. |

## `evaluator` Fields

| Field | Type | Description |
|-------|------|-------------|
| `harness` | string | Harness to use for evaluation (e.g., `pi`, `opencode`). |
| `model` | string | Model to use for evaluation (e.g., `pi-4-mini`). |
| `prompt` | string | Optional custom prompt for the evaluator. |

## Movement Fields

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `id` | Yes | string | Unique within the score. |
| `name` | Yes | string | Human-readable name. |
| `section` | Yes | string | Logical grouping (e.g., `planning`, `execution`, `review`, `delivery`). |
| `description` | No | string | Brief explanation of the movement's purpose. |
| `harness` | No | string | Harness to execute the movement (e.g., `pi`, `opencode`). |
| `model` | No | string | Override the default model for this movement. |
| `provider` | No | string | Override the default provider for this movement. |
| `prompt` | No | string \| object | The prompt text. Supports templating. Can be a plain string or an object with `initial` and `subsequent` for loop-back movements. |
| `output` | No | object | Output configuration. `{ mode: "text" }` or `{ mode: "structured", schema: <json-schema> }`. |
| `goal` | Yes | object | `{ description: string, strategy: "llm_judge" }`. The evaluator uses this to judge success. |
| `transitions` | Yes | array | Array of `{ to, on }` objects defining what happens next. |
| `budget` | No | object | Movement-level budget overrides. `{ maxSpendDollars?, maxRetries?, timeoutMs? }`. |
| `retryOnFailure` | No | boolean | If `true`, retry the movement on failure up to `budget.maxRetries` (default `2`). |
| `subscore` | No | object | Run another score as a child concert. `{ scoreId: string, contextMapping: Record<string, string> }`. |

## Prompt Templating

Movement prompts can reference:
- `{{context.key}}` — values passed in the `context` parameter of `orchestron_start_concert`.
- `{{context.previousOutputs.<movementId>}}` — the full text output of a previous movement.
- `{{context.previousOutputs.<movementId>.<field>}}` — when the previous movement used `output.mode: structured`, you can reference individual fields.

## Prompt Variants for Loop-back Movements

When a movement can be revisited (e.g., a review step that sends you back to planning on failure), use the object form:

```yaml
prompt:
  initial: >
    Create a plan for: {{context.task}}
  subsequent: >
    Revise the plan based on this feedback:
    {{context.previousOutputs.review}}
```

The `initial` prompt is used on the first visit. The `subsequent` prompt is used on every revisit.

## Output Modes

- `text` (default) — Free-form text output.
- `structured` — The harness attempts to produce JSON matching the supplied JSON Schema. Use this when the next movement needs to reference specific fields cleanly.

## Transitions

Each transition is `{ to, on }`:

| `on` value | Meaning |
|------------|---------|
| `success` | Movement completed and goal was achieved. |
| `failure` | Movement failed or goal was not achieved. |
| `skip` | Reserved for future use. |

| `to` value | Meaning |
|------------|---------|
| `<movementId>` | Run that movement next. |
| `__end__` | Finish the concert successfully. |
| `__fail__` | Finish the concert as failed. |

## Subscores

A movement can delegate to another score by specifying `subscore`:

```yaml
movements:
  - id: audit
    name: "Security Audit"
    section: review
    subscore:
      scoreId: security-audit
      contextMapping:
        codebase: "shared.codebase"
        rules: "shared.securityRules"
    goal:
      description: "Security audit completed"
      strategy: llm_judge
    transitions:
      - to: __end__
        on: success
      - to: __fail__
        on: failure
```

The `contextMapping` maps keys in the child score's context to dot-paths in the parent concert's context (which always starts at `shared`). The child concert's result determines the parent movement's success or failure.

## Validation Rules

- The score must have at least one movement.
- `startMovement` must exist in `movements`.
- Every non-start movement must have at least one incoming transition.
- All transition targets must be valid movement ids, `__end__`, or `__fail__`.
- The movement graph must not have cycles that cannot reach a terminal state (`__end__` or `__fail__`).
- `maxNestingDepth` controls how many levels of subscores are allowed.
