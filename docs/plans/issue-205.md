# Implementation Plan — Issue #205 (Revision 3)

**Issue:** Add deterministic (non-LLM) `type: run` score movements, validated on the issue-claim step
**Repository:** sleekslush/orchestron
**Issue revision:** updated `2026-10-08T23:26:13Z`; body/comments sha256 `439f7d1b2cb709d9cbc33b896ed65381b3dacd0be19a4ad48a25a72d191f8f39`
**Status of plan:** ready for implementation
**Revision note:** Revision 3 pins the templated-output normalization rule for run movements so that raw stdout can be safely embedded in a later argv element or env value (the branch-preparation chain depends on it), states the `~/` rule for env values, and gives the rationale for using the `rejection` outcome on the branch-existence check.

---

## 1. Problem Statement

Every score movement is currently a stochastic LLM session, even when the work is
mechanical pipeline glue. The clearest example is the `claim` movement in the
`github-issue-implement` and `github-issue-triage-refine` scores: it exists only to
invoke the issue-labels helper (`labels.sh claim`) and honor its exit codes, yet it
costs an executor LLM session plus an `llm_judge` evaluator session to infer, from
prose, a lock state the helper already returns as an exit code. `fail_cleanup`
(also an LLM movement doing best-effort `labels.sh set … failed`) has the same
character. The implement score's `claim` additionally bundles branch creation, which
has different cleanup obligations from the lock claim.

The goal is a first-class, bounded, deterministic movement kind — `type: run` — for
mechanical, verifiable actions whose exit codes drive transitions. It is explicitly
not a general CI runner and not a `ShellAdapter`. The claim/lock + branch-create +
failure-cleanup flow in the two global `github-issue-*` scores is the validation
target.

### Relationship to other work / linked PRs

- No open or linked pull request references issue #205 (`gh pr list --search` returns
  none). The plan proceeds independently.
- #200 (`persistSession` → `reuseSession`) is **closed and merged**. The issue's
  references to that rename are a field-name coordination note only; there is no
  in-flight branch to rebase against. The run-movement work is independent.
- #168 (dead-concert detection / stale-lock reclamation) is **closed**. It owns the
  guarantee for crashed/cancelled runs. Run movements deliberately do **not** execute
  on cancel/abort or reclaim stale locks; that boundary is preserved here.

---

## 2. Architecture Alignment

The plan follows the architecture expressed in the repository, not a new one:

- **Adapter pattern (AGENTS.md):** each Musician implements a common harness
  interface; new adapters live in `adapter-*` packages. A deterministic run step is
  **not** a harness — its contract (argv, exit code, split stdout/stderr, no
  prompt/session/model) does not fit the harness execute/response contract, and it
  would muddy the adapter model. The issue's resolved decision to reject a
  `ShellAdapter` is honored.
- **Conductor is the sole runtime (AGENTS.md):** the Conductor resolves movements,
  performs execution, evaluates goals, and records to Loge + the per-concert stream.
  The run kind is therefore a **new execution arm inside the Conductor**, not a new
  runtime and not a new package.
- **Harness/evaluator separation:** evaluators are separate sessions. Run movements
  have no evaluator at all — the exit-code→outcome map *is* the evaluation, and it
  must never start a session.
- **Outcome taxonomy already exists:** `success`/`failure`/`rejection` and the
  transition matcher already model technical failure vs goal rejection. Run outcomes
  reuse this taxonomy and the existing `on:` transitions; `__end__`/`__fail__`
  terminal targets are unchanged.
- **Spend honesty (`docs/decisions/spend-resolution.md`):** spend is either measured,
  estimated, or unknown. A run step is genuinely free, so it is **measured `$0`**, not
  "unmeasured"/unknown. This preserves the distinction the ADR established.
- **Recording model (`README`, recording artifacts):** per-attempt directories under a
  per-concert tree, a movement index, per-attempt metadata, and a unified per-concert
  JSONL stream already exist. Run artifacts extend this layout; native-session
  handling is untouched and non-session steps already degrade to `undefined`.
- **SQLite migration pattern:** schema evolution is done with idempotent
  `ALTER TABLE … ADD COLUMN` guards in the Loge initializer. `exit_code` follows that
  exact pattern.
- **Registry validation:** scores are validated by the registry at load/register time
  in one place shared by the CLI and the plugin tools. Per-kind validation belongs
  there so both entry points get it.
- **Additive optional-field convention:** existing scores omit `type`; the issue
  prescribes an optional `type` defaulting to `harness`. A discriminated union
  (`HarnessMovement | RunMovement`) would be more type-safe but would break the
  convention and existing scores; the plan follows the issue and narrows internally
  with type guards. The same additive approach adds a movement-record `kind` so the
  template resolver can normalize run output without a runtime lookup.

---

## 3. Settled Decisions

These are decisions, not open questions. Section 12 lists only the residual
compatibility checks and external coordination.

### 3.1 Command form
`type: run` executes a non-empty argv array with `execve` semantics: per-element
templating, no word splitting, no globbing, no shell interpretation. A leading `~/`
in an argv element expands to the home directory (mirroring the existing config-path
expansion); everything else in argv is literal. Pipelines/globs/expansion are written
explicitly as `["bash","-lc","…"]`. No single-string form and no `shell: true`.

`~/` expansion applies to argv elements and to `cwd`. **Env values are literal after
template substitution** — they do not receive `~/` expansion, because an environment
value is an arbitrary string in which a leading `~/` is not necessarily a path. This
rule is stated once here and reflected in §3.8.

### 3.2 Result shape and spend
Each attempt captures `exitCode`, `stdout`, and `stderr` separately. The movement
record persists `exitCode` (new column + migration), `output` = stdout **verbatim**,
`structured` = stdout parsed by the existing structured-from-text parser when
`output.mode: structured`, `summary` = one human line, and on failure/rejection
`error = { code: 'EXIT_NONZERO', message: <first stderr line> }`. Spend is
`{ spend: 0, spendSource: 'measured' }`; no cost-resolver change is needed because
measured spend short-circuits resolution and the spend-backfill only touches rows
with null spend. Streams are never merged. The movement record also carries a
`kind: 'harness' | 'run'` discriminator (default `harness`) so downstream consumers
and the template resolver can distinguish the kinds without a score lookup.

### 3.3 Outcome mapping and the pinned claim exit-code table
A per-movement `outcomes` map routes exit codes to `success` / `failure` /
`rejection`; keys are numeric exit codes or `default`. Omitted means
`0 → success`, otherwise `failure`. The mapping *is* the evaluation; the evaluator is
never invoked.

**Pinned mapping for both converted `claim` movements.** The helper's contract is
`0` success, `1` usage/unexpected/verification failure, `2` not in the expected
source state, `3` target already held. The issue body fixes `0` success, `3`
back-off-as-rejection, `1`/`2` failure:

| `labels.sh claim` exit | Meaning | Outcome | Triage `claim` target | Implement `claim` target |
|---|---|---|---|---|
| `0` | claim succeeded | `success` | `assess` | branch preparation (see §3.4) |
| `1` | usage / verification failure | `failure` | `fail_cleanup` | `fail_cleanup` |
| `2` | not in expected source state | `failure` | `fail_cleanup` | `fail_cleanup` |
| `3` | target already held (another run owns it) | `rejection` | `__end__` | `fail_cleanup` |
| any other | unexpected | `failure` | `fail_cleanup` | `fail_cleanup` |

This preserves the issue's required divergence for exit `3`: triage ends gracefully
(`rejection → __end__`), implement cleans up (`rejection → fail_cleanup`).

**Explicit behavior change for exit `2`.** Today the evaluator judges "lock not held"
and an exit-2 refusal is reported through the movement's goal as not achieved, which
maps to `rejection → __end__` in triage. Under the pinned table, exit `2` is a
`failure`, so triage routes it to `fail_cleanup` (and thus `__fail__`) rather than a
graceful end. This is intentional: "the state changed underneath us" is an error that
needs visibility, not a clean back-off. It is called out because it is the one
observable semantic change beyond the removal of the LLM/evaluator. In implement,
exit `2` already ended at `fail_cleanup` via `rejection`, so there is no observable
destination change. Tests pin all of `0`, `1`, `2`, `3`, and `default`.

### 3.4 Branch creation — deterministic, not a harness movement in disguise
Per Goal 2, branch creation is deterministic run movements. Because argv-only
execution has no shell conditionals, "create-or-reuse" is expressed with explicit
deterministic steps whose exit codes drive transitions. Machine-consumed values are
passed between steps through **structured output**, not raw stdout text, so no
trailing newline can leak into an argv element (see §3.9). The implement score's
branch preparation is:

1. **Resolve base** (run): `gh repo view <repo> --json defaultBranchRef`, declared
   with `output.mode: structured`. stdout is a JSON object; the next step references
   the parsed leaf `{{context.previousOutputs.resolve_base.defaultBranchRef.name}}`,
   which stringifies to the branch name (`main`) with no trailing newline. Outcomes
   `{0: success, default: failure}`. `success → fetch origin`; `failure →
   fail_cleanup`.
2. **Fetch origin** (run): `git fetch origin`. Outcomes `{0: success, default:
   failure}`. `success → check branch`; `failure → fail_cleanup`.
3. **Check branch** (run): `git rev-parse --verify --quiet
   refs/heads/orchestron/issue-<n>` — the step's post-condition is "the branch already
   exists". Outcomes `{0: success, 1: rejection, default: failure}`. `success`
   (exists) `→ reuse branch`; `rejection` (absent) `→ create branch`;
   `failure → fail_cleanup`.
4. **Create branch** (run): `git checkout -b orchestron/issue-<n>
   origin/{{context.previousOutputs.resolve_base.defaultBranchRef.name}}`. Outcomes
   `{0: success, default: failure}`. `success → implement`; `failure → fail_cleanup`.
5. **Reuse branch** (run): `git checkout orchestron/issue-<n>`. Outcomes `{0:
   success, default: failure}`. `success → implement`; `failure → fail_cleanup`.

The `check`/`create`/`reuse` trio makes each argv reviewable and each exit code
deterministic; the create-or-reuse decision is an outcomes-driven transition, not
agent judgment. No branch step modifies, stages, or commits files.

**Why the check step uses `rejection`.** Run movements have no goal, so `rejection`
is not a judged goal rejection. In the run-outcome vocabulary it is a control-flow
outcome meaning "the step's intended post-condition was not met and an alternate
deterministic path applies" — here, "the branch does not exist, so create it." The
ADR records this control-flow reading of `rejection` explicitly so authors do not
read it as a real evaluator rejection. The `success` path means "branch already
exists, reuse it."

The exact argv and exit codes are authored in the external score repository (§7),
where the target git version is pinned. If an author chooses raw stdout instead of
structured output, the normalization rule in §3.9 is the safety net that keeps a
single trailing newline from corrupting the argv.

### 3.5 Streaming contract — incremental, not buffered
Run stdout/stderr are streamed **incrementally while the child runs**, not buffered
until exit:

- The run arm spawns the child and attaches `stdout`/`stderr` data listeners.
- Each chunk is appended to the per-attempt `stdout`/`stderr` logs as it arrives
  (append semantics, so a partial log survives abort) and emitted as a
  `movement:progress` event (`progressType` `run_stdout` / `run_stderr`) with
  `payload.chunk`.
- On process exit a terminal `movement:progress` (`run_exit`) carries
  `payload.exitCode`; the movement record is then finalized and persisted.
- `status --watch`, the CLI live renderer, and the plugin start/wait progress
  renderers show the streamed chunks live.
- **Abort/timeout:** the child is killed; partial logs and already-emitted stream
  records remain on disk; the movement resolves to a technical `failure`, never a
  mapped outcome; no cleanup run movement executes (arrows-only lifecycle).
- Buffering was rejected: it hides progress, delays live rendering, and would lose all
  partial output on abort.

The Conductor run-arm description, the stream-record timing, and CLI/plugin `--watch`
rendering are all written to this single rule.

### 3.6 Lifecycle event contract — no change to the event union
The public event union is **not** changed. `movement:started` keeps its current shape
(`prompt?` stays undefined for run movements). The run command is carried in the
first reused `movement:progress` event (`progressType: run_start`,
`payload.command: string[]`), followed by `run_stdout` / `run_stderr` chunks and a
`run_exit` terminal event. `status` derives the currently running command from the
latest run-start progress payload, falling back to the existing tool-execution
progress heuristic for harness movements. This avoids widening the event union and
keeps every consumer that already reads `movement:progress` compatible; only the
`progressType` vocabulary expands.

### 3.7 Recording index and attempt metadata
The movement/concert recording index gains an optional `kind?: 'harness' | 'run'`
(default `harness`); `harness` is left `undefined` for run steps (a run step is not a
Musician). The run arm writes the per-attempt metadata record with a run discriminator,
the command, the exit code, the status, and the log filenames, so `session --attempt`
and the movement index can resolve run attempts. Native-session handling is untouched
and unknown harnesses already degrade to `undefined`.

### 3.8 Run-only movement fields
`cwd?: string` and `env?: Record<string, string>` live on the movement and are valid
only for `type: run`; they override the concert cwd and the Conductor process
environment. `timeoutMs` continues under the existing movement budget. Templating
applies to argv elements, `cwd`, and env values; only argv elements and `cwd` receive
leading-`~/` expansion, while env values stay literal (§3.1).

### 3.9 Templated-output normalization for run movements
`execve` has no shell to trim trailing newlines, and `output` is stored verbatim
(§3.2), so a naive substitution of run stdout into a later argv element would carry a
trailing newline and corrupt the argument (e.g. `gh --jq` emits `main\n`). The
result/template contract therefore normalizes run output at the substitution
boundary:

- The bare `{{context.previousOutputs.<id>}}` accessor for a movement whose record
  `kind` is `run` returns the run stdout with **one trailing line terminator removed**
  (`\r?\n`), mirroring POSIX command-substitution semantics. Leading and interior
  whitespace/newlines are preserved.
- Harness movement output is untouched — this normalization is scoped to run records
  so existing prompt behavior does not change.
- Structured accessors (`{{context.previousOutputs.<id>.<path>}}`) return parsed leaf
  values and are never affected by trailing newlines; they are the preferred way to
  pass machine-consumed values between run steps.
- Authors are guided to use `output.mode: structured` + dot-notation for run-to-run
  data flow; the raw accessor remains available for text and is safe for a single
  argv token thanks to the trimming rule.

This rule makes the §3.4 branch chain implementable as written whether the base is
passed as a structured leaf or as raw stdout.

---

## 4. Terminology and Conceptual Phrasing Sweep

A literal string search is insufficient. The phrase **"a movement runs a prompt
through a harness and is evaluated against a goal"** frames every movement as a
harness session. Under this change that framing must become:

> A **harness movement** runs a prompt through a harness session and is evaluated
> against a goal. A **run movement** executes a bounded argv command and maps its exit
> code to an outcome.

Sweep targets (**conceptual**, not string-only):

- The score-authoring skill's Concepts/Movement definition — currently defines a
  movement as always running a prompt through a harness and being evaluated against a
  goal.
- The score-authoring skill's YAML reference "Minimal Required Fields" and per-movement
  field table — `goal` is currently required for every movement.
- The score-authoring skill's transitions documentation — the `success`/`rejection`
  wording assumes evaluator-derived outcomes.
- The README core-concepts table and the "Writing a Score" / transitions sections —
  currently only describe evaluator-driven transitions.
- `AGENTS.md` Core Architectural Rules (#2 "Conductor … delegates to adapters") and
  the Scores section.
- Source comments and test descriptions that describe a movement as necessarily
  harness-backed (movement-execution comments, session-mode comments, recording-layout
  comments).
- The issue's own vocabulary is adopted verbatim: **run movement**, **harness
  movement**, **outcomes map**, **exit code**, **`EXIT_NONZERO`**, **measured $0**.

---

## 5. Surface Inventory

Named at the component/artifact level. `plugin-pi`/`plugin-opencode` skill copies are
symlinks into `plugin-common`, so editing `plugin-common` updates all three; the
symlinks are the cross-reference mechanism that keeps them valid.

### Core domain and contracts
- **Score type contract** — movement kind discriminator, optional `goal`, `command`,
  `outcomes`, `cwd`, `env`; re-exported through the core barrel.
- **Score registry validator** — the single per-kind validation authority.
- **Movement record contract** — new `exitCode` and `kind`; run-specific derivation of
  `output`/`structured`/`summary`/`error`.
- **Conductor execution engine** — run arm (spawn, incremental capture, timeout/abort
  kill, measured `$0`), skip adapter/session/evaluator, outcome mapping, record `kind`.
- **Transition resolver / outcome taxonomy** — unchanged contract; consumes the run
  outcome map.
- **Template resolver** — per-element argv/env/cwd templating and the §3.9
  run-output normalization.
- **Resource-usage / spend semantics** — measured `$0`.

### Events and observability
- **Event taxonomy and stream envelope** — no union change; run command carried in
  `movement:progress` `run_start`, chunks in `run_stdout`/`run_stderr`, terminal
  `run_exit`.
- **Recording artifacts** — attempt-dir run logs (`stdout`/`stderr`), index `kind`
  discriminator, and per-attempt metadata run fields.
- **Trace service** — per-attempt trace rows for run steps (unknown-harness/format
  fallback path).

### Persistence
- **SQLite Loge store and row mappers** — `exit_code` column, migration guard,
  insert/update/read mapping (and `kind` mapping if persisted on the record).

### Interfaces (CLI and plugin consumers)
- **CLI `status` command** — exit-code display, run progress live rendering, running
  command derived from the run-start progress payload.
- **CLI `start` command** — shares the movement output mapping, so run exit codes
  surface there too.
- **CLI `session` command** — route run movements to a log renderer; reject `--open`.
- **CLI output formatting / movement-to-output mapping** — include `exitCode`.
- **Plugin `get-status` projection** — explicit movement field mapping currently drops
  `exitCode`; must include it. Its `currentMovementProgress` is extended for run
  progress types.
- **Plugin `wait-for-concert` projection** — explicit movement field mapping currently
  drops `exitCode`; must include it, and its progress loop must render run progress
  types.
- **Plugin `start-concert` progress rendering** — render run progress types.
- **`list`/aggregate spend rendering** — must render measured `$0` as `$0`, not `~$0`
  or `unknown`.

### Documentation and guidelines
- **README** — core concepts, "Writing a Score", a deterministic-run subsection, the
  executable-code warning, recording layout, transitions.
- **`orchestron-score-authoring` skill (canonical, in `plugin-common`)**:
  - `SKILL.md` concepts and workflow guidance,
  - `references/yaml-reference.md` (required fields, movement field table, run fields,
    outcomes, templated-output normalization, validation rules, transitions),
  - `references/examples.md` (add a run/claim and branch example),
  - `references/patterns.md` (add a deterministic-step pattern).
  - Cross-reference validity: `plugin-pi` symlinks both `SKILL.md` and `references/`;
    `plugin-opencode` symlinks `SKILL.md` only (no `references/` symlink — a
    **pre-existing gap**, flagged but out of scope; do not "fix" silently).
- **`AGENTS.md`** — core architectural rules (Conductor directly executes run
  movements) and the Scores section.
- **`docs/decisions/`** — add a decision record for the run primitive (argv-only/
  no-shell, arrows-only lifecycle, no execution trust gate, exit-code outcome
  mapping, the control-flow reading of `rejection`, templated-output normalization,
  measured `$0`), matching the existing Status/Date/Related → Context → Decision →
  Consequences format.
- **Issue-labels skill docs** (`SKILL.md`, `references/labels.md`) — referenced as the
  exit-code contract; verified unchanged, no edit.

### External / cross-repo surfaces
- **Global `github-issue-implement` and `github-issue-triage-refine` scores** — real
  target is the `orchestron-scores` repository, reached through the
  `~/.orchestron/scores` symlink. These are the validation target and are **not
  committable from this worktree**; in-repo fixtures mirror their shapes.
- **`labels.sh` and its exit-code contract** — external, read-only; no edit.
- **Example scores** — optionally add a deterministic run example.

### Tests, fixtures, CI
- Core test suites (registry, conductor, store, recording, transition, template).
- CLI test suite (status/session/start/output).
- Plugin-common and plugin test suites (score tools, status/wait projections).
- Example/score fixtures (new run fixtures and a mixed run+harness concert).
- Build/CI: no new workflow; `pnpm typecheck && pnpm test` must stay green.

---

## 6. Approach — What Changes Conceptually

### 6.1 Two movement kinds
A movement declares `type: harness` (default; omitting it preserves today's behavior)
or `type: run`. Harness movements keep prompt/harness/model/provider/skills/goal. Run
movements declare a non-empty argv array and an outcomes map. The registry validates
each kind and rejects fields that belong to the other, so an author cannot silently
mix them.

### 6.2 Exit-code-first execution
For a run movement the Conductor does not resolve an adapter, does not create or reuse
a session, and does not call the evaluator. It templates each argv element, expands a
leading `~/`, spawns the process directly with host privileges, streams and captures
stdout/stderr incrementally (§3.5), and converts the exit code to an outcome via the
outcomes map (§3.3). The outcome flows through the existing transition resolver like
an evaluator-derived outcome. A synthesized goal evaluation (`achieved = outcome ===
'success'`) keeps the existing status/display machinery single-shaped; it is never a
real judge call. The record carries `kind: run`, and the template resolver applies
§3.9 normalization when that record's stdout is later interpolated.

### 6.3 Result and observability
Per-attempt logs and stream records are the raw record; the movement record carries
the exit code, stdout-derived output/structured, a one-line summary, and the
`EXIT_NONZERO` stderr message on failure/rejection. `status` shows the exit code and
renders streamed output; `session` renders run logs.

### 6.4 Lifecycle and budgets
Run movements are ordinary DAG participants. Nothing special runs on cancel/abort;
failure cleanup is a run movement reached via `on: failure`. They count toward
movement, section, and program-duration limits. `retryOnFailure` and the movement
timeout apply to mapped failures; `retryOnRejection` is rejected. Spend is measured
`$0`.

### 6.5 Executable-code posture
Because run steps have no trust gate, the README and score-authoring reference must
state plainly that run steps execute commands with the host user's privileges and that
score files are executable code to be treated like scripts. This is captured as an
ADR, not an omission.

---

## 7. Components/Areas Affected and Their Architectural Layer

| Component / area | Layer | Change |
|---|---|---|
| Score type contract (`Movement`, kinds, outcomes) | Domain model | Add `type`, `command`, `outcomes`, `cwd`, `env`; `goal` optional. |
| Movement record contract | Domain model | Add `exitCode` and `kind`; run-specific output/structured/error derivation. |
| Score registry validator | Validation boundary (CLI + plugins) | Per-kind required/rejected fields; `command`/`outcomes` shape checks. |
| Conductor execution engine | Runtime / orchestration | Run arm: spawn, incremental capture, timeout/abort kill, measured `$0`, `EXIT_NONZERO`; skip adapter/session/evaluator. |
| Conductor run loop | Runtime policy | Mapped outcome drives transitions; `retryOnFailure` applies; no rejection retry. |
| Transition resolver | Runtime policy | No signature change; consumes the run outcome. |
| Template resolver | Cross-cutting utility | Per-element argv/env/cwd templating plus §3.9 run-output normalization. |
| Event/stream contract | Domain model | No union change; `movement:progress` `run_start`/`run_stdout`/`run_stderr`/`run_exit`. |
| Recording artifacts + trace service | Observability/recording | Per-attempt run logs, index `kind`, attempt metadata run fields. |
| SQLite Loge + row mappers | Persistence | `exit_code` column + migration + mapping; `kind` mapping. |
| CLI `status`/`start`/output mapping | Interface (CLI) | Exit code display; run progress rendering; running command from run-start payload. |
| CLI `session` | Interface (CLI) | Run log rendering; reject `--open`. |
| Plugin `get-status`/`wait`/`start` projections | Interface (plugin) | Surface `exitCode`; render run progress types. |
| README | Documentation | Run movements; executable-code warning. |
| Score-authoring skill (SKILL/YAML ref/examples/patterns) | Documentation / agent guidance | Run fields, kinds, outcomes, normalization, validation, examples. |
| `AGENTS.md` | Project guidelines | Conductor directly executes run movements; score model. |
| `docs/decisions/` | Architecture decision record | New run-primitive ADR. |
| `orchestron-scores` (external) global scores | Validation target (cross-repo) | Convert claim, add branch movements, convert fail_cleanup. |
| Core + CLI + plugin tests/fixtures | Verification | New/updated coverage. |

---

## 8. Behavior and Contract Changes

### 8.1 Movement contract
- `type?: 'harness' | 'run'` — default `harness`.
- `goal?: Goal` — required for harness movements only.
- `command?: string[]` — required non-empty array of non-empty strings for run
  movements; `execve` semantics.
- `outcomes?: Record<string, 'success' | 'failure' | 'rejection'>` — numeric keys or
  `default`; omitted means `0 → success`, otherwise `failure`.
- `cwd?: string`, `env?: Record<string, string>` — run-only overrides.
- `budget.timeoutMs` applies; `budget.maxRetries` applies to `retryOnFailure`.

### 8.2 Result contract
- Persisted `exitCode?: number` and `kind: 'harness' | 'run'` (default `harness`).
- `output` = stdout verbatim; `structured` = parsed stdout when `output.mode:
  structured`; `summary` = one human line; on failure/rejection `error = { code:
  'EXIT_NONZERO', message: <first stderr line> }`.
- `usage = { spend: 0, spendSource: 'measured' }`.
- Synthesized `goalEvaluation` (`achieved = outcome === 'success'`).

### 8.3 Validation rules (per kind)
- Harness: `goal` required; `command`/`outcomes`/`cwd`/`env` rejected.
- Run: `command` required and well-formed; `outcomes` well-formed if present; reject
  `goal`, `harness`, `model`, `provider`, `skills`, `retryOnRejection`; additionally
  reject `prompt` and `subscore` (no execution meaning; failing loud prevents silently
  ignored authoring errors). Allow `output`, `retryOnFailure`, and `budget`.
- Graph validation (reachability, start movement, transition targets, cycles) is
  kind-agnostic and unchanged.

### 8.4 Templated-output contract
- Bare `{{context.previousOutputs.<id>}}` for a run-kind record returns stdout with one
  trailing line terminator removed; harness output is unchanged.
- Structured accessors return parsed leaf values and are unaffected.
- `~/` expands only in argv elements and `cwd`; env values are literal after
  templating.

### 8.5 Acceptance-criteria satisfaction and verification

- **Run argv + templating + `~/`, no adapter, no evaluator, measured `$0`** —
  §6.2/§3.1/§3.2; verified by a conductor integration test with no adapter registered
  and an evaluator spy asserted never called.
- **Per-movement `outcomes`; defaults; `retryOnFailure` on mapped failures** —
  §3.3/§6.2; verified with explicit and default maps, unknown codes, `default`, and a
  retried mapped failure.
- **Separate exit/stdout/stderr capture; `exitCode` persisted + migration;
  stdout-derived `output`/`structured`; stderr error message** — §3.2/§8.2; verified
  by store round-trip, migration, structured-from-stdout, and stderr-message tests.
- **Full stdout/stderr per attempt + streamed; `status` shows exit code; `session`
  renders logs** — §3.5/§3.6/§3.7; verified by stream/attempt/CLI tests and a live
  partial-output test.
- **Registry per-kind rejection + `command`/`outcomes` validation** — §8.3. The
  `persistSession` item is resolved: run movements bypass session resolution, so the
  program-level option is inert and there is no phantom movement field to reject.
- **Claim conversions verified against `labels.sh` 0/2/3; triage vs implement
  mappings** — §3.3 pins all of `0`/`1`/`2`/`3`/`default` and both transition targets;
  in-repo fixtures mirror them.
- **Branch split from claim; deterministic `fail_cleanup`** — §3.4 defines the
  deterministic branch movements with structured value passing (§3.9); `fail_cleanup`
  becomes a `set … failed` run movement.
- **README + score-authoring reference: host privileges; scores are executable code**
  — §4/§6.5 plus the ADR.
- **`pnpm typecheck && pnpm test` green** — §9/§10.

---

## 9. Test Strategy

### Unit
- **Registry validation (both kinds):** run requires a non-empty string argv; rejects
  `goal`/`harness`/`model`/`provider`/`skills`/`retryOnRejection`/`prompt`/`subscore`;
  harness rejects `command`/`outcomes`/`cwd`/`env`; bad `outcomes` keys/values and
  empty commands fail. Existing reachability/cycle tests remain.
- **Outcome mapping resolver:** default map, explicit numeric keys, `default`, unknown
  codes, and the pinned triage/implement tables of §3.3.
- **Template normalization (§3.9):** a run record's raw output with a trailing newline
  is trimmed by exactly one terminator when substituted; interior newlines and leading
  whitespace are preserved; a harness record's output is unchanged; structured
  accessors are unaffected.
- **Store/row mapping:** `exitCode` (and `kind`) round-trip; an older schema without
  `exit_code` migrates and reads back.
- **Structured-from-stdout:** `output.mode: structured` parses stdout; stderr is never
  merged; parse failure degrades consistently.

### Integration (Conductor)
- Run movement executes a real argv (Node executable + inline script or a portable
  command) with no adapter registered; evaluator spy asserts zero calls; exit
  code/stdout/stderr captured; spend measured `$0`.
- Per-element templating and leading `~/` expansion in argv and `cwd`; env values are
  literal; other characters/paths stay literal.
- **Pinned exit-code transitions:** triage `0→success→assess`, `3→rejection→__end__`,
  `1`/`2`/other `→failure→fail_cleanup`; implement `0→success→branch preparation`,
  `3→rejection→fail_cleanup`, `1`/`2`/other `→failure→fail_cleanup`; explicit
  `default`.
- **Branch-preparation chain:** structured base resolution passes a clean leaf value
  into the create argv (no trailing newline); exists→reuse and absent→create both
  reach the implement movement; a create failure routes to fail_cleanup.
- **Incremental streaming:** a command that emits stdout and stderr in stages produces
  stream records and partial attempt logs before exit; on abort/timeout the partial
  logs and records remain and the movement resolves to failure; no cleanup movement
  runs on cancel.
- `retryOnFailure` retries a mapped failure; `retryOnRejection` cannot be configured.
- Mixed run+harness concert: run movements count toward movement/section/program
  limits; measured `$0` accumulates without becoming unknown or `~$`.
- Recording: movement index marks the run kind with no harness session; attempt
  metadata carries command/exit/log filenames; trace rows degrade to the
  unknown-harness format.

### CLI
- `status --json` and human output include the exit code per movement; `status
  --watch` renders streamed run output and derives the running command from the
  run-start progress payload.
- `session` renders run stdout/stderr/exit for a run movement and rejects `--open`.
- `start` output includes the exit code via the shared movement mapping.

### Plugin
- `get-status` and `wait-for-concert` movement projections include `exitCode`.
- `start`/`wait` progress renderers surface run progress types.

### End-to-end / fixtures
- A deterministic score fixture whose `claim` mirrors the triage and implement shapes,
  covering exit codes 0/1/2/3/default and both mapping tables.
- A branch-preparation fixture covering structured base passing, exists→reuse, and
  absent→create, plus a create-failure path.
- Existing example scores remain valid (harness movements with omitted `type`).

### Cross-repo validation
- The actual `github-issue-*` scores in the `orchestron-scores` repository are
  converted and run there; the in-repo fixtures are the reproducibility net for this
  repository's suite. `labels.sh` is not modified.

### Build
- `pnpm typecheck && pnpm test` must pass; no new dependency (Node standard-library
  process spawning).

---

## 10. Steps

1. **Contract:** extend the movement type with the kind discriminator, `command`,
   `outcomes`, `cwd`, `env`, and optional `goal`; add `exitCode` and `kind` to the
   movement record; export through the core barrel.
2. **Validation:** add per-kind validation to the registry (required/rejected fields,
   argv/outcomes shape) while leaving graph validation kind-agnostic; unit tests.
3. **Outcome resolver:** add the pure exit-code→outcome mapping helper and tests,
   including the pinned §3.3 tables.
4. **Persistence:** add the `exit_code` column and migration guard, wire `exit_code`
   and `kind` mapping, and add store round-trip + migration tests.
5. **Template normalization:** implement the §3.9 run-output trailing-terminator rule
   in the template resolver and add unit tests proving harness output and structured
   accessors are unaffected.
6. **Execution arm:** implement the Conductor run branch — per-element templating, `~/`
   expansion, streaming spawn with cwd/env, incremental stdout/stderr capture and
   logging, timeout/abort kill, measured `$0`, `EXIT_NONZERO`, synthesized goal
   evaluation, record `kind`.
7. **Loop integration:** skip adapter/session/evaluator for run, use the mapped
   outcome for transitions and the existing `retryOnFailure` path, and ensure no
   rejection retry.
8. **Recording/streaming:** write per-attempt run logs, add the index `kind`
   discriminator and attempt metadata run fields, and emit `run_start`/`run_stdout`/
   `run_stderr`/`run_exit` progress events; integration tests.
9. **CLI:** surface `exitCode` in output/status/start; add the run-log renderer to
   `session` and reject `--open`; extend running-command derivation; update CLI tests.
10. **Plugin:** surface `exitCode` in `get-status`/`wait` projections and render run
    progress types in `start`/`wait`; update plugin tests.
11. **Score-authoring skill sweep:** update the canonical skill overview, YAML
    reference, examples, and patterns (including the §3.9 normalization rule and the
    control-flow reading of `rejection`); confirm the
    `plugin-pi`/`plugin-opencode` symlinks keep the copies valid.
12. **README + AGENTS.md:** document run movements, the executable-code warning, and
    the Conductor's direct-execution arm.
13. **ADR:** add the run-primitive decision record.
14. **Fixtures:** add representative run/claim/branch fixtures (structured base
    passing) and a mixed run+harness concert.
15. **External scores:** convert `claim`, add the deterministic branch movements, and
    convert `fail_cleanup` in the two global `github-issue-*` scores in the
    `orchestron-scores` repository (cross-repo; coordinate/link).
16. **Verification:** `pnpm typecheck && pnpm test` and a manual run-concert
    walkthrough of stream/attempt/status/session behavior.

---

## 11. Acceptance Criteria Coverage Summary

| Issue acceptance criterion | Plan section |
|---|---|
| Run argv + templating + `~/`, no adapter, no evaluator, measured `$0` | §3.1–3.2, §6.2, §8.5 |
| Per-movement `outcomes`; defaults; `retryOnFailure` on mapped failures | §3.3, §6.2, §8.5, §9 |
| Separate exit/stdout/stderr capture; `exitCode` persisted + migration; stdout-derived `output`/`structured`; stderr error message | §3.2, §8.2, §9 |
| Full stdout/stderr per attempt + streamed; `status` exit code; `session` logs | §3.5–3.7, §8.5, §9 |
| Registry per-kind rejection + `command`/`outcomes` validation | §8.3, §8.5, §9 |
| Claim conversions verified against `labels.sh` 0/2/3; triage vs implement mappings | §3.3, §5, §8.5, §9, §10 |
| Branch split from claim; deterministic `fail_cleanup` | §3.4, §3.9, §8.5, §10 |
| README + score-authoring reference: host privileges; executable code | §4, §5, §6.5, §8.5, §10 |
| `pnpm typecheck && pnpm test` green | §9, §10 |

---

## 12. Risks, Unknowns, and Assumptions to Validate

These are residual checks and external coordination, not decisions left open. The
architecture-shaping choices (command form, outcome mapping, streaming, events,
recording index, run-only fields, templated-output normalization) are settled in §3.

- **Branch-exists detection:** the design uses an explicit existence check
  (`rev-parse --verify --quiet`) whose return codes (`0` found, `1` absent, other
  fatal) are stable across git versions; validate on the target git and keep the
  codes encoded in the score's outcomes map.
- **`gh --json` shape:** the base-resolution step assumes `gh repo view --json
  defaultBranchRef` emits the documented object shape so the structured dot-path
  resolves; verify against the target `gh` version and prefer the structured path over
  raw stdout.
- **Process cleanup on abort/timeout:** confirm the child (and any descendants) is
  terminated, partial logs are flushed, and no orphan processes remain.
- **Incremental stream volume:** high-volume stdout could produce many small stream
  records; confirm the append path and consumers handle chunk granularity, and
  consider coalescing chunk emission if needed without changing the incremental
  contract.
- **Cross-repo coordination:** the global `github-issue-*` scores live in the
  `orchestron-scores` repository behind a symlink and cannot be committed here;
  land/coordinate that change and keep the in-repo fixtures in sync.
- **Measured `$0` aggregate semantics:** a run-only concert now reports `$0` measured
  rather than unknown; confirm this is desired and that mixed concerts keep honest
  measured/estimated splits.
- **Plugin log scoping:** `exitCode` is surfaced through the plugin status/wait
  projections and run progress types are rendered, but full run-log rendering stays in
  the CLI `session` command plus the on-disk logs/stream; confirm this scoping is
  acceptable.
- **Windows:** path/env/process semantics are POSIX-oriented (leading `~/`); no Windows
  support is assumed.
- **Versioning:** the score `version` bump and any format-compatibility note are the
  implementer's call; the contract is backward compatible (omitted `type` = harness),
  so no score migration is required.
- **`persistSession` wording:** the issue lists a program-level option among
  movement-level rejections; confirmed resolved by bypassing session resolution, but
  worth a note in the implementation PR so reviewers see it was considered.
