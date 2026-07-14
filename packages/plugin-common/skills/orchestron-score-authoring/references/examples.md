# Examples

## Minimal Valid Score

Required fields only.

```yaml
id: hello-world
name: "Hello World"
version: "1.0.0"
startMovement: greet
movements:
  - id: greet
    name: "Greet"
    section: delivery
    prompt: "Say hello to the user."
    goal:
      description: "Greeting is friendly"
      strategy: llm_judge
    transitions:
      - to: __end__
        on: success
```

## Structured Output with Context Passing

```yaml
id: analyze-topic
name: "Analyze Topic"
version: "1.0.0"
program:
  maxMovements: 5
startMovement: analyze
movements:
  - id: analyze
    name: "Analyze"
    section: planning
    harness: pi
    prompt: >
      Analyze the following topic and provide key points:
      {{context.topic}}
    output:
      mode: structured
      schema:
        type: object
        properties:
          summary: { type: string }
          key_points:
            type: array
            items: { type: string }
        required: [summary, key_points]
    goal:
      description: "Analysis is clear and structured"
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
      Based on this analysis, write a one-paragraph summary:
      {{context.previousOutputs.analyze}}
    goal:
      description: "Summary is concise"
      strategy: llm_judge
    transitions:
      - to: __end__
        on: success
```

## Loop-back Review with Prompt Variants

```yaml
id: plan-review-loop
name: "Plan with Review Loop"
version: "1.0.0"
program:
  maxMovements: 15
startMovement: plan
movements:
  - id: plan
    name: "Create Plan"
    section: planning
    harness: pi
    prompt:
      initial: >
        Create a detailed plan for: {{context.task}}
      subsequent: >
        Revise the plan based on this feedback:
        {{context.previousOutputs.review}}
    output:
      mode: structured
      schema:
        type: object
        properties:
          steps:
            type: array
            items: { type: string }
        required: [steps]
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
      Review this plan for completeness and feasibility:
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

## Budget Controls and Retry

```yaml
id: fragile-task
name: "Fragile Task with Retry"
version: "1.0.0"
program:
  maxSpendDollars: 5
  maxMovements: 10
  perSection:
    execution:
      maxSpendDollars: 3
      maxMovements: 6
startMovement: run
movements:
  - id: run
    name: "Run Task"
    section: execution
    harness: pi
    prompt: "Attempt the fragile task described in {{context.task}}."
    retryOnFailure: true
    budget:
      maxRetries: 3
      timeoutMs: 120000
    goal:
      description: "Task completed successfully"
      strategy: llm_judge
    transitions:
      - to: __end__
        on: success
      - to: __fail__
        on: failure
```

## Wildcard Section Budgets

Use `*` to set a base budget for all sections, then override specific fields for individual sections:

```yaml
id: wildcard-budget
name: "Wildcard Budget Example"
version: "1.0.0"
program:
  perSection:
    "*":
      maxMovements: 5
      maxSpendDollars: 2
    execution:
      maxMovements: 3  # overrides *; inherits maxSpendDollars: 2
    review:
      maxSpendDollars: 1  # overrides *; inherits maxMovements: 5
startMovement: run
movements:
  - id: run
    name: "Run"
    section: execution
    harness: pi
    prompt: "Execute the task."
    goal:
      description: "Task executed"
      strategy: llm_judge
    transitions:
      - to: review
        on: success
  - id: review
    name: "Review"
    section: review
    harness: pi
    prompt: "Review the results."
    goal:
      description: "Review complete"
      strategy: llm_judge
    transitions:
      - to: __end__
        on: success
```

## Subscore Delegation

```yaml
id: parent-workflow
name: "Parent Workflow"
version: "1.0.0"
program:
  maxNestingDepth: 3
startMovement: prep
movements:
  - id: prep
    name: "Prepare Context"
    section: planning
    harness: pi
    prompt: "Gather requirements for {{context.project}}."
    goal:
      description: "Requirements gathered"
      strategy: llm_judge
    transitions:
      - to: child_audit
        on: success
      - to: __fail__
        on: failure

  - id: child_audit
    name: "Run Audit Subscore"
    section: review
    subscore:
      scoreId: security-audit
      contextMapping:
        target: "shared.project"
        checklist: "shared.auditChecklist"
    goal:
      description: "Audit subscore completed"
      strategy: llm_judge
    transitions:
      - to: __end__
        on: success
      - to: __fail__
        on: failure
```
