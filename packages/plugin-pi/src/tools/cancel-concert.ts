import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { cancelConcert } from '@orchestron/plugin-common';

export function cancelConcertTool(getOrchestron: () => Promise<import('@orchestron/plugin-common').Orchestron>) {
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
