import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

// src/server/db/ and dist/server/db/ are both three levels below the repo root.
const MIGRATIONS = fileURLToPath(new URL('../../../drizzle', import.meta.url));

export function openDb(path: string): { db: Db; sqlite: Database.Database } {
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  // Deleted cells are overwritten with zeros, so a CSV import draft (every column of a file, for up
  // to an hour) leaves nothing behind in the database file once it's deleted. Old WAL frames can
  // still hold it until a checkpoint: see checkpointWal.
  sqlite.pragma('secure_delete = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS });
  return { db, sqlite };
}

/**
 * Copies the WAL into the database and truncates the WAL file to nothing, so frames written before
 * (an import draft's cells, say) are gone from disk too. Run by the import drafts' prune jobs every
 * 15 minutes. The app has one connection, so nothing holds the WAL open against it; if something
 * did, SQLite would do what it can and leave the rest for the next run, without failing.
 */
export function checkpointWal(sqlite: Database.Database): void {
  sqlite.pragma('wal_checkpoint(TRUNCATE)');
}
