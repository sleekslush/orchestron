# Patterns and Best Practices

## Common Patterns

### Linear Flow

```yaml
movements:
  - id: a
    name: "Step A"
    section: execution
    harness: pi
    prompt: "Do step A."
    goal:
      description: "Step A is complete"
      strategy: llm_judge
    transitions:
      - to: b
        on: success
      - to: __fail__
        on: failure

  - id: b
    name: "Step B"
    section: delivery
    harness: pi
    prompt: "Do step B."
    goal:
      description: "Step B is complete"
      strategy: llm_judge
    transitions:
      - to: __end__
        on: success
```

### Loop-back Review

```yaml
movements:
  - id: plan
    name: "Create Plan"
    section: planning
    harness: pi
    prompt:
      initial: "Create a plan for: {{context.task}}"
      subsequent: "Revise the plan based on: {{context.previousOutputs.review}}"
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
    prompt: "Review this plan: {{context.previousOutputs.plan}}"
    goal:
      description: "Plan is approved or needs revision"
      strategy: llm_judge
    transitions:
      - to: __end__
        on: success
      - to: plan
        on: failure
```

### Gate with Retry

Use `retryOnFailure` and `budget.maxRetries` for movements that may intermittently fail:

```yaml
movements:
  - id: deploy
    name: "Deploy"
    section: execution
    harness: pi
    prompt: "Deploy the application."
    retryOnFailure: true
    budget:
      maxRetries: 3
      timeoutMs: 180000
    goal:
      description: "Deployment succeeded"
      strategy: llm_judge
    transitions:
      - to: verify
        on: success
      - to: __fail__
        on: failure
```

## Best Practices

- Keep prompts focused and specific.
- Use `output.mode: structured` with a JSON schema when downstream movements need predictable, machine-readable output. Reference the whole result with `{{context.previousOutputs.<movementId>}}` or individual fields with dot-notation like `{{context.previousOutputs.<movementId>.<field>}}`.
- Use `{{context.previousOutputs.<movementId>}}` to pass data between movements.
- Always provide both `success` and `failure` transitions so concerts end cleanly on error.
- Set realistic budgets in `program` and per-movement `budget` to prevent runaway costs.
- Use `retryOnFailure: true` for movements that are inherently flaky, with a sensible `budget.maxRetries`.
- Use the `initial`/`subsequent` prompt form for any movement that may be revisited in a loop.
- When editing a score, always call `orchestron_get_score` first to avoid losing existing fields.
- `orchestron_start_concert` only creates and kicks off a concert; it returns immediately. Use `orchestron_wait_for_concert` instead of polling `orchestron_get_concert_status` when you need to block and stream progress until a concert finishes.

## Common User Prompts

- "Create a score that takes a topic, analyzes it, and summarizes it."
- "Add a review step to the simple-plan-review score."
- "Edit the jira-to-mr score to include a security review movement."
- "Run the code-review-and-fix score on the current working directory."
- "Pause the running concert with id abc-123."
- "List all my scores."
- "What is the status of concert xyz-456?"

### Deterministic Step (run movement)

Use `type: run` for mechanical, verifiable work whose exit codes fully encode the
outcome — claiming a lock, creating a branch, running a linter, notifying a
webhook. Do not wrap it in a harness movement and judge it from prose.

```yaml
  - id: claim
    name: "Claim Issue"
    section: setup
    type: run
    command: ["labels.sh", "claim", "{{context.issue}}"]
    outcomes: { 0: success, 3: rejection, default: failure }
    transitions:
      - to: implement
        on: success
      - to: __end__
        on: rejection      # another concert owns the lock — back off
      - to: fail_cleanup
        on: failure
```

Guidelines:

- Keep commands argv-only. If you need a pipe or glob, write `["bash", "-lc", "..."]` explicitly.
- Map every known exit code in `outcomes`; use `default` for the unexpected case.
- Read `rejection` as control-flow ("post-condition not met, take another deterministic path"), not as a judged goal rejection.
- Use `output: { mode: structured }` and dot-notation accessors to pass machine-consumed values between run steps.
- Put failure cleanup in a run movement reached via `on: failure`; nothing special runs on cancel/abort (that is stale-lock reclamation, not cleanup).
