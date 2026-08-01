import type { Orchestron } from '../orchestron.js';
import type { ConcertEvent } from '@orchestron/core';
import { toUsageView, type UsageView } from '../util.js';

export interface GetStatusInput {
  concertId: string;
}

export async function getConcertStatus(
  orchestron: Orchestron,
  input: GetStatusInput,
): Promise<{
  concertId: string;
  scoreId: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  currentMovement: string | null;
  currentMovementProgress?: {
    type: string;
    toolName?: string;
    isError?: boolean;
    elapsedMs?: number;
    message?: string;
    args?: Record<string, unknown>;
    result?: unknown;
    error?: string;
  };
  usage: UsageView;
  movements: Array<{
    movementId: string;
    movementName: string;
    status: string;
    summary: string;
    durationMs: number;
    goalAchieved: boolean;
    goalSummary: string;
    model?: string;
    provider?: string;
  }>;
}> {
  const state = await orchestron.store.getConcert(input.concertId);
  if (!state) {
    throw new Error(`Concert '${input.concertId}' not found`);
  }

  const history = await orchestron.store.getMovementHistory(input.concertId);
  let events: ConcertEvent[] = [];
  if (state.currentMovement) {
    // Prefer the live event log; fall back to SQLite events (backward compat)
    // when no live log exists for the concert yet.
    const live = orchestron.liveEventLog
      ? await orchestron.liveEventLog.read(input.concertId)
      : [];
    events = live.length > 0
      ? live
      : await orchestron.store.getEvents(input.concertId, {
          types: ['movement:progress'],
        });
  }
  const latestProgress = events.length > 0
    ? [...events]
        .filter((e) => e.type === 'movement:progress')
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0]
    : undefined;
  const currentMovementProgress =
    latestProgress?.type === 'movement:progress'
      ? {
          type: latestProgress.progressType,
          toolName: latestProgress.payload.toolName as string | undefined,
          isError: latestProgress.payload.isError as boolean | undefined,
          elapsedMs: latestProgress.payload.elapsedMs as number | undefined,
          message: latestProgress.payload.message as string | undefined,
          args: latestProgress.payload.args as Record<string, unknown> | undefined,
          result: latestProgress.payload.result,
          error: latestProgress.payload.error as string | undefined,
        }
      : undefined;

  return {
    concertId: state.id,
    scoreId: state.scoreId,
    status: state.status,
    startedAt: state.startedAt.toISOString(),
    completedAt: state.completedAt?.toISOString(),
    currentMovement: state.currentMovement,
    currentMovementProgress,
    usage: toUsageView(state.usage),
    movements: history.map((h) => ({
      movementId: h.movementId,
      movementName: h.movementName,
      status: h.status,
      summary: h.summary,
      durationMs: h.durationMs,
      goalAchieved: h.goalEvaluation.achieved,
      goalSummary: h.goalEvaluation.summary,
      model: h.model,
      provider: h.provider,
    })),
  };
}
