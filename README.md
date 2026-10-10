# Orchestron

Workflow orchestration for AI harnesses.

Orchestron turns multi-step, agentic work into repeatable, observable, and
budget-aware workflows. Define a **Score** (a DAG of **Movements**), pick a
harness (Pi, opencode, or future adapters), and let a **Conductor** run the
**Concert** while tracking spend, tokens, and state in a local SQLite store
(`Loge`), with a raw session stream per concert at
`~/.orchestron/concerts/<concertId>/stream.jsonl` and replayable native session
snapshots per attempt.

## Why Orchestron?

- **Repeatable workflows** — encode your planning/execution/review loops as YAML
  scores instead of one-off prompts.
- **Harness-agnostic** — run movements on Pi, opencode, or future adapters through
  the same interface.
- **Observable** — concerts, movements, outputs, and goal evaluations are
  persisted to a local SQLite database (`Loge`); every raw harness-session event
  (prompts, tool activity, message deltas) is streamed verbatim, in order, to a
  per-concert `stream.jsonl`, with replayable native session files per
  attempt under `~/.orchestron/concerts/<concertId>/`.
- **Budget-aware** — set spend, movement, and duration limits at the score or
  section level.
- **Composable** — scores can spawn sub-scores as child concerts.

## Core Concepts

| Term | Meaning |
|---|---|
| **Maestro** | The human operator (you). |
| **Score** | A workflow definition: a DAG of movements with transitions. |
| **Movement** | A single step in a workflow: a **harness movement** (default) runs a prompt through a harness session and is judged against a goal; a **run movement** (`type: run`) executes a bounded argv command and maps its exit code to an outcome. |
| **Section** | Logical grouping of movements (e.g. "Planning", "Execution", "Review"). |
| **Concert** | A running instance of a Score. |
| **Conductor** | Engine that executes one Concert. |
| **Concert Hall** | Registry that creates, finds, and manages Conductors. |
| **Musician** | A harness adapter (Pi, opencode, Claude). |
| **Evaluator** | A separate harness session that judges goal achievement. |
| **Loge** | The SQLite-backed observability/store layer. |

## Quick Start

### Prerequisites

- Node.js 22+
- pnpm 9.15+

### Install

```bash
pnpm install
```

### Typecheck and test

```bash
pnpm typecheck
pnpm test
```

### Run a concert from the CLI

Orchestron looks for score files (`*.score.yaml`) in two places
by default:

1. `./.orchestron/scores/` — project-local scores, checked first
2. `~/.orchestron/scores/` — global scores, checked second

Local scores take priority over global scores when the same score ID is present
in both.

```bash
# Copy an example to the project-local scores directory
mkdir -p ./.orchestron/scores
cp examples/opencode-demo.score.yaml ./.orchestron/scores/

# Or use the global directory
mkdir -p ~/.orchestron/scores
cp examples/opencode-demo.score.yaml ~/.orchestron/scores/

# Start a concert
pnpm orchestron start opencode-demo --context.topic='Obsidian plugins'

# Monitor it
pnpm orchestron list
pnpm orchestron status <concert-id>   # reads the concert's stream.jsonl
pnpm orchestron status                # overview of all concerts
pnpm orchestron status <concert-id> --watch   # tail stream.jsonl (--raw for raw records)
pnpm orchestron status <concert-id> --raw     # one raw JSON envelope per line

# Reopen a recorded session (per movement/attempt)
pnpm orchestron session <concert-id> <movement-id>            # final session of a movement
pnpm orchestron session <concert-id> <movement-id> --attempt <n>   # a specific retry
pnpm orchestron session <concert-id> <movement-id> --print         # render transcript
pnpm orchestron session <concert-id> <movement-id> --open          # continue in its harness

Every raw harness-session event is recorded to JSONL under
`~/.orchestron/concerts/<concertId>/stream.jsonl` (one file per concert, line
order = event order) — the SQLite `events` table keeps only concert-level
lifecycle events.

# Pause, resume, or cancel a concert
pnpm orchestron pause <concert-id>
pnpm orchestron resume <concert-id>
pnpm orchestron cancel <concert-id>

# List available scores
pnpm orchestron scores
pnpm orchestron scores --validate
```

Use `--json` for scriptable output and `--store <path>` for a custom SQLite
path. Pass `--context.key=value` arguments to populate the concert's initial
context. Use `--scores-dir <dir>` to add a custom directory (can be passed
multiple times).

Use `--harness <name>` to set the default harness for movements that don't
specify one. This defaults to `pi`.

### Configuration

Settings are resolved with this priority (highest to lowest):

> **CLI flags** → **`ORCHESTRON_*` environment variables** → **`~/.orchestron/config.json`** → **code defaults**

Create `~/.orchestron/config.json` to set persistent defaults:

```json
{
  "storePath": "~/.orchestron/store.db",
  "scoresDirs": ["~/.orchestron/scores"],
  "defaultHarness": "pi",
  "opencode": {
    "provider": "opencode",
    "modelId": "kimi-k2.5"
  },
  "pi": {
    "provider": "anthropic",
    "modelId": "claude-sonnet-4-20250514"
  }
}
```

Paths starting with `~/` are expanded to your home directory.

#### Supported environment variables

| Variable | Overrides | Default |
|---|---|---|
| `ORCHESTRON_STORE_PATH` | SQLite store location | `~/.orchestron/store.db` |
| `ORCHESTRON_SCORES_DIRS` | Comma-separated score directories | `./.orchestron/scores`, `~/.orchestron/scores` |
| `ORCHESTRON_DEFAULT_HARNESS` | Default harness for movements | `pi` |
| `ORCHESTRON_OPENCODE_PROVIDER` | Opencode model provider | `opencode` |
| `ORCHESTRON_OPENCODE_MODEL_ID` | Opencode model ID | `kimi-k2.5` |
| `ORCHESTRON_PI_PROVIDER` | Pi model provider | — |
| `ORCHESTRON_PI_MODEL_ID` | Pi model ID | — |

Environment variables take precedence over the config file but are overridden
by explicit CLI flags (`--store`, etc.).

#### Harness resolution

Each movement picks its harness using this priority chain:

1. **`movement.harness`** in the score definition
2. **Explicit harness passed to the command** (e.g. `startConcert({ harness: 'pi' })`)
3. **Default harness configuration** (`--harness`, `ORCHESTRON_DEFAULT_HARNESS`, or `defaultHarness` in config)

The same chain applies to the evaluator: `score.evaluator.harness` → explicit harness → default harness.

### Run a score programmatically

```typescript
import { SqliteLoge, ScoreRegistry, ConcertHall, FakeEvaluator } from '@orchestron/core';
import { PiAdapter } from '@orchestron/adapter-pi';
import { OpencodeAdapter } from '@orchestron/adapter-opencode';

const store = new SqliteLoge('./store.db');
const registry = new ScoreRegistry();
registry.loadFrom('./examples/opencode-demo.score.yaml');

const adapters = new Map([
  ['pi', new PiAdapter()],
  ['opencode', new OpencodeAdapter()],
]);

const hall = new ConcertHall({
  store,
  scoreRegistry: registry,
  adapters,
  evaluator: new FakeEvaluator({ alwaysSucceed: true }),
});

const conductor = await hall.createConcert('opencode-demo', {
  initialContext: { topic: 'Obsidian plugins' },
});

await conductor.start();
const state = await conductor.getState();
console.log(state.status, state.history);
```

## Writing a Score

Scores are YAML files with movements, goals, transitions, and program-level
constraints.

```yaml
id: opencode-demo
name: "Opencode Demo"
version: "1.0.0"
program:
  maxMovements: 10
  reuseSession: true
startMovement: analyze

movements:
  - id: analyze
    name: "Analyze Topic"
    section: planning
    harness: opencode
    prompt: >
      Analyze the following topic and provide a concise summary:
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
    name: "Summarize Analysis"
    section: delivery
    harness: opencode
    prompt: >
      Based on the previous analysis, produce a one-paragraph final summary:
      {{context.previousOutputs.analyze}}
    goal:
      description: "Final summary is concise and accurate"
      strategy: llm_judge
    transitions:
      - to: __end__
        on: success
```

### Templating

Movement prompts, run argv elements, run `cwd`, and run `env` values can
reference:

- `{{context.<key>}}` — shared context values.
- `{{context.previousOutputs.<movementId>}}` — raw output from a previous
  movement. For a `run` movement, this is its stdout with one trailing line
  terminator removed (POSIX command-substitution semantics), so it is safe to
  embed in a later argv element.
- `{{context.previousOutputs.<movementId>.<path>}}` — a parsed leaf from a
  structured output. Use this (with `output.mode: structured`) to pass
  machine-consumed values between run steps with no trailing-newline hazard.

### Deterministic run movements

Not every step needs a model. A movement with `type: run` executes a non-empty
`command` argv array directly, with `execve` semantics: per-element templating,
no word splitting, no globbing, no shell interpretation. A leading `~/` in an
argv element or `cwd` expands to the home directory; env values are literal
after templating. Write a pipeline or glob explicitly as
`["bash", "-lc", "..."]`.

```yaml
movements:
  - id: claim
    name: "Claim issue"
    section: setup
    type: run
    command: ["bash", "-lc", "labels.sh claim {{context.issue}}"]
    outcomes:
      0: success
      3: rejection   # another concert owns the lock — back off
      default: failure
    transitions:
      - to: implement
        on: success
      - to: __end__
        on: rejection
      - to: fail_cleanup
        on: failure
```

Run movements have no `goal`, harness, session, model, provider, or skills, and
they never invoke the evaluator: the `outcomes` map *is* the evaluation. Omitted
`outcomes` means `0 → success`, every other code → `failure`. `cwd`, `env`, and
`budget.timeoutMs` apply to run movements; `retryOnFailure` retries a mapped
`failure`; `retryOnRejection` is rejected. Each attempt captures `exitCode`,
`stdout`, and `stderr` separately, streamed live and written per attempt; spend
is measured `$0`.

> **Warning — scores are executable code.** Run steps execute commands directly
> with the host user's privileges. There is no sandbox, allowlist, or trust gate.
> Treat a score file like a script and only run scores you trust.

### Transitions

- `on: success` — for a harness movement, the movement completed and the
  evaluator says the goal is achieved; for a run movement, the exit code mapped
  to `success`.
- `on: failure` — a technical execution failure, a mapped `failure` exit code,
  or (for harness movements) the goal was not achieved.
- `on: rejection` — for a harness movement, the evaluator judged the goal was not
  achieved; for a run movement, the exit code mapped to the control-flow
  `rejection` outcome (the post-condition was not met and an alternate
  deterministic path applies).
- `on: any` — wildcard: matches any outcome.
- Special targets: `__end__` and `__fail__`.

### Constraints

Set limits in `program`:

```yaml
program:
  maxSpendDollars: 2    # dollars
  maxMovements: 100
  maxDurationMs: 600000
  maxNestingDepth: 5
  reuseSession: true
```

## Architecture

```
Maestro / CLI / Plugin
        │
        ▼
┌─────────────────┐
│  Orchestron SDK │
│                 │
│  ConcertHall    │── creates ──▶ Conductor
│  ScoreRegistry  │
│  Loge (SQLite)  │
│  Evaluator      │
└─────────────────┘
        │
        ▼
┌─────────────────┐
│  Musicians      │
│  PiAdapter      │
│  OpencodeAdapter│
│  ClaudeAdapter  │ (future)
└─────────────────┘
```

## Package Layout

```
packages/
  core/              # Types, Conductor, ConcertHall, ScoreRegistry, Loge
  adapter-pi/        # Pi harness adapter
  adapter-opencode/  # Opencode harness adapter
  cli/               # orchestron CLI
  plugin-common/     # Shared plugin logic (tools, orchestron bootstrap)
  plugin-pi/         # Pi session plugin
  plugin-opencode/   # Opencode session plugin
examples/            # Example scores
```

## Adapters

### Pi

```typescript
import { PiAdapter } from '@orchestron/adapter-pi';

const pi = new PiAdapter({
  provider: 'openai',
  modelId: 'gpt-4o',
  tools: ['read', 'edit'],
});
```

### Opencode

```typescript
import { OpencodeAdapter } from '@orchestron/adapter-opencode';

// Connect to an existing server
const opencode = new OpencodeAdapter({ baseUrl: 'http://localhost:4096' });

// Or start an embedded server
const embedded = new OpencodeAdapter({
  embedded: { hostname: '127.0.0.1', port: 4096 },
});
```

## Session Reuse

By default, each movement retains its own harness session keyed by
`concertId:movementId`. Re-visited movements reuse their prior session, so the
agent sees its own previous turns as context (a retry, or a transition that
loops back), while movement A cannot see movement B's conversation history. Set
`reuseSession: false` in the score program to run every execution of a movement
in a brand-new session.

A single movement can diverge from the score default with a movement-level
`reuseSession`. It follows the same movement-over-score precedence as `model`,
`provider`, and `skills`:

```yaml
program:
  reuseSession: true     # score default: cumulative
movements:
  - id: implement        # inherits the score default (cumulative)
    …
  - id: audit
    reuseSession: false  # only this movement runs fresh, every attempt
    …
```

The override works in both directions: `false` makes one movement fresh on a
reuse-default score, and `true` makes one movement cumulative on a
fresh-default score. It applies only to that movement and its re-visits;
siblings and other movements keep the score default. The deprecated
`persistSession` alias remains score-level only and is ignored at the movement
level. The field is optional, so existing scores and example scores remain
valid unchanged — a movement that omits it simply inherits the score default.

Reuse is scoped to a single concert run and held in memory only; it is not
shared across concerts. It does **not** control disk recording — session
transcripts are recorded to disk in both modes (see below).

> **Migration:** `reuseSession` replaces the old `persistSession` option, whose
> name misdescribed the behavior (transcripts are always recorded; sessions are
> never restored across concerts). The legacy `persistSession` key is still
> read with a deprecation warning; `reuseSession` wins when both are set.
> Existing scores can migrate by renaming the key — the behavior is identical.
> The alias is scheduled for removal in 0.2.0.

## Recording & Reopening Sessions

Every harness-session event is recorded **exactly as the SDK emitted it** — no
normalization — into a unified raw envelope stream per concert:

```
~/.orchestron/concerts/<concertId>/
  stream.jsonl                    # raw envelopes: `{ts, source, type, concertId, …}`
  index.json                      # concert summary: status, stream, movement artifact refs
  movements/<movementId>/
    index.json                    # attempts[] + finalAttempt/finalStatus/finalSessionFile
    final-pi-session.jsonl        # cumulative mode: aggregated native snapshot
      (or final-opencode-session.json)
    attempt-0/
      metadata.json               # attempt summary written by the adapter
      pi-session.jsonl            # native pi session snapshot (opencode: opencode-session.json)
      stdout.log                  # run movements: captured stdout
      stderr.log                  # run movements: captured stderr
    attempt-1/ …                  # one dir per retry
```

For a `run` movement the attempt dir holds `stdout.log` and `stderr.log`
instead of a native session file; its movement `index.json` carries `kind: run`
and no `harness`, and `orchestron session` renders the captured logs.

- `source: "sdk"` envelopes carry raw `data`; `source: "concert"` envelopes are
  conductor lifecycle events. Line order is event order; there is no `seq` field.
- Cumulative (`reuseSession: true`, default) movements keep each attempt's
  snapshot and a final aggregated copy (`final-pi-session.jsonl` /
  `final-opencode-session.json`). Fresh movements (`reuseSession: false`) write
  independent per-attempt sessions only, referenced as `attempt-<n>/…`. The
  effective mode is resolved per movement, so a movement-level `reuseSession`
  override determines whether that movement's `final-*` copy exists.
- Retries increment the attempt index (`attempt-0` = first attempt); each
  attempt gets its own snapshot + `session_traces` row in Loge.

Reopen a recorded session:

```bash
# Pi: fork the recorded session into a new one. This reads the artifact and
# never writes to it; the new session links back via `parentSession`. (Plain
# `pi --session <path>` would open the file as the live session store and
# rewrite it as you continue, which would corrupt the recording.)
pi --fork ~/.orchestron/concerts/<concertId>/movements/<id>/final-pi-session.jsonl
# or per attempt
pi --fork ~/.orchestron/concerts/<concertId>/movements/<id>/attempt-1/pi-session.jsonl

# Opencode (import is read-only; creates a new session seeded from the export)
opencode import /absolute/path/to/opencode-session.json

# Or let the CLI launch the right harness for you (--open):
pnpm orchestron session <concert-id> <movement-id> --open

# The CLI prints the exact paths + reopened commands per concert
pnpm orchestron session <concert-id> <movement-id>
pnpm orchestron session <concert-id> <movement-id> --attempt <n> --print
```

## Roadmap

- [x] Core types, SQLite store, ScoreRegistry
- [x] Conductor engine with crash recovery
- [x] Pi harness adapter
- [x] Opencode harness adapter
- [x] CLI (`orchestron start`, `status`, `list`, etc.)
- [x] Opencode session plugin
- [ ] Claude harness adapter
- [ ] More example scores

## License

MIT
