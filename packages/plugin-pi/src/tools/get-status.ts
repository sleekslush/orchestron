import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Orchestron } from '../orchestron.js';
import { toUsageView, type UsageView } from './util.js';

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
  }>;
}> {
  const state = await orchestron.store.getConcert(input.concertId);
  if (!state) {
    throw new Error(`Concert '${input.concertId}' not found`);
  }

  const history = await orchestron.store.getMovementHistory(input.concertId);
  const latestProgress = state.currentMovement
    ? await orchestron.store.getEvents(input.concertId, {
        types: ['movement:progress'],
        limit: 1,
        order: 'desc',
      })
    : [];
  const progressEvent = latestProgress[0];
  const currentMovementProgress =
    progressEvent?.type === 'movement:progress'
      ? {
          type: progressEvent.progressType,
          toolName: progressEvent.payload.toolName as string | undefined,
          isError: progressEvent.payload.isError as boolean | undefined,
          elapsedMs: progressEvent.payload.elapsedMs as number | undefined,
          message: progressEvent.payload.message as string | undefined,
          args: progressEvent.payload.args as Record<string, unknown> | undefined,
          result: progressEvent.payload.result,
          error: progressEvent.payload.error as string | undefined,
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
    })),
  };
}

export function getConcertStatusTool(getOrchestron: () => Promise<Orchestron>) {
  return defineTool({
    name: 'orchestron_get_concert_status',
    label: 'Get Orchestron Concert Status',
    description:
      'Get the current status, movement history, resource usage, and current movement progress of an Orchestron concert.',
    parameters: Type.Object({
      concertId: Type.String({ description: 'ID of the concert to check' }),
    }),
    promptSnippet: 'Check the status of a running or completed Orchestron concert',
    promptGuidelines: [
      'Use orchestron_get_concert_status when the user asks about the status of a concert or workflow.',
      'The concertId is returned by orchestron_start_concert.',
    ],
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const orchestron = await getOrchestron();
      const result = await getConcertStatus(orchestron, params);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
