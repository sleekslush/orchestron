import type {
  Concert,
  ConcertID,
  ConcertStatus,
  MovementID,
  MovementRecord,
  MovementStatus,
  ResourceUsage,
  SerializedError,
} from '../types/concert.js';
import type { ConcertEvent, SessionTrace } from '../types/index.js';

export function serializeDate(d: Date | undefined): string | null {
  return d ? d.toISOString() : null;
}

function deserializeDate(s: string | null): Date | undefined {
  return s ? new Date(s) : undefined;
}

export function jsonParse<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function safeNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && !Number.isNaN(value) ? value : fallback;
}

function safeResourceUsage(value: unknown): ResourceUsage {
  if (!isObject(value)) return {};
  const result: ResourceUsage = {};
  if (typeof value.spend === 'number') result.spend = value.spend;
  if (typeof value.tokens === 'number') result.tokens = value.tokens;
  if (typeof value.inputTokens === 'number') result.inputTokens = value.inputTokens;
  if (typeof value.outputTokens === 'number') result.outputTokens = value.outputTokens;
  return result;
}

export interface ConcertRow {
  id: string;
  score_id: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  current_movement: string | null;
  context: string;
  usage: string;
  triggered_by: string;
  parent_concert_id: string | null;
  child_concert_ids: string;
  nesting_depth: number | null;
  score_yaml: string | null;
  explicit_harness: string | null;
}

export interface MovementRow {
  id: string;
  concert_id: string;
  movement_id: string;
  movement_name: string;
  status: string;
  output: string;
  structured: string | null;
  summary: string;
  goal_evaluation: string;
  usage: string;
  duration_ms: number;
  started_at: string;
  completed_at: string | null;
  error: string | null;
  trace_id: string | null;
  model: string | null;
  provider: string | null;
}

export interface SessionTraceRow {
  id: string;
  concert_id: string;
  movement_id: string;
  session_id: string;
  file_path: string;
  started_at: string;
  completed_at: string | null;
  event_count: number;
  status: string;
  format: string;
}

export interface EventRow {
  concert_id: string;
  type: string;
  data: string;
  timestamp: string;
}

export function rowToConcert(row: ConcertRow, history: MovementRecord[]): Concert {
  return {
    id: row.id,
    scoreId: row.score_id,
    status: row.status as ConcertStatus,
    startedAt: deserializeDate(row.started_at)!,
    completedAt: deserializeDate(row.completed_at),
    currentMovement: row.current_movement,
    history,
    context: isObject(jsonParse(row.context, {})) ? (jsonParse(row.context, {}) as { shared: Record<string, unknown> }) : { shared: {} },
    usage: safeResourceUsage(jsonParse(row.usage, {})),
    triggeredBy: row.triggered_by as Concert['triggeredBy'],
    parentConcertId: row.parent_concert_id ?? undefined,
    childConcertIds: Array.isArray(jsonParse(row.child_concert_ids, []))
      ? (jsonParse(row.child_concert_ids, []) as string[])
      : [],
    nestingDepth: row.nesting_depth ?? undefined,
    explicitHarness: row.explicit_harness ?? undefined,
  };
}

export function rowToMovementRecord(row: MovementRow): MovementRecord {
  return {
    movementId: row.movement_id,
    movementName: row.movement_name,
    status: row.status as MovementStatus,
    output: row.output,
    structured: row.structured ? jsonParse<Record<string, unknown> | undefined>(row.structured, undefined) : undefined,
    summary: row.summary,
    goalEvaluation: isObject(jsonParse(row.goal_evaluation, {}))
      ? (jsonParse(row.goal_evaluation, {}) as MovementRecord['goalEvaluation'])
      : { achieved: false, confidence: 0, summary: '' },
    usage: safeResourceUsage(jsonParse(row.usage, {})),
    durationMs: row.duration_ms,
    startedAt: deserializeDate(row.started_at)!,
    completedAt: deserializeDate(row.completed_at),
    error: row.error ? jsonParse<SerializedError | undefined>(row.error, undefined) : undefined,
    traceId: row.trace_id ?? undefined,
    model: row.model ?? undefined,
    provider: row.provider ?? undefined,
  };
}

export function rowToSessionTrace(row: SessionTraceRow): SessionTrace {
  return {
    id: row.id,
    concertId: row.concert_id,
    movementId: row.movement_id,
    sessionId: row.session_id,
    filePath: row.file_path,
    startedAt: deserializeDate(row.started_at)!,
    completedAt: deserializeDate(row.completed_at),
    eventCount: row.event_count,
    status: row.status as SessionTrace['status'],
    format: row.format as SessionTrace['format'],
  };
}

export function rowToEvent(row: EventRow): ConcertEvent {
  const parsed = jsonParse<Record<string, unknown>>(row.data, {});
  const base = {
    concertId: row.concert_id,
    timestamp: deserializeDate(row.timestamp)!,
  };

  switch (row.type) {
    case 'concert:started':
      return { type: 'concert:started', ...base, scoreId: safeString(parsed.scoreId) };
    case 'concert:paused':
      return { type: 'concert:paused', ...base };
    case 'concert:resumed':
      return { type: 'concert:resumed', ...base };
    case 'concert:completed':
      return { type: 'concert:completed', ...base };
    case 'concert:failed':
      return {
        type: 'concert:failed',
        ...base,
        error: isObject(parsed.error) ? (parsed.error as unknown as SerializedError) : { code: 'UNKNOWN', message: 'Unknown', retryable: false },
      };
    case 'concert:cancelled':
      return { type: 'concert:cancelled', ...base };
    case 'concert:recovered':
      return { type: 'concert:recovered', ...base };
    case 'movement:started':
      return {
        type: 'movement:started',
        ...base,
        movementId: safeString(parsed.movementId),
        prompt: typeof parsed.prompt === 'string' ? parsed.prompt : undefined,
      };
    case 'movement:progress':
      return {
        type: 'movement:progress',
        ...base,
        movementId: safeString(parsed.movementId),
        progressType: safeString(parsed.progressType),
        payload: isObject(parsed.payload) ? parsed.payload : {},
      };
    case 'movement:completed':
      return {
        type: 'movement:completed',
        ...base,
        movementId: safeString(parsed.movementId),
        result: isObject(parsed.result) ? (parsed.result as unknown as MovementRecord) : ({} as unknown as MovementRecord),
      };
    case 'movement:failed':
      return {
        type: 'movement:failed',
        ...base,
        movementId: safeString(parsed.movementId),
        error: isObject(parsed.error) ? (parsed.error as unknown as SerializedError) : { code: 'UNKNOWN', message: 'Unknown', retryable: false },
        retryCount: safeNumber(parsed.retryCount),
      };
    case 'constraint:breached':
      return {
        type: 'constraint:breached',
        ...base,
        constraint: safeString(parsed.constraint),
        limit: safeNumber(parsed.limit),
        actual: safeNumber(parsed.actual),
      };
    case 'child:created':
      return {
        type: 'child:created',
        ...base,
        childConcertId: safeString(parsed.childConcertId),
      };
    case 'child:completed':
      return {
        type: 'child:completed',
        ...base,
        childConcertId: safeString(parsed.childConcertId),
      };
    default:
      return {
        type: row.type as ConcertEvent['type'],
        ...base,
        ...parsed,
      } as ConcertEvent;
  }
}
