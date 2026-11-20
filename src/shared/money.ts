/**
 * Money as whole cents (spec §12.3): integers, never floating point, so sums are exact. Positive
 * means money spent. Used by the server (CSV amounts) and the web (formatting, the rule form).
 */

/** An optional minus, then digits with optional groups of three after commas, then up to two decimals. */
const AMOUNT = /^(-?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/;

/**
 * The largest amount one transaction may have, either way: $10,000,000.00. No family's card
 * transaction comes near it, and with it, adding up millions of transactions stays exact
 * (`Number.MAX_SAFE_INTEGER` is about 9 x 10^15 cents).
 */
export const MAX_AMOUNT_CENTS = 1_000_000_000;

/**
 * Parses an amount written in dollars ("12.74", "-1,234.5", "5") into cents, from the text alone
 * (no float multiplication). Null for anything else: a currency symbol, a plus sign, spaces,
 * exponents, misplaced commas, more than two decimals, or more than `MAX_AMOUNT_CENTS` either way.
 */
export function parseCents(text: string): number | null {
  return parseCentsUpTo(text, MAX_AMOUNT_CENTS);
}

/**
 * `parseCents` with another limit, either way (Savings' Set balance, whose limit isn't one
 * transaction's). `maxCents` must be a safe integer.
 */
export function parseCentsUpTo(text: string, maxCents: number): number | null {
  const m = AMOUNT.exec(text);
  if (!m) return null;
  const dollars = m[2]!.replaceAll(',', '');
  const cents = (m[3] ?? '').padEnd(2, '0');
  // Long digit strings are refused before Number() could round them.
  if (dollars.replace(/^0+/, '').length > String(Math.floor(maxCents / 100)).length) return null;
  const value = Number(dollars) * 100 + Number(cents);
  if (value > maxCents) return null;
  return m[1] === '-' && value !== 0 ? -value : value;
}

/**
 * Parses what a person typed for an amount, e.g. in the rule form: like `parseCents`, but spaces
 * around it and a leading "$" (after any minus sign) are fine.
 */
export function parseCentsInput(text: string): number | null {
  return parseCents(normalizeInput(text));
}

/** `parseCentsInput` with another limit (see `parseCentsUpTo`). */
export function parseCentsInputUpTo(text: string, maxCents: number): number | null {
  return parseCentsUpTo(normalizeInput(text), maxCents);
}

/**
 * Whether what a person typed is written as an amount (what `parseCentsInput` accepts), however
 * big. So a form can tell "not an amount" from "over the limit".
 */
export function isAmountInput(text: string): boolean {
  return AMOUNT.test(normalizeInput(text));
}

function normalizeInput(text: string): string {
  return text.trim().replace(/^(-?)\s*\$\s*/, '$1');
}

/** "$1,234.56", "-$12.74". `currency` is an ISO 4217 code; anything Intl doesn't know is shown as USD. */
export function formatCents(cents: number, currency = 'USD', locale = 'en-US'): string {
  let format: Intl.NumberFormat;
  try {
    format = new Intl.NumberFormat(locale, { style: 'currency', currency });
  } catch {
    format = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' });
  }
  // -0 would read "-$0.00".
  return format.format(cents === 0 ? 0 : cents / 100);
}

/** Cents as the plain decimal text a form field starts with: 1250 is "12.50", -1 is "-0.01". */
export function centsToInput(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
