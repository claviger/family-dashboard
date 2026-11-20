import type { Logger } from 'pino';
import type { Clock } from '../../core/clock.js';
import { sleepUnlessAborted, type JobDef } from '../../core/jobs.js';
import type { Db } from '../../db/index.js';
import type { Plaid } from '../../integrations/plaid/plaid.js';
import type { PanelModule } from '../registry.js';
import { pruneImportPreviews } from './imports.js';
import { pruneRemovedTransactions } from './plaidApply.js';
import type { BankSync, RunSummary } from './plaidSync.js';
import { spendRoutes } from './routes.js';

/** `spend.transactionsSync` starts up to this long after its cron tick (the design's "Jobs"), so syncs don't line up with every other install's. */
export const SYNC_JITTER_MS = 30 * 60_000;

/** What the Plaid jobs need. `plaid` and `bank` are null (or absent) when Plaid isn't configured. */
export interface PlaidJobDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  plaid?: Plaid | null;
  bank?: BankSync | null;
}

/** A run that had failures is a job error with a plain summary; each bank's own status says which. */
function throwIfFailed(summary: RunSummary, what: string): void {
  if (summary.failed > 0) {
    throw new Error(
      `Couldn't ${what} for ${summary.failed} of ${summary.total} ${summary.total === 1 ? 'bank' : 'banks'} through Plaid. Spend settings shows each bank's status.`,
    );
  }
}

/**
 * Spend's Plaid jobs (spec §3.5, the design's "Jobs"):
 * - `spend.transactionsSync`, every 6 hours, starting up to 30 minutes late: a sync for every Item
 *   (the backup to webhooks, research §7.5), skipping those in backoff or waiting for the pick.
 * - `spend.statementsSync`, daily at 06:00 family time: `/liabilities/get` per Item (Plaid
 *   refreshes it about once a day, research §6).
 * - `spend.pruneRemoved`, daily at 04:15: hard-deletes transactions Plaid removed more than 7 days
 *   ago, and link pendings nobody finished. Registered without Plaid too: rows removed while it was
 *   configured still age out.
 * - `spend.plaidRevocations`, hourly: `/item/remove` again for removals Plaid didn't confirm; giving
 *   up on one is a job error naming no bank (the lasting notice in Spend settings names it).
 *
 * `opts.jitterMs` is for tests, which don't wait.
 */
export function plaidJobs(deps: PlaidJobDeps, opts: { jitterMs?: number } = {}): JobDef[] {
  const jitterMs = opts.jitterMs ?? SYNC_JITTER_MS;
  const jobs: JobDef[] = [
    {
      name: 'spend.pruneRemoved',
      cron: '15 4 * * *',
      run: () => {
        const transactions = pruneRemovedTransactions(deps.db, deps.clock.now());
        const pending = deps.plaid?.prunePending() ?? 0;
        if (transactions > 0 || pending > 0) deps.logger.info({ transactions, pending }, 'pruned removed plaid rows');
      },
    },
  ];
  const { plaid, bank } = deps;
  if (!plaid || !bank) return jobs;
  return [
    ...jobs,
    {
      name: 'spend.transactionsSync',
      cron: '0 */6 * * *',
      run: async (signal) => {
        await sleepUnlessAborted(Math.floor(Math.random() * jitterMs), signal);
        if (signal?.aborted) return;
        throwIfFailed(await bank.syncAll({ signal }), 'sync transactions');
      },
    },
    {
      name: 'spend.statementsSync',
      cron: '0 6 * * *',
      run: async (signal) => {
        throwIfFailed(await bank.refreshAllLiabilities({ signal }), 'get statements');
      },
    },
    {
      name: 'spend.plaidRevocations',
      cron: '45 * * * *',
      run: async () => {
        const { gaveUp } = await plaid.retryRevocations();
        if (gaveUp > 0) {
          throw new Error(
            `Gave up ending the dashboard's Plaid connection for ${gaveUp === 1 ? 'a removed bank' : `${gaveUp} removed banks`}. ` +
              "Spend settings says which; remove the dashboard in that bank's connected apps settings, or at my.plaid.com.",
          );
        }
      },
    },
  ];
}

/**
 * The Spend panel (spec §12): cards, closing dates, categories, rules, CSV import, and (phase 6b)
 * Plaid. `spend.pruneImports` deletes CSV previews older than an hour; the Plaid jobs are above.
 */
export const spendPanel: PanelModule = {
  id: 'spend',
  router: spendRoutes,
  jobs: (deps) => [
    {
      name: 'spend.pruneImports',
      cron: '*/15 * * * *',
      run: () => {
        pruneImportPreviews(deps);
      },
    },
    ...plaidJobs(deps),
  ],
};
