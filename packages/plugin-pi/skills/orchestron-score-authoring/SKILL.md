---
name: orchestron-score-authoring
description: Create and edit Orchestron workflow scores (YAML) using the orchestron plugin tools. Use when the user asks to create, write, edit, modify, or author an Orchestron score or workflow.
---

# Orchestron Score Authoring

Use this skill when the user wants to create or edit an Orchestron score.

## What is a Score?

A **Score** is a YAML workflow definition. A **Concert** is one running instance of a Score.

## Workflow

1. Ask the user for the goal if it is unclear.
2. Generate the complete score YAML.
3. Call `orchestron_create_score(scoreId, yaml, persist: false)` to validate and load it into memory.
4. Test the score by running `orchestron_start_concert(scoreId, context)` if the user asks.
5. Only call `orchestron_create_score(..., persist: true)` or `orchestron_edit_score(..., persist: true)` when the user explicitly asks to save the score.

## Tool usage

- `orchestron_create_score(scoreId, yaml, persist?, saveLocation?)` — create a new score. Set `persist: true` only when the user explicitly wants to save.
- `orchestron_edit_score(scoreId, yaml, persist?, saveLocation?)` — edit an existing score. Use `orchestron_get_score(scoreId)` first to read the current YAML.
- `orchestron_get_score(scoreId)` — read the current YAML of a score.
- `orchestron_validate_score(scoreId)` — validate a score without changing anything.
- `orchestron_list_scores()` — see registered scores and whether each one is persisted to disk.

## Score YAML structure

```yaml
id: my-score
name: "My Score"
description: |
  What this workflow does.
version: "1.0.0"

# Optional: configure the evaluator that judges goal achievement.
evaluator:
  harness: pi          # pi, opencode, etc.
  model: pi-4-mini

program:
  maxSpend: 5000       # micro-dollars
  maxTokens: 500000
  maxMovements: 20
  maxDurationMs: 600000
  persistSession: true

startMovement: analyze

movements:
  - id: analyze
    name: "Analyze"
    section: planning
    harness: pi
    prompt: >
      Analyze the following topic:
      {{context.topic}}
    output:
      mode: structured
      schema:
        type: object
        properties:
          summary: { type: string }
        required: [summary]
    goal:
      description: "Analysis is clear and useful"
      strategy: llm_judge
    transitions:
      - to: summarize
        on: success
      - to: __fail__
        on: failure

  - id: summarize
    name: "Summarize"
    section: delivery
    harness: pi
    prompt: >
      Summarize this analysis:
      {{context.previousOutputs.analyze}}
    goal:
      description: "Summary is concise"
      strategy: llm_judge
    transitions:
      - to: __end__
        on: success
```

## Required fields

Top-level:
- `id` — unique score id (lowercase, numbers, hyphens, underscores). Must match the `scoreId` parameter.
- `name` — human-readable name.
- `version` — semantic version string.
- `startMovement` — id of the first movement.
- `program` — constraints object (can be empty `{}`).
- `movements` — non-empty array of movements.

Each movement:
- `id` — unique within the score.
- `name` — human-readable name.
- `section` — logical grouping (e.g., `planning`, `execution`, `review`, `delivery`).
- `harness` — harness to use (e.g., `pi`, `opencode`).
- `prompt` — the prompt text. May use `{{context.key}}` and `{{context.previousOutputs.movementId}}`.
- `goal` — `{ description: string, strategy: "llm_judge" }`.
- `transitions` — array of `{ to, on }` objects.

## Transitions

`on` values:
- `success` — movement succeeded and goal was achieved.
- `failure` — movement failed or goal was not achieved.
- `skip` — reserved for future use.

`to` values:
- A movement id.
- `__end__` — finish the concert successfully.
- `__fail__` — finish the concert as failed.

## Common patterns

**Linear flow:**

```yaml
movements:
  - id: a
    ...
    transitions:
      - to: b
        on: success
      - to: __fail__
        on: failure
  - id: b
    ...
    transitions:
      - to: __end__
        on: success
```

**Loop-back review:**

```yaml
movements:
  - id: plan
    ...
    transitions:
      - to: review
        on: success
  - id: review
    ...
    transitions:
      - to: __end__
        on: success
      - to: plan
        on: failure
```

## Validation rules

- The score must have at least one movement.
- `startMovement` must exist in `movements`.
- Every non-start movement must have an incoming transition.
- All transition targets must be valid movement ids, `__end__`, or `__fail__`.
- The movement graph must not have cycles that cannot reach a terminal (`__end__` or `__fail__`).

## Best practices

- Keep prompts focused and specific.
- Use `output.mode: structured` with a JSON schema when the next movement needs to reference the output cleanly.
- Reference previous outputs with `{{context.previousOutputs.<movementId>}}`.
- Always provide failure transitions so the concert can end cleanly on error.
- Set realistic budgets in `program` and per-movement `budget`.

## Example prompts

- "Create a score that takes a topic, analyzes it, and summarizes it."
- "Add a review step to the simple-plan-review score."
- "Edit the jira-to-mr score to include a security review movement."
