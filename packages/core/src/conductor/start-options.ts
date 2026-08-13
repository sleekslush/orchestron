import type { Concert, ConcertID } from '../types/concert.js';
import type { Program } from '../types/score.js';

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
}
