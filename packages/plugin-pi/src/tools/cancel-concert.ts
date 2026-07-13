import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Orchestron } from '../orchestron.js';

export interface CancelConcertInput {
  concertId: string;
}

export async function cancelConcert(
  orchestron: Orchestron,
  input: CancelConcertInput,
): Promise<{ concertId: string; status: string }> {
  const conductor = await orchestron.hall.loadConcert(input.concertId);
  if (!conductor) {
    throw new Error(`Concert '${input.concertId}' not found`);
  }

  await conductor.cancel();
  // Cancel is async and may need a moment to finalize.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const state = await conductor.getState();
  return { concertId: state.id, status: state.status };
}

export function cancelConcertTool(getOrchestron: () => Promise<Orchestron>) {
  return defineTool({
    name: 'orchestron_cancel_concert',
    label: 'Cancel Orchestron Concert',
    description: 'Cancel a running or paused Orchestron concert.',
    parameters: Type.Object({
      concertId: Type.String({ description: 'ID of the concert to cancel' }),
    }),
    promptSnippet: 'Cancel a running or paused Orchestron concert',
    promptGuidelines: [
      'Use orchestron_cancel_concert when the user asks to cancel or abort a concert.',
    ],
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const orchestron = await getOrchestron();
      const result = await cancelConcert(orchestron, params);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
