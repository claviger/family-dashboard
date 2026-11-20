import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, isLocalDate, LocalDateSchema, LocalTimeSchema, weekdayOf } from './dates.js';

describe('isLocalDate', () => {
  it('accepts real dates and rejects junk and impossible dates', () => {
    expect(isLocalDate('2026-11-15')).toBe(true);
    expect(isLocalDate('2028-02-29')).toBe(true);
    expect(isLocalDate('2026-02-29')).toBe(false);
    expect(isLocalDate('2026-13-01')).toBe(false);
    expect(isLocalDate('2026-1-5')).toBe(false);
    expect(isLocalDate('2026-11-15T00:00:00Z')).toBe(false);
  });
});

describe('addDays', () => {
  it('crosses month and year ends and goes backwards', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-11-15', 6)).toBe('2026-11-21');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('is unaffected by daylight-saving changes', () => {
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02');
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
  });
});

describe('weekdayOf and daysBetween', () => {
  it('give the day of the week and the days from one date to another', () => {
    expect(weekdayOf('2026-11-15')).toBe(0); // a Sunday
    expect(weekdayOf('2026-11-21')).toBe(6);
    expect(daysBetween('2026-11-15', '2026-11-22')).toBe(7);
    expect(daysBetween('2026-11-22', '2026-11-15')).toBe(-7);
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2); // across a DST change
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
  });
});

describe('schemas', () => {
  it('validate dates and 24-hour times', () => {
    expect(LocalDateSchema.safeParse('2026-11-15').success).toBe(true);
    expect(LocalDateSchema.safeParse('11/15/2026').success).toBe(false);
    expect(LocalTimeSchema.safeParse('07:30').success).toBe(true);
    expect(LocalTimeSchema.safeParse('23:59').success).toBe(true);
    expect(LocalTimeSchema.safeParse('24:00').success).toBe(false);
    expect(LocalTimeSchema.safeParse('7:30').success).toBe(false);
    expect(LocalTimeSchema.safeParse('07:30:00').success).toBe(false);
  });
});
