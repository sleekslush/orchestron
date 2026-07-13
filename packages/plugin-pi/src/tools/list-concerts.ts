import { Type } from 'typebox';
import { StringEnum } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Orchestron } from '../orchestron.js';
import { toUsageView, type UsageView } from './util.js';

export interface ListConcertsInput {
  status?:
    | 'pending'
    | 'running'
    | 'paused'
    | 'completed'
    | 'failed'
    | 'cancelled';
  limit?: number;
  offset?: number;
}

export async function listConcerts(
  orchestron: Orchestron,
  input: ListConcertsInput,
): Promise<{
  concerts: Array<{
    concertId: string;
    scoreId: string;
    status: string;
    startedAt: string;
    completedAt?: string;
    usage: UsageView;
  }>;
}> {
  const concerts = await orchestron.store.listConcerts({
    status: input.status,
    limit: input.limit,
    offset: input.offset,
  });

  return {
    concerts: concerts.map((c) => ({
      concertId: c.id,
      scoreId: c.scoreId,
      status: c.status,
      startedAt: c.startedAt.toISOString(),
      completedAt: c.completedAt?.toISOString(),
      usage: toUsageView(c.usage),
    })),
  };
}

export function listConcertsTool(getOrchestron: () => Promise<Orchestron>) {
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
