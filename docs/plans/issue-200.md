# Implementation Plan — Issue #200: Rename `persistSession` to `reuseSession` and clarify in-concert session-reuse semantics

**Issue:** sleekslush/orchestron#200 (open, labels `enhancement`, `documentation`, `orchestron:in-progress`)
**Issue revision:** `2026-10-03T10:29:02Z` (body+comments digest `7951f40033e4a16f58a01215f6ffe08a156a44c058654b79ea8158b7c1024003`)
**Related PR:** sleekslush/orchestron#201 — "Rename persistSession to reuseSession" (open, base at current `main`, mergeState CLEAN, no reviews)
**Related issue:** sleekslush/orchestron#203 — per-movement `reuseSession` override (blocked by #200; "Part of #200")

## Problem

The score-level program option that governs per-movement harness session continuity is
named `persistSession`, but the name describes the wrong axis. The option is a boolean
that controls whether a movement that is visited again inside one concert (a retry, or a
transition that loops back) reuses the harness session it created on a prior attempt,
versus starting every execution from a brand-new session. Reuse is scoped to a single
concert and is held in memory; it is disposed when the concert ends and is never restored
across concerts. Disk recording, by contrast, is unconditional: every attempt writes its
native transcript regardless of the option, and only the aggregated `final-*` copy is
cumulative-mode-only. The name `persistSession` therefore suggests a durability/recording
control that does not exist, and forces the documentation to describe the option
inaccurately ("persisting sessions across movements").

The fix is a rename to `reuseSession` plus a conceptual rewording of every document,
comment, and test description that describes the option.

## Relationship to open PR #201

This plan is an **extension of PR #201, not a replacement**. The implementer should build
on that branch rather than re-authoring the rename.

### Already covered by PR #201

- The core program contract gains `reuseSession` and keeps `persistSession` as a
  deprecated alias.
- The Conductor resolves the mode once per concert through a new resolution helper and
  emits a deprecation warning via the existing direct-console-warning convention.
- The operator README (session and recording sections), the project guidelines, the
  score-authoring YAML reference, the example score, and the recording artifact comment are
  reworded.
- The session ADR is fully reworded at its current head: title, context, decision, config
  knob, interface changes, Conductor behaviour, rename note, and consequences already use
  reuse framing and state that transcripts are recorded in both modes.
- Tests pin the recording semantics across default/explicit modes and cover the legacy
  alias, including the both-keys precedence case and the warning.

### Remaining work this plan sequences

- **Session ADR governance gaps, not prose.** The ADR's context and consequences are
  already correct; what is genuinely open is (a) recording an explicit decision to preserve
  the ADR filename despite its now-mismatched slug, and (b) stating a deprecation-removal
  milestone for the legacy alias in the rename note.
- **The conceptual phrasing sweep is incomplete outside that ADR.** The opencode-adapter
  ADR still frames its session section and stated capability as "session persistence".
  The core adapter contract comment and the trace-service comment still describe a reused
  session as "persistent". The Musician adapter implementations still use "persistent
  session" in their session-tracking comments, and one adapter test description still says
  "reusing a persistent session".
- **Validation against the tightened criteria.** The issue body was expanded after PR #201
  was opened, so the branch must be re-checked against the final acceptance criteria and
  the alias-removal lifecycle before merge.

## Architecture context (the design being aligned to)

- **Layered core.** Contract types live in the core type modules; the Conductor is the
  sole runtime that interprets a `Score` into a `Concert`; ConcertHall only indexes and
  constructs concerts; Loge persists concert/movement/usage rows; per-concert live events
  and per-attempt session artifacts are written to the concert recording tree.
- **Adapter (Musician) pattern.** Harnesses implement a common interface; session reuse is
  expressed only as an optional session identifier passed into execute plus an optional
  dispose hook. The program flag must remain adapter-agnostic and must not leak into any
  specific adapter's contract. Adapter-internal sessions are pooled by session id.
- **Score program as score-level config.** `Program` is the score-level configuration
  surface (budgets, nesting depth, per-section overrides). The session-reuse flag belongs
  there; movement-level override is #203, a separate follow-up.
- **Recording model.** Every attempt writes its per-attempt directory and native
  transcript; cumulative mode additionally aggregates a movement-level final copy. The
  optional `final-*` artifact is the only recording difference between modes. This is the
  semantic distinction the documentation must state unambiguously.
- **Precedence pattern already in use.** Movement-over-score precedence exists for model,
  provider, and skills. The session-mode resolver should be shaped so #203 can add a
  movement-level override using the same pattern without changing the session-key scheme
  (`concertId:movementId`).
- **Logging convention.** There is no structured logger or observability abstraction in the
  runtime. Runtime code writes diagnostics directly with `console.warn`/`console.error`
  (the Conductor already uses `console.error` for stream-write failures, and the opencode
  adapter uses `console.warn`). Deprecation warnings should follow that same convention; do
  not introduce a parallel logging abstraction.
- **ADR conventions.** Design decisions are recorded under `docs/decisions/` with a status,
  date, and related-decision links. The same concept is documented for different audiences:
  README (operator), project guidelines (contributor), the shared score-authoring skill's
  YAML reference (author), and the ADRs (design).

## Approach

1. **Contract change.** Introduce `reuseSession` as the canonical score-level program
   option with a doc comment stating the behavioural axis precisely: it governs in-concert,
   in-memory reuse of a movement's prior session on re-visit; it does not control disk
   recording; transcripts are recorded in both modes. Retain `persistSession` as a
   deprecated alias on the same contract so existing scores keep loading.
2. **Single resolution point.** Resolve the effective mode once per concert from the score
   program, not at each attempt site. The runtime consumes the resolved mode and the
   derived session identifier so default and alias precedence are applied consistently.
   Shape the resolver input so #203 can later feed a movement-level override into the same
   helper.
3. **Alias behaviour and warning surface.** `reuseSession` wins when both keys are present;
   a lone legacy key is honoured with the same behaviour as before. Emit the deprecation
   warning through the established direct `console.warn` convention used elsewhere in
   runtime code, once per concert that contains the legacy key, with an additional clause
   when both keys are present. Do not add a logging abstraction; tests observe the warning
   through the standard console spy mechanism already used in the codebase.
4. **Conceptual terminology sweep.** Replace prose that frames the option as durability or
   disk persistence with reuse framing ("in-concert session reuse", "reused session",
   "cumulative vs. fresh") across: the operator README, the session ADR, the
   opencode-adapter ADR, the score-authoring YAML reference, the project guidelines, the
   core adapter contract comment, the trace-service comment, the Musician adapter
   implementation comments that track per-session state or turn aggregation, and the
   adapter test description that calls a reused session "persistent". Deliberately preserve
   genuine disk-persistence terminology (Loge persistence, pricing persistence, the
   score-tool `persist` save flag, skill/hash persistence, filesystem persistence flags) —
   those are unrelated features.
5. **ADR governance decisions.** Keep the session ADR filename as its stable historical
   identifier and record that deliberate choice in its rename note so a future reader does
   not "fix" it; verify the inbound references from the child-concert-lifecycle ADR and the
   opencode-adapter ADR remain valid. Add a stated removal milestone for the deprecated
   alias so the misleading name does not become permanent.
6. **Align #203.** Leave the resolver's input contract extensible so #203 can add a
   movement-level override and reuse the same helper. #203 remains out of scope here.

## Components and architectural layers affected

All components are named at the architectural level; the implementer locates exact edit
sites from the current tree.

**Core contract layer**

- The core score contract type: the `Program` shape and its documentation, where
  `reuseSession` becomes canonical and `persistSession` becomes a deprecated alias with an
  explicit removal milestone.
- The score-authoring YAML reference shipped with the shared score-authoring skill: the
  program field table and semantic prose (already partly updated by PR #201).
- The score registry / YAML loader: no schema change is required, but it is the place where
  "unknown program key" behaviour must be confirmed still permissive so the alias is not
  rejected. Verification surface only.

**Conductor runtime layer**

- The session-mode resolution component: derives the effective mode and whether the legacy
  key was used; the extension point #203 will extend.
- The Conductor's movement-execution path: consumes the resolved mode for the session
  identifier and the per-movement mode it records.
- The Conductor's concert-index writer: fallback mode for unexecuted movements must reflect
  the resolved score-level mode.
- The Conductor's finalize path: disposal of reused sessions stays unchanged; verify the
  rename does not alter disposal lifetime.
- The direct console-warning convention in runtime code (the Conductor's deprecation
  warning site).

**Recording/artifact layer**

- The recording artifact documentation comment that explains why `final-*` exists only for
  cumulative movements (already updated by PR #201; verify).
- The trace-service documentation comment that describes a reused session as "persistent".
- The core adapter contract comment that describes the session pool key as existing "when
  persistent".

**Musician adapter layer**

- Pi adapter session-tracking comments that label per-session working directory and skill
  maps as "persistent session" state.
- Opencode adapter turn-aggregation comment that describes a reused session as "persistent
  (reused)".
- Opencode adapter test description that says "reusing a persistent session".

**Cross-package docs and guidelines**

- Operator README (session and recording sections, examples, config snippets) — already
  updated by PR #201; verify consistency.
- Project guidelines (AGENTS.md) session-reuse bullet — already updated by PR #201; verify.
- Session ADR: only the filename-preservation note and the alias-removal milestone remain;
  its context, decision, and consequences are already correct.
- Opencode-adapter ADR: session section heading, capability bullet, and the pattern
  reference to the session ADR.
- Child-concert-lifecycle ADR: inbound reference to the session ADR must remain valid.

**Examples**

- Example scores that set the program option, including the opencode demo and any other
  example carrying a `program:` block (verify, do not assume).

**Tests**

- The recording integration test suite (per-attempt vs. cumulative artifacts, mode in the
  movement index).
- A new Conductor-level integration test that asserts the session identifier handed to
  the Musician: cumulative passes the movement session key on every attempt (including a
  re-visited movement), fresh passes none. This is the missing coverage that proves the
  single resolution point drives the session identifier and not only the artifact mode.
- The Musician adapter suites (Pi and opencode), which already exercise session reuse and
  disposal at the adapter level; they remain the regression cover for disposal lifetime.
- The Conductor integration/use-case suites as general regression, noting they do not
  currently exercise session reuse or disposal directly.
- The opencode adapter test suite: rename the test description; no behaviour change.

## Behaviour and contract changes

- **Public score contract.** `reuseSession?: boolean` is canonical; default `true`
  (cumulative). `persistSession?: boolean` remains accepted, is marked deprecated, and
  yields to `reuseSession` when both are present. No other program field changes.
- **Runtime behaviour.** Unchanged for every existing score: `true`/omitted reuses the
  per-movement session across re-visits; `false` starts every execution fresh. The alias
  produces byte-for-byte the same runtime behaviour as before the rename.
- **Observability.** A score that still uses the legacy key produces one deprecation
  warning per concert construction via `console.warn`, naming the score and instructing the
  rename; when both keys are present the warning additionally states that `reuseSession`
  takes precedence.
- **Recording contract.** Unchanged: per-attempt transcript always written; aggregated
  final copy only in cumulative mode.
- **No change** to the session identifier scheme, session disposal lifecycle, adapter
  interface, or movement-level precedence (deferred to #203).

## Migration story (decided)

Adopt the **deprecated alias** path, matching PR #201 and the issue's recommendation:

- Existing scores with `persistSession` continue to load and run identically.
- The legacy key is honoured with a deprecation warning.
- `reuseSession` wins when both keys are present.
- The ADR and README document the rename as behaviour-identical; migration is renaming one
  key.
- The ADR's rename note states an explicit removal milestone for the alias (for example,
  the next minor after 0.1.0) so the deprecated field does not become permanent. The alias
  is not removed in this change.

## Acceptance criteria coverage

1. **Rename throughout the codebase** (program contract, Conductor logic, score reference,
   README, examples, design notes, project guidelines, score-authoring skill): PR #201
   covers the core contract, Conductor, README, examples, guidelines, and skill reference.
   This plan closes the remaining surfaces: the opencode-adapter ADR, the core adapter
   contract comment, the trace-service comment, the Musician adapter implementation
   comments and adapter test description, and the session ADR governance notes.
2. **Decide and document migration**: deprecated alias, documented in the session ADR and
   README, plus an explicit alias-removal milestone.
3. **Reword all documentation unambiguously** (in-concert reuse; transcripts recorded in
   both modes): conceptual sweep across operator, design, contributor, authoring documents,
   source comments, and adapter test descriptions.
4. **Semantics-pinning test** (fresh mode still writes the per-attempt transcript; cumulative
   additionally writes the aggregated final copy): recording integration test parameterised
   across default, explicit `true`, and explicit `false` (already present in PR #201;
   verify).
5. **Legacy-key test** (honoured, warns, yields to `reuseSession`): integration test
   asserting the resulting mode and the console warning, including the both-keys precedence
   case (already present in PR #201; verify).
6. **`pnpm typecheck && pnpm test` pass**: final verification gate.

## Test strategy

**Unit**

- Session-mode resolver: default (omitted program, omitted key) → cumulative; explicit
  `reuseSession: false` → fresh; explicit `true` → cumulative; lone legacy key honoured both
  directions; both keys present → `reuseSession` wins and the resolver reports the legacy
  key as present-but-ignored; no program at all → cumulative. Assert no throw on
  malformed/absent program.

**Integration (Conductor + ConcertHall + stores/recording)**

- Parameterised recording test over default / `reuseSession: true` / `reuseSession: false`:
  movement index records the expected mode; the per-attempt directory and native transcript
  always exist; the aggregated final artifact exists only in cumulative mode.
- Session-identifier hand-off test: with the cumulative default, the Musician observes the
  movement session key on each execute, including an attempt of a movement that is
  re-visited via a loop-back or retry; with `reuseSession: false`, the Musician observes no
  session key on any attempt. This asserts the resolved mode drives the identifier passed to
  the adapter, not just the recorded artifact mode.
- Legacy-alias integration test: a score using only the legacy key runs with the expected
  mode and emits exactly one deprecation warning; a score using both keys resolves to
  `reuseSession` and emits the precedence warning. Observe the warning via the standard
  console spy, consistent with the codebase's direct-console convention.
- Regression: the Musician adapter suites (Pi and opencode) already cover reuse and
  disposal — same session id reuses without disposal, distinct session ids are isolated,
  and dispose releases a tracked session — and must stay green. Existing Conductor/use-case
  suites are general regression only; they do not currently exercise session reuse or
  disposal.

**Adapter**

- Rename the opencode adapter test description that says "persistent session" to reuse
  wording; behaviour unchanged, test must stay green.
- Existing Pi and opencode adapter suites pass unchanged, confirming the comments-only
  sweep did not alter adapter behaviour, preserving the adapter-level reuse/disposal
  regression coverage.

**Type/contract**

- `pnpm typecheck` accepts the deprecated alias and the canonical key without conflicting
  declarations.

**End-to-end**

- A real harness adapter run is not required; the existing fake-adapter recording harness is
  the appropriate deterministic boundary. Existing adapter suites run as part of
  `pnpm test`.

## Risks, unknowns, and assumptions

**Risks**

- **Warning ergonomics.** Resolving in the Conductor constructor emits a warning per concert
  construction; nested/child concerts or repeated concert creation can repeat it. Keep it
  one-per-concert and use the established `console.warn` convention; do not add a parallel
  logging abstraction.
- **Incomplete sweep.** A rename done only by literal string search misses conceptual
  references (the opencode ADR, the core adapter and trace comments, the Musician adapter
  implementation comments, the adapter test description). The plan treats these as explicit
  deliverables.
- **Alias permanence.** A deprecated alias with no removal milestone leaves the misleading
  name in the public contract indefinitely. The plan requires a stated removal point in the
  ADR rename note.
- **ADR filename mismatch.** The session ADR's filename will still say "persistence" while
  its title says "reuse". This plan intentionally preserves the filename to keep inbound ADR
  references valid; the trade-off is recorded in the ADR.
- **Coupling to #203.** A resolver built narrowly for the score level with no clean
  extension seam would force #203 to duplicate logic; keep the resolver input the natural
  place for a movement-level override.

**Unknowns / assumptions to validate**

- Whether maintainers prefer the deprecated alias or a hard break. Assumed: alias, per the
  issue's recommendation and PR #201.
- Whether the resolver should be exported from the core public surface for #203 or remain
  internal. Assumed: internal until #203 needs it.
- Whether any example score outside the opencode demo sets the option. The sweep verifies
  all examples.
- Whether gitignored local scores using the legacy key must be migrated. Assumed not — they
  are runtime state, not repository surfaces; the alias keeps them working.
- The exact future release at which the deprecated alias should be removed (to be pinned in
  the ADR).

## Out of scope

- Movement-level `reuseSession` override (#203).
- Cross-concert session restore or any durability feature.
- Changing the session-key scheme or the adapter interface.
- Removing the deprecated alias in this change.

## Verification checklist

- Core contract exposes `reuseSession` canonical, `persistSession` deprecated with a removal
  milestone and doc comments stating reuse-not-recording semantics.
- One resolution point feeds both the session identifier and the recorded mode, verified by
  a Conductor-level test that the session key handed to the Musician is present on
  cumulative (including a re-visited movement) and absent on fresh.
- Alias precedence and one `console.warn` per concert verified by test.
- Recording semantics pinned for all three modes.
- Conceptual sweep complete across README, session ADR, opencode-adapter ADR, project
  guidelines, score-authoring YAML reference, core adapter contract comment, trace-service
  comment, Musician adapter implementation comments, and adapter test descriptions;
  genuine disk-persistence wording intentionally preserved.
- Session ADR filename decision and inbound references documented; no already-reworded ADR
  prose re-asserted as outstanding.
- `pnpm typecheck && pnpm test` pass.
