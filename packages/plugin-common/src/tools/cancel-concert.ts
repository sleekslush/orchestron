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
  await new Promise((resolve) => setTimeout(resolve, 100));
  const state = await conductor.getState();
  return { concertId: state.id, status: state.status };
}
