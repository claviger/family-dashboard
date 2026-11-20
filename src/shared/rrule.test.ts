import { describe, expect, it } from 'vitest';
import {
  describeRecurrence, describeRule, parseRecurrence, RepeatRuleSchema, sameRule, serializeRule, shiftWeekdays, untilValue, type RepeatRule,
  type RuleContext,
} from './rrule.js';

const LA = 'America/Los_Angeles';
/** A timed series that starts at 9am on Tuesday, November 17, 2026. */
const timed: RuleContext = { allDay: false, startDate: '2026-11-17', startTime: '09:00', timeZone: LA };
/** An all-day series on the same day. */
const allDay: RuleContext = { allDay: true, startDate: '2026-11-17', startTime: null, timeZone: LA };

const never = { type: 'never' } as const;

describe('parseRecurrence', () => {
  it('reads no lines as no repeat', () => {
    expect(parseRecurrence(undefined, timed)).toEqual({ kind: 'none' });
    expect(parseRecurrence([], timed)).toEqual({ kind: 'none' });
    expect(parseRecurrence(['', '  '], timed)).toEqual({ kind: 'none' });
  });

  it('reads each frequency in the subset', () => {
    expect(parseRecurrence(['RRULE:FREQ=DAILY'], timed)).toEqual({ kind: 'rule', editable: true, rule: { freq: 'daily', weekdays: [], end: never } });
    expect(parseRecurrence(['RRULE:FREQ=WEEKLY;BYDAY=WE,MO'], timed)).toEqual({ kind: 'rule', editable: true, rule: { freq: 'weekly', weekdays: ['MO', 'WE'], end: never } });
    expect(parseRecurrence(['RRULE:FREQ=MONTHLY'], timed)).toEqual({ kind: 'rule', editable: true, rule: { freq: 'monthly', weekdays: [], end: never } });
    expect(parseRecurrence(['RRULE:FREQ=YEARLY'], timed)).toEqual({ kind: 'rule', editable: true, rule: { freq: 'yearly', weekdays: [], end: never } });
  });

  it("takes a weekly rule without BYDAY to repeat on the start's weekday", () => {
    expect(parseRecurrence(['RRULE:FREQ=WEEKLY'], timed)).toMatchObject({ rule: { freq: 'weekly', weekdays: ['TU'] } });
  });

  it('accepts what Google writes: INTERVAL=1, WKST, lower case, and the day spelled out when it matches the start', () => {
    expect(parseRecurrence(['RRULE:FREQ=WEEKLY;WKST=SU;INTERVAL=1;BYDAY=TU'], timed)).toMatchObject({ kind: 'rule', rule: { weekdays: ['TU'] } });
    expect(parseRecurrence(['rrule:freq=daily'], timed)).toMatchObject({ kind: 'rule', rule: { freq: 'daily' } });
    expect(parseRecurrence(['RRULE:FREQ=MONTHLY;BYMONTHDAY=17'], timed)).toMatchObject({ kind: 'rule', rule: { freq: 'monthly' } });
    expect(parseRecurrence(['RRULE:FREQ=YEARLY;BYMONTH=11;BYMONTHDAY=17'], timed)).toMatchObject({ kind: 'rule', rule: { freq: 'yearly' } });
    expect(parseRecurrence(['RRULE:FREQ=YEARLY;BYMONTH=11'], timed)).toMatchObject({ kind: 'rule', rule: { freq: 'yearly' } });
  });

  it('reads COUNT, and UNTIL as a date or as UTC, in the family time zone', () => {
    expect(parseRecurrence(['RRULE:FREQ=DAILY;COUNT=10'], timed)).toMatchObject({ rule: { end: { type: 'after', count: 10 } } });
    expect(parseRecurrence(['RRULE:FREQ=DAILY;UNTIL=20261231'], allDay)).toMatchObject({ rule: { end: { type: 'on', date: '2026-12-31' } } });
    // The end of December 31 in Los Angeles is 07:59:59 UTC on January 1.
    expect(parseRecurrence(['RRULE:FREQ=DAILY;UNTIL=20270101T075959Z'], timed)).toMatchObject({ rule: { end: { type: 'on', date: '2026-12-31' } } });
    // A date UNTIL on a timed series breaks RFC 5545, but what it means is clear.
    expect(parseRecurrence(['RRULE:FREQ=DAILY;UNTIL=20261231'], timed)).toMatchObject({ rule: { end: { type: 'on', date: '2026-12-31' } } });
  });

  it('shows a rule that comes with EXDATE or RDATE, but not as editable', () => {
    expect(parseRecurrence(['RRULE:FREQ=WEEKLY;BYDAY=TU', 'EXDATE;TZID=America/Los_Angeles:20261124T090000'], timed))
      .toEqual({ kind: 'rule', editable: false, rule: { freq: 'weekly', weekdays: ['TU'], end: never } });
    // Google's documented all-day examples (research notes §6).
    expect(parseRecurrence(['EXDATE;VALUE=DATE:20150610', 'RDATE;VALUE=DATE:20150609,20150611', 'RRULE:FREQ=DAILY;UNTIL=20150628;INTERVAL=3'], allDay))
      .toEqual({ kind: 'custom' }); // INTERVAL=3 is outside the subset
    expect(parseRecurrence(['RDATE;VALUE=DATE:20261120', 'RRULE:FREQ=DAILY'], allDay)).toMatchObject({ kind: 'rule', editable: false });
  });

  it('calls everything else custom', () => {
    const custom = [
      ['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU'],
      ['RRULE:FREQ=MONTHLY;BYDAY=3TU'],
      ['RRULE:FREQ=MONTHLY;BYMONTHDAY=-1'],
      ['RRULE:FREQ=MONTHLY;BYMONTHDAY=5'], // not the start's day
      ['RRULE:FREQ=YEARLY;BYMONTH=6'],
      ['RRULE:FREQ=YEARLY;BYMONTHDAY=17'],
      ['RRULE:FREQ=WEEKLY;BYDAY=1MO'],
      ['RRULE:FREQ=WEEKLY;BYDAY=MO,MO'],
      ['RRULE:FREQ=DAILY;BYDAY=MO'],
      ['RRULE:FREQ=DAILY;BYHOUR=9'],
      ['RRULE:FREQ=HOURLY'],
      ['RRULE:FREQ=DAILY;COUNT=3;UNTIL=20261231'],
      ['RRULE:FREQ=DAILY;COUNT=0'],
      ['RRULE:FREQ=DAILY;COUNT=5000'],
      ['RRULE:FREQ=DAILY;COUNT=x'],
      ['RRULE:FREQ=DAILY;UNTIL=20261231T090000'], // floating
      ['RRULE:FREQ=DAILY;UNTIL=20261340'],
      // UTC values that don't exist (R1-M4): Date.UTC would roll them into another day.
      ['RRULE:FREQ=DAILY;UNTIL=20261301T000000Z'],
      ['RRULE:FREQ=DAILY;UNTIL=20260230T100000Z'],
      ['RRULE:FREQ=DAILY;UNTIL=20261231T240000Z'],
      ['RRULE:FREQ=DAILY;UNTIL=20261231T250000Z'],
      ['RRULE:FREQ=DAILY;UNTIL=20261231T106000Z'],
      ['RRULE:FREQ=DAILY;UNTIL=20261231T100060Z'],
      ['RRULE:FREQ=DAILY;FREQ=WEEKLY'],
      ['RRULE:FREQ=DAILY;WKST=XX'],
      ['RRULE:FREQ'],
      ['RRULE:FREQ=DAILY', 'RRULE:FREQ=WEEKLY'],
      ['RRULE:FREQ=DAILY', 'EXRULE:FREQ=WEEKLY'],
      ['X-SOMETHING:1'],
    ];
    for (const lines of custom) expect(parseRecurrence(lines, timed), lines.join(' ')).toEqual({ kind: 'custom' });
  });
});

describe('serializeRule', () => {
  it('writes each frequency, leaving monthly and yearly to the start', () => {
    expect(serializeRule({ freq: 'daily', weekdays: [], end: never }, timed)).toBe('RRULE:FREQ=DAILY');
    expect(serializeRule({ freq: 'weekly', weekdays: ['FR', 'MO'], end: never }, timed)).toBe('RRULE:FREQ=WEEKLY;BYDAY=MO,FR');
    expect(serializeRule({ freq: 'monthly', weekdays: [], end: never }, timed)).toBe('RRULE:FREQ=MONTHLY');
    expect(serializeRule({ freq: 'yearly', weekdays: [], end: never }, timed)).toBe('RRULE:FREQ=YEARLY');
  });

  it('writes COUNT, a date UNTIL for all-day series, and the end of the day in UTC for timed ones', () => {
    expect(serializeRule({ freq: 'daily', weekdays: [], end: { type: 'after', count: 5 } }, timed)).toBe('RRULE:FREQ=DAILY;COUNT=5');
    expect(serializeRule({ freq: 'daily', weekdays: [], end: { type: 'on', date: '2026-12-31' } }, allDay)).toBe('RRULE:FREQ=DAILY;UNTIL=20261231');
    expect(serializeRule({ freq: 'daily', weekdays: [], end: { type: 'on', date: '2026-12-31' } }, timed)).toBe('RRULE:FREQ=DAILY;UNTIL=20270101T075959Z');
    // In summer, Los Angeles is 7 hours behind.
    expect(serializeRule({ freq: 'daily', weekdays: [], end: { type: 'on', date: '2026-07-04' } }, timed)).toBe('RRULE:FREQ=DAILY;UNTIL=20260705T065959Z');
    expect(serializeRule({ freq: 'daily', weekdays: [], end: { type: 'on', date: '2026-12-31' } }, { ...timed, timeZone: 'Europe/Berlin' })).toBe('RRULE:FREQ=DAILY;UNTIL=20261231T225959Z');
  });

  it("always writes a timed rule's UNTIL as the end of its last day, and keeps an all-day rule's date (R1-I1)", () => {
    // Google wrote 5pm UTC on the last day (9am in Los Angeles, the series' start time).
    const lines = ['RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261231T170000Z'];
    expect(untilValue(lines)).toBe('20261231T170000Z');
    expect(untilValue(['RRULE:FREQ=DAILY'])).toBeNull();
    const rule = (parseRecurrence(lines, timed) as { rule: RepeatRule }).rule;
    expect(rule.end).toEqual({ type: 'on', date: '2026-12-31' });
    // Not written back as it was: a later start time that day would fall after it.
    expect(serializeRule({ ...rule, weekdays: ['WE'] }, timed, untilValue(lines))).toBe('RRULE:FREQ=WEEKLY;BYDAY=WE;UNTIL=20270101T075959Z');
    expect(serializeRule({ ...rule, end: { type: 'on', date: '2027-01-15' } }, timed, untilValue(lines))).toBe('RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20270116T075959Z');
    expect(serializeRule({ ...rule, end: { type: 'never' } }, timed, untilValue(lines))).toBe('RRULE:FREQ=WEEKLY;BYDAY=TU');
    const allDayLines = ['RRULE:FREQ=DAILY;UNTIL=20261231'];
    const allDayRule = (parseRecurrence(allDayLines, allDay) as { rule: RepeatRule }).rule;
    expect(serializeRule(allDayRule, allDay, untilValue(allDayLines))).toBe('RRULE:FREQ=DAILY;UNTIL=20261231');
  });

  it("reads a UTC UNTIL as the date of the series' last occurrence, in the zone it repeats in (R1-I1)", () => {
    // A 10am Los Angeles series. 18:00Z on December 31 is 10am there: the last one is that day.
    // 17:00Z is 9am, before that day's 10am start: the last one is the day before.
    const ten: RuleContext = { ...timed, startTime: '10:00' };
    const at18 = parseRecurrence(['RRULE:FREQ=DAILY;UNTIL=20261231T180000Z'], ten) as { rule: RepeatRule };
    const at17 = parseRecurrence(['RRULE:FREQ=DAILY;UNTIL=20261231T170000Z'], ten) as { rule: RepeatRule };
    expect(at18.rule.end).toEqual({ type: 'on', date: '2026-12-31' });
    expect(at17.rule.end).toEqual({ type: 'on', date: '2026-12-30' });
    expect(describeRule(at18.rule, ten.startDate)).toBe('Every day, until December 31, 2026');
    expect(describeRule(at17.rule, ten.startDate)).toBe('Every day, until December 30, 2026');
    // Moved to 11am, each keeps its last occurrence: the end of that day in Los Angeles.
    const eleven: RuleContext = { ...timed, startTime: '11:00' };
    expect(serializeRule(at18.rule, eleven, '20261231T180000Z')).toBe('RRULE:FREQ=DAILY;UNTIL=20270101T075959Z');
    expect(serializeRule(at17.rule, eleven, '20261231T170000Z')).toBe('RRULE:FREQ=DAILY;UNTIL=20261231T075959Z');
    expect(parseRecurrence(['RRULE:FREQ=DAILY;UNTIL=20270101T075959Z'], eleven)).toMatchObject({ rule: { end: { type: 'on', date: '2026-12-31' } } });
    expect(parseRecurrence(['RRULE:FREQ=DAILY;UNTIL=20261231T075959Z'], eleven)).toMatchObject({ rule: { end: { type: 'on', date: '2026-12-30' } } });
    // An all-day series has no start time to compare with.
    expect(parseRecurrence(['RRULE:FREQ=DAILY;UNTIL=20261231T170000Z'], allDay)).toMatchObject({ rule: { end: { type: 'on', date: '2026-12-31' } } });
  });

  it('drops a BYMONTHDAY or BYMONTH Google wrote, so the rule follows the start', () => {
    const monthly = (parseRecurrence(['RRULE:FREQ=MONTHLY;BYMONTHDAY=17'], timed) as { rule: RepeatRule }).rule;
    expect(serializeRule(monthly, { ...timed, startDate: '2026-11-18' })).toBe('RRULE:FREQ=MONTHLY');
    const yearly = (parseRecurrence(['RRULE:FREQ=YEARLY;BYMONTH=11;BYMONTHDAY=17'], timed) as { rule: RepeatRule }).rule;
    expect(serializeRule(yearly, timed)).toBe('RRULE:FREQ=YEARLY');
  });

  it('round-trips through parseRecurrence for every shape the editor makes', () => {
    const rules: RepeatRule[] = [];
    for (const end of [never, { type: 'on', date: '2027-03-08' }, { type: 'after', count: 12 }] as const) {
      rules.push({ freq: 'daily', weekdays: [], end }, { freq: 'weekly', weekdays: ['SU', 'TU', 'SA'], end }, { freq: 'monthly', weekdays: [], end }, { freq: 'yearly', weekdays: [], end });
    }
    for (const ctx of [timed, allDay, { ...timed, timeZone: 'Asia/Kolkata' }, { ...timed, timeZone: 'Pacific/Auckland' }]) {
      for (const rule of rules) {
        expect(parseRecurrence([serializeRule(rule, ctx)], ctx), JSON.stringify([rule, ctx])).toEqual({ kind: 'rule', editable: true, rule });
      }
    }
  });
});

describe('RepeatRuleSchema', () => {
  it('needs weekdays exactly for weekly rules, and a sane count', () => {
    expect(RepeatRuleSchema.safeParse({ freq: 'weekly', weekdays: [], end: never }).error?.issues[0]?.message).toBe('Pick at least one day of the week');
    expect(RepeatRuleSchema.safeParse({ freq: 'daily', weekdays: ['MO'], end: never }).success).toBe(false);
    expect(RepeatRuleSchema.safeParse({ freq: 'weekly', weekdays: ['MO', 'MO'], end: never }).success).toBe(false);
    expect(RepeatRuleSchema.safeParse({ freq: 'daily', weekdays: [], end: { type: 'after', count: 0 } }).success).toBe(false);
    expect(RepeatRuleSchema.safeParse({ freq: 'daily', weekdays: [], end: { type: 'after', count: 1.5 } }).success).toBe(false);
    expect(RepeatRuleSchema.safeParse({ freq: 'daily', weekdays: [], end: { type: 'on', date: '2026-02-30' } }).success).toBe(false);
    expect(RepeatRuleSchema.safeParse({ freq: 'weekly', weekdays: ['MO', 'FR'], end: { type: 'after', count: 3 } }).success).toBe(true);
  });
});

describe('sameRule and shiftWeekdays', () => {
  it('compares rules, ignoring weekday order', () => {
    const a: RepeatRule = { freq: 'weekly', weekdays: ['MO', 'WE'], end: { type: 'on', date: '2026-12-31' } };
    expect(sameRule(a, { ...a, weekdays: ['WE', 'MO'] })).toBe(true);
    expect(sameRule(a, { ...a, end: { type: 'on', date: '2027-01-01' } })).toBe(false);
    expect(sameRule(a, { ...a, end: never })).toBe(false);
    expect(sameRule(a, null)).toBe(false);
    expect(sameRule(null, null)).toBe(true);
  });

  it("moves a weekly rule's days with the series, wrapping around the week", () => {
    const rule: RepeatRule = { freq: 'weekly', weekdays: ['TU', 'SA'], end: never };
    expect(shiftWeekdays(rule, 1).weekdays).toEqual(['SU', 'WE']);
    expect(shiftWeekdays(rule, -2).weekdays).toEqual(['SU', 'TH']);
    expect(shiftWeekdays(rule, 14)).toBe(rule);
    const daily: RepeatRule = { freq: 'daily', weekdays: [], end: never };
    expect(shiftWeekdays(daily, 3)).toBe(daily);
  });
});

describe('describeRule and describeRecurrence', () => {
  it('says each rule in plain English', () => {
    expect(describeRule({ freq: 'daily', weekdays: [], end: never }, '2026-11-17')).toBe('Every day');
    expect(describeRule({ freq: 'weekly', weekdays: ['TU'], end: never }, '2026-11-17')).toBe('Every week on Tuesday');
    expect(describeRule({ freq: 'weekly', weekdays: ['FR', 'MO'], end: never }, '2026-11-17')).toBe('Every week on Monday and Friday');
    expect(describeRule({ freq: 'weekly', weekdays: ['MO', 'WE', 'FR'], end: never }, '2026-11-17')).toBe('Every week on Monday, Wednesday, and Friday');
    expect(describeRule({ freq: 'weekly', weekdays: ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'], end: never }, '2026-11-17')).toBe('Every day of the week');
    expect(describeRule({ freq: 'monthly', weekdays: [], end: never }, '2026-11-01')).toBe('Every month on the 1st');
    expect(describeRule({ freq: 'monthly', weekdays: [], end: never }, '2026-11-22')).toBe('Every month on the 22nd');
    expect(describeRule({ freq: 'monthly', weekdays: [], end: never }, '2026-11-13')).toBe('Every month on the 13th');
    expect(describeRule({ freq: 'monthly', weekdays: [], end: never }, '2026-11-23')).toBe('Every month on the 23rd');
    expect(describeRule({ freq: 'yearly', weekdays: [], end: never }, '2026-11-17')).toBe('Every year on November 17');
    expect(describeRule({ freq: 'monthly', weekdays: [], end: never }, '2026-10-31')).toBe('Every month on the 31st, in months that have one');
    expect(describeRule({ freq: 'monthly', weekdays: [], end: never }, '2026-01-29')).toBe('Every month on the 29th, in months that have one');
    expect(describeRule({ freq: 'yearly', weekdays: [], end: never }, '2028-02-29')).toBe('Every year on February 29, in leap years only');
    expect(describeRule({ freq: 'daily', weekdays: [], end: { type: 'on', date: '2026-12-31' } }, '2026-11-17')).toBe('Every day, until December 31, 2026');
    expect(describeRule({ freq: 'daily', weekdays: [], end: { type: 'after', count: 5 } }, '2026-11-17')).toBe('Every day, 5 times');
    // R1-M6: a series that happens once says when.
    expect(describeRule({ freq: 'daily', weekdays: [], end: { type: 'after', count: 1 } }, '2026-11-17')).toBe('Once, on November 17, 2026');
    expect(describeRule({ freq: 'weekly', weekdays: ['TU'], end: { type: 'after', count: 1 } }, '2026-11-17')).toBe('Once, on November 17, 2026');
  });

  it('says what it can about rules it can only show', () => {
    expect(describeRecurrence({ kind: 'none' }, '2026-11-17')).toBeNull();
    expect(describeRecurrence({ kind: 'custom' }, '2026-11-17')).toBe('Repeats on a custom schedule');
    expect(describeRecurrence({ kind: 'rule', editable: false, rule: { freq: 'weekly', weekdays: ['TU'], end: never } }, '2026-11-17'))
      .toBe('Every week on Tuesday, with some dates skipped or added');
  });
});
