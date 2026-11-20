import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const BACKUP_FILE = /^dashboard-\d{4}-\d{2}-\d{2}\.db$/;

/**
 * The CSV import drafts: every column of an uploaded file, for up to an hour. Backups never keep
 * them (they'd outlive the hour by weeks): each copy has them deleted and is vacuumed before it
 * counts as a backup.
 */
export const DRAFT_TABLES = ['csv_import_previews', 'savings_import_previews'] as const;

/** The error a backup that couldn't be scrubbed fails with. Nothing from the database is in it. */
export const BACKUP_SCRUB_FAILED = "The backup couldn't have its import drafts removed, so it was deleted. Nothing was kept.";

function backupFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => BACKUP_FILE.test(f)).sort();
}

function removeCopy(file: string): void {
  for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) rmSync(f, { force: true });
}

/**
 * Deletes the import drafts from a fresh copy and vacuums it, so their cells aren't left in free
 * pages, then checks it. The copy is switched out of WAL first, so it stays one file.
 */
function scrubCopy(file: string): void {
  const copy = new Database(file);
  try {
    copy.pragma('journal_mode = DELETE');
    copy.transaction(() => {
      for (const table of DRAFT_TABLES) copy.prepare(`delete from ${table}`).run();
    })();
    copy.exec('VACUUM');
    if (copy.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('integrity_check');
  } finally {
    copy.close();
  }
}

/**
 * An online copy of `sqlite` at `file`, with the import drafts scrubbed out (above). It's written
 * as `file.partial` and only renamed to `file` once scrubbed; a copy that can't be scrubbed is
 * deleted, and this fails with BACKUP_SCRUB_FAILED. Also what the manual backup before a deploy
 * runs (README, "Backups").
 */
export async function writeScrubbedBackup(sqlite: Database.Database, file: string): Promise<void> {
  const partial = `${file}.partial`;
  removeCopy(partial);
  await sqlite.backup(partial);
  try {
    scrubCopy(partial);
  } catch {
    removeCopy(partial);
    throw new Error(BACKUP_SCRUB_FAILED);
  }
  chmodSync(partial, 0o600);
  renameSync(partial, file);
}

/** Online backup to `dir/dashboard-<date>.db`, scrubbed of import drafts, keeping the newest `keep` files. */
export async function backupDatabase(sqlite: Database.Database, dir: string, date: string, keep = 14): Promise<string> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `dashboard-${date}.db`);
  await writeScrubbedBackup(sqlite, file);
  const files = backupFiles(dir);
  for (const old of files.slice(0, Math.max(0, files.length - keep))) unlinkSync(join(dir, old));
  return file;
}

export function lastBackupTime(dir: string): Date | null {
  const newest = backupFiles(dir).at(-1);
  return newest ? statSync(join(dir, newest)).mtime : null;
}
