import type { Orchestron } from '../orchestron.js';
import { printOutput, formatDate } from '../output.js';

export async function pauseCommandHandler(
  orchestron: Orchestron,
  concertId: string,
  json: boolean,
): Promise<void> {
  if (!orchestron.hall.getConcert(concertId)) {
    await orchestron.hall.rehydrate();
  }
  const conductor = orchestron.hall.getConcert(concertId);
  if (!conductor) {
    throw new Error(`Concert '${concertId}' not found`);
  }
  await conductor.pause();
  const state = await conductor.getState();
  printOutput(json, { concertId: state.id, status: state.status }, () =>
    formatLifecycleHuman('Paused', state),
  );
}

export async function resumeCommandHandler(
  orchestron: Orchestron,
  concertId: string,
  json: boolean,
): Promise<void> {
  if (!orchestron.hall.getConcert(concertId)) {
    await orchestron.hall.rehydrate();
  }
  const conductor = orchestron.hall.getConcert(concertId);
  if (!conductor) {
    throw new Error(`Concert '${concertId}' not found`);
  }
  await conductor.resume();
  const state = await conductor.getState();
  printOutput(json, { concertId: state.id, status: state.status }, () =>
    formatLifecycleHuman('Resumed', state),
  );
}

export async function cancelCommandHandler(
  orchestron: Orchestron,
  concertId: string,
  json: boolean,
): Promise<void> {
  if (!orchestron.hall.getConcert(concertId)) {
    await orchestron.hall.rehydrate();
  }
  const conductor = orchestron.hall.getConcert(concertId);
  if (!conductor) {
    throw new Error(`Concert '${concertId}' not found`);
  }
  await conductor.cancel();
  // Cancel is async but doesn't wait for finalization; give it a moment.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const state = await conductor.getState();
  printOutput(json, { concertId: state.id, status: state.status }, () =>
    formatLifecycleHuman('Cancelled', state),
  );
}

function formatLifecycleHuman(
  action: string,
  state: { id: string; scoreId: string; status: string; startedAt: Date; completedAt?: Date },
): string {
  const lines: string[] = [];
  lines.push(`${action} concert ${state.id}`);
  lines.push(`Score:   ${state.scoreId}`);
  lines.push(`Status:  ${state.status}`);
  lines.push(`Started: ${formatDate(state.startedAt)}`);
  if (state.completedAt) {
    lines.push(`Ended:   ${formatDate(state.completedAt)}`);
  }
  return lines.join('\n');
}
