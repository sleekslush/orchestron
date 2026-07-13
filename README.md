# Orchestron

Workflow orchestration for AI harnesses.

Orchestron turns multi-step, agentic work into repeatable, observable, and
budget-aware workflows. Define a **Score** (a DAG of **Movements**), pick a
harness (Pi, opencode, or future adapters), and let a **Conductor** run the
**Concert** while tracking spend, tokens, and progress in a local SQLite store.

## Why Orchestron?

- **Repeatable workflows** — encode your planning/execution/review loops as YAML
  scores instead of one-off prompts.
- **Harness-agnostic** — run movements on Pi, opencode, or future adapters through
  the same interface.
- **Observable** — every movement, prompt, output, goal evaluation, and cost is
  persisted to a local SQLite database (`Loge`).
- **Budget-aware** — set spend, token, movement, and duration limits at the
  score or section level.
- **Composable** — scores can spawn sub-scores as child concerts.

## Core Concepts

| Term | Meaning |
|---|---|
| **Maestro** | The human operator (you). |
| **Score** | A workflow definition: a DAG of movements with transitions. |
| **Movement** | A single step in a workflow. |
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

Orchestron looks for score files (`*.score.yaml`/`*.score.json`) in two places
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
pnpm orchestron status <concert-id>

# Launch the web dashboard
pnpm orchestron dashboard --port 3000
```

Use `--json` for scriptable output and `--store <path>` for a custom SQLite
path. Pass `--context.key=value` arguments to populate the concert's initial
context. Use `--scores-dir <dir>` to add a custom directory (can be passed
multiple times).

### Configuration

Settings are resolved with this priority (highest to lowest):

> **CLI flags** → **`ORCHESTRON_*` environment variables** → **`~/.orchestron/config.json`** → **code defaults**

Create `~/.orchestron/config.json` to set persistent defaults:

```json
{
  "storePath": "~/.orchestron/store.db",
  "scoresDirs": ["~/.orchestron/scores"],
  "tracesDir": "~/.orchestron/traces",
  "opencode": {
    "provider": "opencode",
    "modelId": "kimi-k2.5"
  },
  "pi": {
    "provider": "anthropic",
    "modelId": "claude-sonnet-4-20250514"
  },
  "dashboard": {
    "port": 3000
  }
}
```

Paths starting with `~/` are expanded to your home directory.

#### Supported environment variables

| Variable | Overrides | Default |
|---|---|---|
| `ORCHESTRON_STORE_PATH` | SQLite store location | `~/.orchestron/store.db` |
| `ORCHESTRON_SCORES_DIRS` | Comma-separated score directories | `./.orchestron/scores`, `~/.orchestron/scores` |
| `ORCHESTRON_OPENCODE_PROVIDER` | Opencode model provider | `opencode` |
| `ORCHESTRON_OPENCODE_MODEL_ID` | Opencode model ID | `kimi-k2.5` |

Environment variables take precedence over the config file but are overridden
by explicit CLI flags (`--store`, etc.).

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
  persistSession: true
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

Movement prompts can reference:

- `{{context.<key>}}` — shared context values.
- `{{context.previousOutputs.<movementId>}}` — raw output from a previous
  movement.

### Transitions

- `on: success` — when the movement completes and the evaluator says the goal is
  achieved.
- `on: failure` — when the movement fails or the goal is not achieved.
- `on: skip` — reserved for future use.
- Special targets: `__end__` and `__fail__`.

### Constraints

Set limits in `program`:

```yaml
program:
  maxSpendDollars: 2    # dollars
  maxMovements: 100
  maxDurationMs: 600000
  maxNestingDepth: 5
  persistSession: true
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
  cli/               # orchestron CLI + basic web dashboard
  plugin-pi/         # Pi session plugin
  plugin-opencode/   # (future) Opencode session plugin
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

## Session Persistence

By default, each movement retains its own harness session keyed by
`concertId:movementId`. Re-visited movements keep their prior context, while
movement A cannot see movement B's conversation history. Set
`persistSession: false` in the score program to disable.

## Roadmap

- [x] Core types, SQLite store, ScoreRegistry
- [x] Conductor engine with crash recovery
- [x] Pi harness adapter
- [x] Opencode harness adapter
- [x] CLI (`orchestron start`, `status`, `list`, `dashboard`, etc.)
- [x] Basic dashboard (`orchestron dashboard`)
- [ ] Opencode session plugin
- [ ] Rich dashboard (web UI + WebSocket)
- [ ] Claude harness adapter
- [ ] More example scores

## License

MIT
