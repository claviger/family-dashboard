import { addDays } from '../../../shared/dates.js';

/**
 * The duplicate test (spec §12.13). A CSV row is a likely duplicate of a stored transaction when
 * they're on the same card, for the same amount, no more than `dateWindowDays` apart, with similar
 * merchant text, and the bank hasn't said they differ (both have reference numbers, and they're
 * different). Pure. Phase 6b uses the same test to match a Plaid transaction to a CSV row.
 *
 * Matching is one to one: each incoming row takes the nearest-date stored transaction that passes,
 * and a stored transaction matched once isn't offered again, so two same-amount tolls a day apart
 * don't both match one stored toll.
 *
 * The thresholds are constants so they can be tuned once real files have been seen.
 */
export const DUPLICATE_TEST = {
  dateWindowDays: 3,
  /** Similar if one normalized string starts with the other's first this many characters, with or without spaces. */
  prefixChars: 8,
  /** ...or if at least this share of the larger set of words is in both. */
  wordShare: 0.5,
} as const;

export type DuplicateTest = { dateWindowDays: number; prefixChars: number; wordShare: number };

/** Uppercase; anything that isn't a letter or digit becomes a space; runs of spaces collapse. */
export function normalizeMerchant(text: string): string {
  return text.toUpperCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** A merchant text normalized once: with spaces, without them ("CVS/PHARMACY" is "CVSPHARMACY"), and its words. */
interface Normalized {
  spaced: string;
  compact: string;
  words: Set<string>;
}

function normalized(text: string): Normalized {
  const spaced = normalizeMerchant(text);
  return { spaced, compact: spaced.replaceAll(' ', ''), words: new Set(spaced.split(' ')) };
}

function startsAlike(a: string, b: string, chars: number): boolean {
  return b.startsWith(a.slice(0, chars)) || a.startsWith(b.slice(0, chars));
}

function similarNormalized(a: Normalized, b: Normalized, test: DuplicateTest): boolean {
  if (a.spaced === '' || b.spaced === '') return false;
  if (startsAlike(a.spaced, b.spaced, test.prefixChars) || startsAlike(a.compact, b.compact, test.prefixChars)) return true;
  const shared = [...a.words].filter((w) => b.words.has(w)).length;
  // Of the larger set, so a lone shared word like a state code doesn't make two long names alike.
  return shared >= test.wordShare * Math.max(a.words.size, b.words.size);
}

export function similarMerchants(a: string, b: string, test: DuplicateTest = DUPLICATE_TEST): boolean {
  return similarNormalized(normalized(a), normalized(b), test);
}

export interface DuplicateCandidate {
  id: number;
  cardId: number;
  date: string;
  amountCents: number;
  /** The merchant name, or the raw description when there's none. */
  merchant: string;
  /**
   * The stored row's raw description too, when it has a merchant name as well (a Plaid row's
   * `name`): a row is alike when it's similar to either. Plaid often cleans the merchant name past
   * recognizing ("Tinynonsens" for the bank's "PAYPAL *TINYNONSENS 207-200-"), while its raw name
   * keeps the bank's text. Absent or null: the merchant text only.
   */
  rawName?: string | null;
  /** The bank's reference number (a CSV row's), or null (a Plaid row's). */
  reference?: string | null;
}

export type DuplicateRow = Omit<DuplicateCandidate, 'id'>;

/** Different reference numbers mean different transactions; a missing one says nothing. */
function referencesAllow(a: string | null | undefined, b: string | null | undefined): boolean {
  return !a || !b || a === b;
}

/**
 * How many free stored candidates one row may test, across its whole date window (used ones are
 * skipped without testing). Only a bucket with more than this many free rows of one card and
 * amount within a week that aren't alike, ahead of one that is, comes near it; the bound keeps a
 * file of 20,000 same-amount rows linear.
 */
export const SCAN_LIMIT = 64;

/**
 * `taken`: matched by a row, so it can't match another. `warned`: named in a possible-duplicate
 * warning, so it isn't named in another. They're kept apart: a warning doesn't stop a match.
 */
type Entry = { candidate: DuplicateCandidate; texts: Normalized[]; taken: boolean; warned: boolean };

/** `e`'s merchant text, or its raw name, is similar to `text`. */
function entryAlike(e: Entry, text: Normalized, test: DuplicateTest): boolean {
  return e.texts.some((t) => similarNormalized(t, text, test));
}

/**
 * The work a matcher has done, so its tests can check it stays linear without timing it:
 * `tested`, free candidates compared with a row; `skipped`, steps taken past used ones.
 */
export interface MatcherWork {
  tested: number;
  skipped: number;
}

/**
 * Entries in the order they were added. Used ones stay in place, and `nextFree` jumps over them:
 * `skip[i]` is never past the first free entry at or after `i`, and is compressed as it's walked,
 * so skipping used entries costs next to nothing however many there are or wherever they sit.
 */
class EntryList {
  readonly items: Entry[] = [];
  private readonly skip: number[] = [];

  push(e: Entry): void {
    this.skip.push(this.items.length);
    this.items.push(e);
  }

  /**
   * The first index at or after `i` whose entry isn't `used`, or `items.length`. Being used never
   * ends, and each list is only ever scanned with one `used`, so the jumps stay right.
   */
  nextFree(i: number, used: (e: Entry) => boolean, work: MatcherWork): number {
    const path: number[] = [];
    let j = i;
    while (j < this.items.length && used(this.items[j]!)) {
      work.skipped++;
      path.push(j);
      j = Math.max(j + 1, this.skip[j]!);
    }
    for (const k of path) this.skip[k] = j;
    return j;
  }
}

/** One card, amount, and date. */
interface Day {
  /** Every candidate, for a row without a reference (a Plaid row in 6b). */
  all: EntryList;
  /** Candidates without a reference, which any row may match. */
  noReference: EntryList;
  /** Candidates with one, by exact reference: a row with a reference may match only its own. */
  byReference: Map<string, EntryList>;
  /** Candidates with one, for `differentReference`. */
  withReference: EntryList;
}

const taken = (e: Entry) => e.taken;
const takenOrWarned = (e: Entry) => e.taken || e.warned;

/** The first entry in `list` not `used` that passes `ok`, spending one of `budget.left` per free entry tested. */
function scan(list: EntryList | undefined, budget: { left: number }, used: (e: Entry) => boolean, ok: (e: Entry) => boolean, work: MatcherWork): Entry | null {
  if (!list) return null;
  for (let i = list.nextFree(0, used, work); i < list.items.length && budget.left > 0; i = list.nextFree(i + 1, used, work)) {
    budget.left--;
    work.tested++;
    const e = list.items[i]!;
    if (ok(e)) return e;
  }
  return null;
}

/**
 * Stored transactions to match rows against, each at most once. Candidates are kept by card and
 * amount, then by date, with their text normalized once. Within a day, rows without a reference
 * number are kept apart, and rows with one are found by it, so a row with a reference never walks
 * past stored rows that the bank says are different. No row tests more than `SCAN_LIMIT`
 * candidates, so a 20,000-row file against 20,000 stored rows is a few lookups per row.
 */
export class DuplicateMatcher {
  private readonly byAmount = new Map<string, Map<string, Day>>();
  /** What every call so far has done (see `MatcherWork`). */
  readonly work: MatcherWork = { tested: 0, skipped: 0 };

  constructor(
    stored: readonly DuplicateCandidate[],
    private readonly test: DuplicateTest = DUPLICATE_TEST,
  ) {
    for (const candidate of stored) {
      const key = `${candidate.cardId}:${candidate.amountCents}`;
      let byDate = this.byAmount.get(key);
      if (!byDate) this.byAmount.set(key, (byDate = new Map()));
      let day = byDate.get(candidate.date);
      if (!day) byDate.set(candidate.date, (day = { all: new EntryList(), noReference: new EntryList(), byReference: new Map(), withReference: new EntryList() }));
      const texts = [normalized(candidate.merchant)];
      if (candidate.rawName && candidate.rawName !== candidate.merchant) texts.push(normalized(candidate.rawName));
      const entry: Entry = { candidate, texts, taken: false, warned: false };
      day.all.push(entry);
      if (!candidate.reference) {
        day.noReference.push(entry);
      } else {
        let same = day.byReference.get(candidate.reference);
        if (!same) day.byReference.set(candidate.reference, (same = new EntryList()));
        same.push(entry);
        day.withReference.push(entry);
      }
    }
  }

  /** The days in `row`'s window, nearest first (the earlier on a tie). */
  private *days(row: DuplicateRow): Generator<Day> {
    const byDate = this.byAmount.get(`${row.cardId}:${row.amountCents}`);
    if (!byDate) return;
    for (let gap = 0; gap <= this.test.dateWindowDays; gap++) {
      for (const date of gap === 0 ? [row.date] : [addDays(row.date, -gap), addDays(row.date, gap)]) {
        const day = byDate.get(date);
        if (day) yield day;
      }
    }
  }

  /** The nearest-date candidate `row` duplicates, which then can't match another row; or null. */
  match(row: DuplicateRow): DuplicateCandidate | null {
    const text = normalized(row.merchant);
    const alike = (e: Entry) => entryAlike(e, text, this.test);
    const budget = { left: SCAN_LIMIT };
    for (const day of this.days(row)) {
      const hit = row.reference
        ? (scan(day.byReference.get(row.reference), budget, taken, alike, this.work) ?? scan(day.noReference, budget, taken, alike, this.work))
        : scan(day.all, budget, taken, alike, this.work);
      if (hit) {
        hit.taken = true;
        return hit.candidate;
      }
      if (budget.left <= 0) break;
    }
    return null;
  }

  /**
   * The nearest-date candidate that passes every part of the test except the reference number:
   * both have one, and they differ. That isn't a duplicate (the bank says they're different), so
   * nothing is taken; the importer shows it as a warning, so a bank that renumbers transactions
   * between downloads shows up. Warnings are one to one too: a stored row named once (or taken by a
   * match) isn't named again, so two renumbered tolls point at two stored ones. Null when `row` has
   * no reference.
   */
  differentReference(row: DuplicateRow): DuplicateCandidate | null {
    if (!row.reference) return null;
    const text = normalized(row.merchant);
    const budget = { left: SCAN_LIMIT };
    for (const day of this.days(row)) {
      const hit = scan(day.withReference, budget, takenOrWarned, (e) => !referencesAllow(e.candidate.reference, row.reference) && entryAlike(e, text, this.test), this.work);
      if (hit) {
        hit.warned = true;
        return hit.candidate;
      }
      if (budget.left <= 0) break;
    }
    return null;
  }
}

/** The stored transaction one row most likely duplicates (the nearest in date), or null. */
export function findDuplicate(row: DuplicateRow, stored: readonly DuplicateCandidate[], test: DuplicateTest = DUPLICATE_TEST): DuplicateCandidate | null {
  return new DuplicateMatcher(stored, test).match(row);
}
