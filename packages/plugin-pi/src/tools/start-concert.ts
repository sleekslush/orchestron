import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { AgentToolUpdateCallback } from '@earendil-works/pi-coding-agent';
import type { Orchestron } from '../orchestron.js';

export interface StartConcertInput {
  scoreId: string;
  context?: Record<string, unknown>;
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

export async function startConcert(
  orchestron: Orchestron,
  input: StartConcertInput,
  onUpdate?: AgentToolUpdateCallback<unknown>,
): Promise<{
  concertId: string;
  scoreId: string;
  status: string;
  startedAt: string;
}> {
  const conductor = await orchestron.hall.createConcert(input.scoreId, {
    initialContext: input.context,
    triggeredBy: 'agent',
  });

  // Start in the background so the Pi session can continue immediately.
  conductor.start().catch(() => {});

  const state = await conductor.getState();
  const result = {
    concertId: state.id,
    scoreId: state.scoreId,
    status: state.status,
    startedAt: state.startedAt.toISOString(),
  };

  if (onUpdate) {
    sendProgress(
      onUpdate,
      `Started concert ${state.id}. Current movement: ${state.currentMovement ?? 'none'}.`,
    );

    // Stream progress updates for a short window so the Pi session sees the concert is alive.
    const startTime = Date.now();
    const maxStreamingMs = 10000;
    const pollIntervalMs = 500;
    let lastTimestamp = new Date(0);
    let lastMovement = state.currentMovement;

    while (Date.now() - startTime < maxStreamingMs) {
      const events = await orchestron.store.getEvents(state.id, {
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

      const current = await orchestron.store.getConcert(state.id);
      if (current && current.currentMovement !== lastMovement) {
        sendProgress(
          onUpdate,
          `Movement advanced from ${lastMovement ?? 'none'} to ${current.currentMovement ?? 'completed'}.`,
        );
        lastMovement = current.currentMovement;
      }
      if (current && current.status !== 'running' && current.status !== 'pending') {
        sendProgress(onUpdate, `Concert finished with status: ${current.status}.`);
        break;
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }

  return result;
}

export function startConcertTool(getOrchestron: () => Promise<Orchestron>) {
  return defineTool({
    name: 'orchestron_start_concert',
    label: 'Start Orchestron Concert',
    description:
      'Start a new Orchestron concert from a registered score. The concert runs in the background and can be monitored with orchestron_get_concert_status.',
    parameters: Type.Object({
      scoreId: Type.String({ description: 'ID of the registered score to run' }),
      context: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: 'Optional initial context values for the concert',
        }),
      ),
    }),
    promptSnippet: 'Start an Orchestron workflow concert from a registered score',
    promptGuidelines: [
      'Use orchestron_start_concert when the user asks to run a workflow, score, or concert.',
      'Pass the scoreId exactly as registered and any context values the score expects.',
    ],
    async execute(_toolCallId, params, _signal, onUpdate, _ctx) {
      const orchestron = await getOrchestron();
      const result = await startConcert(orchestron, params, onUpdate);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
