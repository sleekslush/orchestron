import type { Command } from 'commander';
import type { ConcertEvent } from '@orchestron/core';
import { microToDollars } from '@orchestron/core';

export function wantsJson(cmd: Command): boolean {
  return cmd.optsWithGlobals().json === true;
}

export function printOutput(
  json: boolean,
  data: unknown,
  humanFormatter: () => string,
): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(humanFormatter());
  }
}

export function formatDate(d: Date | undefined): string {
  if (!d) return '-';
  return d.toISOString();
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || ms === null) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatUsage(usage: { spend?: number; tokens?: number }): string {
  const spend = usage.spend ?? 0;
  const tokens = usage.tokens ?? 0;
  return `$${microToDollars(spend).toFixed(6)} / ${tokens} tokens`;
}

export function extractFailure(events: ConcertEvent[]) {
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

export function formatConcertHuman(
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
    model?: string;
    provider?: string;
  }>,
  events: ConcertEvent[],
  verbose = false,
  currentCommand?: string,
  currentPrompt?: string,
): string {
  const lines: string[] = [];
  lines.push(`Concert: ${state.id}`);
  lines.push(`Score:   ${state.scoreId}`);
  lines.push(`Status:  ${state.status}`);
  if (state.currentMovement) {
    lines.push(`Current: ${state.currentMovement}`);
  }
  if (currentCommand) {
    lines.push(`Running: ${currentCommand}`);
  }
  if (currentPrompt) {
    const preview = currentPrompt.length > 200 ? currentPrompt.slice(0, 200) + '...' : currentPrompt;
    lines.push(`Prompt:  ${preview}`);
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
      const isMicroSpend = failure.constraint.name === 'maxSpend';
      const isDollarSpend = failure.constraint.name === 'maxSpendDollars';
      const isSpend = isMicroSpend || isDollarSpend;
      const toDollars = (value: number) =>
        isMicroSpend ? microToDollars(value).toFixed(6) : value.toFixed(6);
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
    if (!verbose) continue;
    if (h.summary) {
      lines.push(`    ${h.summary}`);
    }
    if (h.goalEvaluation.summary) {
      lines.push(`    Goal: ${h.goalEvaluation.summary}`);
    }
    if (h.model) {
      lines.push(`    Model: ${[h.provider, h.model].filter(Boolean).join(' / ')}`);
    }
    if (h.error) {
      lines.push(`    Error: ${h.error.code} — ${h.error.message}`);
    }
  }
  lines.push('');
  lines.push(`Usage: ${formatUsage(state.usage)}`);
  return lines.join('\n');
}
