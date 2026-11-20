import { z } from 'zod';
import { addDays, LocalDateSchema, weekdayOf } from './dates.js';
import { utcToWall, wallToUtcMs } from './zonedTime.js';

/**
 * The repeat rules the event editor offers (spec §9.4), stored as a standard RRULE (RFC 5545
 * §3.3.10), as Google Calendar keeps them in an event's `recurrence` list
 * (docs/research/google-calendar-v3.md §6):
 * - none, daily, weekly on chosen weekdays, monthly on the start's day of the month, or yearly on
 *   the start's date;
 * - ending never, on a date (inclusive), or after N times.
 *
 * Anything else, such as "every 2 weeks", "the second Tuesday", an EXRULE, or a second RRULE, is
 * `custom`: the editor shows it read-only ("Edit the repeat in Google Calendar") and an edit leaves
 * the event's `recurrence` alone. A rule in the subset that comes with EXDATE or RDATE lines (dates
 * skipped or added, often by Google when one instance is deleted) is shown but not editable either,
 * since writing the rule back would mean rewriting those lines too.
 *
 * Pure: no clock, no I/O. Shared by the server (parsing a series, writing a new rule) and the web
 * (the editor and the summary line).
 */

export const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const WEEKDAY_NAMES: Record<Weekday, string> = {
  SU: 'Sunday', MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday',
};

/** The most repeats "after N times" offers. Larger COUNTs from Google are shown as custom. */
export const MAX_COUNT = 1000;

export const RepeatEndSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('never') }),
  z.object({ type: z.literal('on'), date: LocalDateSchema }),
  z.object({
    type: z.literal('after'),
    count: z.number({ error: 'Enter how many times it repeats' }).int('Enter a whole number of times').min(1, 'It has to happen at least once').max(MAX_COUNT, `Keep it to ${MAX_COUNT} times or fewer`),
  }),
], { error: 'Pick when the repeat ends' });

export const RepeatRuleSchema = z
  .object({
    freq: z.enum(['daily', 'weekly', 'monthly', 'yearly'], { error: 'Pick how often it repeats' }),
    /** Weekly only: the days it happens, in WEEKDAYS order. Empty for the others. */
    weekdays: z.array(z.enum(WEEKDAYS, { error: 'Pick weekdays from the list' })),
    end: RepeatEndSchema,
  })
  .superRefine((r, ctx) => {
    if (r.freq === 'weekly' && r.weekdays.length === 0) ctx.addIssue({ code: 'custom', message: 'Pick at least one day of the week' });
    if (r.freq !== 'weekly' && r.weekdays.length > 0) ctx.addIssue({ code: 'custom', message: 'Weekdays only go with a weekly repeat' });
    if (new Set(r.weekdays).size !== r.weekdays.length) ctx.addIssue({ code: 'custom', message: 'Pick each weekday once' });
  });
export type RepeatRule = z.infer<typeof RepeatRuleSchema>;
export type RepeatEnd = z.infer<typeof RepeatEndSchema>;

/**
 * What a rule's dates mean, all in the zone the series repeats in (`timeZone`): whether it's all
 * day, and its first occurrence's date and wall-clock time there.
 */
export interface RuleContext {
  allDay: boolean;
  /**
   * The series' first date (YYYY-MM-DD) in `timeZone`, the zone the series repeats in: the day
   * "monthly" and "yearly" repeat on, and the weekday a weekly rule without BYDAY repeats on.
   */
  startDate: string;
  /**
   * A timed series' first start time (HH:MM) in `timeZone`, which every occurrence keeps; null
   * for an all-day series. A UTC UNTIL earlier in the day than this ends the series the day
   * before (R1-I1 of the phase 5 review).
   */
  startTime: string | null;
  /**
   * The zone the series repeats in (research notes §7), where its rule is expanded: the family's
   * for one made here, else its start's own zone, else the calendar's. A timed series' UNTIL is
   * written as the end of its "ends on" date there.
   */
  timeZone: string;
}

export type ParsedRecurrence =
  | { kind: 'none' }
  /** In the editor's subset. `editable` is false when EXDATE or RDATE lines come with it. */
  | { kind: 'rule'; rule: RepeatRule; editable: boolean }
  | { kind: 'custom' };

function sortWeekdays(days: readonly Weekday[]): Weekday[] {
  return WEEKDAYS.filter((d) => days.includes(d));
}

/**
 * RRULE UNTIL as the date of the series' last occurrence in the zone it repeats in, or null when
 * it's in a form this editor doesn't write, or doesn't exist.
 *
 * A UTC UNTIL is an instant (Google's documented example is the last instance's start). It's read
 * in `ctx.timeZone`: when its wall time there is earlier than the series' start time, that day's
 * occurrence falls after it, so the last one is the day before (R1-I1).
 */
function untilDate(value: string, ctx: RuleContext): string | null {
  const day = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (day) {
    const date = `${day[1]}-${day[2]}-${day[3]}`;
    return LocalDateSchema.safeParse(date).success ? date : null;
  }
  const utc = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!utc) return null; // a floating local UNTIL: not something this editor writes (research notes §6)
  const [y, mo, d, h, mi, se] = utc.slice(1).map(Number) as [number, number, number, number, number, number];
  const instant = Date.UTC(y, mo - 1, d, h, mi, se);
  // Date.UTC rolls values that don't exist (month 13, hour 24) into another day: check it didn't (R1-M4).
  const back = new Date(instant);
  if (Number.isNaN(instant) || back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d
    || back.getUTCHours() !== h || back.getUTCMinutes() !== mi || back.getUTCSeconds() !== se) return null;
  const wall = utcToWall(instant, ctx.timeZone);
  if (!ctx.allDay && ctx.startTime !== null && wall.time < ctx.startTime) return addDays(wall.date, -1);
  return wall.date;
}

/** One RRULE value (after `RRULE:`), or null when it's outside the editor's subset. */
function parseRule(value: string, ctx: RuleContext): RepeatRule | null {
  const fields = new Map<string, string>();
  for (const part of value.split(';')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    if (eq <= 0) return null;
    const key = part.slice(0, eq).toUpperCase();
    if (fields.has(key)) return null;
    fields.set(key, part.slice(eq + 1).toUpperCase());
  }
  const allowed = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'COUNT', 'UNTIL', 'WKST']);
  for (const key of fields.keys()) if (!allowed.has(key)) return null;
  if (fields.has('INTERVAL') && fields.get('INTERVAL') !== '1') return null;
  const wkst = fields.get('WKST');
  if (wkst !== undefined && !(WEEKDAYS as readonly string[]).includes(wkst)) return null;

  const [, m, d] = ctx.startDate.split('-').map(Number);
  const byDay = fields.get('BYDAY');
  const byMonthDay = fields.get('BYMONTHDAY');
  const byMonth = fields.get('BYMONTH');
  let freq: RepeatRule['freq'];
  let weekdays: Weekday[] = [];
  switch (fields.get('FREQ')) {
    case 'DAILY':
      if (byDay !== undefined || byMonthDay !== undefined || byMonth !== undefined) return null;
      freq = 'daily';
      break;
    case 'WEEKLY': {
      if (byMonthDay !== undefined || byMonth !== undefined) return null;
      freq = 'weekly';
      if (byDay === undefined) {
        weekdays = [WEEKDAYS[weekdayOf(ctx.startDate)]!];
      } else {
        const days = byDay.split(',');
        // Plain weekday codes only: "1MO" (the first Monday) isn't a weekly-on-weekdays rule.
        if (days.some((x) => !(WEEKDAYS as readonly string[]).includes(x)) || new Set(days).size !== days.length) return null;
        weekdays = sortWeekdays(days as Weekday[]);
      }
      break;
    }
    case 'MONTHLY':
      if (byDay !== undefined || byMonth !== undefined) return null;
      if (byMonthDay !== undefined && byMonthDay !== String(d)) return null;
      freq = 'monthly';
      break;
    case 'YEARLY':
      if (byDay !== undefined) return null;
      if (byMonth !== undefined && byMonth !== String(m)) return null;
      if (byMonthDay !== undefined && (byMonth === undefined || byMonthDay !== String(d))) return null;
      freq = 'yearly';
      break;
    default:
      return null;
  }

  const count = fields.get('COUNT');
  const until = fields.get('UNTIL');
  if (count !== undefined && until !== undefined) return null; // RFC 5545: never both
  let end: RepeatEnd = { type: 'never' };
  if (count !== undefined) {
    if (!/^\d+$/.test(count)) return null;
    const n = Number(count);
    if (n < 1 || n > MAX_COUNT) return null;
    end = { type: 'after', count: n };
  } else if (until !== undefined) {
    const date = untilDate(until, ctx);
    if (date === null) return null;
    end = { type: 'on', date };
  }
  return { freq, weekdays, end };
}

/**
 * An event's `recurrence` lines, read against the editor's subset. Lines are matched by name,
 * case-insensitively; blank lines are ignored.
 */
export function parseRecurrence(lines: readonly string[] | null | undefined, ctx: RuleContext): ParsedRecurrence {
  const list = (lines ?? []).map((l) => l.trim()).filter((l) => l !== '');
  if (list.length === 0) return { kind: 'none' };
  const rules: string[] = [];
  let exceptions = false;
  for (const line of list) {
    const name = /^([A-Za-z-]+)[:;]/.exec(line)?.[1]?.toUpperCase();
    if (name === 'RRULE') rules.push(line.slice(line.indexOf(':') + 1));
    else if (name === 'EXDATE' || name === 'RDATE') exceptions = true;
    else return { kind: 'custom' }; // EXRULE, or something unknown
  }
  if (rules.length !== 1) return { kind: 'custom' };
  const rule = parseRule(rules[0]!, ctx);
  if (!rule) return { kind: 'custom' };
  return { kind: 'rule', rule, editable: !exceptions };
}

function compact(date: string): string {
  return date.replaceAll('-', '');
}

/**
 * The UNTIL value of a series' one RRULE line, exactly as Google has it, or null. An all-day
 * series whose end didn't change gets it back unchanged (`serializeRule`'s `keepUntil`).
 */
export function untilValue(lines: readonly string[] | null | undefined): string | null {
  const rule = (lines ?? []).map((l) => l.trim()).find((l) => /^RRULE:/i.test(l));
  const m = rule ? /(?:^RRULE:|;)UNTIL=([^;]+)/i.exec(rule) : null;
  return m ? m[1]!.toUpperCase() : null;
}

/**
 * The RRULE line for a rule. "Monthly" and "yearly" leave the day to the series' start (RFC 5545
 * takes it from DTSTART), so moving the series moves them too, and a BYMONTHDAY or BYMONTH Google
 * wrote is dropped. UNTIL is a date for an all-day event and UTC for a timed one (RFC 5545
 * §3.3.10, research notes §6).
 *
 * A timed rule's UNTIL is always the last second of the "ends on" day in `ctx.timeZone` (the zone
 * the series repeats in), so an occurrence any time that day is included, whatever time the series
 * now starts at. Google's own UNTIL is never written back for a timed rule: it may be the last
 * instance's exact start, which a later start time would fall after (R1-I1). An all-day rule's
 * `keepUntil` (the series' own UNTIL, from `untilValue`) is written back when the end date is the
 * one it already had.
 */
export function serializeRule(rule: RepeatRule, ctx: RuleContext, keepUntil?: string | null): string {
  const parts = [`FREQ=${rule.freq.toUpperCase()}`];
  if (rule.freq === 'weekly') parts.push(`BYDAY=${sortWeekdays(rule.weekdays).join(',')}`);
  if (rule.end.type === 'after') parts.push(`COUNT=${rule.end.count}`);
  if (rule.end.type === 'on' && ctx.allDay && keepUntil && untilDate(keepUntil, ctx) === rule.end.date) {
    parts.push(`UNTIL=${keepUntil}`);
  } else if (rule.end.type === 'on') {
    if (ctx.allDay) {
      parts.push(`UNTIL=${compact(rule.end.date)}`);
    } else {
      const last = new Date(wallToUtcMs(rule.end.date, '23:59', ctx.timeZone) + 59_000).toISOString();
      parts.push(`UNTIL=${last.slice(0, 19).replace(/[-:]/g, '')}Z`);
    }
  }
  return `RRULE:${parts.join(';')}`;
}

export function sameRule(a: RepeatRule | null, b: RepeatRule | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.freq !== b.freq) return false;
  if (sortWeekdays(a.weekdays).join() !== sortWeekdays(b.weekdays).join()) return false;
  if (a.end.type !== b.end.type) return false;
  if (a.end.type === 'on' && b.end.type === 'on') return a.end.date === b.end.date;
  if (a.end.type === 'after' && b.end.type === 'after') return a.end.count === b.end.count;
  return true;
}

/**
 * A weekly rule's weekdays moved by `days`, for "All events" edits that move the series to
 * another day without touching the repeat: a Tuesday series moved a day later becomes a Wednesday
 * series. Other rules follow the start by themselves.
 */
export function shiftWeekdays(rule: RepeatRule, days: number): RepeatRule {
  if (rule.freq !== 'weekly' || days % 7 === 0) return rule;
  const shift = ((days % 7) + 7) % 7;
  return { ...rule, weekdays: sortWeekdays(rule.weekdays.map((w) => WEEKDAYS[(WEEKDAYS.indexOf(w) + shift) % 7]!)) };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "March 8, 2026" for `2026-03-08`. */
export function longDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return `${MONTHS[m! - 1]} ${d}, ${y}`;
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/** "Monday", "Monday and Friday", "Monday, Wednesday, and Friday". */
function listOf(items: string[]): string {
  if (items.length <= 2) return items.join(' and ');
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

/** A rule in plain English, e.g. "Every week on Monday and Wednesday, until December 31, 2026". */
export function describeRule(rule: RepeatRule, startDate: string): string {
  const [, m, d] = startDate.split('-').map(Number);
  let text: string;
  switch (rule.freq) {
    case 'daily':
      text = 'Every day';
      break;
    case 'weekly':
      text = rule.weekdays.length === 7 ? 'Every day of the week' : `Every week on ${listOf(sortWeekdays(rule.weekdays).map((w) => WEEKDAY_NAMES[w]))}`;
      break;
    case 'monthly':
      // RFC 5545 skips months without that day; say so, rather than surprise anyone in February.
      text = `Every month on the ${ordinal(d!)}${d! >= 29 ? ', in months that have one' : ''}`;
      break;
    case 'yearly':
      text = `Every year on ${MONTHS[m! - 1]} ${d}${m === 2 && d === 29 ? ', in leap years only' : ''}`;
      break;
  }
  if (rule.end.type === 'on') return `${text}, until ${longDate(rule.end.date)}`;
  // COUNT=1 is the first occurrence and nothing more (R1-M6).
  if (rule.end.type === 'after' && rule.end.count === 1) return `Once, on ${longDate(startDate)}`;
  if (rule.end.type === 'after') return `${text}, ${rule.end.count} times`;
  return text;
}

/** The event detail's repeat line, or null for an event that doesn't repeat. */
export function describeRecurrence(parsed: ParsedRecurrence, startDate: string): string | null {
  if (parsed.kind === 'none') return null;
  if (parsed.kind === 'custom') return 'Repeats on a custom schedule';
  const text = describeRule(parsed.rule, startDate);
  return parsed.editable ? text : `${text}, with some dates skipped or added`;
}
