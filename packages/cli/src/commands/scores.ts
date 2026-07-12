import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import type { Score } from '@orchestron/core';
import type { Orchestron } from '../orchestron.js';
import { printOutput } from '../output.js';

export async function scoresCommandHandler(
  orchestron: Orchestron,
  validate: boolean,
  json: boolean,
): Promise<void> {
  const scores = orchestron.registry.list();

  if (!validate) {
    const output = scores.map((s) => ({
      id: s.id,
      name: s.name,
      version: s.version,
      description: s.description,
      movements: s.movements.map((m) => m.id),
    }));
    printOutput(json, output, () => formatScoresHuman(scores));
    return;
  }

  const results = scores.map((s) => {
    const errors = orchestron.registry.validate(s);
    return {
      id: s.id,
      name: s.name,
      valid: errors.length === 0,
      errors: errors.map((e) => ({ code: e.code, message: e.message })),
    };
  });

  printOutput(json, results, () => formatValidationHuman(results));
}

export function validateScoreFile(
  registry: Orchestron['registry'],
  path: string,
): { id?: string; valid: boolean; errors: Array<{ code: string; message: string }> } {
  const content = readFileSync(resolve(path), 'utf-8');
  const score = yaml.load(content) as Score;
  if (!score || typeof score !== 'object') {
    return {
      valid: false,
      errors: [{ code: 'INVALID_SCORE', message: 'File does not contain a valid score' }],
    };
  }
  const errors = registry.validate(score);
  return {
    id: score.id,
    valid: errors.length === 0,
    errors: errors.map((e) => ({ code: e.code, message: e.message })),
  };
}

function formatScoresHuman(
  scores: Array<{ id: string; name: string; version: string; movements: Array<{ id: string }> }>,
): string {
  if (scores.length === 0) {
    return 'No scores registered.';
  }

  const lines: string[] = [];
  lines.push('Registered scores:');
  lines.push('');
  for (const s of scores) {
    lines.push(`  ${s.id} — ${s.name} (v${s.version})`);
    lines.push(`    movements: ${s.movements.map((m) => m.id).join(', ')}`);
  }
  return lines.join('\n');
}

function formatValidationHuman(
  results: Array<{ id?: string; valid: boolean; errors: Array<{ code: string; message: string }> }>,
): string {
  if (results.length === 0) {
    return 'No scores to validate.';
  }

  const lines: string[] = [];
  let allValid = true;
  for (const r of results) {
    const status = r.valid ? '✓ valid' : '✗ invalid';
    lines.push(`${r.id ?? 'unknown'} — ${status}`);
    if (!r.valid) {
      allValid = false;
      for (const e of r.errors) {
        lines.push(`  [${e.code}] ${e.message}`);
      }
    }
  }
  lines.push('');
  lines.push(allValid ? 'All scores are valid.' : 'Some scores have validation errors.');
  return lines.join('\n');
}
