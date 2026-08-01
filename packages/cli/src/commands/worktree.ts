import { existsSync } from 'node:fs';
import type { Orchestron } from '../orchestron.js';
import { WorktreeManager } from '@orchestron/core';
import { printOutput } from '../output.js';

export interface WorktreeEntry {
  concertId: string;
  scoreId: string;
  status: string;
  path: string;
  branch: string;
  baseDir: string;
  keep: boolean;
  onDisk: boolean;
}

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];

function toEntries(concerts: Array<{ id: string; scoreId: string; status: string; worktree?: { path: string; branch: string; baseDir: string; keep?: boolean } }>): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  for (const c of concerts) {
    if (!c.worktree) continue;
    entries.push({
      concertId: c.id,
      scoreId: c.scoreId,
      status: c.status,
      path: c.worktree.path,
      branch: c.worktree.branch,
      baseDir: c.worktree.baseDir,
      keep: c.worktree.keep === true,
      onDisk: existsSync(c.worktree.path),
    });
  }
  return entries;
}

function formatHuman(entries: WorktreeEntry[], cleaned: number): string {
  if (entries.length === 0) {
    return cleaned > 0 ? `Cleaned ${cleaned} worktree(s). No worktrees remain.` : 'No worktrees found.';
  }

  const lines = entries.map((e) => {
    const status = e.status.padEnd(10);
    const retention = e.keep ? 'keep ' : 'auto ';
    const disk = e.onDisk ? 'on-disk' : 'missing';
    return `${e.concertId}  ${status} ${retention} ${disk}  ${e.branch} @ ${e.path}`;
  });

  const body = lines.join('\n');
  return cleaned > 0 ? `${body}\n\nCleaned ${cleaned} orphaned worktree(s).` : body;
}

export async function worktreeCommandHandler(
  orchestron: Orchestron,
  clean: boolean,
  json: boolean,
): Promise<void> {
  const concerts = await orchestron.store.listConcerts();
  const entries = toEntries(concerts);

  let cleaned = 0;
  if (clean) {
    const manager = new WorktreeManager();
    for (const e of entries) {
      const terminal = TERMINAL_STATUSES.includes(e.status);
      // Only reap worktrees whose concert has finished and was not explicitly
      // kept. This surfaces leftovers from crashes / error paths so the maestro
      // can reclaim them with one command.
      if (terminal && !e.keep) {
        await manager.remove(e.path, e.branch, e.baseDir).catch(() => {});
        cleaned++;
      }
    }
  }

  const output = { worktrees: entries, cleaned };
  printOutput(json, output, () => formatHuman(entries, cleaned));
}
