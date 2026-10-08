# Session Reuse for Harness Adapters

**Status:** Decided
**Date:** 2026-07-12
**Updated:** 2026-09-19 — option renamed `persistSession` → `reuseSession`
**Related:** Phase 3 (Pi Harness Adapter)

## Context

When a movement is re-run (via a transition that loops back, e.g. `review -> plan`),
the harness adapter (e.g. PiAdapter) was creating a fresh agent session per
`execute()` call. This meant the agent lost all conversation context from previous
runs — it could not see what it had produced before.

We needed a way to reuse an agent session across multiple `execute()` calls
within a single Concert.

## Decision

### Session scope

Each movement retains its **own** session keyed by `concertId:movementId`.
Movement A's session does not see Movement B's conversation history.
When a movement is re-visited, it reuses its own session and sees only its
own prior conversation.

### Config knob

`reuseSession: boolean` on the `Program` interface (score-level).

**Default is `true`** — sessions are reused by default. Set `reuseSession: false`
on a score to disable (each `execute()` call gets a fresh session).

Reuse is scoped to a single concert run and held in memory only; it is not
shared across concerts, and it does not control disk recording. Session
transcripts are recorded to disk in both modes: fresh movements keep a
per-attempt snapshot, cumulative movements additionally aggregate a final copy.

### Interface changes

The generic `HarnessAdapter` interface gains two additive, optional fields so any
adapter type can opt in:

1. `sessionId?: string` added to the `execute()` options — the Conductor passes
   `"${concertId}:${movement.id}"` when `reuseSession !== false`.
2. Optional method `disposeSession(sessionId: string): Promise<void>` — the
   Conductor calls this for each tracked session during `finalize()`.

### Conductor behavior

- Always passes `sessionId` when `reuseSession !== false`.
- Tracks `Map<sessionId, HarnessAdapter>` of active sessions.
- On `finalize()`, iterates tracked sessions and calls `adapter.disposeSession()`.

### PiAdapter behavior

- Maintains `Map<sessionId, { session, authStorage, modelRegistry }>` internally.
- `execute()` with a known `sessionId` -> reuse existing session, call `prompt()`,
  do not dispose.
- `execute()` with a new `sessionId` -> create session, store in map, call `prompt()`.
- `execute()` without `sessionId` -> fresh session per call (legacy/opt-out behavior).
- `disposeSession(sessionId)` -> dispose the Pi session, remove from map.

## Rename note (2026-09-19)

The option was originally named `persistSession`, which misdescribed the
behavior: it controls in-concert session **reuse**, and transcripts are always
recorded to disk regardless of the setting. The option is now `reuseSession`.

Migration: legacy scores may keep using `persistSession` — the Conductor still
reads it as a deprecated alias and emits a warning. `reuseSession` wins when
both keys are present. Renaming the key is behavior-identical.

Removal milestone: the `persistSession` alias is **not** removed in the 0.1.0
release. It is scheduled for removal in **0.2.0**, the next minor after 0.1.0,
so the misleading name does not become permanent.

Filename note: this ADR's filename retains the historical slug
`session-persistence.md` even though the title and decision now use reuse
framing. The filename is a stable historical identifier and the inbound
references from `child-concert-lifecycle.md` and `opencode-adapter.md` point at
it; it is deliberately not renamed to keep those links valid. Do not "fix" the
slug without updating every inbound reference.

## Consequences

- Default session reuse means re-visited movements keep context automatically.
- Per-movement isolation prevents cross-movement context bleed.
- The interface is adapter-agnostic — future adapters (opencode, claude) can opt in
  the same way.
- Minimal core changes: two optional interface additions + one Program field.