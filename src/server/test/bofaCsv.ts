/**
 * SYNTHETIC Bank of America credit-card activity CSVs, for tests. Not a real export: the shape is
 * built from what docs/research/spend-plaid-csv.md §1 documents (the header, MM/DD/YYYY dates,
 * purchases negative, 23-digit reference numbers, a quoted and space-padded Payee and Address, a
 * left-padded unquoted Amount, `TEMPRET` temporary credits). Merchants and numbers are made up.
 */

export interface BofaLine {
  /** MM/DD/YYYY, or '' for a temporary credit. */
  date: string;
  reference: string;
  payee: string;
  address?: string;
  /** As BofA writes it: purchases negative, e.g. '-12.74' or '-1,234.56'. */
  amount: string;
}

export const BOFA_HEADER_LINE = 'Posted Date,Reference Number,Payee,Address,Amount';

/** A 23-digit reference number, unique per `seed` and `n`. */
export function reference(seed: number, n: number): string {
  return `2469216${String(seed).padStart(8, '0')}${String(n).padStart(8, '0')}`;
}

/**
 * The file's text. `pad` writes the 2012 sample's padding (Payee 22 characters, Address 15, the
 * Amount right-aligned in 10); `eol` and `bom` vary what's unverified.
 */
export function bofaCsv(lines: BofaLine[], opts: { eol?: string; bom?: boolean; pad?: boolean } = {}): string {
  const eol = opts.eol ?? '\r\n';
  const pad = opts.pad ?? true;
  const body = lines.map((l) => {
    const payee = pad ? l.payee.padEnd(22) : l.payee;
    const address = pad ? (l.address ?? '').padEnd(15) : (l.address ?? '');
    const amount = pad ? l.amount.padStart(10) : l.amount;
    // A comma in the amount needs quotes, like any CSV value with one.
    return `${l.date},${l.reference},"${payee}","${address}",${amount.includes(',') ? `"${amount}"` : amount}`;
  });
  return `${opts.bom ? '\uFEFF' : ''}${[BOFA_HEADER_LINE, ...body].join(eol)}${eol}`;
}

export function bytes(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}
