import { describe, expect, it } from 'vitest';
import { clampedDate, cycleContaining, INFERRED_MIN_GAP_DAYS, planCycles, previousCycle, type CycleInput } from './cycles.js';

function plan(patch: Partial<CycleInput>) {
  return planCycles({ usualClosingDay: 15, known: [], earliestDate: '2026-09-01', latestDate: null, today: '2026-11-16', ...patch });
}
const ranges = (p: ReturnType<typeof planCycles>) => p.cycles.map((c) => `${c.start}..${c.end}${c.current ? ' current' : ''}`);
const closings = (p: ReturnType<typeof planCycles>) => p.closings.map((c) => `${c.date} ${c.source}`);

describe('planCycles input', () => {
  it("needs the latest transaction date, so a caller can't leave it out by mistake", () => {
    // @ts-expect-error latestDate is required: null when the card has no transactions.
    expect(planCycles({ usualClosingDay: 15, known: [], earliestDate: null, today: '2026-11-16' }).mode).toBe('cycles');
  });
});

describe('clampedDate', () => {
  it('clamps the day to the length of the month', () => {
    expect(clampedDate(2026, 2, 31)).toBe('2026-02-28');
    expect(clampedDate(2028, 2, 31)).toBe('2028-02-29');
    expect(clampedDate(2026, 2, 29)).toBe('2026-02-28');
    expect(clampedDate(2026, 4, 31)).toBe('2026-04-30');
    expect(clampedDate(2026, 12, 31)).toBe('2026-12-31');
    expect(clampedDate(2026, 1, 1)).toBe('2026-01-01');
  });
});

describe('planCycles: inferred from the usual closing day', () => {
  it('runs each cycle from the day after one closing date through the next, back to the earliest transaction', () => {
    const p = plan({});
    expect(p.mode).toBe('cycles');
    expect(ranges(p)).toEqual(['2026-11-16..2026-12-15 current', '2026-10-16..2026-11-15', '2026-09-16..2026-10-15', '2026-08-16..2026-09-15']);
    expect(p.cycles[0]!.closing).toEqual({ date: '2026-12-15', source: 'inferred' });
  });

  it('makes the cycle that ends today the current one', () => {
    expect(ranges(plan({ today: '2026-11-15', earliestDate: '2026-11-01' }))).toEqual(['2026-10-16..2026-11-15 current']);
  });

  it('clamps the 31st to short months, February in leap years included', () => {
    const p = plan({ usualClosingDay: 31, earliestDate: '2028-01-20', today: '2028-05-10' });
    expect(ranges(p)).toEqual([
      '2028-05-01..2028-05-31 current',
      '2028-04-01..2028-04-30',
      '2028-03-01..2028-03-31',
      '2028-02-01..2028-02-29',
      '2028-01-01..2028-01-31',
    ]);
    const p2 = plan({ usualClosingDay: 30, earliestDate: '2026-02-10', today: '2026-03-10' });
    expect(ranges(p2)).toEqual(['2026-03-01..2026-03-30 current', '2026-01-31..2026-02-28']);
  });

  it('with no transactions, has only the current cycle', () => {
    expect(ranges(plan({ earliestDate: null }))).toEqual(['2026-11-16..2026-12-15 current']);
  });

  it('treats a transaction dated after today as today for where history starts', () => {
    expect(ranges(plan({ earliestDate: '2026-12-20' }))).toEqual(['2026-11-16..2026-12-15 current']);
  });

  it('extends the cycles to the latest transaction, so one dated after the current cycle still has a cycle', () => {
    // Today is the closing day, and a transaction is dated tomorrow.
    const p = plan({ today: '2026-11-15', earliestDate: '2026-11-01', latestDate: '2026-11-16' });
    expect(ranges(p)).toEqual(['2026-11-16..2026-12-15', '2026-10-16..2026-11-15 current']);
    expect(cycleContaining(p, '2026-11-16')?.start).toBe('2026-11-16');
    const months = plan({ usualClosingDay: null, today: '2026-11-30', earliestDate: '2026-11-01', latestDate: '2026-12-01' });
    expect(ranges(months)).toEqual(['2026-12-01..2026-12-31', '2026-11-01..2026-11-30 current']);
  });
});

describe('planCycles: known closing dates', () => {
  it('lets a manual date replace the inferred one near it, and infers the rest', () => {
    const p = plan({ known: [{ date: '2026-10-18', source: 'manual' }] });
    expect(closings(p)).toContain('2026-10-18 manual');
    expect(closings(p)).not.toContain('2026-10-15 inferred');
    expect(ranges(p)).toEqual(['2026-11-16..2026-12-15 current', '2026-10-19..2026-11-15', '2026-09-16..2026-10-18', '2026-08-16..2026-09-15']);
  });

  it(`drops an inferred date within ${INFERRED_MIN_GAP_DAYS} days of a known one, and keeps one further away`, () => {
    const near = plan({ known: [{ date: '2026-10-30', source: 'manual' }] }); // 15 days after the 15th
    expect(closings(near)).not.toContain('2026-10-15 inferred');
    expect(closings(near)).toContain('2026-11-15 inferred'); // 16 days after
    expect(ranges(near)).toContain('2026-10-31..2026-11-15');
  });

  it('lets a known date replace only the single nearest inferred date, the earlier on a tie', () => {
    // The 31st clamps to Jan 31 and Feb 28, both 14 days from Feb 14: only Jan 31 goes.
    const p = plan({ usualClosingDay: 31, known: [{ date: '2026-02-14', source: 'manual' }], earliestDate: '2026-01-01', today: '2026-05-20' });
    expect(closings(p)).toEqual(expect.arrayContaining(['2026-02-14 manual', '2026-02-28 inferred']));
    expect(closings(p)).not.toContain('2026-01-31 inferred');
    expect(ranges(p).reverse()).toEqual([
      '2026-01-01..2026-02-14', '2026-02-15..2026-02-28', '2026-03-01..2026-03-31', '2026-04-01..2026-04-30', '2026-05-01..2026-05-31 current',
    ]);
    // March 1 is 14 days from both Feb 15 and Mar 15: only Feb 15 goes, so no statement is lost.
    const q = plan({ known: [{ date: '2026-03-01', source: 'manual' }], earliestDate: '2026-01-01', today: '2026-05-20' });
    expect(ranges(q).reverse()).toEqual([
      '2025-12-16..2026-01-15', '2026-01-16..2026-03-01', '2026-03-02..2026-03-15', '2026-03-16..2026-04-15', '2026-04-16..2026-05-15',
      '2026-05-16..2026-06-15 current',
    ]);
  });

  it('fills a gap between known dates, and the time before the first and after the last', () => {
    const p = plan({
      usualClosingDay: null,
      earliestDate: '2026-05-01',
      known: [
        { date: '2026-06-15', source: 'plaid' },
        { date: '2026-09-15', source: 'plaid' },
      ],
    });
    expect(closings(p).filter((c) => c >= '2026-04' && c < '2026-12-31')).toEqual([
      '2026-04-15 inferred', '2026-05-15 inferred', '2026-06-15 plaid', '2026-07-15 inferred', '2026-08-15 inferred', '2026-09-15 plaid',
      '2026-10-15 inferred', '2026-11-15 inferred', '2026-12-15 inferred',
    ]);
    expect(p.cycles.at(-1)!.start).toBe('2026-04-16');
  });

  it("uses the latest known date's day when no usual day is set", () => {
    const p = plan({ usualClosingDay: null, known: [{ date: '2026-08-20', source: 'manual' }, { date: '2026-10-22', source: 'manual' }] });
    expect(p.closingDay).toBe(22);
    expect(ranges(p)[0]).toBe('2026-10-23..2026-11-22 current');
    expect(closings(p)).toContain('2026-09-22 inferred');
    expect(closings(p)).not.toContain('2026-08-22 inferred'); // 2 days from the known 20th
  });

  it('keeps one closing for a date that is both manual and from Plaid, as manual', () => {
    const p = plan({ known: [{ date: '2026-10-15', source: 'plaid' }, { date: '2026-10-15', source: 'manual' }] });
    expect(closings(p).filter((c) => c.startsWith('2026-10-15'))).toEqual(['2026-10-15 manual']);
  });

  it('accepts a manual date after today as the end of the current cycle', () => {
    const p = plan({ known: [{ date: '2026-12-10', source: 'manual' }] });
    expect(ranges(p)[0]).toBe('2026-11-16..2026-12-10 current');
  });

  it('when a known date replaces the next inferred one, the current cycle runs to the one after', () => {
    // The closing moved from the 1st to the 18th: Jan 1 is the inferred date nearest Dec 18, so it goes.
    const p = plan({ usualClosingDay: 1, known: [{ date: '2026-12-18', source: 'manual' }], today: '2026-12-20', earliestDate: '2026-12-05' });
    expect(ranges(p)).toEqual(['2026-12-19..2027-02-01 current', '2026-12-02..2026-12-18']);
    expect(p.cycles[0]!.closing).toEqual({ date: '2027-02-01', source: 'inferred' });
  });
});

describe('planCycles: changing the usual closing day', () => {
  it('moves every inferred date, past ones included, and leaves manual ones alone', () => {
    const manual = [{ date: '2026-09-15', source: 'manual' as const }];
    const before = plan({ known: manual });
    const after = plan({ known: manual, usualClosingDay: 28 });
    expect(closings(before)).toContain('2026-10-15 inferred');
    expect(closings(after)).toContain('2026-10-28 inferred');
    expect(closings(after)).not.toContain('2026-10-15 inferred');
    expect(closings(after)).toContain('2026-09-15 manual');
    expect(closings(after)).not.toContain('2026-09-28 inferred'); // 13 days from the manual date
    expect(ranges(after)[0]).toBe('2026-10-29..2026-11-28 current');
  });
});

describe('planCycles: no closing day at all', () => {
  it('groups by calendar month, back to the earliest transaction', () => {
    const p = plan({ usualClosingDay: null, earliestDate: '2026-09-20' });
    expect(p.mode).toBe('calendar_month');
    expect(ranges(p)).toEqual(['2026-11-01..2026-11-30 current', '2026-10-01..2026-10-31', '2026-09-01..2026-09-30']);
    expect(p.cycles.every((c) => c.closing === null)).toBe(true);
  });

  it('crosses a year, and handles February', () => {
    const p = plan({ usualClosingDay: null, earliestDate: '2027-12-31', today: '2028-02-01' });
    expect(ranges(p)).toEqual(['2028-02-01..2028-02-29 current', '2028-01-01..2028-01-31', '2027-12-01..2027-12-31']);
  });
});

describe('cycleContaining and previousCycle', () => {
  const p = plan({});
  it('finds the cycle a date belongs to, by posted date, both ends included', () => {
    expect(cycleContaining(p, '2026-10-16')?.start).toBe('2026-10-16');
    expect(cycleContaining(p, '2026-11-15')?.start).toBe('2026-10-16');
    expect(cycleContaining(p, '2026-11-16')?.current).toBe(true);
    expect(cycleContaining(p, '2025-01-01')).toBeNull();
  });

  it('gives the cycle before, or null for the oldest', () => {
    expect(previousCycle(p, p.cycles[0]!)?.start).toBe('2026-10-16');
    expect(previousCycle(p, p.cycles.at(-1)!)).toBeNull();
  });
});
