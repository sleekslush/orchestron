import type { Orchestron } from '../orchestron.js';
import { printOutput, formatConcertHuman, extractFailure, formatDate, formatDuration, formatUsage } from '../output.js';

export async function statusCommandHandler(
  orchestron: Orchestron,
  concertId: string | undefined,
  json: boolean,
  verbose = false,
): Promise<void> {
  if (concertId) {
    const state = await orchestron.store.getConcert(concertId);
    if (!state) {
      throw new Error(`Concert '${concertId}' not found`);
    }

    const history = await orchestron.store.getMovementHistory(concertId);
    const events = await orchestron.store.getEvents(concertId);

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
      movements: history.map((h) => ({
        movementId: h.movementId,
        movementName: h.movementName,
        status: h.status,
        summary: h.summary,
        durationMs: h.durationMs,
        goalAchieved: h.goalEvaluation.achieved,
        goalSummary: h.goalEvaluation.summary,
        error: h.error,
        model: h.model,
        provider: h.provider,
      })),
    };

    printOutput(json, output, () => formatConcertHuman(state, history, events, verbose));
  } else {
    const aggregates = await orchestron.store.getAggregates();
    const recent = await orchestron.store.listConcerts({ limit: 10 });

    const output = {
      aggregates,
      recentConcerts: recent.map((c) => ({
        concertId: c.id,
        scoreId: c.scoreId,
        status: c.status,
        startedAt: c.startedAt.toISOString(),
      })),
    };

    printOutput(json, output, () => formatSystemHuman(aggregates, recent));
  }
}

function formatSystemHuman(
  aggregates: {
    totalConcerts: number;
    activeConcerts: number;
    totalSpend: number;
    totalTokens: number;
    avgDurationMs: number;
    failureRate: number;
  },
  recent: Array<{ id: string; scoreId: string; status: string; startedAt: Date }>,
): string {
  const lines: string[] = [];
  lines.push('System Status');
  lines.push('');
  lines.push(`Total concerts: ${aggregates.totalConcerts}`);
  lines.push(`Active concerts: ${aggregates.activeConcerts}`);
  lines.push(`Total spend: ${formatUsage({ spend: aggregates.totalSpend, tokens: aggregates.totalTokens })}`);
  lines.push(`Avg duration: ${formatDuration(aggregates.avgDurationMs)}`);
  lines.push(`Failure rate: ${(aggregates.failureRate * 100).toFixed(1)}%`);
  lines.push('');
  lines.push('Recent concerts:');
  for (const c of recent) {
    lines.push(`  ${c.id}  ${c.scoreId}  ${c.status}  ${formatDate(c.startedAt)}`);
  }
  return lines.join('\n');
}
