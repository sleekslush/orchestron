import type { Orchestron } from '../orchestron.js';
import { printOutput, formatDate, formatDuration, formatUsage } from '../output.js';

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

  await conductor.start();

  const state = await conductor.getState();

  const output = {
    concertId: state.id,
    scoreId: state.scoreId,
    status: state.status,
    startedAt: state.startedAt.toISOString(),
    completedAt: state.completedAt?.toISOString(),
    movements: state.history.map((h) => ({
      movementId: h.movementId,
      movementName: h.movementName,
      status: h.status,
      summary: h.summary,
      durationMs: h.durationMs,
    })),
    usage: state.usage,
  };

  printOutput(json, output, () => formatStartHuman(state));
}

function formatStartHuman(state: {
  id: string;
  scoreId: string;
  status: string;
  startedAt: Date;
  completedAt?: Date;
  history: Array<{
    movementId: string;
    movementName: string;
    status: string;
    summary: string;
    durationMs: number;
  }>;
  usage: { spend?: number; tokens?: number };
}): string {
  const lines: string[] = [];
  lines.push(`Concert: ${state.id}`);
  lines.push(`Score:   ${state.scoreId}`);
  lines.push(`Status:  ${state.status}`);
  lines.push(`Started: ${formatDate(state.startedAt)}`);
  if (state.completedAt) {
    lines.push(`Ended:   ${formatDate(state.completedAt)}`);
  }
  lines.push('');
  lines.push('Movements:');
  for (const h of state.history) {
    lines.push(
      `  [${h.status.toUpperCase()}] ${h.movementName} (${h.movementId}) — ${formatDuration(
        h.durationMs,
      )}`,
    );
    if (h.summary) {
      lines.push(`    ${h.summary}`);
    }
  }
  lines.push('');
  lines.push(`Usage: ${formatUsage(state.usage)}`);
  return lines.join('\n');
}
