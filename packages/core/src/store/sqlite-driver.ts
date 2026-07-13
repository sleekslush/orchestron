interface SqliteStmt {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDb {
  prepare(sql: string): SqliteStmt;
  exec(sql: string): void;
  close(): void;
}

type DatabaseCtor = new (path: string, options?: Record<string, unknown>) => SqliteDb;

let ctor: DatabaseCtor;

const isBun = typeof Bun !== 'undefined' && Bun.version != null;

if (isBun) {
  // @ts-expect-error - bun:sqlite is a Bun built-in, supplied by the runtime
  const { Database } = await import('bun:sqlite');
  ctor = Database as unknown as DatabaseCtor;
} else {
  const mod = await import('better-sqlite3');
  const BetterDB = mod.default ?? mod;
  ctor = BetterDB as unknown as DatabaseCtor;
}

export function createSqliteDb(path: string): SqliteDb {
  return new ctor(path);
}
