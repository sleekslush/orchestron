import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { nanoid } from 'nanoid';
import type { Score } from '../types/score.js';

const execFileAsync = promisify(execFile);

/** Where and how to create the isolated git worktree for a concert. */
export interface WorktreeOptions {
  /**
   * Base commit/branch to create the worktree from. Default: the score's
   * declared `metadata.baseBranch`, else `origin/main`.
   */
  baseBranch?: string;
  /**
   * Keep the worktree on disk after the concert reaches a terminal state
   * instead of disposing it (useful for debugging). Default: false.
   */
  keep?: boolean;
  /** Optional branch name for the worktree. Default: `orchestron/wt-<concertId>`. */
  branch?: string;
  /** Optional filesystem path for the worktree. Default: a sibling of the source tree. */
  path?: string;
}

export interface WorktreeHandle {
  path: string;
  branch: string;
  /** Absolute base directory the worktree was created from. */
  baseDir: string;
}

/** Thin git wrapper so tests can inject a fake instead of touching the real repo. */
export type GitRunner = (args: string[], cwd?: string) => Promise<string>;

const defaultGitRunner: GitRunner = async (args, cwd) => {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
};

/**
 * Creates and disposes isolated git worktrees for a concert so that git-coupled
 * scores (branch switching, commits, pushes) operate on a private checkout
 * rather than the developer's working tree.
 *
 * The concert starts in the worktree's working directory and the worktree is
 * removed when the concert reaches a terminal state.
 */
export class WorktreeManager {
  constructor(private git: GitRunner = defaultGitRunner) {}

  async create(
    score: Score,
    opts: WorktreeOptions,
    concertId: string,
    sourceDir?: string,
  ): Promise<WorktreeHandle> {
    const resolvedBase = resolve(sourceDir ?? process.cwd());
    const branch = opts.branch ?? `orchestron/wt-${concertId}-${nanoid(4)}`;
    const path =
      opts.path ?? resolve(dirname(resolvedBase), `.orchestron-wt-${concertId}-${nanoid(4)}`);
    const metadataBase =
      typeof score.metadata?.baseBranch === 'string'
        ? score.metadata.baseBranch
        : undefined;
    const base = opts.baseBranch ?? metadataBase ?? 'origin/main';

    await this.git(['worktree', 'add', '--force', '-b', branch, path, base], resolvedBase);
    return { path, branch, baseDir: resolvedBase };
  }

  async remove(path: string, branch?: string, sourceDir?: string): Promise<void> {
    // Resolve against a stable absolute base so removal never depends on the
    // runtime process.cwd() at run time (which may differ from creation time).
    const baseDir = resolve(sourceDir ?? process.cwd());
    await this.git(['worktree', 'remove', '--force', path], baseDir).catch(() => {});
    if (branch) {
      await this.git(['branch', '-D', branch], baseDir).catch(() => {});
    }
  }
}
