import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from './index.js';
import { BACKUP_SCRUB_FAILED, backupDatabase, DRAFT_TABLES, lastBackupTime, writeScrubbedBackup } from './backup.js';

/** SYNTHETIC import drafts in both panels, holding a cell nothing else in the database has. */
const CANARY = 'CANARY-DRAFT-CELL-7f3a';
function addDrafts(sqlite: Database.Database) {
  sqlite.exec(`
    insert into users (id, email, display_name, color, role, active, created_at) values (1, 'alex@example.com', 'Alex', '#378ADD', 'admin', 1, 1);
    insert into cards (id, nickname, included, created_at, updated_at) values (1, 'Visa', 1, 1, 1);
    insert into savings_accounts (id, source, nickname, kind, created_at, updated_at) values (1, 'csv', 'Cash', 'cash', 1, 1);
    insert into csv_import_previews (id, user_id, card_id, file_name, file_sha256, rows, plan, created_at, expires_at)
      values ('spend-draft', 1, 1, null, '${'0'.repeat(64)}', '[]', '{"header":["${CANARY}-spend"],"rows":[]}', 1, 9999999999999);
    insert into savings_import_previews (id, user_id, account_id, file_name, file_sha256, layout, plan, created_at, expires_at)
      values ('savings-draft', 1, 1, null, '${'0'.repeat(64)}', 'custom', '{"header":["${CANARY}-savings"],"rows":[]}', 1, 9999999999999);
  `);
}
const count = (db: Database.Database, table: string) => (db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;

describe('backupDatabase', () => {
  it('writes a dated copy and keeps only the newest 14', async () => {
    const work = mkdtempSync(join(tmpdir(), 'fd-backup-test-'));
    const { sqlite } = openDb(join(work, 'dashboard.db'));
    const dir = join(work, 'backups');
    expect(lastBackupTime(dir)).toBeNull();
    for (let day = 1; day <= 15; day++) {
      await backupDatabase(sqlite, dir, `2026-10-${String(day).padStart(2, '0')}`);
    }
    writeFileSync(join(dir, 'unrelated.txt'), 'keep me');
    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(15);
    expect(files[0]).toBe('dashboard-2026-10-02.db');
    expect(files).toContain('unrelated.txt');
    expect(lastBackupTime(dir)).toBeInstanceOf(Date);
    sqlite.close();
  });

  it("leaves the import drafts out of the copy, cells and all, and the copy passes integrity_check; the live drafts stay", async () => {
    const work = mkdtempSync(join(tmpdir(), 'fd-backup-test-'));
    const { sqlite } = openDb(join(work, 'dashboard.db'));
    addDrafts(sqlite);
    const file = await backupDatabase(sqlite, join(work, 'backups'), '2026-11-20');
    expect(DRAFT_TABLES).toEqual(['csv_import_previews', 'savings_import_previews']);
    const copy = new Database(file, { readonly: true });
    for (const table of DRAFT_TABLES) expect(count(copy, table)).toBe(0);
    expect(count(copy, 'cards')).toBe(1);
    expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
    copy.close();
    // VACUUM rewrote the file: the drafts' cells aren't in free pages either.
    expect(readFileSync(file).includes(CANARY)).toBe(false);
    // Only the finished copy is left: no partial file, no WAL beside it.
    expect(readdirSync(join(work, 'backups'))).toEqual(['dashboard-2026-11-20.db']);
    for (const table of DRAFT_TABLES) expect(count(sqlite, table)).toBe(1);
    sqlite.close();
  });

  it('deletes a copy it could not scrub, and says so without anything from the database', async () => {
    const work = mkdtempSync(join(tmpdir(), 'fd-backup-test-'));
    // A database without the draft tables: the scrub's delete fails.
    const bare = new Database(join(work, 'bare.db'));
    bare.exec("create table notes (body text); insert into notes values ('SECRET NOTE')");
    const dir = join(work, 'backups');
    await expect(backupDatabase(bare, dir, '2026-11-20')).rejects.toThrow(BACKUP_SCRUB_FAILED);
    expect(BACKUP_SCRUB_FAILED).not.toMatch(/SECRET|notes/);
    expect(readdirSync(dir)).toEqual([]);
    expect(lastBackupTime(dir)).toBeNull();
    bare.close();
  });
});

describe('writeScrubbedBackup (the manual backup before a deploy)', () => {
  it('copies a database opened read-only, as the docker exec does, with the drafts scrubbed', async () => {
    const work = mkdtempSync(join(tmpdir(), 'fd-backup-test-'));
    const live = join(work, 'dashboard.db');
    const { sqlite } = openDb(live);
    addDrafts(sqlite);
    const source = new Database(live, { readonly: true });
    const file = join(work, 'pre-deploy.db');
    await writeScrubbedBackup(source, file);
    source.close();
    const copy = new Database(file, { readonly: true });
    for (const table of DRAFT_TABLES) expect(count(copy, table)).toBe(0);
    expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
    copy.close();
    expect(readFileSync(file).includes(CANARY)).toBe(false);
    expect(existsSync(`${file}.partial`)).toBe(false);
    sqlite.close();
  });
});
