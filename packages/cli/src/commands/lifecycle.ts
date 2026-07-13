import type { Orchestron } from '../orchestron.js';
import { printOutput, formatDate } from '../output.js';

async function findConductor(
  orchestron: Orchestron,
  concertId: string,
  action: string,
  json: boolean,
) {
  if (!orchestron.hall.getConcert(concertId)) {
    await orchestron.hall.rehydrate();
  }
  const conductor = orchestron.hall.getConcert(concertId);
  if (conductor) return conductor;

  const stored = await orchestron.store.getConcert(concertId);
  const msg = stored
    ? `Concert '${concertId}' is already ${stored.status} (cannot ${action})`
    : `Concert '${concertId}' not found`;
  printOutput(json, { error: msg }, () => msg);
  process.exitCode = 1;
}

export async function pauseCommandHandler(
  orchestron: Orchestron,
  concertId: string,
  json: boolean,
): Promise<void> {
  const conductor = await findConductor(orchestron, concertId, 'pause', json);
  if (!conductor) return;
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
  const conductor = await findConductor(orchestron, concertId, 'resume', json);
  if (!conductor) return;
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
  const conductor = await findConductor(orchestron, concertId, 'cancel', json);
  if (!conductor) return;
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
