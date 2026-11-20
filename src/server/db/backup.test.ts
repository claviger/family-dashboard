import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from './index.js';
import { backupDatabase, lastBackupTime } from './backup.js';

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
});
