import type { Goal, GoalEvaluation, ConcertContext } from '../types/index.js';
import type { Evaluator } from './evaluator.js';

export interface FakeEvaluatorConfig {
  defaultResult?: GoalEvaluation;
  perMovement?: Record<string, GoalEvaluation>;
  failOn?: string[];
  alwaysSucceed?: boolean;
}

export class FakeEvaluator implements Evaluator {
  constructor(private config: FakeEvaluatorConfig = {}) {}

  async evaluate(
    goal: Goal,
    _output: string,
    _context: ConcertContext,
    movementId?: string,
  ): Promise<GoalEvaluation> {
    if (this.config.alwaysSucceed) {
      return { achieved: true, confidence: 1, summary: 'Always succeeds', evidence: '' };
    }

    if (movementId && this.config.perMovement?.[movementId]) {
      return this.config.perMovement[movementId];
    }

    if (movementId && this.config.failOn?.includes(movementId)) {
      return { achieved: false, confidence: 0, summary: 'Configured to fail', evidence: '' };
    }

    return this.config.defaultResult ?? {
      achieved: true,
      confidence: 1,
      summary: 'Goal met (default)',
      evidence: '',
    };
  }
}
