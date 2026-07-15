# Orchestron — AI Coding Guidelines

## Project

TypeScript monorepo (pnpm workspace) for workflow orchestration across AI harnesses
(Pi, opencode, etc.). A **Score** (YAML DAG of **Movements**) defines a repeatable
workflow; the **Conductor** executes it as a **Concert**, tracking state, spend, and
tokens in a local SQLite store (**Loge**).

## Key Terminology

| Term | Meaning |
|---|---|
| Maestro | The human operator |
| Score | Workflow definition (YAML DAG of movements) |
| Movement | A single workflow step |
| Section | Logical grouping of movements |
| Concert | A running instance of a Score |
| Conductor | Runtime engine executing one Concert |
| Concert Hall | Registry that creates and manages Concerts |
| Musician | Harness adapter (Pi, opencode, etc.) |
| Evaluator | Judges goal achievement for a Movement |
| Loge | SQLite-backed observability/store layer |

## Getting Started

```bash
pnpm install
pnpm typecheck   # tsc --noEmit (strict mode)
pnpm test        # vitest run
```

## Code Conventions

- **TypeScript**, ES2022 target, NodeNext module resolution, strict mode.
- Source is `src/`, tests colocated in `src/__tests__/` per package.
- Package imports use the `@orchestron/*` workspace scope.
- Use `pnpm` for all dependency management. Do not add `npm` or `yarn`.
- Prefer `nanoid` for ID generation; prefer `better-sqlite3` for store layer.
- Exported types and functions are re-exported through each package's `src/index.ts`.
- Keep `package.json` `"type": "module"` in all packages.

## Scores

Scores are YAML (`.score.yaml`) defining movements with prompts, goals, output
schemas, and transitions. Use `{{context.<key>}}` and
`{{context.previousOutputs.<movementId>}}` for templating.
Special transition targets: `__end__`, `__fail__`.

Harness resolution priority: movement-level > explicit CLI arg > config default.

## Core Architectural Rules

1. **Adapter pattern** — each Musician implements a common harness interface.
   New adapters go in `packages/adapter-*`.
2. **The Conductor is the sole runtime** — it resolves movements, delegates to
   adapters, evaluates goals, logs to Loge. ConcertHall only creates and indexes.
3. **Evaluators are separate harness sessions** — `FakeEvaluator` (deterministic)
   or `HarnessEvaluator` (LLM-based).
4. **Session persistence** per movement (`concertId:movementId` key) unless
   `persistSession: false`.
5. **Plugin packages** (`plugin-pi`, `plugin-opencode`) provide harness-specific
   session plugins. `plugin-common` has shared tool infrastructure.
6. **CLI** lives in `packages/cli`. The dashboard is a simple embedded web server
   reading/writing the Loge store.

## Config Precedence

CLI flags > `ORCHESTRON_*` env vars > `~/.orchestron/config.json` > code defaults.

## Testing

- Use **vitest**. Tests go in `src/__tests__/` within each package.
- Mock boundaries (network, filesystem, SQLite), not logic. Prefer `FakeEvaluator`
  and `FakeHarnessAdapter` over mocking Conductor internals.
- If a test passes without the implementation, it is over-mocked.

## Pull Requests

- One logical change per branch. Branch from `main`.
- Reference the tracking issue in PR description (e.g. `Part of #48`).
- Run `pnpm typecheck && pnpm test` locally before opening a PR.

## What Not To Do

- Do not add new dependencies without justification. Prefer stdlib or existing workspace dependencies.
- Do not refactor unrelated code alongside a change.
- Do not hardcode paths; use configuration or environment variables.
- Do not commit secrets, API keys, or tokens.
- Do not edit `pnpm-lock.yaml` by hand.
