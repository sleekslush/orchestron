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

const isBun = typeof (globalThis as { Bun?: { version?: string } }).Bun !== 'undefined';

if (isBun) {
  // Cast away the literal specifier: 'bun:sqlite' is a Bun builtin with no
  // package-level type declarations, so TS skips module resolution here.
  const mod = (await import('bun:sqlite' as string)) as { Database: unknown };
  ctor = mod.Database as unknown as DatabaseCtor;
} else {
  const mod = await import('better-sqlite3');
  const BetterDB = mod.default ?? mod;
  ctor = BetterDB as unknown as DatabaseCtor;
}

export function createSqliteDb(path: string): SqliteDb {
  return new ctor(path);
}
