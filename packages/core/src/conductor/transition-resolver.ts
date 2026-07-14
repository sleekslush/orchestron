import type { Movement, Transition } from '../types/score.js';

export function matchTransition(
  movement: Movement,
  achieved: boolean,
): Transition | undefined {
  const status: 'success' | 'failure' = achieved ? 'success' : 'failure';
  return movement.transitions.find((t) => t.on === status || t.on === 'skip');
}
