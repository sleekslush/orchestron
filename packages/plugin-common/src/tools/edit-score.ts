import { existsSync, writeFileSync } from 'node:fs';
import type { Orchestron } from '../orchestron.js';
import {
  findScoreFile,
  parseAndValidateScore,
  sanitizeScoreId,
  scoreFilePath,
} from './_score-helpers.js';

export interface EditScoreInput {
  scoreId: string;
  yaml: string;
  persist?: boolean;
  saveLocation?: 'local' | 'global';
}

export async function editScore(
  orchestron: Orchestron,
  input: EditScoreInput,
): Promise<{
  scoreId: string;
  persisted: boolean;
  path?: string;
  valid: boolean;
  errors: Array<{ code: string; message: string }>;
}> {
  const scoreId = sanitizeScoreId(input.scoreId);

  let existingPath: string | undefined;
  try {
    orchestron.registry.get(scoreId);
    existingPath = findScoreFile(orchestron.scoresDirs, scoreId);
  } catch {
    return {
      scoreId,
      persisted: false,
      valid: false,
      errors: [
        {
          code: 'INVALID_SCORE',
          message: `Score '${scoreId}' not found. Use orchestron_create_score to create it.`,
        },
      ],
    };
  }

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

  orchestron.registry.remove(scoreId);
  orchestron.registry.register(score);

  if (input.persist) {
    const path = existingPath ?? scoreFilePath(orchestron.scoresDirs, scoreId, input.saveLocation);
    writeFileSync(path, input.yaml, 'utf-8');
    return { scoreId, persisted: true, path, valid: true, errors: [] };
  }

  return { scoreId, persisted: !!existingPath, valid: true, errors: [] };
}
