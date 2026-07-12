import Database from 'better-sqlite3';
import type {
  Concert,
  ConcertID,
  ConcertFilter,
  ConcertStatus,
  MovementRecord,
  MovementStatus,
} from '../types/concert.js';
import type { ConcertEvent, EventFilter, SystemAggregates } from '../types/index.js';
import type { ConcertStore } from './concert-store.js';

function serializeDate(d: Date | undefined): string | null {
  return d ? d.toISOString() : null;
}

function deserializeDate(s: string | null): Date | undefined {
  return s ? new Date(s) : undefined;
}

function jsonParse<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

interface ConcertRow {
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
}

interface MovementRow {
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
}

interface EventRow {
  concert_id: string;
  type: string;
  data: string;
  timestamp: string;
}

export class SqliteLoge implements ConcertStore {
  private db: Database.Database;

  constructor(dbPath: string = ':memory:') {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  close(): void {
    this.db.close();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS concerts (
        id TEXT PRIMARY KEY,
        score_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        started_at TEXT NOT NULL,
        completed_at TEXT,
        current_movement TEXT,
        context TEXT NOT NULL DEFAULT '{}',
        usage TEXT NOT NULL DEFAULT '{}',
        triggered_by TEXT NOT NULL DEFAULT 'cli',
        parent_concert_id TEXT,
        child_concert_ids TEXT NOT NULL DEFAULT '[]',
        nesting_depth INTEGER
      );

      CREATE TABLE IF NOT EXISTS movements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        concert_id TEXT NOT NULL,
        movement_id TEXT NOT NULL,
        movement_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        output TEXT NOT NULL DEFAULT '',
        structured TEXT,
        summary TEXT NOT NULL DEFAULT '',
        goal_evaluation TEXT NOT NULL DEFAULT '{}',
        usage TEXT NOT NULL DEFAULT '{}',
        duration_ms INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        concert_id TEXT NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        timestamp TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_movements_concert ON movements(concert_id);
      CREATE INDEX IF NOT EXISTS idx_events_concert ON events(concert_id);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    `);
  }

  async saveConcert(concert: Concert): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO concerts
        (id, score_id, status, started_at, completed_at, current_movement,
         context, usage, triggered_by, parent_concert_id, child_concert_ids, nesting_depth)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      concert.id,
      concert.scoreId,
      concert.status,
      serializeDate(concert.startedAt),
      serializeDate(concert.completedAt),
      concert.currentMovement ?? null,
      JSON.stringify(concert.context),
      JSON.stringify(concert.usage),
      concert.triggeredBy,
      concert.parentConcertId ?? null,
      JSON.stringify(concert.childConcertIds),
      concert.nestingDepth ?? null,
    );

    this.db.prepare('DELETE FROM movements WHERE concert_id = ?').run(concert.id);

    for (const m of concert.history) {
      await this.appendMovement(concert.id, m);
    }
  }

  async updateConcert(concert: Partial<Concert> & { id: ConcertID }): Promise<void> {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (concert.status !== undefined) {
      fields.push('status = ?');
      values.push(concert.status);
    }
    if (concert.completedAt !== undefined) {
      fields.push('completed_at = ?');
      values.push(serializeDate(concert.completedAt));
    }
    if (concert.currentMovement !== undefined) {
      fields.push('current_movement = ?');
      values.push(concert.currentMovement ?? null);
    }
    if (concert.context !== undefined) {
      fields.push('context = ?');
      values.push(JSON.stringify(concert.context));
    }
    if (concert.usage !== undefined) {
      fields.push('usage = ?');
      values.push(JSON.stringify(concert.usage));
    }
    if (concert.childConcertIds !== undefined) {
      fields.push('child_concert_ids = ?');
      values.push(JSON.stringify(concert.childConcertIds));
    }
    if (concert.nestingDepth !== undefined) {
      fields.push('nesting_depth = ?');
      values.push(concert.nestingDepth);
    }

    if (fields.length === 0) return;

    values.push(concert.id);
    const stmt = this.db.prepare(`UPDATE concerts SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
  }

  async getConcert(id: ConcertID): Promise<Concert | null> {
    const row = this.db.prepare('SELECT * FROM concerts WHERE id = ?').get(id) as
      | ConcertRow
      | undefined;
    if (!row) return null;

    const history = await this.getMovementHistory(id);

    return rowToConcert(row, history);
  }

  async deleteConcert(id: ConcertID): Promise<void> {
    this.db.prepare('DELETE FROM events WHERE concert_id = ?').run(id);
    this.db.prepare('DELETE FROM movements WHERE concert_id = ?').run(id);
    this.db.prepare('DELETE FROM concerts WHERE id = ?').run(id);
  }

  async listConcerts(filter?: ConcertFilter): Promise<Concert[]> {
    let sql = 'SELECT * FROM concerts';
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (filter?.status) {
      conditions.push('status = ?');
      params.push(filter.status);
    }
    if (filter?.scoreId) {
      conditions.push('score_id = ?');
      params.push(filter.scoreId);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY started_at DESC';

    if (filter?.limit) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }
    if (filter?.offset) {
      sql += ' OFFSET ?';
      params.push(filter.offset);
    }

    const rows = this.db.prepare(sql).all(...params) as ConcertRow[];
    const results: Concert[] = [];

    for (const row of rows) {
      const history = await this.getMovementHistory(row.id);
      results.push(rowToConcert(row, history));
    }

    return results;
  }

  async appendMovement(concertId: ConcertID, record: MovementRecord): Promise<void> {
    const existing = this.db
      .prepare(
        'SELECT id FROM movements WHERE concert_id = ? AND movement_id = ? AND started_at = ?',
      )
      .get(concertId, record.movementId, serializeDate(record.startedAt));

    if (existing) {
      await this.updateMovement(concertId, record);
      return;
    }

    const stmt = this.db.prepare(`
      INSERT INTO movements
        (concert_id, movement_id, movement_name, status, output, structured,
         summary, goal_evaluation, usage, duration_ms, started_at, completed_at, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      concertId,
      record.movementId,
      record.movementName,
      record.status,
      record.output,
      record.structured ? JSON.stringify(record.structured) : null,
      record.summary,
      JSON.stringify(record.goalEvaluation),
      JSON.stringify(record.usage),
      record.durationMs,
      serializeDate(record.startedAt),
      serializeDate(record.completedAt),
      record.error ? JSON.stringify(record.error) : null,
    );
  }

  async updateMovement(
    concertId: ConcertID,
    record: Partial<MovementRecord> & { movementId: string },
  ): Promise<void> {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (record.status !== undefined) {
      fields.push('status = ?');
      values.push(record.status);
    }
    if (record.output !== undefined) {
      fields.push('output = ?');
      values.push(record.output);
    }
    if (record.structured !== undefined) {
      fields.push('structured = ?');
      values.push(JSON.stringify(record.structured));
    }
    if (record.summary !== undefined) {
      fields.push('summary = ?');
      values.push(record.summary);
    }
    if (record.goalEvaluation !== undefined) {
      fields.push('goal_evaluation = ?');
      values.push(JSON.stringify(record.goalEvaluation));
    }
    if (record.usage !== undefined) {
      fields.push('usage = ?');
      values.push(JSON.stringify(record.usage));
    }
    if (record.durationMs !== undefined) {
      fields.push('duration_ms = ?');
      values.push(record.durationMs);
    }
    if (record.completedAt !== undefined) {
      fields.push('completed_at = ?');
      values.push(serializeDate(record.completedAt));
    }
    if (record.error !== undefined) {
      fields.push('error = ?');
      values.push(JSON.stringify(record.error));
    }

    if (fields.length === 0) return;

    let whereClause = 'concert_id = ?';
    const whereValues: unknown[] = [concertId];

    if (record.startedAt !== undefined) {
      whereClause += ' AND started_at = ?';
      whereValues.push(serializeDate(record.startedAt));
    }

    whereClause += ' AND movement_id = ?';
    whereValues.push(record.movementId);

    values.push(...whereValues);
    const stmt = this.db.prepare(
      `UPDATE movements SET ${fields.join(', ')} WHERE ${whereClause}`,
    );
    stmt.run(...values);
  }

  async getMovementHistory(concertId: ConcertID): Promise<MovementRecord[]> {
    const rows = this.db
      .prepare('SELECT * FROM movements WHERE concert_id = ? ORDER BY started_at ASC')
      .all(concertId) as MovementRow[];
    return rows.map(rowToMovementRecord);
  }

  async pushEvent(event: ConcertEvent): Promise<void> {
    const { concertId, type, timestamp, ...rest } = event as ConcertEvent & { timestamp: Date };
    this.db
      .prepare(
        `INSERT INTO events (concert_id, type, data, timestamp) VALUES (?, ?, ?, ?)`,
      )
      .run(
        concertId,
        type,
        JSON.stringify(rest),
        serializeDate(timestamp ?? new Date()),
      );
  }

  async getEvents(concertId: ConcertID, filter?: EventFilter): Promise<ConcertEvent[]> {
    let sql = 'SELECT * FROM events WHERE concert_id = ?';
    const params: unknown[] = [concertId];

    if (filter?.types && filter.types.length > 0) {
      sql += ` AND type IN (${filter.types.map(() => '?').join(',')})`;
      params.push(...filter.types);
    }
    if (filter?.since) {
      sql += ' AND timestamp >= ?';
      params.push(serializeDate(filter.since));
    }

    sql += ' ORDER BY timestamp ASC';

    if (filter?.limit) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as EventRow[];
    return rows.map(rowToEvent);
  }

  async getAggregates(): Promise<SystemAggregates> {
    const row = this.db
      .prepare(
        `SELECT
          COUNT(*) as totalConcerts,
          SUM(CASE WHEN status IN ('running','paused') THEN 1 ELSE 0 END) as activeConcerts,
          SUM(CAST(json_extract(usage, '$.spend') AS REAL)) as totalSpend,
          SUM(CAST(json_extract(usage, '$.tokens') AS REAL)) as totalTokens,
          AVG(
            CASE WHEN completed_at IS NOT NULL
              THEN (julianday(completed_at) - julianday(started_at)) * 86400000
              ELSE NULL
            END
          ) as avgDurationMs
        FROM concerts`,
      )
      .get() as {
      totalConcerts: number;
      activeConcerts: number;
      totalSpend: number | null;
      totalTokens: number | null;
      avgDurationMs: number | null;
    };

    const failed = this.db
      .prepare("SELECT COUNT(*) as cnt FROM concerts WHERE status = 'failed'")
      .get() as { cnt: number };

    return {
      totalConcerts: row.totalConcerts ?? 0,
      activeConcerts: row.activeConcerts ?? 0,
      totalSpend: row.totalSpend ?? 0,
      totalTokens: row.totalTokens ?? 0,
      avgDurationMs: row.avgDurationMs ?? 0,
      failureRate: row.totalConcerts > 0 ? failed.cnt / row.totalConcerts : 0,
    };
  }
}

function rowToConcert(row: ConcertRow, history: MovementRecord[]): Concert {
  return {
    id: row.id,
    scoreId: row.score_id,
    status: row.status as ConcertStatus,
    startedAt: deserializeDate(row.started_at)!,
    completedAt: deserializeDate(row.completed_at),
    currentMovement: row.current_movement,
    history,
    context: jsonParse(row.context, { shared: {} }),
    usage: jsonParse(row.usage, {}),
    triggeredBy: row.triggered_by as Concert['triggeredBy'],
    parentConcertId: row.parent_concert_id ?? undefined,
    childConcertIds: jsonParse<string[]>(row.child_concert_ids, []),
    nestingDepth: row.nesting_depth ?? undefined,
  };
}

function rowToMovementRecord(row: MovementRow): MovementRecord {
  return {
    movementId: row.movement_id,
    movementName: row.movement_name,
    status: row.status as MovementStatus,
    output: row.output,
    structured: row.structured ? jsonParse<Record<string, unknown> | undefined>(row.structured, undefined) : undefined,
    summary: row.summary,
    goalEvaluation: jsonParse(row.goal_evaluation, { achieved: false, confidence: 0, summary: '' }),
    usage: jsonParse(row.usage, {}),
    durationMs: row.duration_ms,
    startedAt: deserializeDate(row.started_at)!,
    completedAt: deserializeDate(row.completed_at),
    error: row.error ? jsonParse(row.error, undefined) : undefined,
  };
}

function rowToEvent(row: EventRow): ConcertEvent {
  const parsed = jsonParse<Record<string, unknown>>(row.data, {});
  const base = {
    concertId: row.concert_id,
    timestamp: deserializeDate(row.timestamp)!,
  };

  switch (row.type) {
    case 'concert:started':
      return { type: 'concert:started', ...base, scoreId: parsed.scoreId as string };
    case 'concert:paused':
      return { type: 'concert:paused', ...base };
    case 'concert:resumed':
      return { type: 'concert:resumed', ...base };
    case 'concert:completed':
      return { type: 'concert:completed', ...base };
    case 'concert:failed':
      return { type: 'concert:failed', ...base, error: parsed.error as never };
    case 'concert:cancelled':
      return { type: 'concert:cancelled', ...base };
    case 'concert:recovered':
      return { type: 'concert:recovered', ...base };
    case 'movement:started':
      return { type: 'movement:started', ...base, movementId: parsed.movementId as string };
    case 'movement:completed':
      return {
        type: 'movement:completed',
        ...base,
        movementId: parsed.movementId as string,
        result: parsed.result as never,
      };
    case 'movement:failed':
      return {
        type: 'movement:failed',
        ...base,
        movementId: parsed.movementId as string,
        error: parsed.error as never,
        retryCount: (parsed.retryCount as number) ?? 0,
      };
    case 'constraint:breached':
      return {
        type: 'constraint:breached',
        ...base,
        constraint: parsed.constraint as string,
        limit: parsed.limit as number,
        actual: parsed.actual as number,
      };
    case 'child:created':
      return {
        type: 'child:created',
        ...base,
        childConcertId: parsed.childConcertId as string,
      };
    case 'child:completed':
      return {
        type: 'child:completed',
        ...base,
        childConcertId: parsed.childConcertId as string,
      };
    default:
      return {
        type: row.type as ConcertEvent['type'],
        ...base,
        ...parsed,
      } as ConcertEvent;
  }
}
