import Database from 'better-sqlite3';
import { writeScrubbedBackup } from './backup.js';

/**
 * The manual backup before a deploy (README, "Backups"), as the nightly one makes it: an online copy
 * with the CSV import drafts removed and the file vacuumed. Inside the container:
 *
 *   node dist/server/db/backupNow.js /data/dashboard.db /data/backups/pre-<what>-<date>.db
 *
 * The live database is opened read-only. Prints the copy's path, or fails with a message that has
 * nothing from the database in it.
 */
const [source, target] = process.argv.slice(2);
if (!source || !target) {
  console.error('Usage: node dist/server/db/backupNow.js <database> <backup file>');
  process.exit(2);
}
const db = new Database(source, { readonly: true, fileMustExist: true });
try {
  await writeScrubbedBackup(db, target);
  console.log(target);
} catch (err) {
  console.error(err instanceof Error ? err.message : 'The backup failed.');
  process.exitCode = 1;
} finally {
  db.close();
}
