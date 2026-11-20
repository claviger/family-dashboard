import type Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const BACKUP_FILE = /^dashboard-\d{4}-\d{2}-\d{2}\.db$/;

function backupFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => BACKUP_FILE.test(f)).sort();
}

/** Online backup to `dir/dashboard-<date>.db`, keeping the newest `keep` files. */
export async function backupDatabase(sqlite: Database.Database, dir: string, date: string, keep = 14): Promise<string> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `dashboard-${date}.db`);
  await sqlite.backup(file);
  chmodSync(file, 0o600);
  const files = backupFiles(dir);
  for (const old of files.slice(0, Math.max(0, files.length - keep))) unlinkSync(join(dir, old));
  return file;
}

export function lastBackupTime(dir: string): Date | null {
  const newest = backupFiles(dir).at(-1);
  return newest ? statSync(join(dir, newest)).mtime : null;
}
