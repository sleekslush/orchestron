import type { Orchestron } from '../orchestron.js';
import type { ConcertEvent } from '@orchestron/core';
import { printOutput, formatDate, formatDuration, formatUsage } from '../output.js';

export async function statusCommandHandler(
  orchestron: Orchestron,
  concertId: string | undefined,
  json: boolean,
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
      })),
    };

    printOutput(json, output, () => formatConcertHuman(state, history, events));
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

function extractFailure(events: ConcertEvent[]) {
  const reversed = [...events].reverse();
  const breach = reversed.find(
    (e): e is ConcertEvent & { type: 'constraint:breached' } => e.type === 'constraint:breached',
  );
  const failed = reversed.find(
    (e): e is ConcertEvent & { type: 'concert:failed' } => e.type === 'concert:failed',
  );

  if (!breach && !failed) return undefined;

  return {
    error: failed?.error,
    constraint: breach
      ? {
          name: breach.constraint,
          limit: breach.limit,
          actual: breach.actual,
        }
      : undefined,
  };
}

function formatConcertHuman(
  state: {
    id: string;
    scoreId: string;
    status: string;
    startedAt: Date;
    completedAt?: Date;
    currentMovement: string | null;
    usage: { spend?: number; tokens?: number };
  },
  history: Array<{
    movementId: string;
    movementName: string;
    status: string;
    summary: string;
    durationMs: number;
    goalEvaluation: { achieved: boolean; summary: string };
    error?: { code: string; message: string; retryable: boolean } | undefined;
  }>,
  events: ConcertEvent[],
): string {
  const lines: string[] = [];
  lines.push(`Concert: ${state.id}`);
  lines.push(`Score:   ${state.scoreId}`);
  lines.push(`Status:  ${state.status}`);
  if (state.currentMovement) {
    lines.push(`Current: ${state.currentMovement}`);
  }
  lines.push(`Started: ${formatDate(state.startedAt)}`);
  if (state.completedAt) {
    lines.push(`Ended:   ${formatDate(state.completedAt)}`);
  }

  const failure = extractFailure(events);
  if (failure) {
    lines.push('');
    lines.push('Failure:');
    if (failure.error) {
      lines.push(`  Code:    ${failure.error.code}`);
      lines.push(`  Message: ${failure.error.message}`);
      if (failure.error.retryable !== undefined) {
        lines.push(`  Retryable: ${failure.error.retryable}`);
      }
    }
    if (failure.constraint) {
      // Historical breaches used `maxSpend` with micro-dollar values.
      // New breaches use `maxSpendDollars` with dollar values.
      const isMicroSpend = failure.constraint.name === 'maxSpend';
      const isDollarSpend = failure.constraint.name === 'maxSpendDollars';
      const isSpend = isMicroSpend || isDollarSpend;
      const toDollars = (value: number) =>
        isMicroSpend ? (value / 1_000_000).toFixed(6) : value.toFixed(6);
      lines.push(`  Constraint: ${failure.constraint.name}`);
      lines.push(
        `  Limit:      ${isSpend ? '$' + toDollars(failure.constraint.limit) : failure.constraint.limit}`,
      );
      lines.push(
        `  Actual:     ${isSpend ? '$' + toDollars(failure.constraint.actual) : failure.constraint.actual}`,
      );
    }
  }

  lines.push('');
  lines.push('Movements:');
  for (const h of history) {
    const goal = h.goalEvaluation.achieved ? '✓' : '✗';
    lines.push(
      `  [${h.status.toUpperCase()}] ${goal} ${h.movementName} (${h.movementId}) — ${formatDuration(
        h.durationMs,
      )}`,
    );
    if (h.summary) {
      lines.push(`    ${h.summary}`);
    }
    if (h.goalEvaluation.summary) {
      lines.push(`    Goal: ${h.goalEvaluation.summary}`);
    }
    if (h.error) {
      lines.push(`    Error: ${h.error.code} — ${h.error.message}`);
    }
  }
  lines.push('');
  lines.push(`Usage: ${formatUsage(state.usage)}`);
  return lines.join('\n');
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
