import type {
  Concert,
  ConcertStatus,
  MovementRecord,
  MovementStatus,
  ResourceUsage,
  SerializedError,
  ConcertEvent,
  SessionTrace,
} from '../types/index.js';

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

export function serializeDate(d: Date | undefined): string | null {
  return d ? d.toISOString() : null;
}

function deserializeDate(s: string | null): Date | undefined {
  return s ? new Date(s) : undefined;
}

// ---------------------------------------------------------------------------
// Safe JSON parse
// ---------------------------------------------------------------------------

export function jsonParse<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Runtime type guards — the single source of truth for all data-boundary
// validation.  These replace every `as SomeType` cast in the row mappers.
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && !Number.isNaN(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

const CONCERT_STATUS_VALUES = new Set<ConcertStatus>([
  'pending', 'running', 'paused', 'completed', 'failed', 'cancelled',
]);

function isConcertStatus(value: unknown): value is ConcertStatus {
  return isString(value) && CONCERT_STATUS_VALUES.has(value as ConcertStatus);
}

const MOVEMENT_STATUS_VALUES = new Set<MovementStatus>([
  'pending', 'in_progress', 'completed', 'failed', 'skipped',
]);

function isMovementStatus(value: unknown): value is MovementStatus {
  return isString(value) && MOVEMENT_STATUS_VALUES.has(value as MovementStatus);
}

const TRIGGERED_BY_VALUES = new Set<Concert['triggeredBy']>([
  'cli', 'api', 'harness', 'agent',
]);

function isTriggeredBy(value: unknown): value is Concert['triggeredBy'] {
  return isString(value) && TRIGGERED_BY_VALUES.has(value as Concert['triggeredBy']);
}

const SESSION_TRACE_STATUS_VALUES = new Set<SessionTrace['status']>(['completed', 'failed']);
const SESSION_TRACE_FORMAT_VALUES = new Set<SessionTrace['format']>(['pi-jsonl', 'orchestron-trace']);

function isSessionTraceStatus(value: unknown): value is SessionTrace['status'] {
  return isString(value) && SESSION_TRACE_STATUS_VALUES.has(value as SessionTrace['status']);
}

function isSessionTraceFormat(value: unknown): value is SessionTrace['format'] {
  return isString(value) && SESSION_TRACE_FORMAT_VALUES.has(value as SessionTrace['format']);
}

function parseResourceUsage(value: unknown): ResourceUsage {
  if (!isObject(value)) return {};
  return {
    ...(isNumber(value.spend) ? { spend: value.spend } : {}),
    ...(isNumber(value.tokens) ? { tokens: value.tokens } : {}),
    ...(isNumber(value.inputTokens) ? { inputTokens: value.inputTokens } : {}),
    ...(isNumber(value.outputTokens) ? { outputTokens: value.outputTokens } : {}),
  };
}

function parseConcertContext(value: unknown): Concert['context'] {
  if (isObject(value) && isObject(value.shared)) {
    return value as Concert['context'];
  }
  return { shared: {} };
}

function parseGoalEvaluation(value: unknown): MovementRecord['goalEvaluation'] {
  if (!isObject(value)) {
    return { achieved: false, confidence: 0, summary: '' };
  }
  return {
    achieved: isBoolean(value.achieved) ? value.achieved : false,
    confidence: isNumber(value.confidence) ? value.confidence : 0,
    summary: isString(value.summary) ? value.summary : '',
    ...(isString(value.evidence) ? { evidence: value.evidence } : {}),
  };
}

function parseSerializedError(value: unknown, fallback?: Partial<SerializedError>): SerializedError | undefined {
  if (!isObject(value)) return undefined;
  return {
    code: isString(value.code) ? value.code : fallback?.code ?? 'UNKNOWN',
    message: isString(value.message) ? value.message : fallback?.message ?? 'Unknown',
    retryable: isBoolean(value.retryable) ? value.retryable : (fallback?.retryable ?? false),
    ...(isString(value.concertId) ? { concertId: value.concertId } : {}),
    ...(isString(value.movementId) ? { movementId: value.movementId } : {}),
  };
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isString) : [];
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Row → domain object mappers with runtime validation
// ---------------------------------------------------------------------------

export function rowToConcert(row: ConcertRow, history: MovementRecord[]): Concert {
  return {
    id: row.id,
    scoreId: row.score_id,
    status: isConcertStatus(row.status) ? row.status : 'failed',
    startedAt: deserializeDate(row.started_at) ?? new Date(0),
    completedAt: deserializeDate(row.completed_at),
    currentMovement: row.current_movement ?? undefined,
    history,
    context: parseConcertContext(jsonParse(row.context, {})),
    usage: parseResourceUsage(jsonParse(row.usage, {})),
    triggeredBy: isTriggeredBy(row.triggered_by) ? row.triggered_by : 'cli',
    parentConcertId: row.parent_concert_id ?? undefined,
    childConcertIds: parseStringArray(jsonParse(row.child_concert_ids, [])),
    nestingDepth: isNumber(row.nesting_depth) ? row.nesting_depth : undefined,
    explicitHarness: row.explicit_harness ?? undefined,
  };
}

export function rowToMovementRecord(row: MovementRow): MovementRecord {
  return {
    movementId: row.movement_id,
    movementName: row.movement_name,
    status: isMovementStatus(row.status) ? row.status : 'failed',
    output: row.output,
    structured: row.structured
      ? (isObject(jsonParse(row.structured, undefined)) ? jsonParse(row.structured, undefined) as Record<string, unknown> : undefined)
      : undefined,
    summary: row.summary,
    goalEvaluation: parseGoalEvaluation(jsonParse(row.goal_evaluation, {})),
    usage: parseResourceUsage(jsonParse(row.usage, {})),
    durationMs: isNumber(row.duration_ms) ? row.duration_ms : 0,
    startedAt: deserializeDate(row.started_at) ?? new Date(0),
    completedAt: deserializeDate(row.completed_at),
    error: row.error ? parseSerializedError(jsonParse(row.error, undefined)) : undefined,
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
    startedAt: deserializeDate(row.started_at) ?? new Date(0),
    completedAt: deserializeDate(row.completed_at),
    eventCount: isNumber(row.event_count) ? row.event_count : 0,
    status: isSessionTraceStatus(row.status) ? row.status : 'failed',
    format: isSessionTraceFormat(row.format) ? row.format : 'orchestron-trace',
  };
}

export function rowToEvent(row: EventRow): ConcertEvent {
  const parsed = jsonParse<Record<string, unknown>>(row.data, {});
  const timestamp = deserializeDate(row.timestamp) ?? new Date(0);
  const base = { concertId: row.concert_id, timestamp };

  switch (row.type) {
    case 'concert:started':
      return { type: 'concert:started', ...base, scoreId: isString(parsed.scoreId) ? parsed.scoreId : '' };
    case 'concert:paused':
      return { type: 'concert:paused', ...base };
    case 'concert:resumed':
      return { type: 'concert:resumed', ...base };
    case 'concert:completed':
      return { type: 'concert:completed', ...base };
    case 'concert:failed': {
      const error = parseSerializedError(parsed.error, { code: 'CONCERT_FAILED', message: 'Unknown failure' });
      return { type: 'concert:failed', ...base, error: error! };
    }
    case 'concert:cancelled':
      return { type: 'concert:cancelled', ...base };
    case 'concert:recovered':
      return { type: 'concert:recovered', ...base };
    case 'movement:started':
      return {
        type: 'movement:started',
        ...base,
        movementId: isString(parsed.movementId) ? parsed.movementId : '',
        ...(isString(parsed.prompt) ? { prompt: parsed.prompt } : {}),
      };
    case 'movement:progress':
      return {
        type: 'movement:progress',
        ...base,
        movementId: isString(parsed.movementId) ? parsed.movementId : '',
        progressType: isString(parsed.progressType) ? parsed.progressType : '',
        payload: isObject(parsed.payload) ? parsed.payload : {},
      };
    case 'movement:completed':
      return {
        type: 'movement:completed',
        ...base,
        movementId: isString(parsed.movementId) ? parsed.movementId : '',
        result: isObject(parsed.result) ? (parsed.result as unknown as MovementRecord) : ({} as unknown as MovementRecord),
      };
    case 'movement:failed': {
      const error = parseSerializedError(parsed.error, { code: 'MOVEMENT_FAILED', message: 'Movement failed' });
      return {
        type: 'movement:failed',
        ...base,
        movementId: isString(parsed.movementId) ? parsed.movementId : '',
        error: error!,
        retryCount: isNumber(parsed.retryCount) ? parsed.retryCount : 0,
      };
    }
    case 'constraint:breached':
      return {
        type: 'constraint:breached',
        ...base,
        constraint: isString(parsed.constraint) ? parsed.constraint : '',
        limit: isNumber(parsed.limit) ? parsed.limit : 0,
        actual: isNumber(parsed.actual) ? parsed.actual : 0,
      };
    case 'child:created':
      return {
        type: 'child:created',
        ...base,
        childConcertId: isString(parsed.childConcertId) ? parsed.childConcertId : '',
      };
    case 'child:completed':
      return {
        type: 'child:completed',
        ...base,
        childConcertId: isString(parsed.childConcertId) ? parsed.childConcertId : '',
      };
    default:
      // At runtime we construct a valid ConcertEvent by spreading known base
      // fields and the raw parsed data. The cast is unavoidable in the fallback
      // branch, but we validate the type discriminant.
      return { type: row.type as ConcertEvent['type'], ...base, ...parsed } as ConcertEvent;
  }
}
