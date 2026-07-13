import { Type } from 'typebox';
import { StringEnum } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { listConcerts } from '@orchestron/plugin-common';

export function listConcertsTool(getOrchestron: () => Promise<import('@orchestron/plugin-common').Orchestron>) {
  return defineTool({
    name: 'orchestron_list_concerts',
    label: 'List Orchestron Concerts',
    description:
      'List Orchestron concerts, optionally filtered by status, with limit and offset pagination.',
    parameters: Type.Object({
      status: Type.Optional(
        StringEnum([
          'pending',
          'running',
          'paused',
          'completed',
          'failed',
          'cancelled',
        ] as const),
      ),
      limit: Type.Optional(Type.Number({ description: 'Maximum number of concerts to return' })),
      offset: Type.Optional(Type.Number({ description: 'Number of concerts to skip' })),
    }),
    promptSnippet: 'List Orchestron concerts and their statuses',
    promptGuidelines: [
      'Use orchestron_list_concerts when the user asks about their concerts or wants to find a concertId.',
      'Filter by status when the user asks for active, running, completed, failed, or cancelled concerts.',
    ],
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const orchestron = await getOrchestron();
      const result = await listConcerts(orchestron, params);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
