import type { JobDef } from '../../core/jobs.js';
import type { PanelModule } from '../registry.js';
import type { BankSync } from '../spend/plaidSync.js';
import { pruneSavingsImportPreviews } from './imports.js';
import { savingsRoutes } from './routes.js';
import type { SavingsSync } from './sync.js';
import type { SavingsReadDeps } from './views.js';

/**
 * `savings.sync` (the Savings spec, "Sync"): daily at 05:30 family time, every Savings connection,
 * a connection that needs reconnecting checked with `/item/get` first (BankSync.checkItem, as
 * Spend's 06:00 job does). Registered only with Plaid. A run with failures is one plain job error;
 * each connection's status in Savings settings says which.
 *
 * `savings.pruneImports` (always): import drafts older than an hour, every 15 minutes, as Spend's.
 */
export function savingsJobs(deps: SavingsReadDeps & { bank?: BankSync | null; savings?: SavingsSync | null }): JobDef[] {
  const prune: JobDef = { name: 'savings.pruneImports', cron: '*/15 * * * *', run: () => { pruneSavingsImportPreviews(deps); } };
  const { bank, savings } = deps;
  if (!bank || !savings) return [prune];
  return [
    {
      name: 'savings.sync',
      cron: '30 5 * * *',
      run: async (signal) => {
        const summary = await savings.syncAll({ signal, check: (id) => bank.checkItem(id, { reason: 'scheduled' }) });
        if (summary.failed > 0) {
          throw new Error(
            `Couldn't update ${summary.failed} of ${summary.total} savings ${summary.total === 1 ? 'connection' : 'connections'} through Plaid. Savings settings shows each one's status.`,
          );
        }
      },
    },
    prune,
  ];
}

/** The Savings panel (docs/specs/2026-11-19-savings-panel-design.md). */
export const savingsPanel: PanelModule = {
  id: 'savings',
  router: savingsRoutes,
  jobs: (deps) => savingsJobs(deps),
};
