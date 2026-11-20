import { describe, expect, it } from 'vitest';
import { savingsAccounts, savingsBalances, savingsFlows } from '../../db/schema.js';
import { addUser, makeTestApp } from '../../test/helpers.js';
import { addCsvImport, addSavingsAccount, addSavingsItem } from '../../test/savingsFixtures.js';
import { eq } from 'drizzle-orm';
import {
  accountData, deleteFlowsById, deleteSavingsData, flowsFor, investmentFlowIdsIn, liveAccountsOf, markSavingsAccountsRemoved, putManualBalance, putSnapshot, removeFlows, replaceCsvTwin,
  snapshotsFor, upsertFlow,
} from './store.js';

const NOW = new Date('2026-11-15T12:00:00Z');

describe('the Savings store', () => {
  it('keeps one snapshot a day per account, the later fetch winning', () => {
    const t = makeTestApp();
    const item = addSavingsItem(t);
    const cash = addSavingsAccount(t, item.id, { plaidAccountId: 'acct-cash', kind: 'cash' });
    putSnapshot(t.db, cash.id, '2026-11-15', { currentCents: 100_00, availableCents: 90_00 }, NOW);
    putSnapshot(t.db, cash.id, '2026-11-15', { currentCents: 110_00, availableCents: null }, new Date('2026-11-15T18:00:00Z'));
    putSnapshot(t.db, cash.id, '2026-11-16', { currentCents: 120_00, availableCents: null }, new Date('2026-11-16T06:00:00Z'));
    expect(snapshotsFor(t.db, [cash.id]).get(cash.id)!.map((s) => [s.date, s.cents])).toEqual([['2026-11-15', 110_00], ['2026-11-16', 120_00]]);
    expect(t.db.select().from(savingsBalances).all()).toHaveLength(2);
  });

  it('upserts flows by source and Plaid id, and removes them by id', () => {
    const t = makeTestApp();
    const item = addSavingsItem(t);
    const cash = addSavingsAccount(t, item.id, { plaidAccountId: 'acct-cash', kind: 'cash' });
    expect(upsertFlow(t.db, { accountId: cash.id, source: 'transactions', plaidId: 'tx-1', date: '2026-11-03', kind: 'deposit', amountCents: 10_00 }, NOW)).toBe('added');
    expect(upsertFlow(t.db, { accountId: cash.id, source: 'transactions', plaidId: 'tx-1', date: '2026-11-04', kind: 'deposit', amountCents: 12_00 }, NOW)).toBe('updated');
    expect(upsertFlow(t.db, { accountId: cash.id, source: 'transactions', plaidId: 'tx-1', date: '2026-11-04', kind: 'deposit', amountCents: 12_00 }, NOW)).toBe('unchanged');
    expect(flowsFor(t.db, [cash.id]).get(cash.id)).toEqual([{ date: '2026-11-04', kind: 'deposit', cents: 12_00 }]);
    expect(removeFlows(t.db, 'transactions', ['tx-1', 'tx-unknown'])).toBe(1);
    expect(t.db.select().from(savingsFlows).all()).toEqual([]);
  });

  it('deletes a connection\'s accounts with their balances and flows, and nothing of another connection', () => {
    const t = makeTestApp();
    const mine = addSavingsItem(t);
    const other = addSavingsItem(t, { plaidItemId: 'item-other' });
    const a = addSavingsAccount(t, mine.id, { plaidAccountId: 'acct-a', kind: 'cash' });
    const b = addSavingsAccount(t, other.id, { plaidAccountId: 'acct-b', kind: 'investment' });
    for (const id of [a.id, b.id]) {
      putSnapshot(t.db, id, '2026-11-15', { currentCents: 1_00, availableCents: null }, NOW);
      upsertFlow(t.db, { accountId: id, source: 'investments', plaidId: `itx-${id}`, date: '2026-11-15', kind: 'deposit', amountCents: 1_00 }, NOW);
    }
    expect(deleteSavingsData(t.db, mine.id)).toEqual({ accounts: 1 });
    expect(t.db.select().from(savingsAccounts).all().map((r) => r.id)).toEqual([b.id]);
    expect(t.db.select().from(savingsBalances).all().map((r) => r.accountId)).toEqual([b.id]);
    expect(t.db.select().from(savingsFlows).all().map((r) => r.accountId)).toEqual([b.id]);
    expect(accountData(t.db, [b.id]).get(b.id)?.snapshots).toHaveLength(1);
  });

  it("lists an Item's accounts that aren't removed, oldest first", () => {
    const t = makeTestApp();
    const item = addSavingsItem(t);
    const other = addSavingsItem(t, { plaidItemId: 'item-other' });
    const a = addSavingsAccount(t, item.id, { plaidAccountId: 'acct-a', kind: 'cash' });
    addSavingsAccount(t, item.id, { plaidAccountId: 'acct-gone', kind: 'cash', removedAt: NOW });
    const hidden = addSavingsAccount(t, item.id, { plaidAccountId: 'acct-hidden', kind: 'investment', hiddenAt: NOW });
    addSavingsAccount(t, other.id, { plaidAccountId: 'acct-other', kind: 'cash' });
    expect(liveAccountsOf(t.db, item.id).map((r) => r.id)).toEqual([a.id, hidden.id]);
  });

  it("finds the brokerage window's stored flows, both ends included, for those accounts and the investments source only", () => {
    const t = makeTestApp();
    const item = addSavingsItem(t);
    const b = addSavingsAccount(t, item.id, { plaidAccountId: 'acct-b', kind: 'investment' });
    const c = addSavingsAccount(t, item.id, { plaidAccountId: 'acct-c', kind: 'investment' });
    const flow = (accountId: number, source: 'transactions' | 'investments', plaidId: string, date: string) =>
      upsertFlow(t.db, { accountId, source, plaidId, date, kind: 'deposit', amountCents: 1_00 }, NOW);
    flow(b.id, 'investments', 'itx-oct', '2026-10-31');
    flow(b.id, 'investments', 'itx-first', '2026-11-01');
    flow(b.id, 'investments', 'itx-mid', '2026-11-05');
    flow(b.id, 'investments', 'itx-last', '2026-11-10');
    flow(b.id, 'investments', 'itx-after', '2026-11-11');
    flow(b.id, 'transactions', 'tx-in-range', '2026-11-05');
    flow(c.id, 'investments', 'itx-other-account', '2026-11-05');
    expect(investmentFlowIdsIn(t.db, [b.id], '2026-11-01', '2026-11-10').map((f) => [f.plaidId, f.date]).sort()).toEqual([
      ['itx-first', '2026-11-01'], ['itx-last', '2026-11-10'], ['itx-mid', '2026-11-05'],
    ]);
    expect(investmentFlowIdsIn(t.db, [], '2026-11-01', '2026-11-10')).toEqual([]);
  });

  it('deletes flows by row id, past one IN list of 500', () => {
    const t = makeTestApp();
    const item = addSavingsItem(t);
    const b = addSavingsAccount(t, item.id, { plaidAccountId: 'acct-b', kind: 'investment' });
    t.db.transaction((tx) => {
      for (let i = 0; i < 1201; i++) upsertFlow(tx, { accountId: b.id, source: 'investments', plaidId: `itx-${i}`, date: '2026-11-05', kind: 'deposit', amountCents: 1_00 }, NOW);
    });
    const ids = t.db.select({ id: savingsFlows.id }).from(savingsFlows).all().map((r) => r.id);
    expect(ids).toHaveLength(1201);
    const keep = ids.pop()!;
    expect(deleteFlowsById(t.db, [...ids, 999_999])).toBe(1200);
    expect(t.db.select({ id: savingsFlows.id }).from(savingsFlows).all()).toEqual([{ id: keep }]);
    expect(deleteFlowsById(t.db, [])).toBe(0);
  });

  it("marks the Items' accounts removed, leaving ones already removed and other Items' alone", () => {
    const t = makeTestApp();
    const item = addSavingsItem(t);
    const other = addSavingsItem(t, { plaidItemId: 'item-other' });
    const earlier = new Date('2026-10-01T12:00:00Z');
    const a = addSavingsAccount(t, item.id, { plaidAccountId: 'acct-a', kind: 'cash' });
    const gone = addSavingsAccount(t, item.id, { plaidAccountId: 'acct-gone', kind: 'cash', removedAt: earlier });
    const o = addSavingsAccount(t, other.id, { plaidAccountId: 'acct-o', kind: 'cash' });
    expect(markSavingsAccountsRemoved(t.db, [item.id], NOW)).toBe(1);
    const removedAt = (id: number) => t.db.select().from(savingsAccounts).where(eq(savingsAccounts.id, id)).get()!.removedAt;
    expect(removedAt(a.id)).toEqual(NOW);
    expect(removedAt(gone.id)).toEqual(earlier);
    expect(removedAt(o.id)).toBeNull();
    expect(markSavingsAccountsRemoved(t.db, [], NOW)).toBe(0);
  });
});

describe('balances and flows from more than one source', () => {
  it('lets a Plaid balance replace an imported or hand-set one, and a hand-set one replace an imported one, never the other way', () => {
    const t = makeTestApp();
    const admin = addUser(t.db, t.clock, { email: 'alex@example.com', role: 'admin' });
    const item = addSavingsItem(t);
    const cash = addSavingsAccount(t, item.id, { plaidAccountId: 'acct-cash', kind: 'cash' });
    addCsvImport(t, cash.id, admin, { balances: [{ date: '2026-11-01', cents: 1_00 }, { date: '2026-11-02', cents: 2_00 }] });
    putSnapshot(t.db, cash.id, '2026-11-01', { currentCents: 10_00, availableCents: null }, NOW);
    expect(putManualBalance(t.db, cash.id, '2026-11-02', 20_00, NOW)).toBe('saved');
    expect(putManualBalance(t.db, cash.id, '2026-11-01', 99_00, NOW)).toBe('plaid');
    const rows = () => t.db.select().from(savingsBalances).all().map((b) => [b.date, b.currentCents, b.source, b.importId]);
    expect(rows()).toEqual([['2026-11-01', 10_00, 'plaid', null], ['2026-11-02', 20_00, 'manual', null]]);
    putSnapshot(t.db, cash.id, '2026-11-02', { currentCents: 21_00, availableCents: 20_00 }, NOW);
    expect(rows()).toEqual([['2026-11-01', 10_00, 'plaid', null], ['2026-11-02', 21_00, 'plaid', null]]);
  });

  it('replaces the imported flow a new Plaid flow matches: same kind and amount within 3 days, the nearest, one each', () => {
    const t = makeTestApp();
    const admin = addUser(t.db, t.clock, { email: 'alex@example.com', role: 'admin' });
    const item = addSavingsItem(t);
    const cash = addSavingsAccount(t, item.id, { plaidAccountId: 'acct-cash', kind: 'cash' });
    addCsvImport(t, cash.id, admin, { flows: [
      { date: '2026-11-01', kind: 'deposit', cents: 50_00 }, { date: '2026-11-03', kind: 'deposit', cents: 50_00 }, { date: '2026-11-03', kind: 'withdrawal', cents: 50_00 },
    ] });
    const left = () => t.db.select().from(savingsFlows).all().filter((f) => f.source === 'csv').map((f) => [f.date, f.kind]);
    const plaid = { accountId: cash.id, kind: 'deposit' as const, amountCents: 50_00 };
    expect(replaceCsvTwin(t.db, { ...plaid, date: '2026-11-08' })).toBe(0);
    expect(replaceCsvTwin(t.db, { ...plaid, amountCents: 50_01, date: '2026-11-03' })).toBe(0);
    expect(replaceCsvTwin(t.db, { ...plaid, date: '2026-11-04' })).toBe(1);
    expect(left()).toEqual([['2026-11-01', 'deposit'], ['2026-11-03', 'withdrawal']]);
    expect(replaceCsvTwin(t.db, { ...plaid, date: '2026-11-04' })).toBe(1);
    expect(left()).toEqual([['2026-11-03', 'withdrawal']]);
  });
});
