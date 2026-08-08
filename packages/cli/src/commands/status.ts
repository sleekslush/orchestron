import type { Orchestron } from '../orchestron.js';
import type { ConcertEvent } from '@orchestron/core';
import {
  printOutput,
  formatConcertHuman,
  extractFailure,
  formatDate,
  formatDuration,
  formatUsage,
  formatDollars,
  movementToOutput,
} from '../output.js';
import { backfillSpend } from '../spend.js';

function latestProgressEvent(
  events: ConcertEvent[],
): {
  type?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  message?: string;
} | undefined {
  const progress = [...events].reverse().find(
    (e): e is ConcertEvent & { type: 'movement:progress' } => e.type === 'movement:progress',
  );
  if (!progress) return undefined;

  const payload = progress.payload ?? {};
  return {
    type: progress.progressType,
    toolName: typeof payload.toolName === 'string' ? payload.toolName : undefined,
    args: typeof payload.args === 'object' && payload.args !== null && !Array.isArray(payload.args)
      ? (payload.args as Record<string, unknown>)
      : undefined,
    message: typeof payload.message === 'string' ? payload.message : undefined,
  };
}

function latestStartedEvent(
  events: ConcertEvent[],
): { prompt?: string } | undefined {
  const started = [...events].reverse().find(
    (e): e is ConcertEvent & { type: 'movement:started' } => e.type === 'movement:started',
  );
  return started ? { prompt: started.prompt } : undefined;
}

function currentCommandFromProgress(progress: ReturnType<typeof latestProgressEvent>): string | undefined {
  if (!progress) return undefined;
  if (progress.toolName) {
    return `${progress.toolName}${progress.args ? ` ${JSON.stringify(progress.args)}` : ''}`;
  }
  return progress.message;
}

async function renderStatus(
  orchestron: Orchestron,
  concertId: string,
  json: boolean,
  verbose: boolean,
): Promise<void> {
  const state = await orchestron.store.getConcert(concertId);
  if (!state) {
    throw new Error(`Concert '${concertId}' not found`);
  }

  const history = await orchestron.store.getMovementHistory(concertId);
  // Events are persisted to the store by the conductor (fire-and-forget);
  // per-movement export files hold the authoritative session record.
  const fallbackEvents = await orchestron.store.getEvents(concertId);
  const failure = extractFailure(fallbackEvents);
  const progress = latestProgressEvent(fallbackEvents);
  const started = latestStartedEvent(fallbackEvents);
  const currentCommand = currentCommandFromProgress(progress);
  const currentPrompt = started?.prompt;

  const output = {
    concertId: state.id,
    scoreId: state.scoreId,
    status: state.status,
    startedAt: state.startedAt.toISOString(),
    completedAt: state.completedAt?.toISOString(),
    currentMovement: state.currentMovement,
    currentCommand,
    currentPrompt,
    usage: state.usage,
    failure,
    movements: history.map(movementToOutput),
  };

  printOutput(json, output, () =>
    formatConcertHuman(state, history, fallbackEvents, verbose, currentCommand, currentPrompt),
  );
}

async function watchStatus(
  orchestron: Orchestron,
  concertId: string,
  json: boolean,
  verbose: boolean,
): Promise<void> {
  const state = await orchestron.store.getConcert(concertId);
  if (!state) {
    throw new Error(`Concert '${concertId}' not found`);
  }

  if (state.status !== 'running' && state.status !== 'pending') {
    await renderStatus(orchestron, concertId, json, verbose);
    return;
  }

  const controller = new AbortController();
  const isTerminal = (status: string) =>
    status !== 'running' && status !== 'pending';

  // Live tool-level detail now streams to the per-movement export files;
  // watch mode polls the store for movement transitions and terminal state.
  let lastMovement = state.currentMovement;
  try {
    while (!controller.signal.aborted) {
      const current = await orchestron.store.getConcert(concertId);
      if (!current) break;
      if (current.currentMovement !== lastMovement) {
        console.error(`→ [${current.currentMovement}] Running...`);
        lastMovement = current.currentMovement;
      }
      if (isTerminal(current.status)) break;
      await sleep(500);
    }
  } catch {
    // Aborted by terminal status or user; render final status below.
  }

  await renderStatus(orchestron, concertId, json, verbose);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function statusCommandHandler(
  orchestron: Orchestron,
  concertId: string | undefined,
  json: boolean,
  verbose = false,
  watch = false,
): Promise<void> {
  if (concertId) {
    if (watch) {
      await watchStatus(orchestron, concertId, json, verbose);
      return;
    }
    await renderStatus(orchestron, concertId, json, verbose);
    return;
  }

  const aggregates = await (async () => {
    await backfillSpend(orchestron.store);
    return orchestron.store.getAggregates();
  })();
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

function formatSystemHuman(
  aggregates: {
    totalConcerts: number;
    activeConcerts: number;
    totalSpend?: number;
    estimatedSpend?: number;
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
  const spendLine =
    aggregates.totalSpend === undefined
      ? `Total spend: ${formatUsage({ tokens: aggregates.totalTokens })}`
      : `Total spend: ${formatUsage({ spend: aggregates.totalSpend, tokens: aggregates.totalTokens })}`;
  lines.push(spendLine);
  if (aggregates.totalSpend !== undefined && (aggregates.estimatedSpend ?? 0) > 0) {
    lines.push(
      `  (measured $${formatDollars((aggregates.totalSpend ?? 0) - (aggregates.estimatedSpend ?? 0))}, estimated ~$${formatDollars(aggregates.estimatedSpend ?? 0)})`,
    );
  }
  lines.push(`Avg duration: ${formatDuration(aggregates.avgDurationMs)}`);
  lines.push(`Failure rate: ${(aggregates.failureRate * 100).toFixed(1)}%`);
  lines.push('');
  lines.push('Recent concerts:');
  for (const c of recent) {
    lines.push(`  ${c.id}  ${c.scoreId}  ${c.status}  ${formatDate(c.startedAt)}`);
  }
  return lines.join('\n');
}
