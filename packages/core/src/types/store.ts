import type {
  Concert,
  ConcertID,
  ConcertFilter,
  MovementRecord,
  ResourceUsage,
} from './concert.js';
import type { ConcertEvent } from './events.js';

export interface EventFilter {
  types?: string[];
  limit?: number;
  since?: Date;
}

export interface SystemAggregates {
  totalConcerts: number;
  activeConcerts: number;
  totalSpend: number;
  totalTokens: number;
  avgDurationMs: number;
  failureRate: number;
}

export interface ConcertStore {
  saveConcert(concert: Concert): Promise<void>;
  updateConcert(concert: Partial<Concert> & { id: ConcertID }): Promise<void>;
  getConcert(id: ConcertID): Promise<Concert | null>;
  deleteConcert(id: ConcertID): Promise<void>;
  listConcerts(filter?: ConcertFilter): Promise<Concert[]>;

  appendMovement(concertId: ConcertID, record: MovementRecord): Promise<void>;
  updateMovement(
    concertId: ConcertID,
    record: Partial<MovementRecord> & { movementId: string },
  ): Promise<void>;
  getMovementHistory(concertId: ConcertID): Promise<MovementRecord[]>;

  pushEvent(event: ConcertEvent): Promise<void>;
  getEvents(concertId: ConcertID, filter?: EventFilter): Promise<ConcertEvent[]>;

  getAggregates(): Promise<SystemAggregates>;
}
