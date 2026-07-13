import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { getConcertStatus } from '@orchestron/plugin-common';

export function getConcertStatusTool(getOrchestron: () => Promise<import('@orchestron/plugin-common').Orchestron>) {
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
