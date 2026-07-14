import type {
  Concert,
  ConcertID,
  ConcertFilter,
  MovementID,
  MovementRecord,
} from '../types/concert.js';
import type { ConcertEvent, EventFilter, SystemAggregates, SessionTrace } from '../types/index.js';
import type { ConcertStore } from './concert-store.js';
import { createSqliteDb } from './sqlite-driver.js';
import {
  serializeDate,
  jsonParse,
  rowToConcert,
  rowToMovementRecord,
  rowToSessionTrace,
  rowToEvent,
} from './row-mappers.js';
import type {
  ConcertRow,
  MovementRow,
  SessionTraceRow,
  EventRow,
} from './row-mappers.js';

export class SqliteLoge implements ConcertStore {
  private db: ReturnType<typeof createSqliteDb>;

  constructor(dbPath: string = ':memory:') {
    this.db = createSqliteDb(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
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
        score_yaml TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        started_at TEXT NOT NULL,
        completed_at TEXT,
        current_movement TEXT,
        context TEXT NOT NULL DEFAULT '{}',
        usage TEXT NOT NULL DEFAULT '{}',
        triggered_by TEXT NOT NULL DEFAULT 'cli',
        parent_concert_id TEXT,
        child_concert_ids TEXT NOT NULL DEFAULT '[]',
        nesting_depth INTEGER,
        explicit_harness TEXT
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
        error TEXT,
        trace_id TEXT,
        model TEXT,
        provider TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        concert_id TEXT NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        timestamp TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_traces (
        id TEXT PRIMARY KEY,
        concert_id TEXT NOT NULL,
        movement_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        event_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'completed',
        format TEXT NOT NULL DEFAULT 'orchestron-trace'
      );

      CREATE INDEX IF NOT EXISTS idx_movements_concert ON movements(concert_id);
      CREATE INDEX IF NOT EXISTS idx_events_concert ON events(concert_id);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
      CREATE INDEX IF NOT EXISTS idx_session_traces_concert ON session_traces(concert_id);
      CREATE INDEX IF NOT EXISTS idx_session_traces_movement ON session_traces(concert_id, movement_id);
    `);
    this.migrateSchema();
  }

  private migrateSchema(): void {
    // Ensure trace_id column exists on older databases created before the column was added.
    const columnInfo = this.db
      .prepare(`PRAGMA table_info(movements)`)
      .all() as Array<{ name: string }>;
    if (!columnInfo.some((col) => col.name === 'trace_id')) {
      this.db.exec(`ALTER TABLE movements ADD COLUMN trace_id TEXT`);
    }
    if (!columnInfo.some((col) => col.name === 'model')) {
      this.db.exec(`ALTER TABLE movements ADD COLUMN model TEXT`);
    }
    if (!columnInfo.some((col) => col.name === 'provider')) {
      this.db.exec(`ALTER TABLE movements ADD COLUMN provider TEXT`);
    }
    const concertColumns = this.db
      .prepare(`PRAGMA table_info(concerts)`)
      .all() as Array<{ name: string }>;
    if (!concertColumns.some((col) => col.name === 'score_yaml')) {
      this.db.exec(`ALTER TABLE concerts ADD COLUMN score_yaml TEXT NOT NULL DEFAULT ''`);
    }
    if (!concertColumns.some((col) => col.name === 'explicit_harness')) {
      this.db.exec(`ALTER TABLE concerts ADD COLUMN explicit_harness TEXT`);
    }
    const sessionTraceColumns = this.db
      .prepare(`PRAGMA table_info(session_traces)`)
      .all() as Array<{ name: string }>;
    if (
      sessionTraceColumns.some((col) => col.name === 'turn_count') &&
      !sessionTraceColumns.some((col) => col.name === 'event_count')
    ) {
      this.db.exec(`ALTER TABLE session_traces RENAME COLUMN turn_count TO event_count`);
    }
  }

  async saveConcert(concert: Concert, scoreYaml: string): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO concerts
        (id, score_id, score_yaml, status, started_at, completed_at, current_movement,
         context, usage, triggered_by, parent_concert_id, child_concert_ids, nesting_depth, explicit_harness)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      concert.id,
      concert.scoreId,
      scoreYaml,
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
      concert.explicitHarness ?? null,
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

  async getConcertScoreYaml(id: ConcertID): Promise<string | null> {
    const row = this.db.prepare('SELECT score_yaml FROM concerts WHERE id = ?').get(id) as
      | { score_yaml: string }
      | undefined;
    if (!row || !row.score_yaml) return null;
    return row.score_yaml;
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
    const stmt = this.db.prepare(`
      INSERT INTO movements
        (concert_id, movement_id, movement_name, status, output, structured,
         summary, goal_evaluation, usage, duration_ms, started_at, completed_at, error, trace_id, model, provider)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      record.traceId ?? null,
      record.model ?? null,
      record.provider ?? null,
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
    if (record.traceId !== undefined) {
      fields.push('trace_id = ?');
      values.push(record.traceId ?? null);
    }
    if (record.model !== undefined) {
      fields.push('model = ?');
      values.push(record.model ?? null);
    }
    if (record.provider !== undefined) {
      fields.push('provider = ?');
      values.push(record.provider ?? null);
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
      .prepare('SELECT * FROM movements WHERE concert_id = ? ORDER BY started_at ASC, id ASC')
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

    const order = filter?.order === 'desc' ? 'DESC' : 'ASC';
    sql += ` ORDER BY timestamp ${order}, id ${order}`;

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

  async createSessionTrace(trace: SessionTrace): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO session_traces
          (id, concert_id, movement_id, session_id, file_path, started_at, completed_at, event_count, status, format)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        trace.id,
        trace.concertId,
        trace.movementId,
        trace.sessionId,
        trace.filePath,
        serializeDate(trace.startedAt),
        serializeDate(trace.completedAt),
        trace.eventCount,
        trace.status,
        trace.format,
      );
  }

  async updateSessionTrace(id: string, update: Partial<SessionTrace>): Promise<void> {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (update.completedAt !== undefined) {
      fields.push('completed_at = ?');
      values.push(serializeDate(update.completedAt));
    }
    if (update.eventCount !== undefined) {
      fields.push('event_count = ?');
      values.push(update.eventCount);
    }
    if (update.filePath !== undefined) {
      fields.push('file_path = ?');
      values.push(update.filePath);
    }

    const supported = new Set(['completedAt', 'eventCount', 'status', 'filePath']);
    const keysWithValues = Object.entries(update)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k);
    const unsupported = keysWithValues.filter((k) => !supported.has(k));
    if (unsupported.length > 0) {
      throw new Error(
        `updateSessionTrace does not support updating fields: ${unsupported.join(', ')}`,
      );
    }
    if (update.status !== undefined) {
      fields.push('status = ?');
      values.push(update.status);
    }

    if (fields.length === 0) return;

    values.push(id);
    this.db.prepare(`UPDATE session_traces SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  async getSessionTracesForConcert(concertId: ConcertID): Promise<SessionTrace[]> {
    const rows = this.db
      .prepare('SELECT * FROM session_traces WHERE concert_id = ? ORDER BY started_at ASC, id ASC')
      .all(concertId) as SessionTraceRow[];
    return rows.map(rowToSessionTrace);
  }

  async getSessionTraceForMovement(concertId: ConcertID, movementId: MovementID): Promise<SessionTrace | null> {
    const row = this.db
      .prepare('SELECT * FROM session_traces WHERE concert_id = ? AND movement_id = ? ORDER BY started_at DESC LIMIT 1')
      .get(concertId, movementId) as SessionTraceRow | undefined;
    if (!row) return null;
    return rowToSessionTrace(row);
  }
}


