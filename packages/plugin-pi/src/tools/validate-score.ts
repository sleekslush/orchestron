import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Orchestron } from '../orchestron.js';
import { sanitizeScoreId } from './_score-helpers.js';

export interface ValidateScoreInput {
  scoreId: string;
}

export async function validateScore(
  orchestron: Orchestron,
  input: ValidateScoreInput,
): Promise<{
  scoreId: string;
  valid: boolean;
  errors: Array<{ code: string; message: string }>;
}> {
  const scoreId = sanitizeScoreId(input.scoreId);

  try {
    const score = orchestron.registry.get(scoreId);
    const rawErrors = orchestron.registry.validate(score);
    return {
      scoreId,
      valid: rawErrors.length === 0,
      errors: rawErrors.map((e) => ({ code: e.code, message: e.message })),
    };
  } catch (err) {
    return {
      scoreId,
      valid: false,
      errors: [{ code: 'INVALID_SCORE', message: (err as Error).message }],
    };
  }
}

export function validateScoreTool(getOrchestron: () => Promise<Orchestron>) {
  return defineTool({
    name: 'orchestron_validate_score',
    label: 'Validate Orchestron Score',
    description:
      'Validate a registered Orchestron score and return any structural errors (e.g., unreachable movements, unknown transitions, cycles).',
    parameters: Type.Object({
      scoreId: Type.String({ description: 'ID of the score to validate' }),
    }),
    promptSnippet: 'Validate an Orchestron score for structural errors',
    promptGuidelines: [
      'Use orchestron_validate_score when the user wants to check if a score is well-formed without running it.',
    ],
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const orchestron = await getOrchestron();
      const result = await validateScore(orchestron, params);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
