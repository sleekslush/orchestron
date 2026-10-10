# Deterministic Run Movements

Date: 2026-10-08
Status: Accepted

## Context

Every score movement was a stochastic LLM session, even mechanical pipeline
glue. The `claim` movement in the global `github-issue-*` scores only invokes
`labels.sh claim` and honors its exit codes, yet it cost an executor session plus
an `llm_judge` evaluator session to infer, from prose, a lock state the helper
already returns as ground truth. `fail_cleanup` had the same character, and the
implement score's `claim` additionally bundled branch creation (different
cleanup obligations). A lossy trust chain (agent obeys prompt → reports
honestly → judge infers) wrapped around exit codes that already fully encode the
outcome.

## Decision

Add a first-class, bounded, deterministic movement kind, `type: run`, executed by
the Conductor directly. It is not a harness and not a `ShellAdapter`.

- **Command form: argv only, no shell.** `command` is a non-empty array executed
  with `execve` semantics: per-element templating, no word splitting, globbing,
  or shell interpretation. A leading `~/` in an argv element or `cwd` expands to
  the home directory; env values are literal after templating. Pipelines/globs
  are written explicitly as `["bash", "-lc", "..."]`. No single-string form and no
  `shell: true`.
- **Exit-code outcomes.** A per-movement `outcomes` map routes exit codes to the
  existing `success`/`failure`/`rejection` taxonomy. Omitted means `0 → success`,
  otherwise `failure`. The map *is* the evaluation: no adapter, session, or
  evaluator is involved. For a run movement `rejection` is a control-flow
  outcome ("the step's post-condition was not met and an alternate deterministic
  path applies"), not a judged goal rejection.
- **Result shape.** Each attempt captures `exitCode`, `stdout`, and `stderr`
  separately. The record persists `exitCode`, `output` = stdout verbatim,
  `structured` = parsed stdout when `output.mode: structured`, a one-line
  `summary`, and on a non-success outcome
  `error = { code: 'EXIT_NONZERO', message: <first stderr line> }`. Streams are
  never merged.
- **Measured `$0`.** A run step is genuinely free, so spend is measured `$0`
  (never "unmeasured"/unknown), preserving the distinction in
  `spend-resolution.md`.
- **Streaming, not buffering.** stdout/stderr are appended incrementally to
  per-attempt `stdout.log`/`stderr.log` and emitted as `movement:progress`
  (`run_start`/`run_stdout`/`run_stderr`/`run_exit`). Partial logs survive
  abort.
- **Templated-output normalization.** The bare
  `{{context.previousOutputs.<id>}}` accessor for a run record returns stdout
  with one trailing line terminator removed, mirroring POSIX
  command-substitution semantics. Structured accessors return parsed leaves and
  are unaffected; harness output is untouched.
- **Arrows-only lifecycle.** Run steps execute when the DAG reaches them and
  drive transitions like any movement. Nothing special runs on cancel/abort:
  the child is killed, partial logs remain, and the movement resolves to a
  technical `failure`. Guaranteed cleanup for crashed/cancelled runs is stale-lock
  reclamation (#168), not a run step.
- **No execution trust gate.** Run steps execute with the host user's
  privileges. Scores are executable code; the README and score-authoring
  reference say so plainly.

The event union is unchanged: the run command rides in a reused
`movement:progress` event, so existing consumers keep working.

## Consequences

- The `claim`/branch/cleanup flows in the global `github-issue-*` scores become
  deterministic, reviewable argv with exit-code transitions, removing two LLM
  sessions per concert from the critical path.
- Authors must treat score files as scripts. This is documented prominently
  rather than mitigated.
- `goal` is now optional on the movement type; the registry enforces it per kind
  and rejects fields that belong to the other kind, so an author cannot silently
  mix them.
- Schema evolution adds `exit_code` and `kind` columns via the existing
  idempotent `ALTER TABLE` migration pattern; omitted `type` remains `harness`,
  so existing scores need no migration.
- Run movements count toward movement, section, and program duration limits;
  `retryOnFailure` applies to mapped failures and `retryOnRejection` is
  rejected.
