import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { AgentToolUpdateCallback } from '@earendil-works/pi-coding-agent';
import type { Orchestron } from '../orchestron.js';
import { toUsageView, type UsageView } from './util.js';

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
  });
}

function usageEqual(a: UsageView, b: UsageView): boolean {
  return (
    a.spend === b.spend &&
    a.tokens === b.tokens &&
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens
  );
}

export interface WaitForConcertInput {
  concertId: string;
}

function sendProgress(
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  text: string,
): void {
  if (!onUpdate) return;
  onUpdate({
    content: [{ type: 'text', text }],
    details: {},
  });
}

async function lookupMaxSpend(
  orchestron: Orchestron,
  scoreId: string,
): Promise<number | undefined> {
  try {
    const score = orchestron.registry.get(scoreId);
    return score.program?.maxSpendDollars;
  } catch {
    return undefined;
  }
}

export async function waitForConcert(
  orchestron: Orchestron,
  input: WaitForConcertInput,
  onUpdate?: AgentToolUpdateCallback<unknown>,
  signal?: AbortSignal,
): Promise<{
  concertId: string;
  scoreId: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  currentMovement: string | null;
  usage: UsageView;
  movements: Array<{
    movementId: string;
    movementName: string;
    status: string;
    summary: string;
    durationMs: number;
    goalAchieved: boolean;
    goalSummary: string;
  }>;
}> {
  const initial = await orchestron.store.getConcert(input.concertId);
  if (!initial) {
    throw new Error(`Concert '${input.concertId}' not found`);
  }

  const maxSpendDollars = await lookupMaxSpend(orchestron, initial.scoreId);

  if (initial.status !== 'running' && initial.status !== 'pending') {
    sendProgress(onUpdate, `Concert already finished with status: ${initial.status}.`);
    return buildResult(initial, await orchestron.store.getMovementHistory(input.concertId));
  }

  sendProgress(
    onUpdate,
    `Waiting for concert ${input.concertId} to complete. Current movement: ${initial.currentMovement ?? 'none'}.`,
  );
  emitUsage(initial.usage, maxSpendDollars);

  const pollIntervalMs = 500;
  let lastTimestamp = new Date(0);
  let lastMovement = initial.currentMovement;
  let lastUsage = initial.usage;

  function emitUsage(usage: UsageView, maxDollars?: number) {
    const parts: string[] = [];
    if (usage.spend !== undefined) {
      const spendDollars = usage.spend / 1_000_000;
      if (maxDollars !== undefined) {
        const pct = (spendDollars / maxDollars) * 100;
        parts.push(`$${spendDollars.toFixed(4)} spend / $${maxDollars.toFixed(4)} max (${pct.toFixed(1)}%)`);
      } else {
        parts.push(`$${spendDollars.toFixed(4)} spend`);
      }
    }
    if (usage.tokens !== undefined) parts.push(`${usage.tokens} tokens`);
    if (usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
      parts.push(`(${usage.inputTokens} in + ${usage.outputTokens} out)`);
    } else if (usage.inputTokens !== undefined) {
      parts.push(`(${usage.inputTokens} in)`);
    } else if (usage.outputTokens !== undefined) {
      parts.push(`(${usage.outputTokens} out)`);
    }
    if (parts.length > 0) {
      sendProgress(onUpdate, `Usage: ${parts.join(', ')}`);
    }
  }

  while (true) {
    if (signal?.aborted) {
      sendProgress(onUpdate, 'Wait aborted by caller.');
      break;
    }

    const events = await orchestron.store.getEvents(input.concertId, {
      types: ['movement:progress'],
      since: lastTimestamp,
    });
    for (const event of events) {
      if (event.type !== 'movement:progress') continue;
      const payload = event.payload;
      let text =
        (payload.message as string | undefined) ??
        `Progress: ${event.progressType}${payload.toolName ? ` (${payload.toolName as string})` : ''}`;
      if (event.progressType === 'tool_execution_start' && payload.args) {
        const args = payload.args as Record<string, unknown>;
        const cmd =
          (args.command as string | undefined) ??
          (args.filePath as string | undefined) ??
          (args.file as string | undefined) ??
          (args.path as string | undefined);
        if (cmd) {
          text += ` → ${cmd}`;
        }
      }
      if (event.progressType === 'tool_execution_end' && payload.isError) {
        text += ` [error]`;
      }
      sendProgress(onUpdate, text);
      lastTimestamp = event.timestamp;
    }

    const current = await orchestron.store.getConcert(input.concertId);
    if (!current) {
      sendProgress(onUpdate, `Concert ${input.concertId} no longer exists.`);
      break;
    }

    if (current.currentMovement !== lastMovement) {
      sendProgress(
        onUpdate,
        `Movement advanced from ${lastMovement ?? 'none'} to ${current.currentMovement ?? 'completed'}.`,
      );
      lastMovement = current.currentMovement;
    }

    if (!usageEqual(current.usage, lastUsage)) {
      emitUsage(current.usage, maxSpendDollars);
      lastUsage = current.usage;
    }

    if (current.status !== 'running' && current.status !== 'pending') {
      sendProgress(onUpdate, `Concert finished with status: ${current.status}.`);
      emitUsage(current.usage, maxSpendDollars);
      const history = await orchestron.store.getMovementHistory(input.concertId);
      return buildResult(current, history);
    }

    await sleep(pollIntervalMs, signal);
  }

  const final = await orchestron.store.getConcert(input.concertId);
  const history = final ? await orchestron.store.getMovementHistory(input.concertId) : [];
  return buildResult(final ?? initial, history);
}

function buildResult(
  state: {
    id: string;
    scoreId: string;
    status: string;
    startedAt: Date;
    completedAt?: Date;
    currentMovement: string | null;
    usage: UsageView;
  },
  history: Array<{
    movementId: string;
    movementName: string;
    status: string;
    summary: string;
    durationMs: number;
    goalEvaluation: { achieved: boolean; summary: string };
  }>,
) {
  return {
    concertId: state.id,
    scoreId: state.scoreId,
    status: state.status,
    startedAt: state.startedAt.toISOString(),
    completedAt: state.completedAt?.toISOString(),
    currentMovement: state.currentMovement,
    usage: toUsageView(state.usage),
    movements: history.map((h) => ({
      movementId: h.movementId,
      movementName: h.movementName,
      status: h.status,
      summary: h.summary,
      durationMs: h.durationMs,
      goalAchieved: h.goalEvaluation.achieved,
      goalSummary: h.goalEvaluation.summary,
    })),
  };
}

export function waitForConcertTool(getOrchestron: () => Promise<Orchestron>) {
  return defineTool({
    name: 'orchestron_wait_for_concert',
    label: 'Wait for Orchestron Concert',
    description:
      'Block until an Orchestron concert reaches a terminal state (completed, failed, or cancelled). Streams progress updates in real time and returns the final concert status, movement history, and resource usage.',
    parameters: Type.Object({
      concertId: Type.String({ description: 'ID of the concert to wait for' }),
    }),
    promptSnippet: 'Wait for an Orchestron concert to finish',
    promptGuidelines: [
      'Use orchestron_wait_for_concert instead of repeatedly calling orchestron_get_concert_status when you need to wait for a concert to finish.',
      'The concertId is returned by orchestron_start_concert.',
      'This tool blocks until the concert is done, streaming progress updates.',
    ],
    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      const orchestron = await getOrchestron();
      const result = await waitForConcert(orchestron, params, onUpdate, signal);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
