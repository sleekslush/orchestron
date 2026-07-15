import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ScoreRegistry } from './registry/score-registry.js';

/**
 * Create a directory (recursively) if it does not exist.
 * Silently ignores errors (e.g. permissions, already exists).
 */
export function ensureDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
}

/**
 * Load all score files from a directory into the given registry.
 * Supports `.score.yml` and `.score.yaml` files.
 * Silently returns if the directory does not exist.
 */
export function loadScoresFromDir(dir: string, registry: ScoreRegistry): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = resolve(dir, entry);
    const stat = statSync(fullPath);
    if (!stat.isFile()) continue;

    if (/\.score\.(ya?ml)$/i.test(entry)) {
      registry.loadFrom(fullPath);
    }
  }
}
