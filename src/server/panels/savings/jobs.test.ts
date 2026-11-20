import { describe, expect, it } from 'vitest';
import { runJob } from '../../core/jobs.js';
import { jobErrors, savingsImportPreviews } from '../../db/schema.js';
import { FAKE_PLAID_ERRORS } from '../../test/fakePlaid.js';
import { addUser, makeTestApp } from '../../test/helpers.js';
import { bytes, CASH_FILE } from '../../test/importCsv.js';
import { addHandAccount, linkSavingsForTest } from '../../test/savingsFixtures.js';
import { panelJobs } from '../registry.js';
import { startSavingsImport } from './imports.js';
import { savingsJobs } from './index.js';

describe('savings.sync', () => {
  it('registers the daily sync only with Plaid, at 05:30 family time, and the import prune always', () => {
    expect(savingsJobs(makeTestApp()).map((j) => j.name)).toEqual(['savings.pruneImports']);
    const jobs = panelJobs(makeTestApp({ plaid: true }));
    expect(jobs.find((j) => j.name === 'savings.sync')?.cron).toBe('30 5 * * *');
    expect(jobs.find((j) => j.name === 'savings.pruneImports')?.cron).toBe('*/15 * * * *');
    expect(panelJobs(makeTestApp()).find((j) => j.name === 'savings.pruneImports')?.cron).toBe('*/15 * * * *');
  });

  it('syncs every Savings connection, and a run with failures is one plain job error', async () => {
    const t = makeTestApp({ plaid: true });
    const admin = addUser(t.db, t.clock, { email: 'alex@example.com', role: 'admin' });
    linkSavingsForTest(t, admin);
    const [job] = savingsJobs(t);
    await runJob(t, job!);
    expect(t.fakePlaid.count('/accounts/get')).toBe(1);
    expect(t.db.select().from(jobErrors).all()).toEqual([]);

    t.clock.advance(24 * 3600_000);
    for (let i = 0; i < 3; i++) t.fakePlaid.failNext('/accounts/get', FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR);
    await runJob(t, job!);
    expect(t.db.select().from(jobErrors).all().map((e) => [e.job, e.message])).toEqual([
      ['savings.sync', "Couldn't update 1 of 1 savings connection through Plaid. Savings settings shows each one's status."],
    ]);
  });

  it('checks a connection that needs reconnecting with /item/get first, and syncs it once Plaid says it\'s fixed', async () => {
    const t = makeTestApp({ plaid: true });
    const admin = addUser(t.db, t.clock, { email: 'alex@example.com', role: 'admin' });
    const linked = linkSavingsForTest(t, admin);
    t.plaid!.markNeedsReconnect(linked.item.id, 'ITEM_LOGIN_REQUIRED');
    const [job] = savingsJobs(t);
    await runJob(t, job!);
    await t.savings!.idle();
    expect(t.fakePlaid.count('/item/get')).toBe(1);
    // One sync: the check that found it repaired queued it, so the job doesn't run another.
    expect(t.fakePlaid.count('/accounts/get')).toBe(1);
    expect(t.fakePlaid.count('/transactions/sync')).toBe(1);
    expect(t.db.select().from(jobErrors).all()).toEqual([]);
  });
});

describe('savings.pruneImports', () => {
  it('deletes import drafts older than an hour', async () => {
    const t = makeTestApp();
    const admin = addUser(t.db, t.clock, { email: 'alex@example.com', role: 'admin' });
    const hand = addHandAccount(t, { kind: 'cash' });
    startSavingsImport(t, admin, { accountId: hand.id, fileName: null, bytes: bytes(CASH_FILE) });
    const job = savingsJobs(t).find((j) => j.name === 'savings.pruneImports')!;
    await runJob(t, job);
    expect(t.db.select().from(savingsImportPreviews).all()).toHaveLength(1);
    t.clock.advance(60 * 60_000);
    await runJob(t, job);
    expect(t.db.select().from(savingsImportPreviews).all()).toEqual([]);
    expect(t.db.select().from(jobErrors).all()).toEqual([]);
  });
});
