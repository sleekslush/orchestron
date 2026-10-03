# YAML Reference

Complete field-by-field reference for Orchestron score YAML.

## Minimal Required Fields

A valid score requires only:

**Top-level:** `id`, `name`, `version`, `startMovement`, `movements` (≥1)

**Per movement:** `id`, `name`, `section`, `goal`, `transitions`



## `program` Fields

| Field | Type | Description |
|-------|------|-------------|
| `maxSpendDollars` | number | Total budget for the concert in dollars. |
| `maxMovements` | number | Maximum number of movements that may execute across the entire concert. |
| `maxDurationMs` | number | Maximum total duration in milliseconds. |
| `maxNestingDepth` | number | Maximum depth of subscore nesting. Default is `5`. |
| `reuseSession` | boolean | Whether a re-visited movement reuses its prior harness session within a single concert (retries and loop-back transitions). `true` (default): the agent sees its own previous turns as context on re-visits. `false`: every execution runs in a brand-new session. Does **not** control disk recording — session transcripts are recorded in both modes. |
| `persistSession` | boolean | **Deprecated alias for `reuseSession`.** Read with a warning for backward compatibility; `reuseSession` wins when both are set. Rename to `reuseSession`; the alias is scheduled for removal in 0.2.0. |
| `perSection` | object | Per-section budget overrides keyed by `section` ID. Each entry can specify `maxSpendDollars` and `maxMovements`. The `*` wildcard key sets a base budget for all sections; explicit section keys merge on top of it, overriding individual fields. |

## Top-level Fields

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `id` | Yes | string | Unique score identifier. Lowercase letters, numbers, hyphens, underscores. Must match the `scoreId` parameter. |
| `name` | Yes | string | Human-readable name. |
| `version` | Yes | string | Semantic version (e.g., `1.0.0`). |
| `description` | No | string | What this workflow does. |
| `startMovement` | Yes | string | `id` of the first movement to run. |
| `program` | No | object | Execution constraints and global settings. All sub-fields are optional. Omit entirely to use defaults. |
| `evaluator` | No | object | Configures the evaluator that judges whether movement goals are achieved. All sub-fields are optional. |
| `models` | No | object | Score-level model defaults keyed by harness type (e.g., `pi`, `opencode`). Each entry is `{ provider: string, model: string, options?: object }`. Movements inherit these unless they specify their own `model`. See [Per-Harness Model Configuration](#per-harness-model-configuration). |
| `skills` | No | array | Score-level default skill paths loaded by every session (movements and the evaluator) that does not declare its own `skills`. See [Skills](#skills). |
| `movements` | Yes | array | Non-empty list of movements. |
| `metadata` | No | object | Arbitrary key-value data attached to the score. |

## `evaluator` Fields

| Field | Type | Description |
|-------|------|-------------|
| `harness` | string | Harness to use for evaluation (e.g., `pi`, `opencode`). |
| `model` | string | Model to use for evaluation (e.g., `pi-4-mini`). |
| `provider` | string | Provider to use for evaluation. |
| `prompt` | string | Optional custom prompt for the evaluator. |
| `skills` | array | Skill paths the evaluator session loads. Overrides the score-level `skills` default when present; `[]` specifies none. See [Skills](#skills). |

## Movement Fields

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `id` | Yes | string | Unique within the score. |
| `name` | Yes | string | Human-readable name. |
| `section` | Yes | string | Logical grouping (e.g., `planning`, `execution`, `review`, `delivery`). |
| `description` | No | string | Brief explanation of the movement's purpose. |
| `harness` | No | string | Harness to execute the movement. Defaults to the plugin's `defaultHarness` (usually `pi`). |
| `model` | No | string \| object | Model to use for this movement. **Flat string** (backward-compatible): used for all harnesses. **Per-harness map**: keyed by harness type (e.g., `pi`, `opencode`), each with `provider`, `model`, and optional `options` fields. The conductor selects the entry matching the movement's resolved harness. |
| `provider` | No | string | Provider name. Only used when `model` is a flat string. |
| `skills` | No | array | Skill paths this movement's session loads. Overrides the score-level `skills` default when present; `[]` specifies none. See [Skills](#skills). |
| `prompt` | No | string \| object | The prompt text. Supports templating. Optional when the movement does not need a prompt (e.g., subscores). |
| `output` | No | object | Output configuration. Defaults to `{ mode: "text" }`. Use `structured` with a JSON Schema when downstream movements need predictable, machine-readable output. |
| `goal` | Yes | object | `{ description: string, strategy: "llm_judge" }`. The evaluator uses this to judge success. |
| `transitions` | Yes | array | Array of `{ to, on }` objects defining what happens next. |
| `budget` | No | object | Movement-level budget overrides. `{ maxSpendDollars?, maxRetries?, timeoutMs? }`. |
| `retryOnFailure` | No | boolean | If `true`, retry the movement on a technical execution failure (harness/adapter error, timeout, crash) up to `budget.maxRetries` (default `2`). Does **not** retry goal rejections. |
| `retryOnRejection` | No | boolean | If `true`, retry the movement when the harness produced a valid output but the evaluator judged the goal was not achieved (a rejection) up to `budget.maxRetries` (default `2`). Independent of `retryOnFailure`. |
| `subscore` | No | object | Run another score as a child concert. `{ scoreId: string, contextMapping: Record<string, string> }`. |

## Per-Harness Model Configuration

Model names differ between harnesses (Pi and Opencode maintain independent model catalogs). To write a score that works across harnesses, specify models per-harness:

```yaml
movements:
  - id: analyze
    harness: pi
    model:
      pi: { provider: "anthropic", model: "claude-sonnet-4.5" }
      opencode: { provider: "opencode", model: "claude-opus-4-7" }
```

When the movement runs, the conductor selects the entry matching the resolved harness. If the movement uses `harness: pi`, it gets the `pi` entry. If run with `--harness opencode`, it gets the `opencode` entry.

**Flat strings still work** for single-harness scores:

```yaml
movements:
  - id: analyze
    harness: pi
    model: "claude-sonnet-4.5"
    provider: "anthropic"
```

### Score-Level Defaults

Set score-wide model defaults under a top-level `models` key. Movements inherit these unless they specify their own `model`:

```yaml
id: my-score
name: My Score
version: "1.0.0"
startMovement: analyze

models:
  pi: { provider: "anthropic", model: "claude-sonnet-4.5" }
  opencode: { provider: "opencode", model: "claude-opus-4-7" }

movements:
  - id: analyze
    harness: pi
    # inherits pi default from score-level models
  - id: review
    harness: opencode
    model:
      opencode: { provider: "opencode", model: "gpt-5.1-codex" }
    # overrides the opencode default for this movement only
```

### Resolution Precedence

1. Movement-level per-harness map (selected by harness type)
2. Movement-level flat string + `provider`
3. Score-level `models` map (selected by harness type)
4. Nothing — the harness adapter uses its own default

### Per-Harness Options (effort / thinking level)

Each per-harness model entry accepts an `options` map that is passed through to the harness adapter on every movement execution. It is structural pass-through — the score layer only checks that it is a plain object; each adapter decides which keys it honors:

| Key | Harness | Meaning |
|-----|---------|---------|
| `thinkingLevel` | `pi` | Pi thinking level. Valid values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Applied at session creation and re-applied with `setThinkingLevel` on reused sessions, so per-movement toggling works. |
| `variant` | `opencode` | Named model variant forwarded to the opencode server on each prompt. The variant must be preconfigured on the server (effort levels live in provider model `options`/`variants` in the server config — the SDK only forwards the variant name per prompt). |

```yaml
models:
  pi: { provider: "anthropic", model: "claude-opus-4-7", options: { thinkingLevel: "high" } }
  opencode: { provider: "anthropic", model: "claude-opus-4-7", options: { variant: "effort-high" } }
```

Unknown `options` keys are ignored by the adapters.

When both a movement-level entry and a score-level `models` entry apply, the movement-level entry wins entirely — its `options` replace the score-level ones, they are not merged (matching the model/provider precedence above).

### How to determine the right model per harness

- Run `orchestron models` to list available `(provider, model)` pairs for every registered harness, or `orchestron models <harness>` for a single harness. Add `--json` for machine-readable output. A harness whose listing fails (e.g. the opencode server is unreachable) is reported per-harness (`(error: ...)` in human output, an `error` field in JSON) without aborting the rest of the listing.
- **Pi**: `orchestron models pi` (equivalent to `pi --list-models`). Provider IDs are Pi built-in names (`openai`, `anthropic`, `google`, `deepseek`, etc.). Model IDs are Pi built-in model names (`gpt-5`, `claude-sonnet-4.5`, etc.).
- **Opencode**: `orchestron models opencode` (equivalent to `opencode models`). Provider and model IDs come from the Opencode server's registry.

## Skills

A score can declare which skills its sessions need, making the dependency explicit and reviewable instead of relying on whatever the harness happens to auto-discover from the operator's environment. `skills` is a list of **paths** (not names) to skill directories (containing `SKILL.md`) or skill files.

```yaml
skills:              # score-level default for every session
  - /opt/orchestron/skills/review

evaluator:
  skills:            # overrides the score default for the evaluator session only
    - /opt/orchestron/skills/judging

movements:
  - id: implement
    # ...
    skills:          # overrides the score default for this movement's session
      - /opt/orchestron/skills/coding
  - id: lint
    # ...
    skills: []       # explicitly load no declared skills (opts out of the score default)
```

**Resolution and precedence.** Each session-start site uses its own list when present, otherwise the score-level default:

- movement session: `movement.skills ?? score.skills`
- evaluator session: `evaluator.skills ?? score.skills`

This mirrors model resolution. `skills: []` at a movement or evaluator level means "specify none" and opts that session out of the score default; at the score level it means no sessions get declared skills.

**Path resolution.** Each entry must be an **absolute path** to a skill directory (containing `SKILL.md`) or a skill file. Relative paths are rejected — both by the score registry at load time and by the adapters at execution. A declared path that does not exist on disk fails the session immediately with an error naming the missing path. Paths relative to the score file or the concert `cwd` are not supported.

**Additive semantics.** Declared skills *augment* whatever the harness auto-discovers; they do not replace it. There is no "load only these" mode (Pi has `includeDefaults`/`noSkills` but Opencode does not, so restrictive scoping is not portable). Orchestron is a pure pass-through: each harness loads the paths through its own native skill loader and owns discovery, formatting, and diagnostics.

**Harness notes.**
- **Pi** loads declared paths through its native `DefaultResourceLoader` (`additionalSkillPaths`). Pi's own skill diagnostics are surfaced.
- **Opencode (embedded)** merges declared paths into the server's `config.skills.paths` at execute time. Skills are server-global, not per-session: concurrent sessions with different skill lists against one embedded server can affect each other. Prefer one skill list per embedded server where it matters.
  - **`skills: []` caveat:** because skills are server-global and the merge is additive, `skills: []` cannot *unload* paths that an earlier session or concert already applied to a shared embedded server — those paths stay registered for the server's lifetime. `[]` only means "declare no additional skills for this session", not "remove previously registered skills". Use a fresh embedded server (or avoid sharing one) when a clean skill set matters.
- **Opencode (connected server)** cannot inject skills — the external server owns its skill configuration. Declared skill paths are ignored with a warning in this mode.

Paths to a skill *file* and paths to a skill *directory* are both accepted. Opencode `skills.urls` and name-based skill references are not supported.

## Prompt Templating

Movement prompts can reference:
- `{{context.key}}` — values passed in the `context` parameter of `orchestron_start_concert`.
- `{{context.previousOutputs.<movementId>}}` — the full text output of a previous movement.
- `{{context.previousOutputs.<movementId>.<path>}}` — a specific field from a previous movement's structured output using dot-notation, e.g. `{{context.previousOutputs.plan.steps}}` or `{{context.previousOutputs.analyze.summary}}`.
  - Traverses into the parsed `structured` data if available.
  - Falls back to parsing the text `output` as JSON if no structured data was stored.
  - Unrecognized paths are left as-is in the rendered prompt for debugging.

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
- `structured` — The harness attempts to produce JSON matching the supplied JSON Schema. Use this when the next movement needs predictable, machine-readable output. Reference the whole result with `{{context.previousOutputs.<movementId>}}` or individual fields with dot-notation like `{{context.previousOutputs.<movementId>.<field>}}`.

## Transitions

Each transition is `{ to, on }`:

| `on` value | Meaning |
|------------|---------|
| `success` | Movement completed and goal was achieved. |
| `failure` | A technical execution failure (harness/adapter error, timeout, crash) — the prompt/model combination itself broke. |
| `rejection` | The harness produced a valid output but the evaluator judged the goal was not achieved. |
| `any` | Wildcard: matches `success`, `failure`, or `rejection`. |

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
- Optional `skills` (on the score, a movement, or the evaluator) must be an array of absolute, non-empty strings. An empty array is valid. A path that is relative or does not exist is rejected (the registry rejects relative paths; adapters reject both relative and missing paths).
