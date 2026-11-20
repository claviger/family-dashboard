import type { AppDeps } from './app.js';
import { deleteExpiredSessions } from './auth/sessions.js';
import { localDate } from './core/clock.js';
import type { JobDef } from './core/jobs.js';
import { backupDatabase } from './db/backup.js';
import { getFamilySettings } from './settings.js';

export function platformJobs(deps: AppDeps): JobDef[] {
  return [
    {
      name: 'db.backup',
      cron: '0 3 * * *',
      run: async () => {
        const date = localDate(deps.clock.now(), getFamilySettings(deps.db).timeZone);
        await backupDatabase(deps.sqlite, deps.backupDir, date);
      },
    },
    {
      name: 'sessions.cleanup',
      cron: '30 3 * * *',
      run: () => {
        deleteExpiredSessions(deps.db, deps.clock);
      },
    },
  ];
}
