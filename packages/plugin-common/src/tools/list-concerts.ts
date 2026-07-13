import type { Orchestron } from '../orchestron.js';
import { toUsageView, type UsageView } from '../util.js';

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
