import { z } from 'zod';

/** True when `value` is a real calendar date written as YYYY-MM-DD. */
export function isLocalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Adds `days` (may be negative) to a YYYY-MM-DD date. Pure calendar arithmetic, no time zones. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The day of the week of a YYYY-MM-DD date: 0 is Sunday, 6 is Saturday. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** How many days `to` is after `from` (negative when it's before). Both YYYY-MM-DD. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** A local calendar date in the family time zone, e.g. 2026-11-15. */
export const LocalDateSchema = z
  .string({ error: 'Enter a date written as YYYY-MM-DD' })
  .refine(isLocalDate, 'Enter a real date written as YYYY-MM-DD');

/** A local wall-clock time, 24-hour HH:MM, e.g. 07:30. */
export const LocalTimeSchema = z
  .string({ error: 'Enter a 24-hour time written as HH:MM' })
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Enter a 24-hour time written as HH:MM');
