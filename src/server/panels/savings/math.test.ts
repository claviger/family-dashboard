import { describe, expect, it } from 'vitest';
import { addMonths, balanceSeries, dailyFlows, monthBounds, monthBreakdown, sixMonthsBefore, sumBreakdowns, type FlowPoint, type Snapshot } from './math.js';

const at = (date: string) => new Date(`${date}T12:00:00Z`);
const snap = (date: string, cents: number): Snapshot => ({ date, cents, fetchedAt: at(date) });
const dep = (date: string, cents: number): FlowPoint => ({ date, kind: 'deposit', cents });
const wd = (date: string, cents: number): FlowPoint => ({ date, kind: 'withdrawal', cents });

describe('month helpers', () => {
  it('give a month\'s first and last day, step months, and go back six months clamped to the month', () => {
    expect(monthBounds('2026-02')).toEqual({ first: '2026-02-01', last: '2026-02-28' });
    expect(monthBounds('2028-02')).toEqual({ first: '2028-02-01', last: '2028-02-29' });
    expect(monthBounds('2026-12')).toEqual({ first: '2026-12-01', last: '2026-12-31' });
    expect(addMonths('2026-11', -1)).toBe('2026-10');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-11', 2)).toBe('2027-01');
    expect(sixMonthsBefore('2026-11-19')).toBe('2026-05-19');
    expect(sixMonthsBefore('2026-08-31')).toBe('2026-02-28');
    expect(sixMonthsBefore('2027-03-31')).toBe('2026-09-30');
    expect(sixMonthsBefore('2028-08-31')).toBe('2028-02-29');
  });
});

describe('monthBreakdown', () => {
  it('starts from the last snapshot of last month and splits the change into flows and market change', () => {
    const snaps = [snap('2026-10-30', 1000_00), snap('2026-10-31', 1010_00), snap('2026-11-10', 1200_00), snap('2026-11-19', 1250_00)];
    const flows = [dep('2026-10-31', 999_00), dep('2026-11-03', 300_00), wd('2026-11-12', 100_00), dep('2026-11-15', 25_00), dep('2026-12-01', 7_00)];
    expect(monthBreakdown(snaps, flows, '2026-11', { flowsAvailable: true, current: true })).toEqual({
      start: { cents: 1010_00, date: '2026-10-31', sinceFirstSnapshot: false },
      end: { cents: 1250_00, date: '2026-11-19', fetchedAt: at('2026-11-19').toISOString(), source: 'plaid' },
      depositsCents: 325_00,
      withdrawalsCents: 100_00,
      // 1250 − 1010 − 325 + 100
      changeCents: 15_00,
      totalChangeCents: 240_00,
    });
  });

  it('uses the last snapshot before the month even when days are missing at the month\'s end', () => {
    const snaps = [snap('2026-10-20', 500_00), snap('2026-11-05', 520_00)];
    expect(monthBreakdown(snaps, [], '2026-11', { flowsAvailable: true, current: true }).start).toEqual({ cents: 500_00, date: '2026-10-20', sinceFirstSnapshot: false });
    // October has a snapshot, so its late flows stay October's (Market change absorbs the gap there).
    expect(monthBreakdown(snaps, [dep('2026-10-25', 7_00)], '2026-11', { flowsAvailable: true, current: true }).depositsCents).toBe(0);
  });

  it("after a month with no snapshot, counts every flow since the start snapshot, so the gap month's flows aren't market change", () => {
    const snaps = [snap('2026-09-30', 1000_00), snap('2026-11-19', 1300_00)];
    const flows = [dep('2026-09-30', 1_00), dep('2026-10-10', 200_00), wd('2026-10-20', 10_00), dep('2026-11-05', 50_00)];
    expect(monthBreakdown(snaps, flows, '2026-11', { flowsAvailable: true, current: true })).toMatchObject({
      start: { cents: 1000_00, date: '2026-09-30', sinceFirstSnapshot: false },
      depositsCents: 250_00,
      withdrawalsCents: 10_00,
      // 1300 − 1000 − 250 + 10
      changeCents: 60_00,
      totalChangeCents: 300_00,
    });
  });

  it("in the current month before its first snapshot, holds at the last one before it and counts the month's flows", () => {
    // December 1, before the 05:30 job (or while the connection needs reconnecting).
    const snaps = [snap('2026-11-29', 100_00), snap('2026-11-30', 110_00)];
    const flows = [dep('2026-11-30', 5_00), dep('2026-12-01', 20_00)];
    expect(monthBreakdown(snaps, flows, '2026-12', { flowsAvailable: true, current: true })).toEqual({
      start: { cents: 110_00, date: '2026-11-30', sinceFirstSnapshot: false },
      end: { cents: 110_00, date: '2026-11-30', fetchedAt: at('2026-11-30').toISOString(), source: 'plaid' },
      depositsCents: 20_00,
      withdrawalsCents: 0,
      changeCents: -20_00,
      totalChangeCents: 0,
    });
    expect(monthBreakdown(snaps, flows, '2026-12', { flowsAvailable: false, current: true })).toMatchObject({ changeCents: null, totalChangeCents: 0 });
    // The same month viewed as a past month has no data.
    expect(monthBreakdown(snaps, flows, '2026-12', { flowsAvailable: true, current: false }).start).toBeNull();
  });

  it('starts the first month from the first snapshot and counts only flows after its day', () => {
    const snaps = [snap('2026-11-12', 2000_00), snap('2026-11-19', 2100_00)];
    const flows = [dep('2026-11-02', 50_00), dep('2026-11-12', 40_00), dep('2026-11-13', 60_00)];
    expect(monthBreakdown(snaps, flows, '2026-11', { flowsAvailable: true, current: true })).toMatchObject({
      start: { cents: 2000_00, date: '2026-11-12', sinceFirstSnapshot: true },
      depositsCents: 60_00,
      withdrawalsCents: 0,
      changeCents: 40_00,
      totalChangeCents: 100_00,
    });
  });

  it('with a single snapshot so far, has no change', () => {
    expect(monthBreakdown([snap('2026-11-19', 10_00)], [], '2026-11', { flowsAvailable: true, current: true })).toMatchObject({
      start: { cents: 10_00, sinceFirstSnapshot: true }, end: { cents: 10_00 }, changeCents: 0, totalChangeCents: 0,
    });
  });

  it('without flows, gives only the total change', () => {
    const b = monthBreakdown([snap('2026-10-31', 100_00), snap('2026-11-19', 130_00)], [dep('2026-11-03', 5_00)], '2026-11', { flowsAvailable: false, current: true });
    expect(b).toMatchObject({ depositsCents: null, withdrawalsCents: null, changeCents: null, totalChangeCents: 30_00 });
  });

  it('for a past month, ends at its last snapshot', () => {
    const snaps = [snap('2026-09-30', 1_00), snap('2026-10-15', 2_00), snap('2026-10-31', 3_00), snap('2026-11-19', 9_00)];
    expect(monthBreakdown(snaps, [], '2026-10', { flowsAvailable: true, current: false })).toMatchObject({
      start: { cents: 1_00, date: '2026-09-30' }, end: { cents: 3_00, date: '2026-10-31' }, totalChangeCents: 2_00,
    });
  });

  it('is empty for a month with no snapshot', () => {
    const empty = { start: null, end: null, depositsCents: null, withdrawalsCents: null, changeCents: null, totalChangeCents: null };
    expect(monthBreakdown([snap('2026-11-19', 1_00)], [dep('2026-10-02', 1_00)], '2026-10', { flowsAvailable: true, current: false })).toEqual(empty);
    // A past month with snapshots only before it stays empty.
    expect(monthBreakdown([snap('2026-09-30', 1_00)], [dep('2026-10-02', 1_00)], '2026-10', { flowsAvailable: true, current: false })).toEqual(empty);
    expect(monthBreakdown([], [], '2026-11', { flowsAvailable: true, current: true })).toEqual(empty);
  });
});

describe('sumBreakdowns', () => {
  it('adds start, end and total change, and flows only when every account has them', () => {
    const a = monthBreakdown([snap('2026-10-31', 100_00), snap('2026-11-19', 150_00)], [dep('2026-11-02', 20_00)], '2026-11', { flowsAvailable: true, current: true });
    const b = monthBreakdown([snap('2026-10-31', 1000_00), snap('2026-11-18', 990_00)], [wd('2026-11-04', 30_00)], '2026-11', { flowsAvailable: true, current: true });
    const c = monthBreakdown([snap('2026-10-31', 10_00), snap('2026-11-19', 12_00)], [], '2026-11', { flowsAvailable: false, current: true });
    expect(sumBreakdowns([a, b])).toEqual({
      start: { cents: 1100_00, date: '2026-10-31', sinceFirstSnapshot: false },
      end: { cents: 1140_00, date: '2026-11-19', fetchedAt: at('2026-11-18').toISOString(), source: 'plaid' },
      depositsCents: 20_00, withdrawalsCents: 30_00, changeCents: 50_00, totalChangeCents: 40_00,
    });
    expect(sumBreakdowns([a, c])).toMatchObject({ depositsCents: null, withdrawalsCents: null, changeCents: null, totalChangeCents: 52_00 });
    // An account without data that month adds nothing.
    expect(sumBreakdowns([a, monthBreakdown([], [], '2026-11', { flowsAvailable: true, current: true })])).toEqual(a);
    expect(sumBreakdowns([]).start).toBeNull();
  });

  it('says "since" the latest first snapshot when any account started this month', () => {
    const cash = monthBreakdown([snap('2026-10-31', 100_00), snap('2026-11-19', 150_00)], [], '2026-11', { flowsAvailable: true, current: true });
    const brokerage = monthBreakdown([snap('2026-11-12', 1000_00), snap('2026-11-18', 1010_00)], [], '2026-11', { flowsAvailable: true, current: true });
    const other = monthBreakdown([snap('2026-11-05', 10_00), snap('2026-11-19', 10_00)], [], '2026-11', { flowsAvailable: true, current: true });
    expect(sumBreakdowns([cash, brokerage, other]).start).toEqual({ cents: 1110_00, date: '2026-11-12', sinceFirstSnapshot: true });
    expect(sumBreakdowns([cash, other]).start).toEqual({ cents: 110_00, date: '2026-11-05', sinceFirstSnapshot: true });
    expect(sumBreakdowns([cash]).start).toEqual({ cents: 100_00, date: '2026-10-31', sinceFirstSnapshot: false });
  });
});

describe('balanceSeries', () => {
  it('adds accounts day by day, carrying each one\'s last balance forward, never before its first snapshot', () => {
    const cash = [snap('2026-11-16', 100_00), snap('2026-11-18', 120_00)];
    const brokerage = [snap('2026-11-17', 1000_00), snap('2026-11-19', 1100_00)];
    const series = balanceSeries([cash, brokerage], '2026-11-19');
    expect(series.rangeStart).toBe('2026-05-19');
    expect(series.startsOn).toBe('2026-11-16');
    expect(series.points).toEqual([
      { date: '2026-11-16', cents: 100_00 },
      { date: '2026-11-17', cents: 1100_00 },
      { date: '2026-11-18', cents: 1120_00 },
      { date: '2026-11-19', cents: 1220_00 },
    ]);
    expect(series.monthEnds).toEqual([{ month: '2026-11', date: '2026-11-19', cents: 1220_00 }]);
  });

  it('starts at the range\'s first day once it has six months, and lists each month\'s end', () => {
    const snaps = [snap('2026-04-30', 10_00), snap('2026-06-15', 20_00), snap('2026-09-01', 30_00)];
    const series = balanceSeries([snaps], '2026-11-19');
    expect(series.startsOn).toBe('2026-05-19');
    expect(series.points[0]).toEqual({ date: '2026-05-19', cents: 10_00 });
    expect(series.points).toHaveLength(185);
    expect(series.points.at(-1)).toEqual({ date: '2026-11-19', cents: 30_00 });
    expect(series.monthEnds.map((m) => [m.month, m.date, m.cents])).toEqual([
      ['2026-05', '2026-05-31', 10_00], ['2026-06', '2026-06-30', 20_00], ['2026-07', '2026-07-31', 20_00],
      ['2026-08', '2026-08-31', 20_00], ['2026-09', '2026-09-30', 30_00], ['2026-10', '2026-10-31', 30_00], ['2026-11', '2026-11-19', 30_00],
    ]);
  });

  it('totals only the accounts it is given, so a hidden or removed one the caller leaves out moves neither the line nor its start', () => {
    const cash = [snap('2026-11-16', 100_00), snap('2026-11-18', 120_00)];
    const hidden = [snap('2026-11-01', 5000_00), snap('2026-11-19', 5100_00)];
    const series = balanceSeries([cash], '2026-11-19');
    expect(series.startsOn).toBe('2026-11-16');
    expect(series.points.map((p) => p.cents)).toEqual([100_00, 100_00, 120_00, 120_00]);
    expect(balanceSeries([cash, hidden], '2026-11-19').startsOn).toBe('2026-11-01');
  });

  it('names each account whose first snapshot comes after the line starts, where the total steps up', () => {
    const cash = [snap('2026-11-16', 100_00), snap('2026-11-18', 120_00)];
    const brokerage = [snap('2026-11-17', 1000_00), snap('2026-11-19', 1100_00)];
    const ira = [snap('2026-11-19', 500_00)];
    expect(balanceSeries([cash, brokerage, ira], '2026-11-19', ['Cash', 'Brokerage', 'IRA']).joins).toEqual([
      { date: '2026-11-17', nickname: 'Brokerage' },
      { date: '2026-11-19', nickname: 'IRA' },
    ]);
    // One that started before the six months, or the account that starts the line, isn't a step.
    const old = [snap('2026-04-30', 10_00)];
    expect(balanceSeries([old, ira], '2026-11-19', ['Old', 'IRA']).joins).toEqual([{ date: '2026-11-19', nickname: 'IRA' }]);
    expect(balanceSeries([cash], '2026-11-19', ['Cash']).joins).toEqual([]);
    // A snapshot after today doesn't count yet.
    expect(balanceSeries([cash, [snap('2026-11-20', 1_00)]], '2026-11-19', ['Cash', 'Later']).joins).toEqual([]);
  });

  it('is empty with no snapshots, or only snapshots after today', () => {
    expect(balanceSeries([], '2026-11-19')).toEqual({ points: [], rangeStart: '2026-05-19', startsOn: null, monthEnds: [], joins: [], flows: [] });
    expect(balanceSeries([[snap('2026-11-20', 1_00)]], '2026-11-19').points).toEqual([]);
  });
});

describe("where a month\'s end came from", () => {
  it("is the end snapshot\'s source, and mixed for a total of different ones", () => {
    const csvSnap = { ...snap('2026-11-10', 5_00), source: 'csv' as const };
    const a = monthBreakdown([snap('2026-10-31', 1_00), snap('2026-11-15', 2_00)], [], '2026-11', { flowsAvailable: true, current: true });
    const b = monthBreakdown([snap('2026-10-31', 1_00), csvSnap], [], '2026-11', { flowsAvailable: true, current: true });
    expect(a.end?.source).toBe('plaid');
    expect(b.end?.source).toBe('csv');
    expect(sumBreakdowns([a, a]).end?.source).toBe('plaid');
    expect(sumBreakdowns([a, b]).end?.source).toBe('mixed');
  });
});

describe('dailyFlows', () => {
  const always = () => true;
  const acct = (flows: FlowPoint[], known: (month: string) => boolean = always, after: string | null = null) => ({ flows, known, after });

  it("totals each day's deposits and withdrawals across accounts, only days with a flow, oldest first", () => {
    const a = acct([dep('2026-11-03', 300_00), wd('2026-11-03', 20_00), dep('2026-11-10', 5_00)]);
    const b = acct([dep('2026-11-03', 1_00), wd('2026-11-12', 7_50)]);
    expect(dailyFlows([a, b], '2026-11-01', '2026-11-19')).toEqual([
      { date: '2026-11-03', depositCents: 301_00, withdrawalCents: 20_00 },
      { date: '2026-11-10', depositCents: 5_00, withdrawalCents: 0 },
      { date: '2026-11-12', depositCents: 0, withdrawalCents: 7_50 },
    ]);
  });

  it("keeps only the window's days", () => {
    const a = acct([dep('2026-10-31', 1_00), dep('2026-11-01', 2_00), dep('2026-11-19', 3_00), dep('2026-11-20', 4_00)]);
    expect(dailyFlows([a], '2026-11-01', '2026-11-19').map((f) => f.date)).toEqual(['2026-11-01', '2026-11-19']);
  });

  it('leaves out a transfer between two of the accounts: the same amount out of one and into another within two days', () => {
    const checking = acct([wd('2026-11-05', 500_00), wd('2026-11-09', 80_00)]);
    const brokerage = acct([dep('2026-11-07', 500_00), dep('2026-11-09', 81_00)]);
    // 500 out on the 5th and in on the 7th pair; 80 out and 81 in don't match.
    expect(dailyFlows([checking, brokerage], '2026-11-01', '2026-11-19')).toEqual([
      { date: '2026-11-09', depositCents: 81_00, withdrawalCents: 80_00 },
    ]);
    // Three days apart isn't a transfer.
    expect(dailyFlows([acct([wd('2026-11-05', 500_00)]), acct([dep('2026-11-08', 500_00)])], '2026-11-01', '2026-11-19')).toHaveLength(2);
  });

  it('never pairs an account with itself', () => {
    const a = acct([wd('2026-11-05', 50_00), dep('2026-11-05', 50_00)]);
    expect(dailyFlows([a], '2026-11-01', '2026-11-19')).toEqual([{ date: '2026-11-05', depositCents: 50_00, withdrawalCents: 50_00 }]);
  });

  it('pairs one to one, the nearest dates first', () => {
    const out = acct([wd('2026-11-05', 100_00)]);
    // Two deposits of the same amount: the one a day later pairs, the one two days earlier stays.
    const into = acct([dep('2026-11-03', 100_00), dep('2026-11-06', 100_00)]);
    expect(dailyFlows([out, into], '2026-11-01', '2026-11-19')).toEqual([{ date: '2026-11-03', depositCents: 100_00, withdrawalCents: 0 }]);
    // Two withdrawals, one deposit: one withdrawal stays.
    const twoOut = acct([wd('2026-11-05', 100_00), wd('2026-11-06', 100_00)]);
    expect(dailyFlows([twoOut, acct([dep('2026-11-06', 100_00)])], '2026-11-01', '2026-11-19')).toEqual([
      { date: '2026-11-05', depositCents: 0, withdrawalCents: 100_00 },
    ]);
  });

  it("pairs across the window's edge, so half a transfer just inside it isn't drawn", () => {
    const a = acct([wd('2026-10-31', 40_00)]);
    const b = acct([dep('2026-11-01', 40_00)]);
    expect(dailyFlows([a, b], '2026-11-01', '2026-11-19')).toEqual([]);
  });

  it("counts only the months whose flows are known, and only after the account's first balance", () => {
    const noOctober = acct([dep('2026-10-20', 9_00), dep('2026-11-02', 1_00)], (m) => m !== '2026-10');
    expect(dailyFlows([noOctober], '2026-10-01', '2026-11-19')).toEqual([{ date: '2026-11-02', depositCents: 1_00, withdrawalCents: 0 }]);
    const joined = acct([dep('2026-11-02', 1_00), dep('2026-11-03', 2_00)], always, '2026-11-02');
    expect(dailyFlows([joined], '2026-11-01', '2026-11-19').map((f) => f.date)).toEqual(['2026-11-03']);
    // An unknown flow pairs with nothing: the known side of the transfer shows.
    const unknown = acct([dep('2026-11-05', 60_00)], () => false);
    expect(dailyFlows([acct([wd('2026-11-05', 60_00)]), unknown], '2026-11-01', '2026-11-19')).toEqual([
      { date: '2026-11-05', depositCents: 0, withdrawalCents: 60_00 },
    ]);
  });
});

describe('balanceSeries flows and window', () => {
  it("carries the accounts' flows from the line's first day through today", () => {
    const cash = [snap('2026-11-10', 100_00), snap('2026-11-19', 200_00)];
    const flows = [{ flows: [dep('2026-11-01', 5_00), dep('2026-11-12', 100_00)], known: () => true, after: '2026-11-10' }];
    const series = balanceSeries([cash], '2026-11-19', ['Cash'], { flows });
    expect(series.flows).toEqual([{ date: '2026-11-12', depositCents: 100_00, withdrawalCents: 0 }]);
    expect(balanceSeries([cash], '2026-11-19').flows).toEqual([]);
  });

  it('takes a window in months: one month back from today, the same carry-forward and joins', () => {
    const cash = [snap('2026-09-01', 10_00), snap('2026-10-25', 20_00)];
    const ira = [snap('2026-11-05', 500_00)];
    const series = balanceSeries([cash, ira], '2026-11-19', ['Cash', 'IRA'], { months: 1 });
    expect(series.rangeStart).toBe('2026-10-19');
    expect(series.startsOn).toBe('2026-10-19');
    expect(series.points).toHaveLength(32);
    expect(series.points[0]).toEqual({ date: '2026-10-19', cents: 10_00 });
    expect(series.points.at(-1)).toEqual({ date: '2026-11-19', cents: 520_00 });
    expect(series.joins).toEqual([{ date: '2026-11-05', nickname: 'IRA' }]);
    expect(series.monthEnds.map((m) => m.month)).toEqual(['2026-10', '2026-11']);
    // Clamped to the shorter month.
    expect(balanceSeries([cash], '2027-03-31', [], { months: 1 }).rangeStart).toBe('2027-02-28');
  });
});
