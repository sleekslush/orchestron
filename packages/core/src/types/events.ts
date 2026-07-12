import type { ConcertID, SerializedError } from './concert.js';
import type { MovementID, ScoreID } from './score.js';

export type ConcertEvent =
  | { type: 'concert:started'; concertId: ConcertID; scoreId: ScoreID; timestamp: Date }
  | { type: 'concert:paused'; concertId: ConcertID; timestamp: Date }
  | { type: 'concert:resumed'; concertId: ConcertID; timestamp: Date }
  | { type: 'concert:completed'; concertId: ConcertID; timestamp: Date }
  | { type: 'concert:failed'; concertId: ConcertID; error: SerializedError; timestamp: Date }
  | { type: 'concert:cancelled'; concertId: ConcertID; timestamp: Date }
  | { type: 'concert:recovered'; concertId: ConcertID; timestamp: Date }
  | { type: 'movement:started'; concertId: ConcertID; movementId: MovementID; timestamp: Date }
  | { type: 'movement:progress'; concertId: ConcertID; movementId: MovementID; progressType: string; payload: Record<string, unknown>; timestamp: Date }
  | { type: 'movement:completed'; concertId: ConcertID; movementId: MovementID; result: import('./concert.js').MovementRecord; timestamp: Date }
  | { type: 'movement:failed'; concertId: ConcertID; movementId: MovementID; error: SerializedError; retryCount: number; timestamp: Date }
  | { type: 'constraint:breached'; concertId: ConcertID; constraint: string; limit: number; actual: number; timestamp: Date }
  | { type: 'child:created'; concertId: ConcertID; childConcertId: ConcertID; timestamp: Date }
  | { type: 'child:completed'; concertId: ConcertID; childConcertId: ConcertID; timestamp: Date };
