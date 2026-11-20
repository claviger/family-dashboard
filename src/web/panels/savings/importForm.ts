import type { SavingsAccountKind, SavingsDateFormat, SavingsGroupChoice, SavingsImportDraft, SavingsImportGroup, SavingsMapping } from '../../../shared/savings.js';
import { importStep } from './format.js';

/**
 * The import steps' form logic, kept pure so it's unit-tested: the columns form's starting values
 * (with the ambiguous-date rule), the mapping it sends, the step after each answer, and the groups
 * form's starting choices. CsvImport.tsx renders them.
 */

/** A column index, or '' for none chosen. */
type Col = number | '';

export interface MapForm {
  date: Col;
  format: SavingsDateFormat | '';
  kind: 'signed' | 'split';
  amount: Col;
  inIsNegative: boolean;
  debit: Col;
  credit: Col;
  balance: Col;
  isValue: boolean;
  description: Col;
}

/**
 * The columns form's start: the draft's mapping (saved, built-in, or the admin's own before Back),
 * else the server's suggestion. A date column that fits both M/D and D/M starts with no format
 * unless the draft's own mapping already says which (plan decision 8): a suggestion's guess is
 * never trusted there. An investment's balance column isn't its value unless said so.
 */
export function formFromDraft(d: Pick<SavingsImportDraft, 'mapping' | 'suggested' | 'dateFormats'>, kind: SavingsAccountKind): MapForm {
  const m = d.mapping ?? d.suggested;
  const fits = m ? d.dateFormats[m.date.column] ?? [] : [];
  const format: MapForm['format'] = !m ? '' : d.mapping && fits.includes(d.mapping.date.format) ? d.mapping.date.format : fits.length === 1 ? fits[0]! : '';
  return {
    date: m?.date.column ?? '',
    format,
    kind: m?.amount.kind ?? 'signed',
    amount: m?.amount.kind === 'signed' ? m.amount.column : '',
    inIsNegative: m?.amount.kind === 'signed' ? m.amount.inIsNegative : false,
    debit: m?.amount.kind === 'split' ? m.amount.debit : '',
    credit: m?.amount.kind === 'split' ? m.amount.credit : '',
    balance: m?.balance?.column ?? '',
    isValue: kind === 'cash' ? true : m?.balance?.isValue ?? false,
    description: m?.description ?? '',
  };
}

/** The mapping the columns form sends, or what to choose first. The server checks every row and that no column has two roles. */
export function mappingFromForm(v: MapForm, kind: SavingsAccountKind): { ok: true; mapping: SavingsMapping } | { ok: false; problem: string } {
  if (v.date === '' || v.format === '') return { ok: false, problem: 'Choose the date column and how its dates are written.' };
  if (v.kind === 'signed' ? v.amount === '' : v.debit === '' || v.credit === '') return { ok: false, problem: 'Choose the amount column, or the debit and credit columns.' };
  return {
    ok: true,
    mapping: {
      date: { column: v.date, format: v.format },
      amount: v.kind === 'signed' ? { kind: 'signed', column: v.amount as number, inIsNegative: v.inIsNegative } : { kind: 'split', debit: v.debit as number, credit: v.credit as number },
      balance: v.balance === '' ? null : { column: v.balance, isValue: kind === 'cash' ? true : v.isValue },
      description: v.description === '' ? null : v.description,
    },
  };
}

/**
 * The step after a PUT's answer. A columns change always goes through the groups (the server
 * marks the draft groups-pending, plan decision 14), so only an answer to the choices can show
 * the results.
 */
export function stepAfterUpdate(d: Pick<SavingsImportDraft, 'mapping' | 'groups' | 'results'>, sentChoices: boolean): 'map' | 'groups' | 'results' {
  const step = importStep(d);
  return step === 'results' && !sentChoices ? 'groups' : step;
}

/** The groups form's start: each group's choice, or for a new one (choice null) the suggestion, preselected and marked New. */
export function groupChoicesFrom(groups: readonly SavingsImportGroup[]): Record<string, SavingsGroupChoice> {
  return Object.fromEntries(groups.map((g) => [g.label, g.choice ?? g.suggested]));
}
