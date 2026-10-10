import type { Orchestron } from '../orchestron.js';

export interface StartConcertInput {
  scoreId: string;
  context?: Record<string, unknown>;
  /** Explicit harness for this concert, overriding the global default. */
  harness?: string;
  /** Working directory for the concert's harness sessions. Default: process.cwd(). */
  cwd?: string;
}

/**
 * Create and kick off a concert, returning immediately.
 *
 * The concert runs in the background. This operation never streams or blocks;
 * observation is the job of `waitForConcert` (or the structured
 * `getConcertStatus`). The returned `status` is the conductor's post-kickoff
 * status: `running` normally, or a terminal status when the concert finalizes
 * synchronously during kickoff (for example, a missing required context).
 */
export async function startConcert(
  orchestron: Orchestron,
  input: StartConcertInput,
): Promise<{
  concertId: string;
  scoreId: string;
  status: string;
  startedAt: string;
}> {
  const conductor = await orchestron.hall.createConcert(input.scoreId, {
    initialContext: input.context,
    triggeredBy: 'agent',
    harness: input.harness,
    cwd: input.cwd,
  });

  // Kick off execution without awaiting terminal state. `Conductor.start()`
  // applies its pre-run status transition synchronously, so the state read
  // below reflects the post-kickoff status rather than the stale `pending`.
  conductor.start().catch(() => {});

  const state = await conductor.getState();
  return {
    concertId: state.id,
    scoreId: state.scoreId,
    status: state.status,
    startedAt: state.startedAt.toISOString(),
  };
}
