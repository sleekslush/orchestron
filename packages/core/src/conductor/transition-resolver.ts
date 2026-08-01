import type { Movement, Transition } from '../types/score.js';

/** Outcome of a movement execution that drives transition resolution. */
export type MovementOutcome = 'success' | 'failure' | 'rejection';

export function matchTransition(
  movement: Movement,
  outcome: MovementOutcome,
): Transition | undefined {
  return movement.transitions.find((t) => t.on === outcome || t.on === 'any');
}
