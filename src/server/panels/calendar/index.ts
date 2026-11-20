import { sleepUnlessAborted } from '../../core/jobs.js';
import type { PanelModule } from '../registry.js';
import { calendarAdminRoutes, calendarRoutes } from './routes.js';

/**
 * `calendar.refreshSummary` starts up to this long after its 5-minute cron tick, so its runs are
 * 3.75 to 6.25 minutes apart: Google's quota guide asks for ±25% on anything done on a regular
 * basis (docs/research/google-calendar-v3.md §8, §10).
 */
export const REFRESH_JITTER_MS = 75_000;

/**
 * The Calendar panel (spec §9). Its jobs (spec §3.5):
 * - `calendar.refreshSummary`, every 5 minutes with jitter: fetches the home card's window so it
 *   loads quickly and stays fresh, prunes old cached windows, and deletes calendar picks nobody
 *   finished. A failure is recorded (the System page shows it) and on the connection's status.
 * - `calendar.revocations`, hourly: revokes what a disconnect couldn't. Giving up on one is a job
 *   error, so an admin knows to remove the access in that Google account's settings.
 */
export const calendarPanel: PanelModule = {
  id: 'calendar',
  router: calendarRoutes,
  adminRouter: calendarAdminRoutes,
  jobs: (deps) => [
    {
      name: 'calendar.refreshSummary',
      cron: '*/5 * * * *',
      run: async (signal) => {
        await sleepUnlessAborted(Math.floor(Math.random() * REFRESH_JITTER_MS), signal);
        if (signal?.aborted) return;
        deps.calendar.prunePending();
        await deps.calendarEvents.refreshSummary();
      },
    },
    {
      name: 'calendar.revocations',
      cron: '30 * * * *',
      run: async () => {
        const { gaveUp } = await deps.calendar.retryRevocations();
        if (gaveUp > 0) {
          throw new Error(
            `Gave up revoking the dashboard's Google Calendar access for ${gaveUp === 1 ? 'a disconnected account' : `${gaveUp} disconnected accounts`}. ` +
              "Remove the dashboard's access in that Google account's settings.",
          );
        }
      },
    },
  ],
};
