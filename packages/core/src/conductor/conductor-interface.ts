import type { Concert, ConcertID, ConcertStatus } from '../types/concert.js';
import type { ConcertEvent } from '../types/events.js';
import type { StartOptions } from './start-options.js';

export type ConcertEventListener = (event: ConcertEvent) => void;

export interface IConductor {
  readonly concertId: ConcertID;
  readonly scoreId: string;
  readonly status: ConcertStatus;
  start(options?: StartOptions): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  cancel(): Promise<void>;
  getState(): Promise<Concert>;
  recover(): Promise<void>;
  onEvent(listener: ConcertEventListener): void;
  offEvent(listener: ConcertEventListener): void;
}
