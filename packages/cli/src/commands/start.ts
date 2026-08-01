import type { Orchestron } from '../orchestron.js';
import type { ConcertEvent } from '@orchestron/core';
import { printOutput, formatConcertHuman, extractFailure, movementToOutput } from '../output.js';

const MAX_TOOL_LINE_LENGTH = 120;

/** Render a compact one-line description of the tool and its primary target. */
function renderToolLine(payload: Record<string, unknown>): string {
  const toolName = typeof payload.toolName === 'string' ? payload.toolName : '';
  const args = payload.args;
  let line = `  ↳ ${toolName}`;
  if (args && typeof args === 'object') {
    const record = args as Record<string, unknown>;
    const command = record.command;
    const filePath = record.filePath ?? record.file ?? record.path;
    if (typeof command === 'string' && command.length > 0) line += ` ${command}`;
    else if (typeof filePath === 'string' && filePath.length > 0) line += ` ${filePath}`;
  }
  if (line.length > MAX_TOOL_LINE_LENGTH + 3) {
    line = `${line.slice(0, MAX_TOOL_LINE_LENGTH)}...`;
  }
  return line;
}

function printLiveEvent(event: ConcertEvent): void {
  switch (event.type) {
    case 'movement:started':
      console.error(`→ [${event.movementId}] Running...`);
      break;
    case 'movement:completed':
      console.error(`✓ [${event.movementId}] Completed`);
      break;
    case 'movement:failed':
      console.error(`✗ [${event.movementId}] Failed: ${event.error?.message ?? 'Unknown error'}`);
      break;
    case 'movement:progress':
      if (event.progressType === 'tool_execution_start') {
        console.error(renderToolLine(event.payload));
      } else if (event.progressType === 'text_delta' && typeof event.payload?.delta === 'string') {
        process.stderr.write(event.payload.delta);
      }
      break;
  }
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

  const events: ConcertEvent[] = [];
  const listener = (event: ConcertEvent) => {
    events.push(event);
    printLiveEvent(event);
  };
  conductor.onEvent(listener);

  try {
    await conductor.start();
  } finally {
    conductor.offEvent(listener);
  }

  const state = await conductor.getState();
  const history = await orchestron.store.getMovementHistory(conductor.concertId);
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
