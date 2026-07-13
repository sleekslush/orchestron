import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { pauseConcert } from '@orchestron/plugin-common';

export function pauseConcertTool(getOrchestron: () => Promise<import('@orchestron/plugin-common').Orchestron>) {
  return defineTool({
    name: 'orchestron_pause_concert',
    label: 'Pause Orchestron Concert',
    description: 'Pause a running Orchestron concert.',
    parameters: Type.Object({
      concertId: Type.String({ description: 'ID of the concert to pause' }),
    }),
    promptSnippet: 'Pause a running Orchestron concert',
    promptGuidelines: [
      'Use orchestron_pause_concert when the user asks to pause or stop a running concert temporarily.',
    ],
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const orchestron = await getOrchestron();
      const result = await pauseConcert(orchestron, params);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
