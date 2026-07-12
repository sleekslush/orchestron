# Orchestron — Architectural Plan

## Nomenclature

| Term | Concept |
|---|---|
| **Maestro** | The human operator |
| **Score** | A workflow definition (DAG of movements) |
| **Movement** | A single step in a workflow |
| **Section** | Logical grouping of movements (e.g. "Planning", "Execution", "Review") |
| **Concert** | A single running instance of a Score |
| **Conductor** | Engine that executes one Concert — runs movements, evaluates goals, transitions |
| **Concert Hall** | Registry of active Concerts; creates, finds, and manages Conductors |
| **Musician** | A harness adapter (Pi, opencode, Claude) |
| **Evaluator** | A separate harness session that judges goal achievement |
| **Program** | Configuration & constraints for a Score |
| **Loge** | The observability/store layer (SQLite-backed) |

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│                        Maestro                             │
│    (Human - CLI / Dashboard / Harness Session)            │
└─────┬──────────┬──────────────────┬───────────────────────┘
      │          │                  │
┌─────▼────┐ ┌───▼────┐  ┌─────────▼──────────────────┐
│   CLI    │ │Plugin  │  │   Dashboard (on-demand)     │
│          │ │(Pi/    │  │   $ orchestron dashboard    │
│          │ │ etc.)  │  │   - Local web server        │
└─────┬────┘ └───┬────┘  │   - Real-time via WS        │
      │          │       │   - Reads/writes Loge store  │
      └─────┬────┘       └──────────────────────────────┘
            │
┌───────────▼──────────────────────────────────────────────┐
│                  Orchestron SDK                           │
│                                                            │
│  ┌──────────────────────────────┐  ┌────────────────────┐ │
│  │       Concert Hall           │  │   ScoreRegistry    │ │
│  │                              │  │                    │ │
│  │  createConcert(scoreId)      │  │  register(score)   │ │
│  │  getConcert(id) → Conductor  │  │  get(id) → Score   │ │
│  │  list() → Conductor[]        │  │  loadFrom(path)    │ │
│  │  waitForConcert(id)          │  │                    │ │
│  └──────────┬───────────────────┘  └────────────────────┘ │
│             │ creates & indexes                           │
│  ┌──────────▼───────────────────────────────────────────┐ │
│  │              Conductor (per Concert)                 │ │
│  │                                                       │ │
│  │  start() → loop:                                      │ │
│  │    ① Resolve current Movement                         │ │
│  │    ② Resolve Musician (harness adapter)               │ │
│  │    ③ Build prompt (with context + structured schema)   │ │
│  │    ④ Musician.execute(prompt, ctx) → HarnessResponse   │ │
│  │    ⑤ Evaluator.evaluate(goal, output, ctx)             │ │
│  │    ⑥ Evaluate transitions → next Movement              │ │
│  │    ⑦ Log everything to Loge                            │ │
│  │    ⑧ Check Program constraints; abort if breached     │ │
│  │                                                       │ │
│  │  pause() / resume() / cancel()                        │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                            │
│  ┌────────────────────────────────┐  ┌──────────────────┐ │
│  │  Musician (Harness Adapters)   │  │   Evaluator      │ │
│  │                                │  │                  │ │
│  │  PiAdapter: createSession()    │  │  Uses separate   │ │
│  │  → prompt() → dispose()        │  │  harness session │ │
│  │                                │  │  (lightweight)   │ │
│  │  OpencodeAdapter:              │  │                  │ │
│  │  → client.session.create()     │  │                  │ │
│  │  → .prompt() → .delete()       │  │                  │ │
│  │                                │  │                  │ │
│  │  ClaudeAdapter: (future)       │  │                  │ │
│  └────────────────────────────────┘  └──────────────────┘ │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐ │
│  │  Loge (Store)                                        │ │
│  │  - SQLite via better-sqlite3                          │ │
│  │  - Concerts, Movements, Events, ResourceUsage        │ │
│  │  - System aggregates for dashboard                    │ │
│  │  - No server — file-based, single DB file             │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐ │
│  │  Error Taxonomy                                      │ │
│  │                                                       │ │
│  │  OrchestronError (base)                               │ │
│  │    ├── HarnessError     (HARNESS_FAILURE/TIMEOUT)     │ │
│  │    ├── ConstraintBreach (SPEND_LIMIT/TOKEN_LIMIT)     │ │
│  │    ├── GoalEvalError    (EVALUATOR_FAILURE)           │ │
│  │    ├── ScoreValidation  (CYCLE/DANGLING/INVALID)      │ │
│  │    └── ConductorPanic   (INTERNAL/STATE_CORRUPTION)   │ │
│  └──────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────┘
```

---

## Key Design Decisions

### 1. One Conductor per Concert

Each Concert gets its own Conductor instance. No shared mutable state between conductors. The Concert Hall is just a map + factory — it does not coordinate execution.

```
ConcertHall
├── createConcert("jira-to-mr") → Conductor A (owns Concert A)
├── createConcert("plan-to-doc") → Conductor B (owns Concert B)
└── getConcert("concert-a") → Conductor A
```

### 2. Sub-scores (nested Concerts)

A Movement can specify a `subscore` instead of a `harness`. The parent Conductor spawns a child Concert via ConcertHall and awaits it.

```typescript
interface Movement {
  subscore?: {
    scoreId: ScoreID;
    contextMapping: Record<string, string>;  // parent → child context mapping
  };
}
```

- Child budgets nest inside parent budgets
- Pause/cancel parent → cascades to children
- Max nesting depth: 5
- Child events carry `parentConcertId` for traceability

### 3. Movement output model

```typescript
interface Movement {
  output?: OutputConfig;  // optional — if absent, raw text
}

interface OutputConfig {
  mode: 'text' | 'structured';
  schema?: JSONSchema;  // required when mode = 'structured'
}

// HarnessResponse always carries both forms
interface HarnessResponse {
  output: string;                       // raw LLM text, always present
  structured?: Record<string, unknown>; // parsed when mode = 'structured'
  usage: ResourceUsage;
  summary: string;
}
```

When `mode: 'structured'`, the adapter appends schema instructions to the prompt and parses the result. This is done by the adapter, not the Conductor — keeping the conductor harness-agnostic.

### 4. Evaluator uses a separate harness session

Each Score configures an evaluator — either a specific harness/model or a default. The Evaluator receives the goal description + movement output and returns a `GoalEvaluation`. This is a separate, lightweight harness session.

```typescript
interface EvaluatorConfig {
  harness?: 'pi' | 'opencode' | 'claude';
  model?: string;
  prompt?: string;  // custom eval prompt template
}
```

### 5. Cost tracking is an adapter concern

Usage data comes from the harness SDK. The `ResourceUsage` type is defined in core, but how it's populated depends on what the specific harness SDK exposes. The adapter is responsible for extracting usage from session metadata.

```typescript
interface ResourceUsage {
  spend?: number;   // in micro-dollars (or undefined if not available)
  tokens?: number;  // total tokens (or undefined)
  inputTokens?: number;
  outputTokens?: number;
}
```

### 6. Crash recovery: play it simple

State is persisted after every completed movement transition. If the process crashes mid-movement, recovery is handled via `Conductor.recover()`:

1. `Conductor.recover()` loads the stored concert state, creates a synthetic `MovementRecord` with code `STATE_CORRUPTION`, appends it to the store, and matches the `on: failure` transition to determine the next movement.
2. If no `currentMovement` was set, execution starts from `score.startMovement`.
3. After the synthetic failure is recorded, the normal execution loop resumes — following transitions, executing movements, and evaluating goals.
4. `ConcertHall.rehydrate()` calls `recover()` on every `running` concert (paused concerts are rehydrated but not recovered).
5. Recovery is async and non-blocking — rehydration fires all recoveries in the background.
6. Retry loops triggered by `on: failure` transitions work the same as runtime failures — no special recovery path needed for re-execution.

Paused concerts are rehydrated into memory for observation/cancellation but are not auto-recovered.

### 7. Secrets are out of scope

The harness itself has tools for API keys, tokens, etc. Orchestron does not handle secrets. Period.

---

## Initiation Paths

### From CLI

```
$ orchestron start jira-to-mr --context.ticket=PROJ-123
```

CLI loads SDK → `ConcertHall.createConcert("jira-to-mr", { ticket: "PROJ-123" })` → Conductor starts.

### From Pi session (plugin)

```
User: "Run the jira-to-mr workflow for PROJ-123"
Pi: calls orchestron_start_concert tool
Plugin: ConcertHall.createConcert("jira-to-mr", { ticket: "PROJ-123" })
```

The Conductor creates *new* Pi sessions for each movement (via `createAgentSession()`). The originating Pi session is unaffected and remains interactive.

### From any harness (via API)

```typescript
orchestron.concertHall.createConcert(scoreId, context);
```

---

## High-Level Interfaces & Types

```typescript
// === Identifiers ===
type ConcertID = string;
type MovementID = string;
type ScoreID = string;
type SectionID = string;
type ConcertStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
type MovementStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';

// === Error Taxonomy ===
class OrchestronError extends Error {
  readonly code: string;
  readonly concertId?: ConcertID;
  readonly movementId?: MovementID;
  readonly retryable: boolean;
}

class HarnessError extends OrchestronError {
  code: 'HARNESS_FAILURE' | 'HARNESS_TIMEOUT';
}

class ConstraintBreachError extends OrchestronError {
  code: 'SPEND_LIMIT' | 'TOKEN_LIMIT' | 'MOVEMENT_LIMIT' | 'DURATION_LIMIT';
  readonly limit: number;
  readonly actual: number;
  readonly constraint: string;
}

class GoalEvalError extends OrchestronError {
  code: 'EVALUATOR_FAILURE' | 'AMBIGUOUS_RESULT';
}

class ScoreValidationError extends OrchestronError {
  code: 'CYCLE_DETECTED' | 'DANGLING_TRANSITION' | 'UNKNOWN_MOVEMENT' | 'INVALID_SCORE';
}

class ConductorPanic extends OrchestronError {
  code: 'INTERNAL_ERROR' | 'STATE_CORRUPTION';
}

// === Resource Usage ===
interface ResourceUsage {
  spend?: number;
  tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}

// === Program ===
interface Program {
  maxSpend?: number;
  maxTokens?: number;
  maxMovements?: number;
  maxDurationMs?: number;
  maxNestingDepth?: number;
  perSection?: Record<SectionID, SectionBudget>;
}

interface SectionBudget {
  maxSpend?: number;
  maxTokens?: number;
  maxMovements?: number;
}

// === Goal ===
interface Goal {
  description: string;
  strategy: 'llm_judge';
}

interface GoalEvaluation {
  achieved: boolean;
  confidence: number;
  summary: string;
  evidence?: string;
}

// === Transition ===
interface Transition {
  to: MovementID | '__end__' | '__fail__';
  on: 'success' | 'failure' | 'skip' | GoalEvaluation;
}

// === Output ===
interface OutputConfig {
  mode: 'text' | 'structured';
  schema?: Record<string, unknown>;  // JSON Schema
}

// === Movement ===
interface Movement {
  id: MovementID;
  name: string;
  section: SectionID;
  description: string;
  harness?: 'pi' | 'opencode' | 'claude';
  subscore?: {
    scoreId: ScoreID;
    contextMapping: Record<string, string>;
  };
  prompt?: string | PromptTemplate;
  output?: OutputConfig;
  goal: Goal;
  transitions: Transition[];
  budget?: MovementBudget;
  retryOnFailure?: boolean;
}

interface MovementBudget {
  maxSpend?: number;
  maxTokens?: number;
  maxRetries?: number;
  timeoutMs?: number;
}

// === Score ===
interface Score {
  id: ScoreID;
  name: string;
  description: string;
  version: string;
  evaluator?: EvaluatorConfig;
  movements: Movement[];
  startMovement: MovementID;
  program: Program;
  metadata?: Record<string, unknown>;
}

interface EvaluatorConfig {
  harness?: 'pi' | 'opencode' | 'claude';
  model?: string;
  prompt?: string;
}

// === Concert ===
interface Concert {
  id: ConcertID;
  scoreId: ScoreID;
  status: ConcertStatus;
  startedAt: Date;
  completedAt?: Date;
  currentMovement: MovementID | null;
  history: MovementRecord[];
  context: ConcertContext;
  usage: ResourceUsage;
  triggeredBy: 'cli' | 'api' | 'harness' | 'agent';
  parentConcertId?: ConcertID;
  childConcertIds: ConcertID[];
}

interface ConcertContext {
  shared: Record<string, unknown>;
}

// === Movement Record ===
interface MovementRecord {
  movementId: MovementID;
  movementName: string;
  status: MovementStatus;
  output: string;
  structured?: Record<string, unknown>;
  summary: string;
  goalEvaluation: GoalEvaluation;
  usage: ResourceUsage;
  durationMs: number;
  startedAt: Date;
  completedAt?: Date;
  error?: OrchestronError;
}

// === Harness Adapter ===
interface HarnessAdapter {
  readonly type: 'pi' | 'opencode' | 'claude';
  execute(
    prompt: string,
    context: ConcertContext,
    options?: { signal?: AbortSignal; output?: OutputConfig },
  ): Promise<HarnessResponse>;
  getUsage?(): Promise<ResourceUsage>;
}

interface HarnessResponse {
  output: string;
  structured?: Record<string, unknown>;
  summary: string;
  usage: ResourceUsage;
}

// === Evaluator ===
interface Evaluator {
  evaluate(goal: Goal, output: string, context: ConcertContext): Promise<GoalEvaluation>;
}

// === Conductor ===
interface Conductor {
  readonly concertId: ConcertID;
  readonly status: ConcertStatus;
  start(signal?: AbortSignal): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  cancel(): Promise<void>;
  getState(): Promise<Concert>;
}

// === Concert Hall ===
interface ConcertHall {
  createConcert(scoreId: ScoreID, options?: StartOptions): Promise<Conductor>;
  getConcert(id: ConcertID): Conductor | undefined;
  list(filter?: ConcertFilter): Conductor[];
  waitForConcert(id: ConcertID): Promise<Concert>;
  getChildConcerts(parentId: ConcertID): ConcertID[];
}

interface StartOptions {
  initialContext?: Record<string, unknown>;
  programOverride?: Partial<Program>;
  triggeredBy?: Concert['triggeredBy'];
  parentConcertId?: ConcertID;
}

// === Loge (Store) ===
interface ConcertStore {
  // Concerts
  saveConcert(c: Concert): Promise<void>;
  updateConcert(c: Concert): Promise<void>;
  getConcert(id: ConcertID): Promise<Concert | null>;
  listConcerts(filter?: ConcertFilter): Promise<Concert[]>;

  // Movement history
  appendMovement(id: ConcertID, record: MovementRecord): Promise<void>;
  getMovementHistory(id: ConcertID): Promise<MovementRecord[]>;

  // Events
  pushEvent(event: ConcertEvent): Promise<void>;
  getEvents(id: ConcertID, filter?: EventFilter): Promise<ConcertEvent[]>;

  // Aggregates
  getAggregates(): Promise<SystemAggregates>;
}

interface SystemAggregates {
  totalConcerts: number;
  activeConcerts: number;
  totalSpend: number;
  totalTokens: number;
  avgDurationMs: number;
  failureRate: number;
}

type ConcertEvent =
  | { type: 'concert:started'; concertId: ConcertID; timestamp: Date }
  | { type: 'concert:paused'; concertId: ConcertID; timestamp: Date }
  | { type: 'concert:resumed'; concertId: ConcertID; timestamp: Date }
  | { type: 'concert:completed'; concertId: ConcertID; timestamp: Date }
  | { type: 'concert:failed'; concertId: ConcertID; error: OrchestronError; timestamp: Date }
  | { type: 'concert:cancelled'; concertId: ConcertID; timestamp: Date }
  | { type: 'movement:started'; concertId: ConcertID; movementId: MovementID; timestamp: Date }
  | { type: 'movement:completed'; concertId: ConcertID; movementId: MovementID; result: MovementRecord; timestamp: Date }
  | { type: 'movement:failed'; concertId: ConcertID; movementId: MovementID; error: OrchestronError; retryCount: number; timestamp: Date }
  | { type: 'constraint:breached'; concertId: ConcertID; constraint: string; limit: number; actual: number; timestamp: Date }
  | { type: 'child:created'; parentConcertId: ConcertID; childConcertId: ConcertID; timestamp: Date }
  | { type: 'child:completed'; parentConcertId: ConcertID; childConcertId: ConcertID; timestamp: Date };

// === Score Registry ===
interface ScoreRegistry {
  register(score: Score): void;
  registerMany(scores: Score[]): void;
  get(id: ScoreID): Score;
  list(): Score[];
  remove(id: ScoreID): void;
  loadFrom(path: string): void;
  validate(score: Score): ScoreValidationError[];
}

// === Top-Level Orchestron ===
interface Orchestron {
  readonly scores: ScoreRegistry;
  readonly concertHall: ConcertHall;
  readonly store: ConcertStore;
  registerAdapter(type: string, adapter: HarnessAdapter): void;
  registerScoresFrom(path: string): void;
}

// === Dashboard ===
interface DashboardServer {
  start(port?: number): Promise<void>;
  stop(): Promise<void>;
  readonly url: string;
}
```

---

## Dashboard Views

| View | Content |
|---|---|
| **Foyer** | All Concerts (active/past), total spend, token usage, failure rate |
| **Concert Detail** | Timeline of movements, status of each, summaries, resource burn-down |
| **Movement Inspector** | Full input/output, goal evaluation, harness session, structured data |
| **Concert Tree** | Parent/child hierarchy for sub-scores |
| **Score Library** | Registered scores with their movement DAGs |
| **Live View** | Real-time feed of events via WebSocket |

---

## Package Structure

```
orchestron/
├── packages/
│   ├── core/                   # Types, Conductor, ConcertHall, Loge, ScoreRegistry
│   │   ├── src/
│   │   │   ├── types/          # All domain types & interfaces
│   │   │   │   ├── concert.ts
│   │   │   │   ├── score.ts
│   │   │   │   ├── movement.ts
│   │   │   │   ├── errors.ts
│   │   │   │   └── events.ts
│   │   │   ├── conductor/      # Conductor engine
│   │   │   │   ├── conductor.ts
│   │   │   │   └── conductor.test.ts
│   │   │   ├── hall/           # ConcertHall
│   │   │   │   └── concert-hall.ts
│   │   │   ├── store/          # Loge — ConcertStore interface + SQLite
│   │   │   │   ├── concert-store.ts
│   │   │   │   └── sqlite-loge.ts
│   │   │   ├── registry/       # ScoreRegistry
│   │   │   │   └── score-registry.ts
│   │   │   ├── evaluator/      # Goal evaluator
│   │   │   │   ├── evaluator.ts
│   │   │   │   └── default-evaluator.ts
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── adapter-pi/             # Pi harness adapter
│   │   ├── src/
│   │   │   ├── pi-adapter.ts
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── adapter-opencode/       # Opencode harness adapter
│   │   ├── src/
│   │   │   ├── opencode-adapter.ts
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── adapter-claude/         # (future) Claude harness adapter
│   │   └── package.json
│   │
│   ├── cli/                    # orchestron CLI
│   │   ├── src/
│   │   │   ├── commands/
│   │   │   │   ├── start.ts
│   │   │   │   ├── pause.ts
│   │   │   │   ├── status.ts
│   │   │   │   ├── list.ts
│   │   │   │   ├── scores.ts
│   │   │   │   └── dashboard.ts
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── dashboard/              # Local web server + React frontend
│   │   ├── src/
│   │   │   ├── server/
│   │   │   │   └── dashboard-server.ts
│   │   │   └── ui/
│   │   │       ├── views/
│   │   │       │   ├── Foyer.tsx
│   │   │       │   ├── ConcertDetail.tsx
│   │   │       │   ├── MovementInspector.tsx
│   │   │       │   ├── ConcertTree.tsx
│   │   │       │   ├── ScoreLibrary.tsx
│   │   │       │   └── LiveView.tsx
│   │   │       └── App.tsx
│   │   └── package.json
│   │
│   └── plugin-pi/              # Pi session plugin
│       ├── src/
│       │   ├── tools/
│       │   │   ├── start-concert.ts
│       │   │   ├── get-status.ts
│       │   │   ├── list-concerts.ts
│       │   │   ├── pause-concert.ts
│       │   │   ├── cancel-concert.ts
│       │   │   └── list-scores.ts
│       │   └── index.ts
│       └── package.json
│
├── examples/
│   ├── jira-to-mr.score.yaml
│   ├── notion-clarify.score.yaml
│   └── plan-to-markdown.score.yaml
│
├── package.json                # Monorepo root (pnpm workspaces)
├── tsconfig.json
└── PLAN.md
```

---

## Example Score (YAML)

```yaml
id: jira-to-mr
name: "Jira Ticket to Merge Request"
version: 1.0.0
evaluator:
  harness: pi
  model: pi-4-mini
program:
  maxSpend: 5000
  maxTokens: 500000
startMovement: clarify

movements:
  - id: clarify
    name: "Clarify Ticket"
    section: planning
    harness: pi
    prompt: "Given the Jira ticket {{context.ticket}}, clarify requirements..."
    output:
      mode: structured
      schema:
        type: object
        properties:
          requirements:
            type: array
            items: { type: string }
          acceptance_criteria:
            type: array
            items: { type: string }
    goal:
      description: "Ticket has clear, actionable requirements"
      strategy: llm_judge
    transitions:
      - on: success -> implement
      - on: failure -> __fail__

  - id: implement
    name: "Implement Code"
    section: execution
    harness: pi
    prompt: "Implement the solution for: {{context.previousOutputs.clarify}}"
    output:
      mode: structured
      schema:
        type: object
        properties:
          code: { type: string }
          tests: { type: string }
    goal:
      description: "Working implementation with tests"
      strategy: llm_judge
    budget:
      maxSpend: 3000
    transitions:
      - on: success -> review
      - on: failure -> __fail__

  - id: review
    name: "Code Review"
    section: review
    harness: pi
    prompt: "Review this implementation: {{context.previousOutputs.implement}}"
    goal:
      description: "All issues identified and addressed"
      strategy: llm_judge
    transitions:
      - on: success -> create_mr
      - on: failure -> implement

  - id: create_mr
    name: "Create Merge Request"
    section: delivery
    harness: pi
    prompt: "Create MR from: {{context.previousOutputs.implement}}"
    goal:
      description: "MR created with description and changelog"
      strategy: llm_judge
    transitions:
      - on: success -> update_jira
      - on: failure -> __fail__

  - id: update_jira
    name: "Update Jira Ticket"
    section: delivery
    harness: pi
    prompt: "Update Jira ticket {{context.ticket}} with MR link..."
    goal:
      description: "Ticket updated with MR reference"
      strategy: llm_judge
    transitions:
      - on: success -> __end__
```
