# Session Persistence for Harness Adapters

**Status:** Decided
**Date:** 2026-07-12
**Related:** Phase 3 (Pi Harness Adapter)

## Context

When a movement is re-run (via a transition that loops back, e.g. `review -> plan`),
the harness adapter (e.g. PiAdapter) was creating a fresh agent session per
`execute()` call. This meant the agent lost all conversation context from previous
runs — it could not see what it had produced before.

We needed a way to maintain a persistent agent session across multiple `execute()`
calls within a single Concert.

## Decision

### Session scope

Each movement retains its **own** session keyed by `concertId:movementId`.
Movement A's session does not see Movement B's conversation history.
When a movement is re-visited, it reuses its own session and sees only its
own prior conversation.

### Config knob

`persistSession: boolean` on the `Program` interface (score-level).

**Default is `true`** — sessions persist by default. Set `persistSession: false`
on a score to disable (each `execute()` call gets a fresh session).

### Interface changes

The generic `HarnessAdapter` interface gains two additive, optional fields so any
adapter type can opt in:

1. `sessionId?: string` added to the `execute()` options — the Conductor passes
   `"${concertId}:${movement.id}"` when `persistSession !== false`.
2. Optional method `disposeSession(sessionId: string): Promise<void>` — the
   Conductor calls this for each tracked session during `finalize()`.

### Conductor behavior

- Always passes `sessionId` when `persistSession !== false`.
- Tracks `Map<sessionId, HarnessAdapter>` of active sessions.
- On `finalize()`, iterates tracked sessions and calls `adapter.disposeSession()`.

### PiAdapter behavior

- Maintains `Map<sessionId, { session, authStorage, modelRegistry }>` internally.
- `execute()` with a known `sessionId` -> reuse existing session, call `prompt()`,
  do not dispose.
- `execute()` with a new `sessionId` -> create session, store in map, call `prompt()`.
- `execute()` without `sessionId` -> fresh session per call (legacy/opt-out behavior).
- `disposeSession(sessionId)` -> dispose the Pi session, remove from map.

## Consequences

- Default persistent sessions mean re-visited movements keep context automatically.
- Per-movement isolation prevents cross-movement context bleed.
- The interface is adapter-agnostic — future adapters (opencode, claude) can opt in
  the same way.
- Minimal core changes: two optional interface additions + one Program field.
