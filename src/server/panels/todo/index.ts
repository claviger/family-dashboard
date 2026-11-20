import type { PanelModule } from '../registry.js';
import { todoRoutes } from './routes.js';

/**
 * The To-do panel (spec §10). With Todoist configured, `todo.todoistSync` runs every 10 minutes
 * (spec §3.5): an incremental sync for each linked, active person. Webhooks and opening the
 * drill-down sync sooner. `todo.todoistRevocations` runs hourly and tries again to revoke the
 * tokens of unlinked accounts that Todoist didn't confirm revoking; the System page warns about
 * those itself, so a failed retry isn't also a job error.
 */
export const todoPanel: PanelModule = {
  id: 'todo',
  router: todoRoutes,
  jobs: (deps) => {
    const { todoist } = deps;
    if (!todoist) return [];
    return [
      {
        name: 'todo.todoistSync',
        cron: '*/10 * * * *',
        run: async () => {
          const { total, failed } = await todoist.syncAll();
          if (failed > 0) {
            throw new Error(`Todoist sync failed for ${failed} of ${total} linked people. Each person's link shows its own status on the Users page.`);
          }
        },
      },
      {
        name: 'todo.todoistRevocations',
        cron: '0 * * * *',
        run: async () => {
          await todoist.retryRevocations();
        },
      },
    ];
  },
};
