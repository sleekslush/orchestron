/**
 * SQLite driver factory.
 *
 * Uses createRequire to synchronously resolve better-sqlite3 (Node) or
 * bun:sqlite (Bun) without top-level await or module-level side effects.
 * This keeps the SqliteLoge constructor synchronous, avoiding cascading
 * async changes across dozens of call sites.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

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

const __require = createRequire(
  typeof __filename !== 'undefined' ? __filename : import.meta.url ? fileURLToPath(import.meta.url) : '.',
);

let ctor: DatabaseCtor | undefined;

function getDatabaseConstructor(): DatabaseCtor {
  if (ctor) return ctor;

  const isBun = typeof Bun !== 'undefined' && Bun.version != null;

  if (isBun) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = __require('bun:sqlite');
    ctor = Database as unknown as DatabaseCtor;
  } else {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = __require('better-sqlite3');
    ctor = (mod.default ?? mod) as unknown as DatabaseCtor;
  }

  return ctor!;
}

export function createSqliteDb(path: string): SqliteDb {
  const dbCtor = getDatabaseConstructor();
  return new dbCtor(path);
}

export type { SqliteDb, SqliteStmt, DatabaseCtor };
