# Implementation Plan — Issue #203: Per-movement `reuseSession` override of the score-level session-reuse default

**Issue:** sleekslush/orchestron#203 (open; labels `documentation`, `enhancement`, `follow-up`, `orchestron:in-progress`)
**Issue revision:** `2026-10-08T23:26:13Z` (body+comments digest `f49d263747bd362a20947e4d5a2bd8a67641db34b8bdf426219c526466d770f3`)
**Related merged PR:** sleekslush/orchestron#204 — "Complete reuseSession rename: terminology sweep, ADR governance, session-key tests (#200)" (merged). Explicitly states "#203 remains the follow-up for the movement-level override."
**Related closed issue:** sleekslush/orchestron#200 (CLOSED; blocked-by dependency, satisfied by #204). No open or linked PR addresses #203.

## Problem

Session reuse is configurable only at the score level through the score program's
`reuseSession` option. There is no way for one movement to diverge from the score
default: a mostly-cumulative score cannot make a single movement start fresh on every
attempt, and a mostly-fresh score cannot make a single movement retain its prior turns.

The `Movement` contract already carries movement-over-score overrides for `model`,
`provider`, and `skills`, but has no equivalent for session reuse. The Conductor resolves
one session mode per concert from the score program and applies it uniformly to every
non-subscore movement, deriving the movement session key from that single mode. Movement
sessions are already isolated per movement (`concertId:movementId`), so a per-movement
toggle changes only the session key handed to the Musician and the mode recorded for that
movement — it requires no change to the session-key scheme and introduces no
cross-movement context bleed.

The work extends the just-landed `reuseSession` semantics (#200, PR #204). The deprecated
`persistSession` alias stays score-level-only; a movement-level alias is explicitly out of
scope because the alias is slated for removal in 0.2.0.

## Relationship to linked pull requests

- **PR #204 (merged):** landed the `reuseSession` rename, the score-level resolver and
  alias handling, the terminology sweep, the session-key hand-off test, and the ADR
  governance note. It does not add movement-level resolution. **This plan proceeds
  independently on top of it**; no open PR for #203 exists (`closedByPullRequestsReferences`
  is empty), so there is nothing to extend or supersede.
- **Issue #200 (closed):** the former blocker. Its dependency resolution is recorded in the
  issue body and in the final refinement comment; this plan does not reopen it.
- Work remaining after this plan is exactly the movement-level contract field, per-movement
  resolution and recording, documentation for four audiences, and the new tests listed
  below.

## Architecture being aligned to

- **Layered core.** Contract types live in the core type modules; the Conductor is the
  sole runtime translating a `Score` into a `Concert`; ConcertHall only creates and
  indexes concerts; Loge persists concert/movement/usage rows; the per-concert recording
  tree holds live events and per-attempt session artifacts. The change belongs in the core
  contract and the Conductor runtime, nowhere else.
- **Movement-over-score precedence pattern.** `model`, `provider`, and `skills` already
  resolve at the movement site by preferring the movement value and falling back to the
  score value (for `skills`: `movement.skills ?? score.skills`). The session-reuse override
  must follow the same shape and be resolved at the same movement execution site, not at
  construction time.
- **Single resolution point for score-level alias logic.** The score-level resolver owns the
  `reuseSession`/`persistSession` mapping, the both-keys precedence, and the
  `deprecatedUsed`/`bothSet` flags. The movement override must compose with that resolution
  rather than re-implement alias logic.
- **Adapter (Musician) pattern.** Session reuse is expressed only as an optional session
  identifier passed to execute plus an optional dispose hook. The override must remain
  adapter-agnostic; no adapter contract changes.
- **Recording model.** Every attempt writes its own attempt directory and native
  transcript. Cumulative movements additionally aggregate a movement-level `final-*`
  snapshot; fresh movements do not. The mode is recorded in the movement index, the
  per-attempt trace row, and the concert index. The effective per-movement mode must flow
  into all four.
- **Score loading convention.** The score registry loads YAML by cast-and-trust for
  optional movement fields and validates only exhaustive/structural concerns (e.g. skills
  paths, required-context shape). An optional boolean needs no loader or schema change.
- **Diagnostics convention.** Runtime diagnostics use direct `console.warn`/`console.error`;
  there is no structured logger. The existing score-level deprecation warning must continue
  to fire unchanged.
- **ADR and documentation conventions.** Decisions live under the design-decisions area with
  status/date/related links; the same concept is documented once per audience: operator
  README, contributor guidelines, author-facing score-authoring skill reference, and design
  ADRs. The session ADR keeps its historical slug deliberately and is cross-referenced by
  the child-concert-lifecycle and opencode-adapter ADRs.
- **Skill reference indirection.** The Pi and Opencode plugin skill trees expose the
  score-authoring skill and its references as symlinks into the shared plugin-common skill
  tree. The real edit target is the shared reference; the symlinked copies stay valid
  automatically.

## Approach

1. **Contract change (core types layer).** Add an optional, documented
   `reuseSession?: boolean` to the `Movement` contract, alongside `model`/`provider`/`skills`.
   The doc comment must state: omitted means inherit the score-resolved value; set means
   override for this movement and its re-visits only; siblings and other movements are
   unaffected; reuse remains scoped to one concert and in-memory only; the field does not
   control disk recording. Do not add a movement-level `persistSession` alias.
2. **Resolution (core runtime layer).** Continue resolving the score-level mode once per
   concert in the constructor, including alias handling and its warning. Add a small pure
   helper in the session-mode module that composes the score-resolved `SessionMode` with an
   optional movement override: `undefined` → score mode; `true` → cumulative; `false` →
   fresh. Prefer this thin composer over widening the existing score-program resolver with a
   movement argument, so the alias/deprecation logic stays single-sourced and the
   score-level unit contract is unchanged. At the non-subscore movement execution site,
   resolve the effective mode from the movement and use it for both the derived session
   identifier and the recorded mode, replacing the current single-mode assignment.
3. **Recording (core runtime layer).** The effective per-movement mode already drives the
   movement-mode map that feeds the movement index, the per-attempt trace row, the
   cumulative-vs-fresh final-snapshot decision, and the concert index. Ensure the effective
   mode is stored in that map before recording is set up, so both the per-attempt trace and
   the final artifact follow the override. Preserve the concert-index fallback: a movement
   that appears in concert history but was never executed has no mode-map entry and falls
   back to the score-level resolved mode.
4. **Subscore behavior (core runtime layer).** Subscore movements return before session
   resolution, so the parent creates no session for them and the movement-level field is a
   documented no-op; nested session behavior is governed by the child score. Do not add a
   validation gate. Update the movement contract comment and author docs to say so.
5. **Documentation sweep (all documentation surfaces).** Document the override once per
   audience with consistent wording:
   - operator README session-reuse section (state precedence and both directions);
   - the session ADR's config-knob and conductor-behavior sections (keep the historical
     filename; state that the alias remains score-level only and that the override wins
     while the score-level warning still fires);
   - the author-facing score-authoring YAML reference movement-field table and, if useful,
     a short cross-reference from the program-field row;
   - the contributor guidelines' core architectural rule 4;
   - add the movement field to an example score only if an example benefits; otherwise state
     that existing examples remain valid because the field is optional.
   Also sweep conceptual wording (not just literal strings) across source comments and test
   descriptions that currently describe the mode as a single score-level decision.
6. **Tests.** Add a unit test for the new composer covering omitted/true/false and the
   interaction with the score-resolved value; extend the Conductor-level precedence tests to
   mirror the existing skills/model precedence tests in both override directions, asserting
   that only the overriding movement's mode and session key change and that siblings inherit
   the score default; assert the recorded mode in the movement index and concert index and
   the final-snapshot behavior; assert the score-level alias warning still fires when a
   movement override is present and that the override wins; assert the subscore no-op.
   Re-run the existing session-key hand-off coverage for the cumulative and fresh defaults.

## Affected components and architectural layers

- **Core contract types layer:** the `Movement` interface (new optional field plus doc
  comment); the score program contract is unchanged (its `reuseSession`/`persistSession`
  surface is preserved for score-level compatibility).
- **Core runtime layer (session-mode module):** the existing score-level resolver stays as
  the alias authority; add a pure per-movement composer over its `SessionMode` output.
- **Core runtime layer (Conductor):** the movement execution path that derives the session
  identifier and records the mode; the movement-mode map consumed by attempt finalization,
  final-snapshot handling, and concert-index writing; subscore delegation that returns
  before resolution.
- **Core recording surfaces:** the movement index mode field, the per-attempt session trace
  mode field, the cumulative/fresh final-snapshot decision, and the concert index per-movement
  mode (including its never-executed fallback). Interfaces are already typed to the two-value
  mode and need no shape change.
- **Core registry/loading:** no change expected; verify the cast-and-trust convention for
  optional movement fields still holds.
- **Adapter packages:** no contract change; the behavior is honored through the existing
  session identifier hand-off.
- **Documentation surfaces:** operator README session/recording sections; the
  session-persistence ADR; the shared score-authoring skill YAML reference (and its
  plugin-pi/plugin-opencode symlinked presentations); the contributor guidelines core
  architectural rule 4; example scores as applicable.
- **Test surfaces:** the session-mode unit suite; the Conductor/recording integration
  suites that cover precedence, session-key hand-off, mode recording, alias warning, and
  subscore behavior.

## Behavior and contract changes mapped to acceptance criteria

- **Contract field:** `Movement.reuseSession?: boolean` with a doc comment covering omitted
  inheritance, movement-and-revisits-only scope, and recording neutrality.
- **Effective mode:** per non-subscore movement, `movement.reuseSession` when present,
  otherwise the score-level resolved mode; both the session identifier and recorded mode
  derive from it.
- **Both directions:** `false` on a reuse-default score makes only that movement fresh;
  `true` on a fresh-default score makes only that movement reuse. Siblings are unaffected.
- **Alias scope:** the deprecated `persistSession` alias remains score-level only and is
  ignored at the movement level; the score-level warning still fires; a movement override
  wins over the score-resolved mode but does not suppress the warning.
- **Recording:** the movement index, per-attempt trace mode, cumulative final-snapshot
  decision, and the concert index all reflect the effective mode; history-only,
  never-executed movements fall back to the score-level mode.
- **Subscore no-op:** documented, with no validation gate.
- **Docs:** the four named surfaces updated consistently.
- **Verification:** `pnpm typecheck && pnpm test` pass.

## Ambiguities resolved

- **"The score reference":** this means the score-level `reuseSession` field on the score
  program contract, whose resolved `SessionMode` is the fallback for the movement override.
  It is not a YAML file reference or a score-id reference.
- **Movement-level alias:** the issue's "leaning no" is adopted — no movement-level
  `persistSession`; the field is a single canonical `reuseSession` override.
- **Resolver shape:** extend the session-mode area with a small composer rather than
  changing the existing score-level resolver's signature. This keeps score-level alias logic
  single-sourced and preserves existing unit expectations.
- **Subscore recording:** since subscore movements never reach the mode map, the concert
  index continues to fall back to the score default for them; this is intentional and
  documented, not a defect.
- **Filename preservation:** the session ADR keeps its historical slug; inbound references
  from the child-concert-lifecycle and opencode-adapter ADRs remain valid and must not be
  "fixed".
- **Real edit target for skill docs:** update the shared plugin-common score-authoring YAML
  reference; the plugin-pi and plugin-opencode presentations are symlinks and require no
  separate edit.
- **Example scores:** no example change is required because the override is optional;
  reference the new field in documentation instead, and only add it to an example if a
  concrete scenario needs it.

## Surface inventory

Behavior, contract, and terminology surfaces the change reaches:

- Core contract type for movements; the core session-mode module; the Conductor movement
  execution, mode tracking, subscore delegation, and concert-index writing areas.
- Core recording interfaces for movement index, attempt trace, and concert index (mode
  fields are consumed, not reshaped).
- Core registry/loading behavior for optional movement fields (verify only).
- Adapter session hand-off behavior in both Musician packages (consumed, not changed).
- Operator README session-reuse and recording sections.
- Session-persistence ADR (config knob, conductor behavior, rename/alias lifecycle), with
  its preserved filename and its inbound references from the child-concert-lifecycle and
  opencode-adapter ADRs.
- Shared score-authoring skill YAML reference, exposed through the plugin-pi and
  plugin-opencode skill trees by symlink.
- Contributor guidelines core architectural rule 4.
- Example scores (checked for consistency; unchanged unless a scenario benefits).
- Session-mode unit tests; Conductor precedence tests analogous to the existing
  skills/model precedence tests; recording integration tests for mode, final snapshot, and
  session-key hand-off; the alias-warning test; the subscore no-op test.
- Source comments and test descriptions that describe session reuse as a single
  score-level decision.

## Test strategy

- **Unit (session-mode module):** the score-level resolver's existing cases remain; add
  cases for the composer — omitted inherits the score value, explicit `true` yields
  cumulative, explicit `false` yields fresh, and the score value is not mutated. This is the
  cheapest place to pin both directions and the fallback.
- **Integration (Conductor):** register a score with at least two movements and a route that
  re-visits the overriding movement; assert the session identifier and recorded mode for the
  overriding movement change while the sibling keeps the score default, for both override
  directions. Mirror the structure of the existing skills/model precedence tests so the new
  behavior is provably consistent with the established pattern. Include a re-visit/retry so
  the per-visit behavior is exercised, not just a single execution.
- **Recording integration:** assert the movement index mode, the concert index mode, the
  per-attempt trace mode, and the presence/absence of the cumulative `final-*` snapshot
  match the effective per-movement mode; assert the history-only fallback to the score-level
  mode.
- **Alias scope:** with a score-level legacy alias present and a movement override set,
  assert the deprecation warning still fires and the movement override determines the mode.
  Assert that a movement-level `persistSession` key has no effect (it is not a recognized
  contract field).
- **Subscore:** assert a subscore movement produces no parent session and that the
  movement-level field is inert for it.
- **Regression:** keep the existing cumulative/fresh session-key hand-off test passing, and
  run `pnpm typecheck && pnpm test`.

## Risks, unknowns, and assumptions to validate

- **Precedence semantics of `??` vs alias:** the plan resolves the override against the
  already-resolved score mode, so a score-level legacy alias still resolves first and the
  movement override then wins. Validate that this matches the issue's "movement override
  winning" while the warning still fires.
- **Mode-map timing:** confirm the effective mode is stored before the recording object and
  per-attempt trace are built, or the trace/movement index will record the wrong mode.
- **Never-executed movements:** confirm they truly have no mode-map entry so the
  concert-index fallback applies; if some path pre-populates the map, the fallback would be
  masked.
- **Registry validation:** confirm optional movement fields are cast-and-trust and that no
  exhaustive movement-key validator rejects the new field; if one exists, add minimal
  typing rather than a run-time gate.
- **Symlinked skill references:** confirm the plugin skill trees are symlinks so the single
  shared reference edit propagates; if any copy is materialized, update it too.
- **Terminology drift:** a literal search for `reuseSession` will not catch comments and
  test descriptions that describe the mode as a single score-level decision; sweep
  conceptually.
- **Subscore nesting:** the parent does not create a session for subscore movements;
  confirm nested behavior is fully governed by the child score and that documenting it as a
  no-op does not conflict with child-level overrides (which are a separate score).
- **Assumption:** no adapter contract or session-key scheme change is needed; sessions stay
  keyed `concertId:movementId`. Validate against both Musician packages.

## Definition of done

- `Movement.reuseSession` exists with a precise doc comment; the deprecated alias remains
  score-level only.
- Effective mode resolves per non-subscore movement and drives both session key and
  recorded mode; siblings and the score-level warning behavior are preserved.
- Recording surfaces and the never-executed fallback record the correct mode.
- Subscore no-op documented.
- README, session ADR, score-authoring YAML reference, and contributor guidelines updated
  with consistent wording.
- New unit/integration tests cover both override directions, sibling inheritance, session-key
  hand-off, mode recording, alias scope, and the subscore no-op.
- `pnpm typecheck && pnpm test` pass.
