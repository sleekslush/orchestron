---
name: orchestron-score-authoring
description: Create, edit, run, and manage Orchestron workflow scores (YAML) and concerts using the orchestron plugin tools. Use when the user asks to create, write, edit, modify, author, run, pause, cancel, or inspect an Orchestron score, workflow, or concert.
---

# Orchestron Score Authoring

Use this skill when the user wants to create, edit, run, or manage an Orchestron score or concert.

## Concepts

- **Score** — A YAML workflow definition. Describes movements, transitions, goals, and execution constraints.
- **Concert** — One running instance of a Score.
- **Movement** — A single step in a workflow. Each movement runs a prompt through a harness and is evaluated against a goal.
- **Transition** — Rules that decide which movement runs next based on the current movement's result.

## Complete Tool Reference

### Score authoring

- `orchestron_create_score(scoreId, yaml, persist?, saveLocation?)` — Create a new score from complete YAML. Set `persist: true` only when the user explicitly wants to save. Default keeps the score in memory only.
- `orchestron_edit_score(scoreId, yaml, persist?, saveLocation?)` — Replace an existing score with new YAML. Use `orchestron_get_score(scoreId)` first to read the current definition.
- `orchestron_get_score(scoreId)` — Read the full YAML and file path of a score. Returns empty YAML if the score is only in memory.
- `orchestron_list_scores()` — List all registered scores and their movements.

### Concert management

- `orchestron_start_concert(scoreId, context?)` — Start a new concert from a registered score. Returns a `concertId`. The concert runs in the background.
- `orchestron_get_concert_status(concertId)` — Get current status, movement history, resource usage, and current movement progress.
- `orchestron_list_concerts(status?, limit?, offset?)` — List concerts, optionally filtered by status (`pending`, `running`, `paused`, `completed`, `failed`, `cancelled`).
- `orchestron_pause_concert(concertId)` — Pause a running concert.
- `orchestron_cancel_concert(concertId)` — Cancel a running or paused concert.
- `orchestron_wait_for_concert(concertId)` — Block until the concert reaches a terminal state (`completed`, `failed`, or `cancelled`). Streams progress updates in real time. Prefer this over polling `orchestron_get_concert_status`.

## Workflow Guidelines

### Creating a new score
1. Ask the user for the goal if it is unclear.
2. Generate the complete score YAML with all required fields.
3. Call `orchestron_create_score(..., persist: false)` to validate and load it into memory.
4. Test the score by running `orchestron_start_concert(scoreId, context)` if the user asks.
5. Only set `persist: true` when the user explicitly asks to save the score.

### Editing an existing score
1. Call `orchestron_get_score(scoreId)` to read the current YAML.
2. Call `orchestron_edit_score(..., persist: false)` to preview and validate changes in memory.
3. Only set `persist: true` when the user explicitly asks to save the change.

### Running a concert
1. Call `orchestron_start_concert(scoreId, context)`.
2. If you need to wait for completion, call `orchestron_wait_for_concert(concertId)`.
3. If the user asks for status, call `orchestron_get_concert_status(concertId)`.

## Score YAML at a Glance

Required fields only. All others are optional.

```yaml
id: my-score                # must match scoreId param
name: "My Score"
version: "1.0.0"
startMovement: plan
movements:
  - id: plan
    name: "Create Plan"
    section: planning
    prompt: >
      Create a plan for: {{context.task}}
    goal:
      description: "Plan is detailed and actionable"
      strategy: llm_judge
    transitions:
      - to: review
        on: success
      - to: __fail__
        on: failure

  - id: review
    name: "Review Plan"
    section: review
    prompt: >
      Review this plan:
      {{context.previousOutputs.plan}}
    goal:
      description: "Plan is approved or needs revision"
      strategy: llm_judge
    transitions:
      - to: __end__
        on: success
      - to: plan
        on: failure
```

## Detailed Reference

See [references/yaml-reference.md](references/yaml-reference.md) for the complete field-by-field schema, prompt templating rules, output modes, transitions, subscores, and validation rules.

See [references/examples.md](references/examples.md) for detailed YAML examples including structured output, loop-back reviews, budget controls, retries, and subscore delegation.

See [references/patterns.md](references/patterns.md) for common workflow patterns, best practices, and example user requests.
