import type { Goal, GoalEvaluation, ConcertContext } from '../types/index.js';

export interface Evaluator {
  evaluate(
    goal: Goal,
    output: string,
    context: ConcertContext,
    movementId?: string,
  ): Promise<GoalEvaluation>;
}
