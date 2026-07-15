# Child-Concert Lifecycle Cascade

**Status:** Decided / Deferred
**Date:** 2026-07-12
**Related:** PLAN.md (Sub-scores, since removed), `packages/core/src/conductor/conductor.ts`

## Context

The original PLAN.md (since removed) defined sub-scores as nested Concerts: a Movement can specify a `subscore` instead of a harness, and the parent Conductor spawns a child Concert via `ConcertHall`. The plan also stated that parent lifecycle operations should cascade to children:

> "Pause/cancel parent → cascades to children"

The `Conductor.executeSubscore()` method creates a child concert and calls `child.start()`, but it does not keep a reference to the child conductor or propagate pause/cancel signals. This means a parent pause or cancel currently does not stop the child from running.

## Decision

**Defer the full lifecycle-cascade implementation.**

The current code intentionally creates a child concert as an independent `IConductor` and awaits it. The parent records the child ID and aggregates its results, but it does not manage the child’s lifecycle. We will keep this behavior for now and implement the cascade in a future change once the Conductor/Hall boundary is fully stable.

The Conductor/Hall decoupling work (see `packages/core/src/conductor/child-concert-factory.ts`) already gives the parent Conductor a narrow interface to child creation. The next step for cascade support is to:

1. Track the child `IConductor` instances in the parent Conductor.
2. Pass the parent’s abort signal into the child `start()` call.
3. In the parent’s `pause()`, `resume()`, and `cancel()` methods, iterate active children and call the same method on each.
4. In the parent’s `finalize()`, wait for or cancel active children before completing.

## Consequences

- A parent pause/cancel currently does not stop child concerts.
- Resource usage and runtime may continue after the parent appears finished.
- The parent/child hierarchy is still tracked via `childConcertIds` and `child:created` / `child:completed` events.

## Related work

- `docs/decisions/session-persistence.md`
- `PLAN.md` §2 "Sub-scores (nested Concerts)" (since removed)
