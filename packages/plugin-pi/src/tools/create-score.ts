import { existsSync, writeFileSync } from 'node:fs';
import { Type } from 'typebox';
import { StringEnum } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Orchestron } from '../orchestron.js';
import {
  parseAndValidateScore,
  sanitizeScoreId,
  scoreFilePath,
} from './_score-helpers.js';

export interface CreateScoreInput {
  scoreId: string;
  yaml: string;
  persist?: boolean;
  saveLocation?: 'local' | 'global';
}

export async function createScore(
  orchestron: Orchestron,
  input: CreateScoreInput,
): Promise<{
  scoreId: string;
  persisted: boolean;
  path?: string;
  valid: boolean;
  errors: Array<{ code: string; message: string }>;
}> {
  const scoreId = sanitizeScoreId(input.scoreId);
  const { score, errors } = parseAndValidateScore(orchestron.registry, input.yaml);

  if (errors.length > 0) {
    return { scoreId, persisted: false, valid: false, errors };
  }

  if (score.id !== scoreId) {
    return {
      scoreId,
      persisted: false,
      valid: false,
      errors: [
        {
          code: 'INVALID_SCORE',
          message: `YAML id '${score.id}' does not match requested score id '${scoreId}'`,
        },
      ],
    };
  }

  const path = scoreFilePath(orchestron.scoresDirs, scoreId, input.saveLocation);

  if (existsSync(path)) {
    return {
      scoreId,
      persisted: false,
      valid: true,
      errors: [
        {
          code: 'INVALID_SCORE',
          message: `Score '${scoreId}' already exists at ${path}. Use orchestron_edit_score to modify it.`,
        },
      ],
    };
  }

  orchestron.registry.register(score);

  if (input.persist) {
    writeFileSync(path, input.yaml, 'utf-8');
    return { scoreId, persisted: true, path, valid: true, errors: [] };
  }

  return { scoreId, persisted: false, valid: true, errors: [] };
}

export function createScoreTool(getOrchestron: () => Promise<Orchestron>) {
  return defineTool({
    name: 'orchestron_create_score',
    label: 'Create Orchestron Score',
    description:
      'Create a new Orchestron score from a complete YAML definition. The score is validated and registered in memory. Set persist: true to save it to the scores directory. Use this to draft and test a score before persisting it.',
    parameters: Type.Object({
      scoreId: Type.String({
        description:
          'Unique identifier for the score. Will be sanitized to lowercase letters, numbers, hyphens, and underscores. Must match the id field in the YAML.',
      }),
      yaml: Type.String({
        description:
          'Complete YAML content of the score. Must include id, name, version, startMovement, program, and movements.',
      }),
      persist: Type.Optional(
        Type.Boolean({
          description:
            'If true, save the score to the scores directory after validation. Default is false, which keeps the score in memory only.',
        }),
      ),
      saveLocation: Type.Optional(
        StringEnum(['local', 'global'] as const, {
          description: "Where to save the score. 'local' (default) uses ./.orchestron/scores/. 'global' uses ~/.orchestron/scores/.",
        }),
      ),
    }),
    promptSnippet: 'Create a new Orchestron workflow score from YAML',
    promptGuidelines: [
      'Use orchestron_create_score when the user wants to create a new score or workflow.',
      'First call with persist: false to validate and register the score in memory.',
      'Test the score by running orchestron_start_concert.',
      'Only set persist: true once the user explicitly asks to save the score.',
      'The scoreId must match the id field in the YAML.',
      'If the score already exists on disk, use orchestron_edit_score instead.',
    ],
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const orchestron = await getOrchestron();
      const result = await createScore(orchestron, params);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
