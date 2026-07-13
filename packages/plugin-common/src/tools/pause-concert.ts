import type { Orchestron } from '../orchestron.js';

export interface PauseConcertInput {
  concertId: string;
}

export async function pauseConcert(
  orchestron: Orchestron,
  input: PauseConcertInput,
): Promise<{ concertId: string; status: string }> {
  const conductor = await orchestron.hall.loadConcert(input.concertId);
  if (!conductor) {
    throw new Error(`Concert '${input.concertId}' not found`);
  }

  await conductor.pause();
  const state = await conductor.getState();
  return { concertId: state.id, status: state.status };
}
