import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { getDataDir } from '@pc/utils';
import * as schema from './schema.ts';

export type DB = BetterSQLite3Database<typeof schema>;
export type DbTransaction = Parameters<Parameters<DB['transaction']>[0]>[0];
export type DbExecutor = DB | DbTransaction;

let _db: DB | null = null;
let _sqlite: Database.Database | null = null;

/** Lazy singleton. Reads PC_DATA_DIR at first call. */
export function getDb(): DB {
  if (_db) return _db;
  const dir = getDataDir();
  mkdirSync(dir, { recursive: true });
  _sqlite = new Database(join(dir, 'pc.sqlite'));
  _sqlite.pragma('journal_mode = WAL');
  _sqlite.pragma('foreign_keys = ON');
  // Wait briefly on a locked DB instead of surfacing immediate SQLITE_BUSY
  // when a second writer (tooling, a dev shell) touches the file.
  _sqlite.pragma('busy_timeout = 5000');
  _db = drizzle(_sqlite, { schema });
  return _db;
}

/** Underlying better-sqlite3 handle (for PRAGMA / introspection). Ensures the
 *  connection is initialized first. */
export function getRawDb(): Database.Database {
  getDb();
  return _sqlite!;
}

/** Test/teardown only. Production keeps the connection for its lifetime. */
export function closeDb(): void {
  _sqlite?.close();
  _sqlite = null;
  _db = null;
}
