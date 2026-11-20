import type { CardMapping, SpendImportFormat } from '../../../shared/spend.js';

/**
 * Bank of America's credit card activity CSV (spec §12.13, research §1) as a built-in format (the
 * generic import design): its exact header and its mapping, read by the generic path (cardCsv.ts).
 * Everything about the format is community-sourced (research §1); "Verify with a real export" in the
 * phase 6a plan lists what to check against a real file.
 */

export const BOFA_HEADER = ['Posted Date', 'Reference Number', 'Payee', 'Address', 'Amount'] as const;

/** BofA's checking and savings export starts with one of these lines (research §1.3). */
const CHECKING_HEADERS = [
  ['Description', '', 'Summary Amt.'],
  ['Date', 'Description', 'Amount', 'Running Bal.'],
];

export const BOFA_MESSAGES = {
  mostlyCredits:
    'Most rows in this file are credits. Bank of America lists purchases as negative amounts, so check the amounts below before importing.',
} as const;

function sameCells(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** A built-in card format (the generic import design, "Built-in formats"): data, recognized by its exact header. */
export interface CardFormat {
  id: Exclude<SpendImportFormat, 'custom'>;
  name: string;
  header: readonly string[];
  mapping: CardMapping;
  /**
   * Whether its files can end with a footer. Without one (Bank of America's), every non-blank line
   * after the table's last row is listed as an unreadable row, by line and why, as the old reader did;
   * with one, those lines are skipped and counted.
   */
  hasFooter: boolean;
}

/** Bank of America's credit card export: M/D/YYYY, purchases negative, a 23-digit reference number (research §1). */
export const BOFA_FORMAT: CardFormat = {
  id: 'bofa_credit',
  name: 'Bank of America credit card',
  header: BOFA_HEADER,
  hasFooter: false,
  mapping: { date: { column: 0, format: 'mdy' }, amount: { kind: 'signed', column: 4, purchasesNegative: true }, description: 2, reference: 1, address: 3 },
};

export const CARD_FORMATS: readonly CardFormat[] = [BOFA_FORMAT];

/** The built-in format whose header is exactly this one (after trimming), or null. */
export function cardFormatFor(header: readonly string[]): CardFormat | null {
  return CARD_FORMATS.find((f) => sameCells(header.map((h) => h.trim()), f.header)) ?? null;
}

/** BofA's checking and savings export: the columns step says those belong in Savings (plan decision 16). */
export function looksLikeBofaChecking(header: readonly string[]): boolean {
  const trimmed = header.map((h) => h.trim());
  return CHECKING_HEADERS.some((h) => sameCells(trimmed, h));
}
