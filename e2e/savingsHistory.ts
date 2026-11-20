import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Past Savings balances and flows, written straight into the e2e server's database.
 *
 * Why this exists: Plaid has no past balances (the Savings spec, "Line graph"), so neither does the
 * fake Plaid. Every sync stores today's snapshot and nothing older, and a test can't wait months
 * for the graph, a past month, or an account that joins part way through the line. So the tests
 * that need history add the rows a real server would have stored on earlier days, here, and
 * nothing else: no Plaid state, no other tables. The app reads them as it reads its own (no
 * cache), so the next page load shows them.
 *
 * The database is the one playwright.config.ts gives the app (`DATA_DIR=e2e/.data`), relative to
 * where Playwright runs (the repo root). Each call opens it, writes in one transaction, and closes
 * it again, so the server's own writes wait for it at most a moment. Everything is synthetic.
 */

const DB_PATH = join(process.cwd(), 'e2e', '.data', 'dashboard.db');

function withDb<T>(fn: (db: Database.Database) => T): T {
  if (!existsSync(DB_PATH)) throw new Error(`The e2e database isn't at ${DB_PATH}. Run Playwright from the repo root.`);
  const db = new Database(DB_PATH, { timeout: 10_000 });
  try {
    return db.transaction(() => fn(db))();
  } finally {
    db.close();
  }
}

function accountId(db: Database.Database, plaidAccountId: string): number {
  const row = db.prepare('select id from savings_accounts where plaid_account_id = ?').get(plaidAccountId) as { id: number } | undefined;
  if (!row) throw new Error('That account isn\'t shown in Savings: pick it first.');
  return row.id;
}

/** Noon that day, local time: when a past snapshot was "fetched". */
function noon(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12, 0, 0, 0).getTime();
}

/** A balance snapshot for a shown account (by Plaid's account id) on a past day, as the daily sync would have stored it. */
export function addPastSnapshot(plaidAccountId: string, date: string, dollars: number): void {
  withDb((db) => {
    const id = accountId(db, plaidAccountId);
    db.prepare(
      `insert into savings_balances (account_id, date, current_cents, available_cents, fetched_at) values (?, ?, ?, null, ?)
       on conflict (account_id, date) do update set current_cents = excluded.current_cents, fetched_at = excluded.fetched_at`,
    ).run(id, date, Math.round(dollars * 100), noon(date));
  });
}

/** A deposit or withdrawal on a past day, as a sync would have stored it from the cash account's transactions. */
export function addPastFlow(plaidAccountId: string, date: string, kind: 'deposit' | 'withdrawal', dollars: number): void {
  withDb((db) => {
    const id = accountId(db, plaidAccountId);
    const at = noon(date);
    db.prepare(
      `insert into savings_flows (account_id, source, plaid_id, date, amount_cents, kind, created_at, updated_at) values (?, 'transactions', ?, ?, ?, ?, ?, ?)`,
    ).run(id, `e2e-history-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, date, Math.round(dollars * 100), kind, at, at);
  });
}
