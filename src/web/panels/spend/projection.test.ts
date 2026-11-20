import { describe, expect, it } from 'vitest';
import { onTrackLine, projectedCents } from './projection.js';

// A 30-day cycle: Nov 16 to Dec 15.
const cycle = { start: '2026-11-16', end: '2026-12-15', current: true };

describe('projectedCents', () => {
  it('scales spending so far to the whole cycle, counting today', () => {
    // Day 10 of 30: $100 so far is $300 by the end.
    expect(projectedCents(cycle, '2026-11-25', 100_00)).toBe(300_00);
    // Day 2.
    expect(projectedCents(cycle, '2026-11-17', 10_00)).toBe(150_00);
  });

  it('is the total itself on the last day', () => {
    expect(projectedCents(cycle, '2026-12-15', 123_45)).toBe(123_45);
  });

  it('rounds to whole cents', () => {
    // Day 3 of 30: 1000 / 3 * 30 = 10000; 1001 / 3 * 30 = 10010.
    expect(projectedCents(cycle, '2026-11-18', 1001)).toBe(10010);
    // Day 7 of 30: 100 / 7 * 30 = 428.57...
    expect(projectedCents(cycle, '2026-11-22', 100)).toBe(429);
  });

  it('shows nothing on the first day', () => {
    expect(projectedCents(cycle, '2026-11-16', 50_00)).toBeNull();
  });

  it('shows nothing with nothing spent, or more credits than spending', () => {
    expect(projectedCents(cycle, '2026-11-25', 0)).toBeNull();
    expect(projectedCents(cycle, '2026-11-25', -20_00)).toBeNull();
  });

  it('shows nothing for a past cycle, or a day outside the cycle', () => {
    expect(projectedCents({ ...cycle, current: false }, '2026-11-25', 100_00)).toBeNull();
    expect(projectedCents(cycle, '2026-11-15', 100_00)).toBeNull();
    expect(projectedCents(cycle, '2026-12-16', 100_00)).toBeNull();
  });

  it('counts days by the calendar across a year end and February', () => {
    // Dec 16 to Jan 15 is 31 days; Jan 1 is day 17.
    expect(projectedCents({ start: '2026-12-16', end: '2027-01-15', current: true }, '2027-01-01', 17_00)).toBe(31_00);
    // February 2028 (a leap year): 29 days, day 1 skipped, day 29 is the total.
    expect(projectedCents({ start: '2028-02-01', end: '2028-02-29', current: true }, '2028-02-15', 15_00)).toBe(29_00);
  });

  it('ignores daylight saving: the dates are calendar days, not 24-hour spans', () => {
    // Nov 1 to Nov 30, 2026 spans the US change on Nov 1; day 15 of 30.
    expect(projectedCents({ start: '2026-11-01', end: '2026-11-30', current: true }, '2026-11-15', 15_00)).toBe(30_00);
  });
});

describe('onTrackLine', () => {
  it('says the projection and the end date', () => {
    expect(onTrackLine(cycle, '2026-11-25', 1234_56)).toBe('On track for $3,703.68 by Dec 15');
  });

  it('is null when there is nothing to project', () => {
    expect(onTrackLine(cycle, '2026-11-16', 1234_56)).toBeNull();
    expect(onTrackLine({ ...cycle, current: false }, '2026-11-25', 1234_56)).toBeNull();
  });
});
