import { existsSync, writeFileSync } from 'node:fs';
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

  if (errors.length > 0 || !score) {
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

  if (input.persist) {
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
    writeFileSync(path, input.yaml, 'utf-8');
    return { scoreId, persisted: true, path, valid: true, errors: [] };
  }

  orchestron.registry.register(score);
  return { scoreId, persisted: false, valid: true, errors: [] };
}
