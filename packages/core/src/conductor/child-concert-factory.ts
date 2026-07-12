import type { ScoreID } from '../types/score.js';
import type { IConductor } from './conductor-interface.js';
import type { StartOptions } from './start-options.js';

export interface ChildConcertFactory {
  createChildConcert(scoreId: ScoreID, options?: StartOptions): Promise<IConductor>;
}
