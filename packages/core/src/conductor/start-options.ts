import type { Concert, ConcertID } from '../types/concert.js';
import type { Program } from '../types/score.js';

export interface StartOptions {
  initialContext?: Record<string, unknown>;
  programOverride?: Partial<Program>;
  triggeredBy?: Concert['triggeredBy'];
  parentConcertId?: ConcertID;
  nestingDepth?: number;
}
