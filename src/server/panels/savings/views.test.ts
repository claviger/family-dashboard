import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { SAVINGS_MESSAGES, SAVINGS_STALE_AFTER_MS, SavingsOverviewSchema, SavingsSummarySchema } from '../../../shared/savings.js';
import { plaidItems, savingsAccounts } from '../../db/schema.js';
import { addUser, makeTestApp, type TestApp } from '../../test/helpers.js';
import { addCsvImport, addHandAccount, addSavingsAccount, addSavingsItem, linkSavingsForTest } from '../../test/savingsFixtures.js';
import { setFamilySettings } from '../../settings.js';
import { putManualBalance, putSnapshot, upsertFlow } from './store.js';
import { savingsOverview, savingsSummary } from './views.js';

// Synthetic. The clock is 2026-11-15 12:00 UTC; the family time zone is UTC.
const at = (date: string, hour = 6) => new Date(`${date}T${String(hour).padStart(2, '0')}:00:00Z`);

function snap(t: TestApp, accountId: number, date: string, cents: number) {
  putSnapshot(t.db, accountId, date, { currentCents: cents, availableCents: null }, at(date));
}
let flowId = 0;
function flow(t: TestApp, accountId: number, date: string, kind: 'deposit' | 'withdrawal', cents: number, source: 'transactions' | 'investments' = 'transactions') {
  upsertFlow(t.db, { accountId, source, plaidId: `p-${++flowId}`, date, kind, amountCents: cents }, at(date));
}

/** A Savings Item with a cash account and a brokerage, with October's last day and some of November. */
function family() {
  const t = makeTestApp();
  const item = addSavingsItem(t);
  const cash = addSavingsAccount(t, item.id, { plaidAccountId: 'acct-cash', kind: 'cash', nickname: 'Cash', mask: '4321' });
  const brokerage = addSavingsAccount(t, item.id, { plaidAccountId: 'acct-brokerage', kind: 'investment', nickname: 'Brokerage', mask: '8765' });
  snap(t, cash.id, '2026-10-31', 1000_00);
  snap(t, cash.id, '2026-11-15', 1200_00);
  snap(t, brokerage.id, '2026-10-31', 5000_00);
  snap(t, brokerage.id, '2026-11-15', 5600_00);
  flow(t, cash.id, '2026-11-03', 'deposit', 300_00);
  flow(t, cash.id, '2026-11-10', 'withdrawal', 90_00);
  flow(t, brokerage.id, '2026-11-05', 'deposit', 500_00, 'investments');
  return { t, item, cash, brokerage };
}

describe('savingsSummary', () => {
  it('gives each shown account its balance, as of when, and this month\'s change, and the total', () => {
    const { t, cash, brokerage } = family();
    const summary = SavingsSummarySchema.parse(savingsSummary(t));
    expect(summary.month).toBe('2026-11');
    expect(summary.accounts.map((a) => [a.account.id, a.account.nickname, a.account.kind, a.balanceCents, a.monthChangeCents, a.asOf, a.stale])).toEqual([
      [cash.id, 'Cash', 'cash', 1200_00, 200_00, at('2026-11-15').toISOString(), false],
      [brokerage.id, 'Brokerage', 'investment', 5600_00, 600_00, at('2026-11-15').toISOString(), false],
    ]);
    expect([summary.totalCents, summary.totalChangeCents, summary.stale, summary.attention]).toEqual([6800_00, 800_00, false, []]);
  });

  it('gives a brokerage its market change this month, and a cash account none', () => {
    const { t } = family();
    // Brokerage: 5600 − 5000 − the 500 deposit.
    expect(savingsSummary(t).accounts.map((a) => [a.account.kind, a.marketChangeCents])).toEqual([['cash', null], ['investment', 100_00]]);
  });

  it("gives no market change for a brokerage whose flows aren't known", () => {
    const { t, item } = family();
    t.db.update(plaidItems).set({ investmentsStatus: 'unavailable', investmentsErrorCode: 'PRODUCTS_NOT_SUPPORTED' }).where(eq(plaidItems.id, item.id)).run();
    expect(savingsSummary(t).accounts.map((a) => [a.account.kind, a.monthChangeCents, a.marketChangeCents])).toEqual([['cash', 200_00, null], ['investment', 600_00, null]]);
  });

  it('leaves out hidden and removed accounts', () => {
    const { t, cash, brokerage } = family();
    t.db.update(savingsAccounts).set({ hiddenAt: t.clock.now() }).where(eq(savingsAccounts.id, cash.id)).run();
    t.db.update(savingsAccounts).set({ removedAt: t.clock.now() }).where(eq(savingsAccounts.id, brokerage.id)).run();
    expect(savingsSummary(t)).toMatchObject({ accounts: [], totalCents: null, totalChangeCents: null, stale: false });
  });

  it('is stale once the latest snapshot is more than 26 hours old', () => {
    const { t } = family();
    t.clock.set(new Date(at('2026-11-15').getTime() + SAVINGS_STALE_AFTER_MS));
    expect(savingsSummary(t).stale).toBe(false);
    t.clock.advance(60_000);
    const summary = savingsSummary(t);
    expect(summary.stale).toBe(true);
    expect(summary.accounts.every((a) => a.stale)).toBe(true);
  });

  it('marks a brokerage without Investments as having no flows, and leaves the cash account\'s', () => {
    const { t, item } = family();
    t.db.update(plaidItems).set({ investmentsStatus: 'unavailable', investmentsErrorCode: 'PRODUCTS_NOT_SUPPORTED' }).where(eq(plaidItems.id, item.id)).run();
    expect(savingsSummary(t).accounts.map((a) => [a.account.kind, a.account.flowsAvailable])).toEqual([['cash', true], ['investment', false]]);
  });

  it('says when a connection needs reconnecting, and how it\'s fixed', () => {
    const t = makeTestApp({ plaid: true });
    const admin = addUser(t.db, t.clock, { email: 'alex@example.com', role: 'admin' });
    const linked = linkSavingsForTest(t, admin);
    t.plaid!.markNeedsReconnect(linked.item.id, 'ITEM_LOGIN_REQUIRED');
    expect(savingsSummary(t).attention).toEqual([{ itemId: linked.item.id, institutionName: 'Example Brokerage', fix: 'reconnect' }]);
  });

  it('is empty before anything is linked', () => {
    const t = makeTestApp();
    expect(savingsSummary(t)).toEqual({
      serverNow: t.clock.now().toISOString(), month: '2026-11', accounts: [], totalCents: null, totalChangeCents: null, stale: false, attention: [],
      series: { points: [], rangeStart: '2026-10-15', startsOn: null, monthEnds: [], joins: [], flows: [] },
    });
  });
});

describe('savingsOverview', () => {
  it('breaks the current month down per account and in total, with the months that have data and the series', () => {
    const { t, cash, brokerage } = family();
    const overview = SavingsOverviewSchema.parse(savingsOverview(t, null));
    expect([overview.month, overview.current, overview.months]).toEqual(['2026-11', true, ['2026-11', '2026-10']]);
    expect(overview.accounts.map((a) => [a.account.id, a.breakdown.depositsCents, a.breakdown.withdrawalsCents, a.breakdown.changeCents, a.breakdown.totalChangeCents])).toEqual([
      [cash.id, 300_00, 90_00, -10_00, 200_00],
      [brokerage.id, 500_00, 0, 100_00, 600_00],
    ]);
    expect(overview.total).toMatchObject({ start: { cents: 6000_00 }, end: { cents: 6800_00 }, depositsCents: 800_00, withdrawalsCents: 90_00, changeCents: 90_00, totalChangeCents: 800_00 });
    expect(overview.series.startsOn).toBe('2026-10-31');
    expect(overview.series.points.at(-1)).toEqual({ date: '2026-11-15', cents: 6800_00 });
    expect(overview.series.monthEnds).toEqual([{ month: '2026-10', date: '2026-10-31', cents: 6000_00 }, { month: '2026-11', date: '2026-11-15', cents: 6800_00 }]);
    expect(overview.series.joins).toEqual([]);
    // An account linked later steps the total up on its first day: the series names it.
    const ira = addSavingsAccount(t, addSavingsItem(t, { plaidItemId: 'item-ira' }).id, { plaidAccountId: 'acct-ira', kind: 'investment', nickname: 'Roth IRA', mask: '2468' });
    snap(t, ira.id, '2026-11-12', 2000_00);
    expect(savingsOverview(t, null).series.joins).toEqual([{ date: '2026-11-12', nickname: 'Roth IRA' }]);
  });

  it('shows a past month, a removed account that had data then marked as such, and no hidden one', () => {
    const { t, cash, brokerage } = family();
    snap(t, cash.id, '2026-09-30', 900_00);
    t.db.update(savingsAccounts).set({ removedAt: t.clock.now() }).where(eq(savingsAccounts.id, brokerage.id)).run();
    const october = savingsOverview(t, '2026-10');
    expect(october).toMatchObject({ month: '2026-10', current: false, months: ['2026-11', '2026-10', '2026-09'] });
    expect(october.accounts.map((a) => [a.account.id, a.account.connectionRemoved, a.breakdown.totalChangeCents])).toEqual([
      // The brokerage's first snapshot is October's last day, so October is its first, partial month.
      [cash.id, false, 100_00], [brokerage.id, true, 0],
    ]);
    // Removed accounts aren't in the current views: the current month and the graph are the shown
    // accounts', so the drill-down's total matches the home card's.
    const november = savingsOverview(t, null);
    expect(november.accounts.map((a) => a.account.id)).toEqual([cash.id]);
    expect(november.total.end?.cents).toBe(1200_00);
    expect(november.total.end?.cents).toBe(savingsSummary(t).totalCents);
    expect(november.series.points.at(-1)).toEqual({ date: '2026-11-15', cents: 1200_00 });
    t.db.update(savingsAccounts).set({ hiddenAt: t.clock.now() }).where(eq(savingsAccounts.id, cash.id)).run();
    expect(savingsOverview(t, '2026-10').accounts.map((a) => a.account.id)).toEqual([brokerage.id]);
  });

  it('refuses a month that hasn\'t started', () => {
    const { t } = family();
    expect(() => savingsOverview(t, '2026-12')).toThrow(SAVINGS_MESSAGES.monthNotStarted);
  });

  it('refuses a month before the earliest one with data', () => {
    const { t } = family();
    expect(savingsOverview(t, '2026-10').month).toBe('2026-10');
    expect(() => savingsOverview(t, '2026-09')).toThrow(SAVINGS_MESSAGES.monthBeforeData);
    // Before anything is linked, only the current month.
    expect(() => savingsOverview(makeTestApp(), '2026-10')).toThrow(SAVINGS_MESSAGES.monthBeforeData);
  });

  it('takes the month from the family time zone, not UTC, near a month boundary', () => {
    const { t, cash, brokerage } = family();
    setFamilySettings(t.db, { name: 'The Family', timeZone: 'America/Los_Angeles' });
    // 2026-12-01 05:00 UTC is still November 30 in Los Angeles.
    t.clock.set(new Date('2026-12-01T05:00:00Z'));
    snap(t, cash.id, '2026-11-30', 1300_00);
    snap(t, brokerage.id, '2026-11-30', 5700_00);
    const summary = savingsSummary(t);
    expect(summary.month).toBe('2026-11');
    expect([summary.totalCents, summary.totalChangeCents]).toEqual([7000_00, 1000_00]);
    const overview = savingsOverview(t, null);
    expect([overview.month, overview.current, overview.months]).toEqual(['2026-11', true, ['2026-11', '2026-10']]);
    expect(overview.series.points.at(-1)).toEqual({ date: '2026-11-30', cents: 7000_00 });
    expect(() => savingsOverview(t, '2026-12')).toThrow(SAVINGS_MESSAGES.monthNotStarted);
    // An hour later than midnight there, December has started and holds at November's last snapshot.
    t.clock.set(new Date('2026-12-01T09:00:00Z'));
    expect(savingsSummary(t)).toMatchObject({ month: '2026-12', totalCents: 7000_00, totalChangeCents: 0 });
    expect(savingsOverview(t, null)).toMatchObject({ month: '2026-12', months: ['2026-12', '2026-11', '2026-10'] });
  });

  it('is the current month alone, with an empty graph, before anything is linked', () => {
    const t = makeTestApp();
    expect(savingsOverview(t, null)).toMatchObject({ months: ['2026-11'], accounts: [], series: { points: [], startsOn: null } });
  });
});

describe('hand-added accounts and imported history', () => {
  it('shows a hand-added cash account\'s imported months with their flows, and the graph from its first imported day', () => {
    const t = makeTestApp();
    const admin = addUser(t.db, t.clock, { email: 'alex@example.com', role: 'admin' });
    const hand = addHandAccount(t, { kind: 'cash', nickname: 'Hand cash' });
    addCsvImport(t, hand.id, admin, {
      balances: [{ date: '2026-09-20', cents: 1000_00 }, { date: '2026-10-31', cents: 1400_50 }],
      flows: [{ date: '2026-10-03', kind: 'deposit', cents: 500_00 }, { date: '2026-10-10', kind: 'withdrawal', cents: 100_00 }],
    });
    const october = SavingsOverviewSchema.parse(savingsOverview(t, '2026-10'));
    expect(october.accounts).toEqual([expect.objectContaining({
      account: expect.objectContaining({ nickname: 'Hand cash', source: 'manual', mask: null, flowsAvailable: true }),
      // 1400.50 − 1000 − 500 + 100
      breakdown: expect.objectContaining({ start: expect.objectContaining({ cents: 1000_00, date: '2026-09-20' }), end: expect.objectContaining({ cents: 1400_50, source: 'csv' }), depositsCents: 500_00, withdrawalsCents: 100_00, changeCents: 50 }),
    })]);
    const now = savingsOverview(t, null);
    expect(now.months).toEqual(['2026-11', '2026-10', '2026-09']);
    expect(now.series.startsOn).toBe('2026-09-20');
  });

  it('joins a hand-added brokerage from its first balance, and counts its flows once it has an import', () => {
    const { t } = family();
    const admin = addUser(t.db, t.clock, { email: 'alex@example.com', role: 'admin' });
    const hand = addHandAccount(t, { kind: 'investment', nickname: 'Hand brokerage' });
    putManualBalance(t.db, hand.id, '2026-11-10', 2000_00, t.clock.now());
    const before = savingsOverview(t, null);
    expect(before.series.joins).toEqual([{ date: '2026-11-10', nickname: 'Hand brokerage' }]);
    expect(before.accounts.find((a) => a.account.id === hand.id)).toMatchObject({ account: { flowsAvailable: false }, breakdown: { depositsCents: null, end: { source: 'manual' } } });
    addCsvImport(t, hand.id, admin, { flows: [{ date: '2026-11-12', kind: 'deposit', cents: 300_00 }] });
    expect(savingsOverview(t, null).accounts.find((a) => a.account.id === hand.id)).toMatchObject({ account: { flowsAvailable: true }, breakdown: { depositsCents: 300_00 } });
  });

  it('never calls a hand-added account stale, and says where its balance came from', () => {
    const { t } = family();
    const hand = addHandAccount(t, { kind: 'cash', nickname: 'Hand cash' });
    putManualBalance(t.db, hand.id, '2026-11-01', 50_00, new Date('2026-11-01T12:00:00Z'));
    const s = SavingsSummarySchema.parse(savingsSummary(t));
    expect(s.accounts.find((a) => a.account.id === hand.id)).toMatchObject({ account: { source: 'manual' }, balanceCents: 50_00, balanceDate: '2026-11-01', balanceSource: 'manual', stale: false });
    expect(s.stale).toBe(false);
    expect(s.accounts.find((a) => a.account.nickname === 'Cash')).toMatchObject({ account: { source: 'plaid' }, balanceSource: 'plaid' });
  });
});

describe('Batch C review: where a balance came from, and which months have flows', () => {
  it('times "Updated" and stale on a linked account from its newest Plaid balance, not a hand-set one', () => {
    const t = makeTestApp();
    const item = addSavingsItem(t);
    const cash = addSavingsAccount(t, item.id, { plaidAccountId: 'acct-cash', kind: 'cash', nickname: 'Cash', mask: '4321' });
    snap(t, cash.id, '2026-11-13', 900_00);
    putManualBalance(t.db, cash.id, '2026-11-15', 950_00, t.clock.now());
    const s = SavingsSummarySchema.parse(savingsSummary(t));
    expect(s.accounts[0]).toMatchObject({ balanceCents: 950_00, balanceDate: '2026-11-15', balanceSource: 'manual', asOf: at('2026-11-13').toISOString(), stale: true });
    expect(s.stale).toBe(true);
  });

  it('counts a hand-added account\'s flows only in months an import covers', () => {
    const t = makeTestApp();
    const admin = addUser(t.db, t.clock, { email: 'alex@example.com', role: 'admin' });
    const hand = addHandAccount(t, { kind: 'cash', nickname: 'Hand cash' });
    addCsvImport(t, hand.id, admin, {
      balances: [{ date: '2026-09-20', cents: 1000_00 }, { date: '2026-10-31', cents: 1400_50 }],
      flows: [{ date: '2026-10-03', kind: 'deposit', cents: 500_00 }],
    });
    putManualBalance(t.db, hand.id, '2026-11-10', 1500_00, t.clock.now());
    const november = savingsOverview(t, '2026-11');
    expect(november.accounts[0]).toMatchObject({ account: { flowsAvailable: false }, breakdown: { depositsCents: null, totalChangeCents: 99_50 } });
    expect(savingsOverview(t, '2026-10').accounts[0]).toMatchObject({ account: { flowsAvailable: true }, breakdown: { depositsCents: 500_00 } });
    expect(SavingsSummarySchema.parse(savingsSummary(t)).accounts[0]).toMatchObject({ account: { flowsAvailable: false } });
  });

  it('counts the months an import\'s file covers by its recorded days, not only the rows still stored', () => {
    const t = makeTestApp();
    const admin = addUser(t.db, t.clock, { email: 'alex@example.com', role: 'admin' });
    const hand = addHandAccount(t, { kind: 'cash', nickname: 'Hand cash' });
    addCsvImport(t, hand.id, admin, {
      balances: [{ date: '2026-09-20', cents: 1000_00 }, { date: '2026-10-31', cents: 1400_50 }],
      flows: [{ date: '2026-10-03', kind: 'deposit', cents: 500_00 }],
      firstDate: '2026-09-20', lastDate: '2026-11-02',
    });
    putManualBalance(t.db, hand.id, '2026-11-10', 1500_00, t.clock.now());
    // The file reached Nov 2 though nothing from November was stored: November's flows are known, and none.
    expect(savingsOverview(t, '2026-11').accounts[0]).toMatchObject({ account: { flowsAvailable: true }, breakdown: { depositsCents: 0, withdrawalsCents: 0 } });
    // An import from before 0014 (no recorded days) still counts by its stored rows.
    const old = addHandAccount(t, { kind: 'cash', nickname: 'Old import' });
    addCsvImport(t, old.id, admin, { flows: [{ date: '2026-10-03', kind: 'deposit', cents: 1_00 }], balances: [{ date: '2026-10-31', cents: 5_00 }] });
    const ofOld = (month: string) => savingsOverview(t, month).accounts.find((a) => a.account.id === old.id)!.account.flowsAvailable;
    expect([ofOld('2026-10'), ofOld('2026-11')]).toEqual([true, false]);
  });

  it('counts a linked brokerage\'s flows in months an import covers, even without Investments', () => {
    const t = makeTestApp();
    const admin = addUser(t.db, t.clock, { email: 'alex@example.com', role: 'admin' });
    const item = addSavingsItem(t, { investmentsStatus: 'unavailable', investmentsErrorCode: 'PRODUCTS_NOT_SUPPORTED' });
    const brokerage = addSavingsAccount(t, item.id, { plaidAccountId: 'acct-brokerage', kind: 'investment', nickname: 'Brokerage', mask: '8765' });
    snap(t, brokerage.id, '2026-09-30', 20_000_00);
    snap(t, brokerage.id, '2026-10-31', 21_500_00);
    snap(t, brokerage.id, '2026-11-14', 22_000_00);
    addCsvImport(t, brokerage.id, admin, {
      flows: [{ date: '2026-10-05', kind: 'deposit', cents: 1_000_00 }, { date: '2026-10-20', kind: 'withdrawal', cents: 200_00 }],
      firstDate: '2026-10-01', lastDate: '2026-10-31',
    });
    const of = (month: string) => savingsOverview(t, month).accounts.find((a) => a.account.id === brokerage.id)!;
    expect(of('2026-10')).toMatchObject({ account: { flowsAvailable: true }, breakdown: { depositsCents: 1_000_00, withdrawalsCents: 200_00, changeCents: 700_00 } });
    // November isn't covered: the no-Investments total change, as before.
    expect(of('2026-11')).toMatchObject({ account: { flowsAvailable: false }, breakdown: { depositsCents: null, totalChangeCents: 500_00 } });
  });

  it('leaves a hidden hand-added account out of the home card and the graph', () => {
    const { t } = family();
    const hand = addHandAccount(t, { kind: 'cash', nickname: 'Hidden hand', hiddenAt: t.clock.now() });
    putManualBalance(t.db, hand.id, '2026-11-10', 50_00, t.clock.now());
    expect(savingsSummary(t).accounts.map((a) => a.account.nickname)).toEqual(['Cash', 'Brokerage']);
    const o = savingsOverview(t, null);
    expect(o.accounts.map((a) => a.account.nickname)).toEqual(['Cash', 'Brokerage']);
    expect(o.series.joins).toEqual([]);
  });

  it('shows a removed hand-added account in a past month with its data, never the current one', () => {
    const { t } = family();
    const hand = addHandAccount(t, { kind: 'cash', nickname: 'Old hand', removedAt: t.clock.now() });
    putManualBalance(t.db, hand.id, '2026-10-20', 70_00, t.clock.now());
    expect(savingsOverview(t, '2026-10').accounts.map((a) => a.account.nickname)).toContain('Old hand');
    expect(savingsOverview(t, null).accounts.map((a) => a.account.nickname)).not.toContain('Old hand');
    expect(savingsSummary(t).accounts.map((a) => a.account.nickname)).not.toContain('Old hand');
  });

  it('says the total\'s end is mixed when the accounts\' ends came from different sources', () => {
    const { t } = family();
    expect(savingsOverview(t, null).total.end?.source).toBe('plaid');
    const hand = addHandAccount(t, { kind: 'cash', nickname: 'Hand cash' });
    putManualBalance(t.db, hand.id, '2026-11-15', 10_00, t.clock.now());
    expect(SavingsOverviewSchema.parse(savingsOverview(t, null)).total.end?.source).toBe('mixed');
  });
});

describe("the graphs' flows", () => {
  it("gives the home card the last month of the total, with each day's flows", () => {
    const { t } = family();
    const series = SavingsSummarySchema.parse(savingsSummary(t)).series;
    expect(series.rangeStart).toBe('2026-10-15');
    // The line starts at the first snapshot (Oct 31) and runs through today.
    expect(series.startsOn).toBe('2026-10-31');
    expect(series.points.at(-1)).toEqual({ date: '2026-11-15', cents: 6800_00 });
    expect(series.flows).toEqual([
      { date: '2026-11-03', depositCents: 300_00, withdrawalCents: 0 },
      { date: '2026-11-05', depositCents: 500_00, withdrawalCents: 0 },
      { date: '2026-11-10', depositCents: 0, withdrawalCents: 90_00 },
    ]);
  });

  it("leaves a transfer between two shown accounts out of both graphs, and a brokerage's flows out without Investments", () => {
    const { t, item, cash, brokerage } = family();
    flow(t, cash.id, '2026-11-12', 'withdrawal', 250_00);
    flow(t, brokerage.id, '2026-11-13', 'deposit', 250_00, 'investments');
    const dates = (s: { flows: { date: string }[] }) => s.flows.map((f) => f.date);
    expect(dates(savingsSummary(t).series)).toEqual(['2026-11-03', '2026-11-05', '2026-11-10']);
    expect(dates(SavingsOverviewSchema.parse(savingsOverview(t, null)).series)).toEqual(['2026-11-03', '2026-11-05', '2026-11-10']);
    // Without Investments the brokerage's deposit isn't known, so the cash withdrawal is money out.
    t.db.update(plaidItems).set({ investmentsStatus: 'unavailable', investmentsErrorCode: 'PRODUCTS_NOT_SUPPORTED' }).where(eq(plaidItems.id, item.id)).run();
    expect(savingsOverview(t, null).series.flows).toEqual([
      { date: '2026-11-03', depositCents: 300_00, withdrawalCents: 0 },
      { date: '2026-11-10', depositCents: 0, withdrawalCents: 90_00 },
      { date: '2026-11-12', depositCents: 0, withdrawalCents: 250_00 },
    ]);
  });

  it('pairs a transfer to a hidden account with nothing: money out of the shown total', () => {
    const { t, cash, brokerage } = family();
    flow(t, cash.id, '2026-11-12', 'withdrawal', 250_00);
    flow(t, brokerage.id, '2026-11-12', 'deposit', 250_00, 'investments');
    t.db.update(savingsAccounts).set({ hiddenAt: t.clock.now() }).where(eq(savingsAccounts.id, brokerage.id)).run();
    expect(savingsSummary(t).series.flows).toEqual([
      { date: '2026-11-03', depositCents: 300_00, withdrawalCents: 0 },
      { date: '2026-11-10', depositCents: 0, withdrawalCents: 90_00 },
      { date: '2026-11-12', depositCents: 0, withdrawalCents: 250_00 },
    ]);
  });
});
