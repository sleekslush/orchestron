import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import type { Score, ScoreRegistry } from '@orchestron/core';
import { DEFAULT_SCORES_DIR } from '../orchestron.js';

const SAFE_SCORE_ID = /^[a-z0-9_-]+$/;

export function sanitizeScoreId(scoreId: string): string {
  const sanitized = scoreId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/--+/g, '-');

  if (!sanitized || !SAFE_SCORE_ID.test(sanitized)) {
    throw new Error(
      `Score id '${scoreId}' cannot be sanitized to a safe filename. Use only lowercase letters, numbers, hyphens, and underscores.`,
    );
  }

  return sanitized;
}

export function findScoreFile(scoresDirs: string[], scoreId: string): string | undefined {
  const sanitized = sanitizeScoreId(scoreId);
  for (const dir of scoresDirs) {
    const path = resolve(dir, `${sanitized}.score.yaml`);
    if (existsSync(path)) return path;
  }
  return undefined;
}

export function scoreFilePath(
  scoresDirs: string[],
  scoreId: string,
  saveLocation: 'local' | 'global' = 'local',
): string {
  const sanitized = sanitizeScoreId(scoreId);
  const targetDir = saveLocation === 'global' ? DEFAULT_SCORES_DIR : scoresDirs[0];
  if (!targetDir) {
    throw new Error('No scores directory configured');
  }
  return resolve(targetDir, `${sanitized}.score.yaml`);
}

export function parseAndValidateScore(
  registry: ScoreRegistry,
  yamlText: string,
): { score?: Score; errors: Array<{ code: string; message: string }> } {
  let parsed: unknown;
  try {
    parsed = yaml.load(yamlText);
  } catch (err) {
    return {
      errors: [{ code: 'INVALID_SCORE', message: `YAML parse error: ${(err as Error).message}` }],
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      errors: [{ code: 'INVALID_SCORE', message: 'YAML does not contain a valid object' }],
    };
  }
  const score = parsed as Score;
  const rawErrors = registry.validate(score);
  const errors = rawErrors.map((e) => ({ code: e.code, message: e.message }));
  return { score, errors };
}

export function readScoreFile(path: string): string {
  return readFileSync(path, 'utf-8');
}
