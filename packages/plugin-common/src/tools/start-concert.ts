import type { Orchestron } from '../orchestron.js';
import type { ConcertEvent } from '@orchestron/core';

export type ProgressCallback = (text: string) => void;

export interface StartConcertInput {
  scoreId: string;
  context?: Record<string, unknown>;
  /** Explicit harness for this concert, overriding the global default. */
  harness?: string;
  /** Working directory for the concert's harness sessions. Default: process.cwd(). */
  cwd?: string;
  /** Run the concert in an isolated git worktree. */
  worktree?: boolean | { baseBranch?: string; keep?: boolean };
}

function progressText(event: ConcertEvent): string | undefined {
  if (event.type !== 'movement:progress') return undefined;
  const payload = event.payload;
  let text =
    (payload.message as string | undefined) ??
    `Progress: ${event.progressType}${payload.toolName ? ` (${payload.toolName as string})` : ''}`;
  if (event.progressType === 'tool_execution_start' && payload.args) {
    const args = payload.args as Record<string, unknown>;
    const cmd =
      (args.command as string | undefined) ??
      (args.filePath as string | undefined) ??
      (args.file as string | undefined) ??
      (args.path as string | undefined);
    if (cmd) {
      text += ` → ${cmd}`;
    }
  }
  if (event.progressType === 'tool_execution_end' && payload.isError) {
    text += ` [error]`;
  }
  if (event.progressType === 'text_delta' && typeof payload.delta === 'string') {
    text += ` ${payload.delta}`;
  }
  return text;
}

export async function startConcert(
  orchestron: Orchestron,
  input: StartConcertInput,
  onUpdate?: ProgressCallback,
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
    worktree: input.worktree,
  });

  const state = await conductor.getState();
  const result = {
    concertId: state.id,
    scoreId: state.scoreId,
    status: state.status,
    startedAt: state.startedAt.toISOString(),
  };

  if (onUpdate) {
    onUpdate(
      `Started concert ${state.id}. Current movement: ${state.currentMovement ?? 'none'}.`,
    );

    // Stream live progress from the conductor bus for a bounded window (or until
    // the concert reaches a terminal state), then return so the caller can act
    // on the concertId while execution continues in the background.
    const maxStreamingMs = 10000;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        conductor.offEvent(listener);
        resolve();
      };

      const listener = (event: ConcertEvent) => {
        if (event.type === 'movement:started') {
          onUpdate(`Movement ${event.movementId} started.`);
        } else if (event.type === 'movement:progress') {
          const text = progressText(event);
          if (text) onUpdate(text);
        } else if (
          event.type === 'concert:completed' ||
          event.type === 'concert:failed' ||
          event.type === 'concert:cancelled'
        ) {
          onUpdate(`Concert finished with status: ${event.type.replace('concert:', '')}.`);
          finish();
        }
      };
      conductor.onEvent(listener);

      const timer = setTimeout(finish, maxStreamingMs);
      conductor.start().catch(() => {});
    });
  } else {
    conductor.start().catch(() => {});
  }

  return result;
}
