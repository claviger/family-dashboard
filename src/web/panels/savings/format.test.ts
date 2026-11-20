import { describe, expect, it } from 'vitest';
import { SAVINGS_MESSAGES, type MonthBreakdown } from '../../../shared/savings.js';
import {
  accountLabel, asOfLine, axisLabels, cardGraphLine, flowDayLine, flowsSummaryLine, flowTotals, changeLabel, choiceWords, columnName, endLine, groupLine, groupName, handBalanceLine, heldLine, importAddsLine, importRecordLine,
  importSkippedLine, importStep, joinsLine, mixedStartLine, monthLabel, noFlowsNote, prefilledLine, profileLine, shortMonth, signedMoney, startLine, summaryBalanceLine,
  undoWarning, updatedAsOf, importNames,
} from './format.js';

describe('Savings text', () => {
  it('signs a change, with a real minus sign, and none on zero', () => {
    expect(signedMoney(12_34)).toBe('+$12.34');
    expect(signedMoney(-1234_56)).toBe('−$1,234.56');
    expect(signedMoney(0)).toBe('$0.00');
  });

  it('names months, accounts, and the change line by kind', () => {
    expect(monthLabel('2026-11')).toBe('November 2026');
    expect(shortMonth('2026-02')).toBe('Feb');
    expect(accountLabel({ nickname: 'Cash', mask: '4321' })).toBe('Cash ·4321');
    expect(accountLabel({ nickname: 'Brokerage', mask: null })).toBe('Brokerage');
    expect(changeLabel('investment')).toBe('Market change');
    expect(changeLabel('cash')).toBe('Other change');
  });

  it("says where the month starts: last month's end, or the first snapshot", () => {
    const start = (s: MonthBreakdown['start']) => startLine(s, '2026-11');
    expect(start({ cents: 1, date: '2026-10-31', sinceFirstSnapshot: false })).toBe('Start (end of October)');
    expect(start({ cents: 1, date: '2026-11-12', sinceFirstSnapshot: true })).toBe('Since Nov 12');
    expect(start(null)).toBe('Start');
    // January's start is the end of the previous December.
    expect(startLine({ cents: 1, date: '2025-12-31', sinceFirstSnapshot: false }, '2026-01')).toBe('Start (end of December)');
  });

  it('says when "now" was fetched, in the family time zone', () => {
    expect(asOfLine('2026-11-15T14:05:00Z', 'America/Los_Angeles')).toBe('As of Nov 15, 6:05 AM');
  });

  it("says when the current month is still holding last month's balance", () => {
    expect(heldLine({ date: '2026-10-31' }, '2026-11')).toBe('No balance read in November yet');
    expect(heldLine({ date: '2026-11-01' }, '2026-11')).toBeNull();
    expect(heldLine(null, '2026-11')).toBeNull();
  });

  it('says why the total steps up where an account was added', () => {
    expect(joinsLine([])).toBeNull();
    expect(joinsLine([{ date: '2026-11-19', nickname: 'Roth IRA' }])).toBe('Roth IRA was added on Nov 19, so the total steps up there.');
    expect(joinsLine([{ date: '2026-09-02', nickname: 'Cash' }, { date: '2026-11-19', nickname: 'Roth IRA' }])).toBe(
      'Cash was added on Sep 2 and Roth IRA on Nov 19, so the total steps up on those days.',
    );
    expect(joinsLine([{ date: '2026-08-01', nickname: 'A' }, { date: '2026-09-02', nickname: 'B' }, { date: '2026-11-19', nickname: 'C' }])).toBe(
      'A was added on Aug 1, B on Sep 2 and C on Nov 19, so the total steps up on those days.',
    );
  });

  it("says when the total's start mixes last month's end with accounts that started this month", () => {
    const end = (name: string) => ({ name, start: { cents: 1, date: '2026-10-31', sinceFirstSnapshot: false } });
    const since = (name: string, date: string) => ({ name, start: { cents: 1, date, sinceFirstSnapshot: true } });
    expect(mixedStartLine([end('Cash'), since('Roth IRA', '2026-11-19')])).toBe('Mixed: Roth IRA since Nov 19, the rest from the end of last month');
    expect(mixedStartLine([end('Cash'), since('A', '2026-11-03'), since('B', '2026-11-19')])).toBe('Mixed: A since Nov 3 and B since Nov 19, the rest from the end of last month');
    // All from last month's end, or all since this month: not mixed.
    expect(mixedStartLine([end('Cash'), end('Brokerage')])).toBeNull();
    expect(mixedStartLine([since('A', '2026-11-03'), since('B', '2026-11-19')])).toBeNull();
    expect(mixedStartLine([end('Cash'), { name: 'Empty', start: null }])).toBeNull();
  });

  it('writes axis ticks in full under $10,000 and compact from there, one style per axis', () => {
    expect(axisLabels([6_000_00, 6_200_00, 6_400_00])).toEqual(['$6,000', '$6,200', '$6,400']);
    expect(axisLabels([0, 5_000_00, 10_000_00])).toEqual(['$0', '$5K', '$10K']);
    expect(axisLabels([60_000_00, 62_500_00])).toEqual(['$60K', '$62.5K']);
    expect(axisLabels([1_000_000_00, 1_250_000_00])).toEqual(['$1M', '$1.25M']);
    expect(axisLabels([900_000_00, 1_000_000_00])).toEqual(['$900K', '$1M']);
  });
});

describe('imports and where balances came from', () => {
  it("says where a month's end came from", () => {
    expect(endLine({ date: '2026-11-15', fetchedAt: '2026-11-15T14:05:00Z', source: 'plaid' }, 'America/Los_Angeles')).toBe('As of Nov 15, 6:05 AM');
    expect(endLine({ date: '2026-10-31', fetchedAt: '2026-11-15T14:05:00Z', source: 'csv' }, 'UTC')).toBe('Imported balance for Oct 31');
    expect(endLine({ date: '2026-11-12', fetchedAt: '2026-11-15T14:05:00Z', source: 'manual' }, 'UTC')).toBe('Set by hand for Nov 12');
    expect(endLine({ date: '2026-11-12', fetchedAt: '2026-11-15T14:05:00Z', source: 'mixed' }, 'UTC')).toBe('Some balances imported or set by hand, the latest for Nov 12');
    expect(handBalanceLine(null)).toBe('No balance yet');
    expect(handBalanceLine({ date: '2026-11-12', source: 'csv' })).toBe('Imported balance for Nov 12');
    expect(handBalanceLine({ date: '2026-11-12', source: 'manual' })).toBe('Set by hand for Nov 12');
    expect(handBalanceLine({ date: '2026-11-12', source: 'plaid' })).toBe('Balance for Nov 12');
  });

  it("gives the home card a balance's source only when it isn't Plaid's", () => {
    expect(summaryBalanceLine({ balanceDate: '2026-11-12', balanceSource: 'csv' })).toBe('Imported balance for Nov 12');
    expect(summaryBalanceLine({ balanceDate: '2026-11-12', balanceSource: 'manual' })).toBe('Set by hand for Nov 12');
    expect(summaryBalanceLine({ balanceDate: '2026-11-12', balanceSource: 'plaid' })).toBeNull();
    expect(summaryBalanceLine({ balanceDate: null, balanceSource: null })).toBeNull();
  });

  it('names columns and groups, and words the results', () => {
    expect(columnName(['Date', ''], 1)).toBe('Column 2');
    expect(columnName(['Date', ''], 0)).toBe('Date');
    expect(groupName('YOU SOLD')).toBe('YOU SOLD …');
    expect(groupName('')).toBe('No description');
    expect(choiceWords('by_sign')).toBe('by sign');
    expect(groupLine({ label: 'YOU SOLD', count: 12, choice: 'not_counted' })).toBe('YOU SOLD … (12): not counted');
    const p = { deposits: { add: 2, already: 0 }, withdrawals: { add: 1, already: 3 }, balances: { add: 7, skipped: 1 } };
    expect(importAddsLine(p)).toBe('Adds 2 deposits, 1 withdrawal, and 7 daily balances.');
    expect(importAddsLine({ deposits: { add: 0, already: 0 }, withdrawals: { add: 0, already: 0 }, balances: { add: 0, skipped: 0 } })).toBe('Nothing new to add.');
    expect(importSkippedLine(p)).toBe("Skipped, since they're already here or Plaid has them: 3 withdrawals and 1 daily balance.");
    expect(importSkippedLine({ deposits: { add: 1, already: 0 }, withdrawals: { add: 0, already: 0 }, balances: { add: 0, skipped: 0 } })).toBeNull();
    expect(importRecordLine({ fileName: 'statement.csv', uploadedAt: '2026-11-15T14:05:00Z', uploadedBy: 'Alex', flowsLeft: 7, balancesLeft: 7 }, 'UTC'))
      .toBe('statement.csv, Nov 15, by Alex: 7 deposits and withdrawals and 7 daily balances');
    expect(importRecordLine({ fileName: null, uploadedAt: '2026-11-15T14:05:00Z', uploadedBy: null, flowsLeft: 0, balancesLeft: 0 }, 'UTC')).toBe('A file, Nov 15: nothing left');
    expect(profileLine({ format: 'fidelity_cash', groups: [{ label: 'A', choice: 'by_sign' }] })).toBe('Saved import settings: Fidelity cash management, 1 group');
    expect(profileLine({ format: 'custom', groups: [] })).toBe('Saved import settings: your own columns, 0 groups');
  });

  it('names an import by its file and upload day, so two of the same file stay apart', () => {
    const r = (id: number, fileName: string | null, uploadedAt: string) => ({ id, fileName, uploadedAt });
    // Alone on its day: the day is enough.
    expect(importNames([r(1, 'statement.csv', '2026-11-15T14:05:00Z'), r(2, null, '2026-11-16T01:05:00Z')], 'America/Los_Angeles'))
      .toEqual(new Map([[1, 'statement.csv, Nov 15'], [2, 'the file, Nov 15']]));
    // The same file twice that day: the time too.
    expect(importNames([r(3, 'a.csv', '2026-11-19T23:05:00Z'), r(4, 'a.csv', '2026-11-19T15:30:00Z'), r(5, 'b.csv', '2026-11-19T15:30:00Z')], 'UTC'))
      .toEqual(new Map([[3, 'a.csv, Nov 19, 11:05 PM'], [4, 'a.csv, Nov 19, 3:30 PM'], [5, 'b.csv, Nov 19']]));
    // The same minute too: numbered, newest first as listed, so every name is still its own.
    const same = importNames([r(6, 'a.csv', '2026-11-19T15:30:10Z'), r(7, 'a.csv', '2026-11-19T15:30:40Z')], 'UTC');
    expect(same).toEqual(new Map([[6, 'a.csv, Nov 19, 3:30 PM (1)'], [7, 'a.csv, Nov 19, 3:30 PM (2)']]));
  });

  it('warns before Undo only when a later import skipped rows as already here', () => {
    expect(undoWarning({ overlaps: 0 })).toBeNull();
    expect(undoWarning({ overlaps: 2 })).toBe(SAVINGS_MESSAGES.importUndoOverlaps);
  });

  it('says where the first answer filled the steps in from', () => {
    const d = { prefilled: 'guess', format: 'custom', suggested: null, problem: null } as const;
    expect(prefilledLine({ ...d, prefilled: 'profile' })).toBe("Filled in from this account's saved import settings. Check them before importing.");
    expect(prefilledLine({ ...d, prefilled: 'builtin', format: 'fidelity_brokerage' })).toBe('This looks like a Fidelity brokerage file, so the columns and groups are filled in. Check them before importing.');
    expect(prefilledLine({ ...d, suggested: {} as never })).toBe('The columns are a guess from their names. Check each one.');
    expect(prefilledLine(d)).toBeNull();
    // A saved or built-in mapping that doesn't fit says why instead.
    expect(prefilledLine({ ...d, prefilled: 'profile', suggested: {} as never, problem: 'Line 5.' })).toBeNull();
  });

  it('opens the import at the first step that needs the admin', () => {
    const base = { mapping: null, groups: null, results: null };
    expect(importStep(base)).toBe('map');
    expect(importStep({ ...base, mapping: {} as never, groups: [] })).toBe('groups');
    expect(importStep({ ...base, mapping: {} as never, groups: [], results: {} as never })).toBe('results');
  });
});

describe('the flows note and "Updated" (Batch C review)', () => {
  it('says why there are no deposits and withdrawals: a linked account without them, or a month no import covers', () => {
    expect(noFlowsNote({ source: 'plaid', flowsAvailable: false })).toBe(SAVINGS_MESSAGES.noFlows);
    expect(noFlowsNote({ source: 'manual', flowsAvailable: false })).toBe(SAVINGS_MESSAGES.noImportForMonth);
    expect(noFlowsNote({ source: 'manual', flowsAvailable: true })).toBeNull();
  });

  it('takes "Updated" from the oldest Plaid read among linked accounts only', () => {
    const a = (source: 'plaid' | 'manual', asOf: string | null) => ({ account: { source }, asOf });
    expect(updatedAsOf([a('plaid', '2026-11-13T06:00:00.000Z'), a('plaid', '2026-11-15T06:00:00.000Z'), a('manual', '2026-11-01T06:00:00.000Z')])).toBe('2026-11-13T06:00:00.000Z');
    expect(updatedAsOf([a('manual', '2026-11-01T06:00:00.000Z'), a('plaid', null)])).toBeNull();
  });
});

describe('flow line text', () => {
  const flows = [
    { date: '2026-11-03', depositCents: 3_000_00, withdrawalCents: 0 },
    { date: '2026-11-05', depositCents: 10_00, withdrawalCents: 45_50 },
    { date: '2026-11-09', depositCents: 0, withdrawalCents: 1_00 },
  ];

  it('reads a day’s deposits and withdrawals, only the parts it has', () => {
    expect(flowDayLine(flows[0])).toBe('Deposits $3,000.00');
    expect(flowDayLine(flows[1])).toBe('Deposits $10.00 · Withdrawals $45.50');
    expect(flowDayLine(flows[2])).toBe('Withdrawals $1.00');
    expect(flowDayLine(undefined)).toBeNull();
  });

  it('totals the window and says it for screen readers', () => {
    expect(flowTotals(flows)).toEqual({ depositCents: 3_010_00, withdrawalCents: 46_50, depositDays: 2, withdrawalDays: 2 });
    expect(flowsSummaryLine(flows)).toBe('Flow lines: deposits $3,010.00 on 2 days, withdrawals $46.50 on 2 days, not counting transfers between your accounts.');
    expect(flowsSummaryLine([flows[0]!])).toBe('Flow lines: deposits $3,000.00 on 1 day, no withdrawals, not counting transfers between your accounts.');
    expect(flowsSummaryLine([])).toBeNull();
  });

  it('describes the home card graph', () => {
    const points = [{ cents: 6_000_00 }, { cents: 6_100_00 }, { cents: 9_012_34 }];
    expect(cardGraphLine(points, flows)).toBe('Last month: from $6,000.00 to $9,012.34; deposits $3,010.00, withdrawals $46.50.');
    expect(cardGraphLine(points, [])).toBe('Last month: from $6,000.00 to $9,012.34.');
  });
});
