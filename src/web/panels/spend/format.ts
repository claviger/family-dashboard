import { CSV_DATE_FORMAT_LABELS } from '../../../shared/csvImport.js';
import { formatCents } from '../../../shared/money.js';
import {
  POSSIBLE_DUPLICATE, type CardMapping, type CategoryKind, type ImportColumns, type ImportPreview, type CycleMode, type FieldSource, type PreviewRow, type SpendCycle, type SpendPerson, type SpendTransaction,
} from '../../../shared/spend.js';
import { formatAgo } from '../../freshness.js';
import { columnName } from '../savings/format.js';

/**
 * Text for the Spend panel (spec §12.11, §12.12). Pure, so it's unit-tested and type-checked with
 * the server code. Dates are family-local YYYY-MM-DD strings, formatted without converting zones.
 */

export const money = formatCents;

const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const DAY_YEAR = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const MONTH = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

const utc = (date: string) => new Date(`${date}T00:00:00Z`);

/** "Nov 2". */
export function shortDate(date: string): string {
  return DAY.format(utc(date));
}

/** "Nov 2, 2026". */
export function longDate(date: string): string {
  return DAY_YEAR.format(utc(date));
}

/** "Nov 2, 2026" for an instant (an ISO timestamp), on the family's calendar. */
export function instantDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone }).format(new Date(iso));
}

/**
 * A total as words: spending is "$12.00 spent" (so far, in the current cycle); more refunds and
 * payments than spending is "$12.00 in credits", never a negative amount "spent".
 */
export function totalWords(totalCents: number, current: boolean, currency = 'USD'): { amount: string; words: string } {
  const amount = money(Math.abs(totalCents), currency);
  if (totalCents < 0) return { amount, words: current ? 'in credits so far' : 'in credits' };
  return { amount, words: current ? 'spent so far' : 'spent' };
}

/**
 * Each transaction's name for the controls on its row: merchant, date, and amount, so two rows of
 * the same merchant on the same day differ; rows that still match get ", 1 of 2" and so on.
 */
export function rowLabels(rows: readonly SpendTransaction[]): Map<number, string> {
  const base = new Map(rows.map((t) => [t.id, `${t.merchant}, ${longDate(t.date)}, ${money(t.amountCents, t.currency)}`]));
  const counts = new Map<string, number>();
  for (const label of base.values()) counts.set(label, (counts.get(label) ?? 0) + 1);
  const seen = new Map<string, number>();
  const out = new Map<number, string>();
  for (const t of rows) {
    const label = base.get(t.id)!;
    const total = counts.get(label)!;
    if (total === 1) out.set(t.id, label);
    else {
      const n = (seen.get(label) ?? 0) + 1;
      seen.set(label, n);
      out.set(t.id, `${label}, ${n} of ${total}`);
    }
  }
  return out;
}

/**
 * A cycle as people read it: "Oct 16 to Nov 15, 2026", "Dec 16, 2026 to Jan 15, 2027" across a
 * year, or "November 2026" for a calendar month.
 */
export function cycleLabel(cycle: Pick<SpendCycle, 'start' | 'end'>, mode: CycleMode): string {
  if (mode === 'calendar_month') return MONTH.format(utc(cycle.start));
  const sameYear = cycle.start.slice(0, 4) === cycle.end.slice(0, 4);
  return `${sameYear ? shortDate(cycle.start) : longDate(cycle.start)} to ${longDate(cycle.end)}`;
}

/** The cycle picker's option: the label, and "(current)" for the current one. */
export function cycleOption(cycle: SpendCycle, mode: CycleMode): string {
  return `${cycleLabel(cycle, mode)}${cycle.current ? ' (current)' : ''}`;
}

/** An amount that may be negative, as words: "$12.00", or "$12.00 in credits" for more credits than spending. */
function amountWords(cents: number, currency: string): string {
  return cents < 0 ? `${money(-cents, currency)} in credits` : money(cents, currency);
}

/**
 * "Up $12.34 from last cycle ($100.00)", "Down ...", "The same as last cycle ...", with a negative
 * previous total in credits; null with nothing to compare.
 */
export function changeLine(totalCents: number, previousCents: number | null, mode: CycleMode, currency = 'USD'): string | null {
  if (previousCents === null) return null;
  const last = mode === 'calendar_month' ? 'last month' : 'last cycle';
  const diff = totalCents - previousCents;
  const previous = amountWords(previousCents, currency);
  if (diff === 0) return `The same as ${last} (${previous})`;
  return `${diff > 0 ? 'Up' : 'Down'} ${money(Math.abs(diff), currency)} from ${last} (${previous})`;
}

/** The pending part of a total: "$12.00", or "$12.00 in credits" when pending credits outweigh pending charges. */
export function pendingAmount(cents: number, currency = 'USD'): string {
  return amountWords(cents, currency);
}

export interface PeriodNames {
  /** For sentences: "this cycle", or a past cycle's dates. */
  current: string;
  /** "last cycle", or "the previous cycle" before a past one. */
  previous: string;
  /** Column headings: "This cycle" and "Last cycle", or a past cycle's dates and "Previous cycle". */
  currentHeading: string;
  previousHeading: string;
  /** When nothing was spent in the cycle. */
  empty: string;
}

/**
 * The names of the cycle on screen and the one before it, for the breakdowns' headings, caption,
 * and empty text. The current cycle is "this cycle"; a past one is named by its dates, since "this
 * cycle" and "last cycle" would be wrong for it. Calendar months say "month".
 */
export function periodNames(cycle: Pick<SpendCycle, 'start' | 'end' | 'current'>, mode: CycleMode): PeriodNames {
  const unit = mode === 'calendar_month' ? 'month' : 'cycle';
  if (cycle.current) {
    return { current: `this ${unit}`, previous: `last ${unit}`, currentHeading: `This ${unit}`, previousHeading: `Last ${unit}`, empty: `Nothing spent this ${unit}.` };
  }
  const label = cycleLabel(cycle, mode);
  return {
    current: label,
    previous: `the previous ${unit}`,
    currentHeading: label,
    previousHeading: `Previous ${unit}`,
    empty: `Nothing spent ${mode === 'calendar_month' ? 'in' : 'from'} ${label}.`,
  };
}

/** "Moved Pets up. It's now 2 of 12." `index` is where it was (from 0), before the move. */
export function movedLine(name: string, direction: 'up' | 'down', index: number, count: number): string {
  const now = direction === 'up' ? index : index + 2;
  return `Moved ${name} ${direction}. It's now ${now} of ${count}.`;
}

export function personName(person: Pick<SpendPerson, 'displayName' | 'active'> | null): string {
  if (!person) return 'Household';
  return person.active ? person.displayName : `${person.displayName} (deactivated)`;
}

/** Why a field has its value, next to the picker; empty for the default. */
export function sourceNote(source: FieldSource): string {
  switch (source) {
    case 'manual':
      return 'Set by hand';
    case 'rule':
      return 'By a rule';
    case 'mapping':
      return 'From the bank';
    default:
      return '';
  }
}

/** "Updated 3 days ago" from the card's last import (by the server's clock), or that nothing's been imported. */
export function updatedLine(updatedAt: string | null, now: number): string {
  return updatedAt ? `Updated ${formatAgo(updatedAt, now)}` : 'Nothing imported yet';
}

/** "Visa ·1234", or just the nickname. */
export function cardName(card: { nickname: string; mask: string | null }): string {
  return card.mask ? `${card.nickname} ·${card.mask}` : card.nickname;
}

/**
 * The line under a CSV preview row that looks like a stored transaction: a duplicate (left out
 * unless ticked), or a `POSSIBLE_DUPLICATE` warning on a new row (ticked), with the stored one it
 * looks like. Null for anything else.
 */
export function previewNote(row: PreviewRow): string | null {
  if (!row.duplicateOf) return null;
  const label = row.status === 'duplicate' ? 'Looks like one already here' : row.status === 'new' && row.reason === POSSIBLE_DUPLICATE ? POSSIBLE_DUPLICATE : null;
  if (!label) return null;
  const d = row.duplicateOf;
  return `${label}: ${shortDate(d.date)}, ${d.merchant}, ${money(d.amountCents)}`;
}

/** The line under the totals naming the category left out of them, by its current name (review C-M6). Null until the categories load. */
export function excludedNote(categories: readonly { name: string; kind: CategoryKind }[]): string | null {
  const excluded = categories.find((c) => c.kind === 'excluded');
  return excluded ? `The ${excluded.name} category isn't counted.` : null;
}

/** How many transactions the totals leave out for being in another currency, or null when none. */
export function otherCurrencyLine(count: number): string | null {
  if (count <= 0) return null;
  return `${count} ${count === 1 ? 'transaction is' : 'transactions are'} in another currency and not counted.`;
}

/**
 * The fields "Remove rule" (reset to automatic) offers (review C-M8): those set by hand, and those a rule or the
 * bank's mapping set to a value that can't be assigned any more (an archived category, a
 * deactivated person), which are kept until something decides them again. Household always can be.
 */
export function resettableFields(t: SpendTransaction): ('category' | 'person')[] {
  const fields: ('category' | 'person')[] = [];
  if (t.categorySource === 'manual' || (t.categorySource !== 'default' && t.category.archived)) fields.push('category');
  if (t.personSource === 'manual' || (t.personSource !== 'default' && t.person !== null && !t.person.active)) fields.push('person');
  return fields;
}

/** A card's saved columns in words, one role a line, for its Imports area. */
export function mappingLines(header: readonly string[], m: CardMapping): string[] {
  const col = (c: number) => columnName(header, c);
  return [
    `Date: ${col(m.date.column)}, written ${CSV_DATE_FORMAT_LABELS[m.date.format]}`,
    m.amount.kind === 'signed'
      ? `Amount: ${col(m.amount.column)}, purchases ${m.amount.purchasesNegative ? 'negative' : 'positive'}`
      : `Amount: ${col(m.amount.charges)} for charges, ${col(m.amount.credits)} for payments and credits`,
    `Description: ${col(m.description)}`,
    m.reference === null ? 'Reference number: none, so each row gets a key from its date, amount, and description' : `Reference number: ${col(m.reference)}`,
    `Address: ${m.address === null ? 'none' : col(m.address)}`,
  ];
}

/** Where the upload's answer filled the columns in from (shown only with that answer); null when saved columns didn't fit, whose message says so instead. */
export function prefilledNote(p: Pick<ImportPreview, 'prefilled' | 'format' | 'columns'>): string | null {
  if (p.columns.problem) return null;
  if (p.prefilled === 'profile') return "Read with this card's saved columns. If something looks wrong, change the columns.";
  if (p.prefilled === 'builtin' && p.format === 'bofa_credit') return "This is a Bank of America credit card file, so it's read the way Bank of America writes it.";
  return p.columns.suggested ? 'The columns are a guess from their names. Check each one.' : null;
}

/** How many lines after the table were skipped as a footer (a count from the server, never their contents), or null for none. */
export function skippedNote(c: Pick<ImportColumns, 'trailingSkipped'>): string | null {
  const n = c.trailingSkipped;
  if (n === 0) return null;
  return `${n} ${n === 1 ? 'line after the table was' : 'lines after the table were'} skipped, as a footer.`;
}
