import type { PanelModule } from '../registry.js';
import { generateChores } from './generator.js';
import { listenForChoreEvents, reconcileOccurrences } from './linkage.js';
import { choreAdminRoutes, choreRoutes } from './routes.js';
import { retryPendingTodos } from './todoLink.js';

/**
 * The Chores panel (spec §11). Its jobs run in the family time zone (spec §3.5): `chores.generate`
 * every 15 minutes, which includes 00:00, and `todo.retryPending` every 5 minutes.
 */
export const choresPanel: PanelModule = {
  id: 'chores',
  router: choreRoutes,
  jobs: (deps) => [
    {
      name: 'chores.generate',
      cron: '*/15 * * * *',
      run: async () => {
        await generateChores(deps);
      },
    },
    {
      name: 'todo.retryPending',
      cron: '*/5 * * * *',
      run: async () => {
        reconcileOccurrences(deps);
        const { stillPending, actionsPending } = await retryPendingTodos(deps);
        // Recorded as a job error, so admins see it on the System page while it lasts (spec §14).
        // Stuck items aren't counted: the System page lists them on their own.
        if (stillPending + actionsPending > 0) {
          throw new Error(
            `Chore to-dos still waiting: ${stillPending} to create, ${actionsPending} to remove or complete. Retrying with backoff.`,
          );
        }
      },
    },
  ],
  listen: listenForChoreEvents,
  adminRouter: choreAdminRoutes,
};
