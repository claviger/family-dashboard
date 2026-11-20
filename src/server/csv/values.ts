import { isLocalDate } from '../../shared/dates.js';
import { parseCents } from '../../shared/money.js';
import { CSV_DATE_FORMATS, type CsvDateFormat } from '../../shared/csvImport.js';

/**
 * Reading a CSV cell as money or a date, for both importers (the Savings plan's decisions 6 and 8;
 * the generic card import design). Pure. Nothing here logs or quotes a cell.
 */

/** A money cell (the Savings plan's decision 6): null when empty, 'bad' when it isn't money. */
export function parseMoney(text: string): number | null | 'bad' {
  let t = text.trim().replace(/−/g, '-');
  if (t === '') return null;
  // At most one negative marker: parentheses or a minus, never both or two minus signs ("(-5)" and "--5" are bad, not 5.00).
  let negatives = 0;
  if (/^\(.*\)$/.test(t)) {
    negatives++;
    t = t.slice(1, -1).trim();
  }
  const sign = () => {
    if (t.startsWith('-')) {
      negatives++;
      t = t.slice(1).trim();
    } else if (t.startsWith('+')) t = t.slice(1).trim();
  };
  sign();
  t = t.replace(/^[$€£¥]\s*/, '').replace(/\s*[$€£¥]$/, '');
  sign();
  if (negatives > 1) return 'bad';
  const cents = parseCents(t);
  if (cents === null || cents < 0) return 'bad';
  return negatives === 1 && cents !== 0 ? -cents : cents;
}

const DATE_PATTERNS: Record<CsvDateFormat, RegExp> = {
  ymd: /^(\d{4})-(\d{1,2})-(\d{1,2})$/,
  mdy: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
  dmy: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
};

/** A date cell in `format`, as YYYY-MM-DD, or null when it isn't a real day written that way. */
export function parseDate(text: string, format: CsvDateFormat): string | null {
  const m = DATE_PATTERNS[format].exec(text.trim());
  if (!m) return null;
  const [y, mo, d] = format === 'ymd' ? [m[1]!, m[2]!, m[3]!] : format === 'mdy' ? [m[3]!, m[1]!, m[2]!] : [m[3]!, m[2]!, m[1]!];
  const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  return isLocalDate(iso) ? iso : null;
}

/** The formats every non-empty value fits; none for a column with no values. Both `mdy` and `dmy`: ambiguous, the admin chooses. */
export function dateFormatsOf(values: readonly string[]): CsvDateFormat[] {
  const present = values.map((v) => v.trim()).filter((v) => v !== '');
  if (present.length === 0) return [];
  return CSV_DATE_FORMATS.filter((f) => present.every((v) => parseDate(v, f) !== null));
}
