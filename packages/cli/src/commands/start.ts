import type { Orchestron } from '../orchestron.js';
import { printOutput, formatConcertHuman, extractFailure, movementToOutput } from '../output.js';

async function pollAndPrintProgress(
  orchestron: Orchestron,
  concertId: string,
  lastCount: number,
): Promise<number> {
  const events = await orchestron.store.getEvents(concertId);
  for (let i = lastCount; i < events.length; i++) {
    const e = events[i];
    switch (e.type) {
      case 'movement:started':
        console.error(`→ [${e.movementId}] Running...`);
        break;
      case 'movement:completed':
        console.error(`✓ [${e.movementId}] Completed`);
        break;
      case 'movement:failed':
        console.error(`✗ [${e.movementId}] Failed: ${e.error?.message ?? 'Unknown error'}`);
        break;
      case 'movement:progress':
        if (e.progressType === 'tool_execution_start' && typeof e.payload?.toolName === 'string') {
          console.error(`  ↳ ${e.payload.toolName}...`);
        }
        break;
    }
  }
  return events.length;
}

export async function startCommandHandler(
  orchestron: Orchestron,
  scoreId: string,
  context: Record<string, unknown>,
  json: boolean,
): Promise<void> {
  const conductor = await orchestron.hall.createConcert(scoreId, {
    initialContext: context,
    triggeredBy: 'cli',
  });

  console.error(`Concert ID: ${conductor.concertId}`);

  let lastEventCount = 0;
  let polling = false;
  let pollingDone = false;
  let activePoll: Promise<void> | undefined;
  const pollInterval = 1000;
  const scheduleNextPoll = () => {
    if (pollingDone) return;
    setTimeout(() => {
      if (pollingDone || polling) return;
      polling = true;
      activePoll = (async () => {
        try {
          lastEventCount = await pollAndPrintProgress(orchestron, conductor.concertId, lastEventCount);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Progress poll failed: ${message}`);
        } finally {
          polling = false;
          if (!pollingDone) {
            scheduleNextPoll();
          }
          activePoll = undefined;
        }
      })();
    }, pollInterval);
  };
  scheduleNextPoll();

  try {
    await conductor.start();
  } finally {
    pollingDone = true;
    const pending = activePoll;
    if (pending) {
      await pending;
    }
  }

  const state = await conductor.getState();
  const history = await orchestron.store.getMovementHistory(conductor.concertId);
  const events = await orchestron.store.getEvents(conductor.concertId);

  const failure = extractFailure(events);

  const output = {
    concertId: state.id,
    scoreId: state.scoreId,
    status: state.status,
    startedAt: state.startedAt.toISOString(),
    completedAt: state.completedAt?.toISOString(),
    currentMovement: state.currentMovement,
    usage: state.usage,
    failure,
    movements: history.map(movementToOutput),
  };

  printOutput(json, output, () => formatConcertHuman(state, history, events, true));
}
