import type { ConcertFilter } from '@orchestron/core';
import { computeLiveness } from '@orchestron/core';
import type { Orchestron } from '../orchestron.js';
import { printOutput, formatDate, formatUsage, formatLivenessHuman } from '../output.js';

export async function listCommandHandler(
  orchestron: Orchestron,
  filter: ConcertFilter,
  json: boolean,
): Promise<void> {
  const concerts = await orchestron.store.listConcerts(filter);

  const output = concerts.map((c) => ({
    concertId: c.id,
    scoreId: c.scoreId,
    status: c.status,
    startedAt: c.startedAt.toISOString(),
    completedAt: c.completedAt?.toISOString(),
    usage: c.usage,
    liveness: computeLiveness(c),
  }));

  printOutput(json, output, () => formatListHuman(concerts));
}

function formatListHuman(
  concerts: Array<{
    id: string;
    scoreId: string;
    status: string;
    startedAt: Date;
    completedAt?: Date;
    usage: { spend?: number; tokens?: number };
  }>,
): string {
  if (concerts.length === 0) {
    return 'No concerts found.';
  }

  const lines: string[] = [];
  lines.push(
    `${'Concert ID'.padEnd(16)} ${'Score'.padEnd(24)} ${'Status'.padEnd(12)} ${'Started'.padEnd(24)} Usage`,
  );
  lines.push(''.padEnd(100, '-'));

  for (const c of concerts) {
    const id = c.id.length > 15 ? `${c.id.slice(0, 12)}...` : c.id;
    const score = c.scoreId.length > 23 ? `${c.scoreId.slice(0, 20)}...` : c.scoreId;
    const started = formatDate(c.startedAt);
    const live = computeLiveness(c);
    const statusColumn = live.stale ? `${c.status}*` : c.status;
    lines.push(
      `${id.padEnd(16)} ${score.padEnd(24)} ${statusColumn.padEnd(12)} ${started.padEnd(24)} ${formatUsage(
        c.usage,
      )}  ${formatLivenessHuman(live)}`,
    );
  }

  return lines.join('\n');
}
