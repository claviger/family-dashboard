import type { CsvDateFormat } from '../../../shared/csvImport.js';
import type { CardMapping, ImportPreview } from '../../../shared/spend.js';

/**
 * The columns step's form logic (the generic import design, "Map columns"), kept pure so it's
 * unit-tested: the form's starting values, with the ambiguous-date rule (plan decision 8), and the
 * mapping it sends. CsvImport.tsx renders it. The server checks every row.
 */

/** A column index, or '' for none chosen. */
type Col = number | '';

export interface CardMapForm {
  date: Col;
  format: CsvDateFormat | '';
  kind: 'signed' | 'split';
  amount: Col;
  purchasesNegative: boolean;
  charges: Col;
  credits: Col;
  description: Col;
  reference: Col;
  address: Col;
}

/**
 * The form's start: the draft's mapping (saved, built in, or the admin's own before Change the
 * columns), else the server's suggestion. A date column that fits both M/D and D/M starts with no
 * format unless the draft's own mapping says which: a suggestion's guess is never trusted there.
 */
export function formFromPreview(p: Pick<ImportPreview, 'mapping' | 'columns'>): CardMapForm {
  const m = p.mapping ?? p.columns.suggested;
  const fits = m ? p.columns.dateFormats[m.date.column] ?? [] : [];
  const format: CardMapForm['format'] = !m ? '' : p.mapping && fits.includes(p.mapping.date.format) ? p.mapping.date.format : fits.length === 1 ? fits[0]! : '';
  return {
    date: m?.date.column ?? '',
    format,
    kind: m?.amount.kind ?? 'signed',
    amount: m?.amount.kind === 'signed' ? m.amount.column : '',
    purchasesNegative: m?.amount.kind === 'signed' ? m.amount.purchasesNegative : false,
    charges: m?.amount.kind === 'split' ? m.amount.charges : '',
    credits: m?.amount.kind === 'split' ? m.amount.credits : '',
    description: m?.description ?? '',
    reference: m?.reference ?? '',
    address: m?.address ?? '',
  };
}

/** The mapping the form sends, or what to choose first. */
export function mappingFromForm(v: CardMapForm): { ok: true; mapping: CardMapping } | { ok: false; problem: string } {
  if (v.date === '' || v.format === '') return { ok: false, problem: 'Choose the date column and how its dates are written.' };
  if (v.kind === 'signed' ? v.amount === '' : v.charges === '' || v.credits === '') {
    return { ok: false, problem: 'Choose the amount column, or the charges and the payments and credits columns.' };
  }
  if (v.description === '') return { ok: false, problem: 'Choose the description or payee column.' };
  return {
    ok: true,
    mapping: {
      date: { column: v.date, format: v.format },
      amount: v.kind === 'signed' ? { kind: 'signed', column: v.amount as number, purchasesNegative: v.purchasesNegative } : { kind: 'split', charges: v.charges as number, credits: v.credits as number },
      description: v.description,
      reference: v.reference === '' ? null : v.reference,
      address: v.address === '' ? null : v.address,
    },
  };
}
