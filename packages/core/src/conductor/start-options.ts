import type { Concert, ConcertID } from '../types/concert.js';
import type { Program } from '../types/score.js';
import type { WorktreeOptions } from '../worktree/worktree-manager.js';

export interface StartOptions {
  initialContext?: Record<string, unknown>;
  programOverride?: Partial<Program>;
  triggeredBy?: Concert['triggeredBy'];
  parentConcertId?: ConcertID;
  nestingDepth?: number;
  /** Explicit harness for this concert, overriding the global defaultHarness. */
  harness?: string;
  /**
   * Working directory for the concert's harness sessions (tool calls such as
   * `git checkout -b` land here). Default: `process.cwd()`.
   */
  cwd?: string;
  /**
   * Run the concert in an isolated git worktree created before the concert
   * starts and disposed when it reaches a terminal state. The worktree path
   * becomes the concert's `cwd`. `true` uses defaults; an object allows
   * configuring the base branch / keep / path.
   */
  worktree?: boolean | WorktreeOptions;
}
