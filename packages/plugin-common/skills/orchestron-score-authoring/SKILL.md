---
name: orchestron-score-authoring
description: Create, edit, run, and manage Orchestron workflow scores (YAML) and concerts using the orchestron plugin tools. Use when the user asks to create, write, edit, modify, author, run, pause, cancel, or inspect an Orchestron score, workflow, or concert.
---

# Orchestron Score Authoring

Use this skill when the user wants to create, edit, run, or manage an Orchestron score or concert.

## Concepts

- **Score** — A YAML workflow definition. Describes movements, transitions, goals, and execution constraints.
- **Concert** — One running instance of a Score.
- **Movement** — A single step in a workflow. A **harness movement** (`type: harness`, the default) runs a prompt through a harness session and is evaluated against a goal. A **run movement** (`type: run`) executes a bounded argv command and maps its exit code to an outcome — no LLM session, no evaluator.
- **Transition** — Rules that decide which movement runs next based on the current movement's result.

## Complete Tool Reference

### Score authoring

- `orchestron_create_score(scoreId, yaml, persist?, saveLocation?)` — Create a new score from complete YAML. Set `persist: true` only when the user explicitly wants to save. Default keeps the score in memory only.
- `orchestron_edit_score(scoreId, yaml, persist?, saveLocation?)` — Replace an existing score with new YAML. Use `orchestron_get_score(scoreId)` first to read the current definition.
- `orchestron_get_score(scoreId)` — Read the full YAML and file path of a score. Returns empty YAML if the score is only in memory.
- `orchestron_list_scores()` — List all registered scores and their movements.

### Concert management

- `orchestron_start_concert(scoreId, context?)` — Create and kick off a new concert from a registered score. Returns immediately with the `concertId` and post-kickoff status; the concert runs in the background. This tool does not stream or block.
- `orchestron_get_concert_status(concertId)` — Get current status, movement history, resource usage, and current movement progress.
- `orchestron_list_concerts(status?, limit?, offset?)` — List concerts, optionally filtered by status (`pending`, `running`, `paused`, `completed`, `failed`, `cancelled`).
- `orchestron_pause_concert(concertId)` — Pause a running concert.
- `orchestron_cancel_concert(concertId)` — Cancel a running or paused concert.
- `orchestron_wait_for_concert(concertId)` — Block until the concert reaches a terminal state (`completed`, `failed`, or `cancelled`). The sole streaming/observation tool; it attaches to any concert id (created this turn, by another process, or by the CLI) and streams progress updates in real time. Prefer this over polling `orchestron_get_concert_status`.

## Workflow Guidelines

### Model selection

Model names differ between harnesses. When authoring scores:

- **Check the harness first.** A movement's `harness` field determines which model namespace applies. Pi uses Pi built-in model IDs; Opencode uses Opencode server model IDs.
- **Discover models with `orchestron models`.** Run `orchestron models` (or `orchestron models <harness>` for a single harness) to list valid `(provider, model)` pairs instead of guessing.
- **Use per-harness model config for cross-harness scores.** When a score may run on multiple harnesses, use the per-harness map form:
  ```yaml
  model:
    pi: { provider: "anthropic", model: "claude-sonnet-4.5" }
    opencode: { provider: "opencode", model: "claude-opus-4-7" }
  ```
- **Control effort with per-harness `options`.** Add `options` to a per-harness model entry to control effort/thinking: `options: { thinkingLevel: "high" }` for Pi, `options: { variant: "effort-high" }` for Opencode (variant must be preconfigured on the opencode server). See the yaml reference for valid values.
- **Use flat strings for single-harness scores.** When the harness is fixed, a flat string is simpler:
  ```yaml
  harness: pi
  model: "claude-sonnet-4.5"
  provider: "anthropic"
  ```
- **Omit model/provider to use defaults.** If the user doesn't specify a model, leave it out — the harness adapter will use its configured default.
- **Score-level `models` for shared defaults.** Use the top-level `models` key when all movements share the same model configuration.

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
1. Call `orchestron_start_concert(scoreId, context)` — this creates the concert and returns immediately (it does not wait).
2. Optionally observe it by calling `orchestron_wait_for_concert(concertId)`, which blocks and streams progress until the concert finishes.
3. If the user asks for status instead of blocking, call `orchestron_get_concert_status(concertId)`.

## Score YAML at a Glance

A harness movement requires `goal`; a run movement requires `command` and rejects
harness-only fields. All other fields are optional.

```yaml
id: my-score                # must match scoreId param
name: "My Score"
version: "1.0.0"
startMovement: plan
models:                     # optional score-level defaults
  pi: { provider: "anthropic", model: "claude-sonnet-4.5" }
movements:
  - id: plan
    name: "Create Plan"
    section: planning
    harness: pi
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
    harness: pi
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

Deterministic step:

```yaml
  - id: claim
    name: "Claim Issue"
    section: setup
    type: run
    command: ["bash", "-lc", "labels.sh claim {{context.issue}}"]
    outcomes: { 0: success, 3: rejection, default: failure }
    transitions:
      - to: implement
        on: success
      - to: __end__
        on: rejection
      - to: fail_cleanup
        on: failure
```

> Run steps execute commands with the host user's privileges. Score files are
executable code; only run scores you trust.

## Detailed Reference

See [references/yaml-reference.md](references/yaml-reference.md) for the complete field-by-field schema, prompt templating rules, output modes, transitions, subscores, and validation rules.

See [references/examples.md](references/examples.md) for detailed YAML examples including structured output, loop-back reviews, budget controls, retries, and subscore delegation.

See [references/patterns.md](references/patterns.md) for common workflow patterns, best practices, and example user requests.
