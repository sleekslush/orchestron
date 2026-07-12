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
- [x] `HarnessEvaluator` — real harness-based evaluator using `Score.evaluator` config
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
- [ ] **Deferred**: cascading pause/cancel/resume to child concerts (see `docs/decisions/child-concert-lifecycle.md`)
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
  - [x] Bug fix: PiAdapter no longer disposes newly-created persisted sessions — correctly retains them for subsequent execute() calls
- [ ] Integration test: run a real 2-movement score against Pi

## Phase 4: Opencode Harness Adapter ✅

**Goal**: Second harness adapter via `@opencode-ai/sdk`; works alongside Pi.

- [x] Scaffold `packages/adapter-opencode/` — `package.json`, `src/index.ts`, `src/opencode-adapter.ts`
- [x] Implement `OpencodeAdapter`:
  - Connect to existing server via `createOpencodeClient()`, or start embedded via `createOpencode()`
  - Native structured output via `format: { type: "json_schema", schema }`
  - Session persistence (reuse sessions per `sessionId`, same pattern as PiAdapter)
  - Abort signal → `client.session.abort()`
  - Usage extraction from response metadata (fall back to `{}` when unavailable)
  - `disposeSession()` → `client.session.delete()`
  - Global `dispose()` for embedded server cleanup
- [x] Add optional `dispose(): Promise<void>` to `HarnessAdapter` interface in core types
- [x] Unit tests: session lifecycle, structured output, abort, session reuse
- [ ] Integration test: run a real 2-movement score against opencode
- [x] Update example scores to show `harness: opencode`
- [x] Document decisions in `docs/decisions/opencode-adapter.md`

## Phase 5: CLI ✅

**Goal**: `orchestron start|pause|status|list|scores` from the terminal.

- [x] Create `packages/cli/`
- [x] Commands:
  - `orchestron start <score-id> [--context.key=val ...]`
  - `orchestron pause <concert-id>`
  - `orchestron resume <concert-id>`
  - `orchestron cancel <concert-id>`
  - `orchestron status [concert-id]`
  - `orchestron list [--status running|completed|failed]`
  - `orchestron scores [--validate]`
  - `orchestron dashboard` — launches dashboard server
- [x] Output: human-readable by default, `--json` for programmatic use
- [x] Config: `--store` flag for custom SQLite path, default `~/.orchestron/store.db`

## Phase 6: Pi Session Plugin ✅

**Goal**: Start and monitor concerts from within a Pi session using natural language.

- [x] Create `packages/plugin-pi/`
- [x] Define orchestron tools for Pi:
  - `orchestron_start_concert(scoreId, context?)`
  - `orchestron_get_concert_status(concertId)`
  - `orchestron_list_concerts(filter?)`
  - `orchestron_pause_concert(concertId)`
  - `orchestron_cancel_concert(concertId)`
  - `orchestron_list_scores()`
  - `orchestron_create_score(scoreId, yaml, persist?, saveLocation?)`
  - `orchestron_edit_score(scoreId, yaml, persist?, saveLocation?)`
  - `orchestron_get_score(scoreId)`
- [x] Tools return structured data (JSON) so Pi can summarize for the user
- [x] Example: "Run the jira-to-mr workflow for PROJ-123" → tool call → concert starts in background → user can check status
- [x] Add `orchestron-score-authoring` skill to the Pi plugin package
- [x] In-memory score drafts: validate and register without persisting, test via `orchestron_start_concert`, then persist when asked

## Phase 7: Opencode Session Plugin

**Goal**: Start and monitor concerts from within an opencode session using natural language.

- [ ] Create `packages/plugin-opencode/`
- [ ] Define orchestron tools for opencode:
  - `orchestron_start_concert(scoreId, context?)`
  - `orchestron_get_concert_status(concertId)`
  - `orchestron_list_concerts(filter?)`
  - `orchestron_pause_concert(concertId)`
  - `orchestron_cancel_concert(concertId)`
  - `orchestron_list_scores()`
- [ ] Tools return structured data (JSON) so opencode can summarize for the user
- [ ] Reuse the same tool definitions and orchestron integration as the Pi plugin

## Phase 8: Dashboard

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

## Phase 9: Score Examples + Docs

**Goal**: Working example scores and enough docs for someone to author their own.

- [x] `examples/jira-to-mr.score.yaml`
- [x] `examples/simple-plan-review.score.yaml`
- [ ] `examples/notion-clarify.score.yaml`
- [ ] `examples/plan-to-markdown.score.yaml`
- [x] Score authoring guide (skill: `packages/plugin-pi/skills/orchestron-score-authoring/SKILL.md`)

## Phase 10: V1 (Future)

- [ ] Claude harness adapter
- [ ] Scheduled/cron-triggered Concerts
- [ ] Score template system (reusable movement patterns)
- [ ] Mock harness adapters for CI testing
- [ ] Audience/redaction configuration
- [ ] Multi-machine Concert Hall (distributed conductors)
