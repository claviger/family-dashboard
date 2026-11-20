/**
 * SYNTHETIC credit card exports from issuers other than Bank of America, for the generic importer's
 * tests. Not real exports: the layouts are common shapes (Debit and Credit columns with D/M/YYYY
 * dates; one signed Amount column with purchases positive), and every merchant and amount is
 * invented. Never commit a real export.
 */

export const DEBIT_CREDIT_HEADER = 'Transaction Date,Description,Category,Debit,Credit';

export interface DebitCreditLine {
  /** D/M/YYYY, or '' for one that hasn't posted. */
  date: string;
  description: string;
  category?: string;
  debit?: string;
  credit?: string;
}

/** A Debit and Credit file: a comma in a value is quoted, like any CSV value with one. */
export function debitCreditCsv(lines: readonly DebitCreditLine[], opts: { eol?: string; preamble?: readonly string[] } = {}): string {
  const eol = opts.eol ?? '\r\n';
  const cell = (v: string | undefined) => (v === undefined ? '' : v.includes(',') ? `"${v}"` : v);
  const body = lines.map((l) => [l.date, cell(l.description), l.category ?? 'Shopping', cell(l.debit), cell(l.credit)].join(','));
  return `${[...(opts.preamble ?? []), DEBIT_CREDIT_HEADER, ...body].join(eol)}${eol}`;
}

/**
 * 13 to 17 October 2026, D/M/YYYY (a day over 12, so the format is clear): a coffee, a big
 * purchase with a thousands separator, two identical coffees on one day, a payment, and a refund the
 * issuer wrote as negative in its Credit column.
 */
export const DEBIT_CREDIT_SAMPLE: DebitCreditLine[] = [
  { date: '13/10/2026', description: 'CORNER CAFE 0042', category: 'Dining', debit: '4.50' },
  { date: '14/10/2026', description: 'BOOK NOOK', debit: '1,024.99' },
  { date: '15/10/2026', description: 'CORNER CAFE 0042', category: 'Dining', debit: '4.50' },
  { date: '15/10/2026', description: 'CORNER CAFE 0042', category: 'Dining', debit: '4.50' },
  { date: '16/10/2026', description: 'ONLINE PAYMENT THANK YOU', category: 'Payment', credit: '500.00' },
  { date: '17/10/2026', description: 'HARDWARE BARN #12', category: 'Home', credit: '-12.00' },
];

export const SIGNED_HEADER = 'Date,Merchant,Amount';

/** One signed Amount column with purchases positive (the opposite of Bank of America's), YYYY-MM-DD. */
export function signedCsv(lines: readonly { date: string; merchant: string; amount: string }[]): string {
  return `${[SIGNED_HEADER, ...lines.map((l) => `${l.date},${l.merchant},${l.amount.includes(',') ? `"${l.amount}"` : l.amount}`)].join('\n')}\n`;
}
