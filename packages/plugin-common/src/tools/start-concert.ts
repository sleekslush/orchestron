import type { Orchestron } from '../orchestron.js';

export type ProgressCallback = (text: string) => void;

export interface StartConcertInput {
  scoreId: string;
  context?: Record<string, unknown>;
  /** Explicit harness for this concert, overriding the global default. */
  harness?: string;
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
  });

  conductor.start().catch(() => {});

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

    const startTime = Date.now();
    const maxStreamingMs = 10000;
    const pollIntervalMs = 500;
    let lastTimestamp = new Date(0);
    let lastMovement = state.currentMovement;

    while (Date.now() - startTime < maxStreamingMs) {
      const events = await orchestron.store.getEvents(state.id, {
        types: ['movement:progress'],
        since: lastTimestamp,
      });
      for (const event of events) {
        if (event.type !== 'movement:progress') continue;
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
        onUpdate(text);
        lastTimestamp = event.timestamp;
      }

      const current = await orchestron.store.getConcert(state.id);
      if (current && current.currentMovement !== lastMovement) {
        onUpdate(
          `Movement advanced from ${lastMovement ?? 'none'} to ${current.currentMovement ?? 'completed'}.`,
        );
        lastMovement = current.currentMovement;
      }
      if (current && current.status !== 'running' && current.status !== 'pending') {
        onUpdate(`Concert finished with status: ${current.status}.`);
        break;
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }

  return result;
}
