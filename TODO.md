# Orchestron — Implementation Phases

## Phase 1: Foundation (Core Types + Store) ✅

**Goal**: Types, SQLite store, Score Registry, error taxonomy — everything the rest compiles against.

- [x] Scaffold monorepo (pnpm workspaces, `tsconfig.json`)
- [x] `packages/core/src/types/` — all domain types and interfaces
- [x] `packages/core/src/types/errors.ts` — full error taxonomy
- [x] `packages/core/src/store/` — `ConcertStore` interface + `SqliteLoge` implementation
  - Schema creation, CRUD for concerts, movement history, events, aggregates
- [x] `packages/core/src/registry/` — `ScoreRegistry` with YAML/JSON loading
  - `validate()` — cycle detection, dangling transitions, unknown movements
- [x] `packages/core/src/index.ts` — re-exports everything

## Phase 2: Conductor Engine ✅

**Goal**: Conductor can load a Score, walk the movement DAG, call an in-memory fake harness.

- [x] `packages/core/src/evaluator/` — `Evaluator` interface + `FakeEvaluator`
- [x] `packages/core/src/conductor/` — `Conductor` class
  - Movement resolution, prompt building with context
  - Goal delegation to Evaluator
  - Transition matching
  - Constraint checking (spend, tokens, movements, duration)
  - Sub-score spawning (hooks into ConcertHall)
  - Crash recovery: fail mid-flight movement, let transitions decide
- [x] `packages/core/src/hall/` — `ConcertHall` class
  - `createConcert()`, `getConcert()`, `list()`, `waitForConcert()`
  - Rehydration of incomplete Concerts on restart
  - Child concert tracking
- [x] `packages/core/src/__tests__/` — Conductor unit tests with mock harness
- [x] `packages/core/src/__tests__/use-cases.test.ts` — 6 integration use cases

## Phase 3: Pi Harness Adapter ✅

**Goal**: Real movement execution via Pi SDK.

- [x] Create `packages/adapter-pi/`
- [x] Implement `PiAdapter` — wraps `@earendil-works/pi-coding-agent` `createAgentSession()` / `session.prompt()` / `session.dispose()`
  - Handle `OutputConfig.mode === 'structured'` — inject schema into prompt, parse result
  - Extract `ResourceUsage` from agent_end event (input/output tokens, cost → spend)
  - Abort signal bridges to `session.abort()`
- [x] Session persistence: per-movement sessions with `persistSession` (Program config, default `true`)
  - [x] `sessionId` in `HarnessAdapter.execute()` options
  - [x] Optional `disposeSession()` on `HarnessAdapter`
  - [x] Conductor passes `concertId:movementId` as sessionId, tracks active sessions, disposes on finalize
  - [x] PiAdapter reuses sessions per sessionId, implements `disposeSession()`
- [ ] Integration test: run a real 2-movement score against Pi

## Phase 4: CLI

**Goal**: `orchestron start|pause|status|list|scores` from the terminal.

- [ ] Create `packages/cli/`
- [ ] Commands:
  - `orchestron start <score-id> [--context.key=val ...]`
  - `orchestron pause <concert-id>`
  - `orchestron resume <concert-id>`
  - `orchestron cancel <concert-id>`
  - `orchestron status [concert-id]`
  - `orchestron list [--status running|completed|failed]`
  - `orchestron scores [--validate]`
  - `orchestron dashboard` — launches dashboard server
- [ ] Output: human-readable by default, `--json` for programmatic use
- [ ] Config: `--store` flag for custom SQLite path, default `~/.orchestron/store.db`

## Phase 5: Dashboard

**Goal**: Real-time web UI for monitoring Concerts, drilling into movements.

- [ ] Create `packages/dashboard/`
- [ ] Backend: local HTTP + WebSocket server (`express` + `ws` or `hono`)
  - Reads SQLite directly
  - Pushes events to connected clients via WebSocket
- [ ] Frontend: React app (Vite + Tailwind)
  - **Foyer**: Active/past concerts, aggregates, live feed
  - **Concert Detail**: Movement timeline, status badges, burn-down chart
  - **Movement Inspector**: Input prompt, output, goal evaluation, structured data
  - **Concert Tree**: Parent/child hierarchy
  - **Score Library**: Browse scores, inspect movement DAGs
  - **Live View**: Real-time event stream

## Phase 6: Pi Session Plugin

**Goal**: Start and monitor concerts from within a Pi session using natural language.

- [ ] Create `packages/plugin-pi/`
- [ ] Define orchestron tools for Pi:
  - `orchestron_start_concert(scoreId, context?)`
  - `orchestron_get_concert_status(concertId)`
  - `orchestron_list_concerts(filter?)`
  - `orchestron_pause_concert(concertId)`
  - `orchestron_cancel_concert(concertId)`
  - `orchestron_list_scores()`
- [ ] Tools return structured data (JSON) so Pi can summarize for the user
- [ ] Example: "Run the jira-to-mr workflow for PROJ-123" → tool call → concert starts in background → user can check status

## Phase 7: Score Examples + Docs

**Goal**: Working example scores and enough docs for someone to author their own.

- [x] `examples/jira-to-mr.score.yaml`
- [x] `examples/simple-plan-review.score.yaml`
- [ ] `examples/notion-clarify.score.yaml`
- [ ] `examples/plan-to-markdown.score.yaml`
- [ ] Score authoring guide (README or AGENTS.md)

## Phase 8: Opencode Adapter + Polish

**Goal**: Second harness adapter; hardening.

- [ ] Create `packages/adapter-opencode/`
  - `createOpencodeClient()` → `client.session.create()` → `.prompt()` → `.delete()`
- [ ] Concurrent safety — document or resolve command races
- [ ] Performance — backpressure, timeout propagation
- [ ] End-to-end test with both Pi and opencode adapters

## Phase 9: V1 (Future)

- [ ] Claude harness adapter
- [ ] Scheduled/cron-triggered Concerts
- [ ] Score template system (reusable movement patterns)
- [ ] Mock harness adapters for CI testing
- [ ] Audience/redaction configuration
- [ ] Multi-machine Concert Hall (distributed conductors)
