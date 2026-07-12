import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Orchestron } from '../orchestron.js';

export interface StartConcertInput {
  scoreId: string;
  context?: Record<string, unknown>;
}

export async function startConcert(
  orchestron: Orchestron,
  input: StartConcertInput,
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
  return {
    concertId: state.id,
    scoreId: state.scoreId,
    status: state.status,
    startedAt: state.startedAt.toISOString(),
  };
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
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const orchestron = await getOrchestron();
      const result = await startConcert(orchestron, params);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
