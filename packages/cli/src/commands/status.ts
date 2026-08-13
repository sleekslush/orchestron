import type { Orchestron } from '../orchestron.js';
import type { ConcertEvent, StreamRecord } from '@orchestron/core';
import { streamRecordToEvent, streamRecordsToEvents } from '@orchestron/core';
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

function truncateJson(data: unknown, max = 240): string {
  let text: string;
  try {
    text = JSON.stringify(data);
  } catch {
    text = String(data);
  }
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/** Render a raw SDK stream record for the terminal (display-only). */
function printSdkRecord(record: StreamRecord): void {
  const attempt = record.attempt !== undefined ? ` attempt=${record.attempt}` : '';
  const harness = record.harness ? `[${record.harness}]` : '';
  const data = record.data as Record<string, unknown> | undefined;
  const props = (data?.properties as Record<string, unknown> | undefined) ?? data;

  if (record.synthetic && record.type === 'user.prompt') {
    const prompt = (data as { prompt?: unknown } | undefined)?.prompt;
    if (typeof prompt === 'string') {
      const text = prompt.length > 200 ? prompt.slice(0, 200) + '…' : prompt;
      process.stderr.write(`\n> ${text}\n`);
      return;
    }
  }

  switch (record.type) {
    case 'message_update': {
      const inner = data?.assistantMessageEvent as { type?: unknown; delta?: unknown } | undefined;
      if (inner?.type === 'text_delta' && typeof inner.delta === 'string') {
        process.stderr.write(inner.delta);
      }
      return;
    }
    case 'tool_execution_start':
      console.error(`  ↳ ${harness}${attempt} ${String(data?.toolName ?? 'tool')}...`);
      return;
    case 'tool_execution_end':
      if (typeof data?.isError === 'boolean' && data.isError) {
        console.error(`  ↳ ${harness}${attempt} ${String(data?.toolName ?? 'tool')} [error: ${String(data?.error ?? 'unknown')}]`);
      } else {
        console.error(`  ↳ ${harness}${attempt} ${String(data?.toolName ?? 'tool')}`);
      }
      return;
    case 'session.next.text.delta': {
      const delta = props?.delta;
      if (typeof delta === 'string') {
        process.stderr.write(delta);
      }
      return;
    }
    case 'session.next.tool.called':
      console.error(`  ↳ ${harness}${attempt} ${String(props?.tool ?? 'tool')}...`);
      return;
    case 'session.next.tool.success':
    case 'session.next.tool.failed':
      console.error(
        `  ↳ ${harness}${attempt} ${String(props?.tool ?? props?.callID ?? 'tool')}${record.type === 'session.next.tool.failed' ? ' [error]' : ''}`,
      );
      return;
    case 'turn_end':
    case 'agent_end':
      console.error(`  ${harness}${attempt} ${record.type}`);
      return;
    case 'session.next.step.ended':
    case 'session.next.step.failed':
      console.error(`  ${harness}${attempt} ${record.type.replace('session.next.', '')}`);
      return;
    default:
      console.error(`  ${harness}${attempt} ${record.type} ${truncateJson(record.data)}`);
  }
}

function printStreamRecord(record: StreamRecord): void {
  if (record.source === 'concert') {
    const event = streamRecordToEvent(record);
    if (event) printLiveEvent(event);
    return;
  }
  printSdkRecord(record);
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
  const records = await orchestron.concertStream.read(concertId);
  const streamEvents = streamRecordsToEvents(records);
  const events = streamEvents.length > 0 ? streamEvents : await orchestron.store.getEvents(concertId);
  const failure = extractFailure(events);
  const progress = latestProgressEvent(events);
  const started = latestStartedEvent(events);
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
    formatConcertHuman(state, history, events, verbose, currentCommand, currentPrompt),
  );
}

async function watchStatus(
  orchestron: Orchestron,
  concertId: string,
  json: boolean,
  verbose: boolean,
  raw: boolean,
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
    for await (const batch of orchestron.concertStream.watch(concertId, {
      signal: controller.signal,
    })) {
      for (const record of batch) {
        if (raw) {
          console.log(JSON.stringify(record));
          continue;
        }
        printStreamRecord(record);
      }
      const terminal = await checkTerminal();
      if (terminal) break;
    }
  } catch (err) {
    if (!(err instanceof Error && err.name === 'AbortError')) {
      console.error(`watch interrupted: ${(err as Error).message}`);
    }
  }

  await renderStatus(orchestron, concertId, json, verbose);
}

export async function statusCommandHandler(
  orchestron: Orchestron,
  concertId: string | undefined,
  json: boolean,
  verbose = false,
  watch = false,
  raw = false,
): Promise<void> {
  if (concertId) {
    if (watch) {
      await watchStatus(orchestron, concertId, json, verbose, raw);
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
