import type { HarnessAdapter, HarnessResponse } from '../types/adapter.js';
import type { Goal, GoalEvaluation, ConcertContext } from '../types/index.js';
import { GoalEvalError } from '../types/errors.js';
import type { Evaluator } from './evaluator.js';
import { safeJsonParse, extractBalancedJson } from '../json-utils.js';

const goalEvaluationSchema = {
  type: 'object',
  properties: {
    achieved: { type: 'boolean' },
    confidence: { type: 'number' },
    summary: { type: 'string' },
    evidence: { type: 'string' },
  },
  required: ['achieved', 'confidence', 'summary'],
} as const;

export interface HarnessEvaluatorConfig {
  adapter: HarnessAdapter;
  promptTemplate?: string;
  model?: string;
  provider?: string;
}

export class HarnessEvaluator implements Evaluator {
  constructor(private config: HarnessEvaluatorConfig) {}

  async evaluate(
    goal: Goal,
    output: string,
    context: ConcertContext,
    movementId?: string,
  ): Promise<GoalEvaluation> {
    const prompt = this.buildPrompt(goal, output, context, movementId);

    const response = await this.config.adapter.execute(prompt, context, {
      output: {
        mode: 'structured',
        schema: goalEvaluationSchema as unknown as Record<string, unknown>,
      },
      model: this.config.model,
      provider: this.config.provider,
    });

    return this.parseEvaluation(response, goal, movementId);
  }

  private buildPrompt(
    goal: Goal,
    output: string,
    context: ConcertContext,
    movementId?: string,
  ): string {
    const template =
      this.config.promptTemplate ??
      `You are evaluating whether a movement achieved its goal.

Goal: {{goal.description}}
Movement output: {{output}}
Movement ID: {{movementId}}
Shared context: {{context}}

Return a JSON object with:
- "achieved": boolean
- "confidence": number between 0 and 1
- "summary": a brief explanation of your judgment
- "evidence": optional evidence supporting your judgment`;

    return template
      .replaceAll('{{goal.description}}', goal.description)
      .replaceAll('{{output}}', output)
      .replaceAll('{{movementId}}', movementId ?? '')
      .replaceAll('{{context}}', JSON.stringify(context.shared, null, 2));
  }

  private parseEvaluation(
    response: HarnessResponse,
    goal: Goal,
    movementId?: string,
  ): GoalEvaluation {
    const structured = response.structured;
    if (this.isGoalEvaluation(structured)) {
      return structured;
    }

    const text = response.output.trim();
    if (text) {
      const parsed = this.extractGoalEvaluation(text);
      if (parsed) {
        return parsed;
      }
    }

    throw new GoalEvalError(
      `Evaluator could not parse a valid GoalEvaluation for movement '${movementId ?? 'unknown'}'`,
      'EVALUATOR_FAILURE',
      undefined,
      movementId,
    );
  }

  private extractGoalEvaluation(text: string): GoalEvaluation | undefined {
    const blockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (blockMatch) {
      const parsed = safeJsonParse(blockMatch[1].trim());
      if (this.isGoalEvaluation(parsed)) {
        return parsed;
      }
    }

    const balanced = extractBalancedJson(text);
    if (balanced) {
      const parsed = safeJsonParse(balanced);
      if (this.isGoalEvaluation(parsed)) {
        return parsed;
      }
    }

    const parsed = safeJsonParse(text.trim());
    if (this.isGoalEvaluation(parsed)) {
      return parsed;
    }

    return undefined;
  }

  private isGoalEvaluation(value: unknown): value is GoalEvaluation {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const v = value as Record<string, unknown>;
    return (
      typeof v.achieved === 'boolean' &&
      typeof v.confidence === 'number' &&
      typeof v.summary === 'string'
    );
  }
}
