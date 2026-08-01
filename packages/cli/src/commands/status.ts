import type { Orchestron } from '../orchestron.js';
import type { ConcertEvent } from '@orchestron/core';
import {
  printOutput,
  formatConcertHuman,
  extractFailure,
  formatDate,
  formatDuration,
  formatUsage,
  movementToOutput,
} from '../output.js';

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
    case 'movement:rejected':
      console.error(`✗ [${event.movementId}] Rejected: ${event.result?.summary ?? 'Goal not achieved'}`);
      break;
    case 'concert:completed':
      console.error('✓ Concert completed');
      break;
    case 'concert:failed':
      console.error(`✗ Concert failed: ${event.error?.message ?? 'Unknown error'}`);
      break;
    case 'concert:cancelled':
      console.error('✗ Concert cancelled');
      break;
    case 'movement:progress':
      if (event.progressType === 'tool_execution_start' && typeof event.payload?.toolName === 'string') {
        console.error(`  ↳ ${event.payload.toolName}...`);
      } else if (event.progressType === 'tool_execution_end' && typeof event.payload?.toolName === 'string') {
        const error = event.payload?.isError ? ` [error: ${event.payload.error ?? 'unknown'}]` : '';
        console.error(`  ↳ ${event.payload.toolName}${error}`);
      } else if (event.progressType === 'text_delta' && typeof event.payload?.delta === 'string') {
        process.stderr.write(event.payload.delta);
      }
      break;
  }
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
  const events = await orchestron.liveEventLog.read(concertId);
  const fallbackEvents = events.length === 0 ? await orchestron.store.getEvents(concertId) : events;
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

  const checkTerminal = async () => {
    const current = await orchestron.store.getConcert(concertId);
    if (current && isTerminal(current.status)) {
      controller.abort();
      return current.status;
    }
    return undefined;
  };

  try {
    for await (const batch of orchestron.liveEventLog.watch(concertId, {
      signal: controller.signal,
    })) {
      for (const event of batch) {
        printLiveEvent(event);
      }
      const terminal = await checkTerminal();
      if (terminal) break;
    }
  } catch {
    // Aborted by terminal status or user; render final status below.
  }

  await renderStatus(orchestron, concertId, json, verbose);
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

function formatSystemHuman(
  aggregates: {
    totalConcerts: number;
    activeConcerts: number;
    totalSpend?: number;
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
