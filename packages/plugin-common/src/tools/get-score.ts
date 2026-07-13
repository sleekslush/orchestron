import type { Orchestron } from '../orchestron.js';
import { findScoreFile, readScoreFile, sanitizeScoreId } from './_score-helpers.js';

export interface GetScoreInput {
  scoreId: string;
}

export async function getScore(
  orchestron: Orchestron,
  input: GetScoreInput,
): Promise<{
  scoreId: string;
  yaml: string;
  path?: string;
  persisted: boolean;
}> {
  const scoreId = sanitizeScoreId(input.scoreId);
  const path = findScoreFile(orchestron.scoresDirs, scoreId);

  if (!path) {
    try {
      orchestron.registry.get(scoreId);
      return { scoreId, yaml: '', path: undefined, persisted: false };
    } catch {
      throw new Error(`Score '${scoreId}' not found`);
    }
  }

  const yaml = readScoreFile(path);
  return { scoreId, yaml, path, persisted: true };
}
