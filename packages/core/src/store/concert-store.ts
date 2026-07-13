import type {
  Concert,
  ConcertID,
  ConcertFilter,
  MovementID,
  MovementRecord,
} from '../types/concert.js';
import type { ConcertEvent, EventFilter, SystemAggregates, SessionTrace } from '../types/index.js';

export interface ConcertStore {
  saveConcert(concert: Concert, scoreYaml: string): Promise<void>;
  updateConcert(concert: Partial<Concert> & { id: ConcertID }): Promise<void>;
  getConcert(id: ConcertID): Promise<Concert | null>;
  deleteConcert(id: ConcertID): Promise<void>;
  listConcerts(filter?: ConcertFilter): Promise<Concert[]>;

  getConcertScoreYaml(id: ConcertID): Promise<string | null>;

  appendMovement(concertId: ConcertID, record: MovementRecord): Promise<void>;
  updateMovement(
    concertId: ConcertID,
    record: Partial<MovementRecord> & { movementId: string },
  ): Promise<void>;
  getMovementHistory(concertId: ConcertID): Promise<MovementRecord[]>;

  pushEvent(event: ConcertEvent): Promise<void>;
  getEvents(concertId: ConcertID, filter?: EventFilter): Promise<ConcertEvent[]>;

  getAggregates(): Promise<SystemAggregates>;

  createSessionTrace(trace: SessionTrace): Promise<void>;
  updateSessionTrace(id: string, update: Partial<SessionTrace>): Promise<void>;
  getSessionTracesForConcert(concertId: ConcertID): Promise<SessionTrace[]>;
  getSessionTraceForMovement(concertId: ConcertID, movementId: MovementID): Promise<SessionTrace | null>;
}
