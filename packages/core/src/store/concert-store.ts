import type {
  Concert,
  ConcertID,
  ConcertFilter,
  MovementRecord,
} from '../types/concert.js';
import type { ConcertEvent, EventFilter, SystemAggregates } from '../types/index.js';

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
