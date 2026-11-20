import { eq } from 'drizzle-orm';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { SAVINGS_MESSAGES, SavingsImportDraftSchema, type SavingsMapping } from '../../../shared/savings.js';
import { savingsAccounts, savingsBalances, savingsFlows, savingsImportPreviews, savingsImportProfiles, savingsImports } from '../../db/schema.js';
import { BANK_FILE, BROKERAGE_FILE, bytes, CASH_FILE, CASH_HEADER, CASH_SAMPLE, cashLine, fidelityFile } from '../../test/importCsv.js';
import { addUser, makeTestApp, type TestApp } from '../../test/helpers.js';
import { addHandAccount, addSavingsAccount, addSavingsItem } from '../../test/savingsFixtures.js';
import { CSV_TABLE_MESSAGES } from './csvTable.js';
import { BUILT_IN_FORMATS } from './importFormats.js';
import {
  cancelSavingsImport, clearImportProfile, commitSavingsImport, importProfilesOf, listSavingsImports, pruneSavingsImportPreviews, startSavingsImport,
  undoSavingsImport, updateImportProfile, updateSavingsImport, type SavingsImportDeps,
} from './imports.js';
import { putSnapshot, upsertFlow } from './store.js';

// Synthetic files (src/server/test/importCsv.ts). The clock is 2026-11-15 12:00 UTC; the family time zone is UTC.
const BANK: SavingsMapping = { date: { column: 0, format: 'dmy' }, amount: { kind: 'split', debit: 2, credit: 3 }, balance: { column: 4, isValue: true }, description: 1 };

function setup(opts: { logger?: pino.Logger } = {}) {
  const t = makeTestApp({ logger: opts.logger });
  const admin = addUser(t.db, t.clock, { email: 'alex@example.com', role: 'admin', displayName: 'Alex' });
  const other = addUser(t.db, t.clock, { email: 'other@example.com', role: 'admin' });
  const deps: SavingsImportDeps = t;
  return { t, admin, other, deps };
}
type Setup = ReturnType<typeof setup>;
const start = (s: Setup, accountId: number, text: string, fileName: string | null = 'History_for_Account_X00000001.csv', userId = s.admin) =>
  SavingsImportDraftSchema.parse(startSavingsImport(s.deps, userId, { accountId, fileName, bytes: bytes(text) }));
const update = (s: Setup, id: string, body: Parameters<typeof updateSavingsImport>[3]) => SavingsImportDraftSchema.parse(updateSavingsImport(s.deps, s.admin, id, body));
const flowRows = (t: TestApp) => t.db.select().from(savingsFlows).all().map((f) => [f.source, f.date, f.kind, f.amountCents]);
const balanceRows = (t: TestApp) => t.db.select().from(savingsBalances).all().map((b) => [b.source, b.date, b.currentCents]);

describe('importing a bank\'s CSV with its own columns', () => {
  it('starts with the sample, each column\'s date formats, and a suggested mapping, nothing saved', () => {
    const s = setup();
    const hand = addHandAccount(s.t, { kind: 'cash', nickname: 'Hand cash' });
    const d = start(s, hand.id, BANK_FILE, 'statement.csv');
    expect(d).toMatchObject({
      account: { id: hand.id, nickname: 'Hand cash', kind: 'cash' }, fileName: 'statement.csv', rows: 6, header: ['Date', 'Description', 'Debit', 'Credit', 'Balance'],
      format: 'custom', prefilled: 'guess', mapping: null, suggested: BANK, problem: null, groups: null, results: null, expiresAt: '2026-11-15T13:00:00.000Z',
    });
    expect(d.sample).toHaveLength(6);
    expect(d.sample[0]).toEqual(['13/10/2026', 'OPENING TRANSFER FROM SAVINGS', '', '1,000.00', '1,000.00']);
    expect(d.dateFormats).toEqual([['dmy'], [], [], [], []]);
    expect(flowRows(s.t)).toEqual([]);
  });

  it('takes the mapping, lists the groups with suggestions, then the choices, then shows the results', () => {
    const s = setup();
    const hand = addHandAccount(s.t, { kind: 'cash' });
    const d = start(s, hand.id, BANK_FILE);
    const mapped = update(s, d.id, { mapping: BANK });
    expect(mapped.groups).toEqual([
      { label: 'CARD PURCHASE', count: 2, choice: null, suggested: 'by_sign' }, { label: 'ATM WITHDRAWAL', count: 1, choice: null, suggested: 'by_sign' },
      { label: 'INTEREST PAID', count: 1, choice: null, suggested: 'not_counted' }, { label: 'OPENING TRANSFER', count: 1, choice: null, suggested: 'by_sign' },
      { label: 'SALARY EXAMPLE', count: 1, choice: null, suggested: 'by_sign' },
    ]);
    expect(mapped.results).toBeNull();
    const choices = Object.fromEntries(mapped.groups!.map((g) => [g.label, g.suggested]));
    expect(() => update(s, d.id, { mapping: BANK, choices: { 'CARD PURCHASE': 'by_sign' } })).toThrow(SAVINGS_MESSAGES.importChooseEvery);
    const ready = update(s, d.id, { mapping: BANK, choices });
    expect(ready.results).toEqual({
      dateRange: { from: '2026-10-13', to: '2026-11-05' },
      deposits: { add: 2, already: 0 }, withdrawals: { add: 3, already: 0 }, balances: { add: 5, skipped: 0 }, warnings: [],
    });
    expect(() => update(s, d.id, { mapping: { ...BANK, date: { column: 0, format: 'mdy' } } })).toThrow(SAVINGS_MESSAGES.mapBadDate(5, 'M/D/YYYY'));
  });

  it('never takes a guessed date format when the dates fit both M/D and D/M: the admin chooses (plan decision 8)', () => {
    const s = setup();
    const hand = addHandAccount(s.t, { kind: 'cash' });
    const ambiguous = ['Date,Description,Amount,Balance', '01/02/2026,PAY IN,10.00,10.00', '03/04/2026,PAY OUT,-5.00,5.00', ''].join('\n');
    const d = start(s, hand.id, ambiguous);
    expect(d).toMatchObject({ prefilled: 'guess', mapping: null, groups: null, results: null });
    expect(d.dateFormats[0]).toEqual(['mdy', 'dmy']);
    const m: SavingsMapping = { date: { column: 0, format: 'dmy' }, amount: { kind: 'signed', column: 2, inIsNegative: false }, balance: { column: 3, isValue: true }, description: 1 };
    const chosen = update(s, d.id, { mapping: m, choices: { 'PAY IN': 'by_sign', 'PAY OUT': 'by_sign' } });
    expect(chosen.results!.dateRange).toEqual({ from: '2026-02-01', to: '2026-04-03' });
  });

  it('records the file\'s first and last day even when nothing on those days is stored', () => {
    const s = setup();
    const hand = addHandAccount(s.t, { kind: 'cash' });
    const text = ['Date,Description,Amount', '2026-09-30,FEE WAIVED,0.00', '2026-10-05,PAY IN,100.00', '2026-11-02,FEE WAIVED,0.00'].join('\n');
    const d = start(s, hand.id, text, 'edges.csv');
    const m: SavingsMapping = { date: { column: 0, format: 'ymd' }, amount: { kind: 'signed', column: 2, inIsNegative: false }, balance: null, description: 1 };
    update(s, d.id, { mapping: m, choices: { 'FEE WAIVED': 'by_sign', 'PAY IN': 'by_sign' } });
    commitSavingsImport(s.deps, s.admin, d.id);
    expect(flowRows(s.t)).toEqual([['csv', '2026-10-05', 'deposit', 100_00]]);
    expect(s.t.db.select().from(savingsImports).get()).toMatchObject({ firstDate: '2026-09-30', lastDate: '2026-11-02' });
  });

  it('imports, records it, saves the account\'s settings, and the next file with the same header goes straight to the results', () => {
    const s = setup();
    const hand = addHandAccount(s.t, { kind: 'cash' });
    const d = start(s, hand.id, BANK_FILE, 'statement.csv');
    const mapped = update(s, d.id, { mapping: BANK });
    update(s, d.id, { mapping: BANK, choices: Object.fromEntries(mapped.groups!.map((g) => [g.label, g.suggested])) });
    expect(commitSavingsImport(s.deps, s.admin, d.id)).toBe('Imported statement.csv: 2 deposits, 3 withdrawals, and 5 daily balances added.');
    const record = s.t.db.select().from(savingsImports).get()!;
    expect(record).toMatchObject({ accountId: hand.id, layout: 'custom', depositsAdded: 2, withdrawalsAdded: 3, balancesAdded: 5, skipped: 0 });
    // The file's own days, first to last, for the months it covers.
    expect(record).toMatchObject({ firstDate: '2026-10-13', lastDate: '2026-11-05' });
    expect(flowRows(s.t).filter((f) => f[3] === 45_10)).toHaveLength(2);
    expect(s.t.db.select().from(savingsImportPreviews).all()).toEqual([]);
    expect(importProfilesOf(s.t.db, [hand.id])).toEqual([expect.objectContaining({ accountId: hand.id, format: 'custom', mapping: BANK, header: ['Date', 'Description', 'Debit', 'Credit', 'Balance'] })]);
    // The saved profile holds two-word labels, never the rest of a description.
    expect(JSON.stringify(s.t.db.select().from(savingsImportProfiles).get())).not.toMatch(/FROM SAVINGS|SHOP|5678|EMPLOYER/);

    const again = start(s, hand.id, BANK_FILE);
    expect(again).toMatchObject({ prefilled: 'profile', mapping: BANK, results: { deposits: { add: 0, already: 2 }, withdrawals: { add: 0, already: 3 }, balances: { add: 0, skipped: 5 } } });
    expect(again.groups!.every((g) => g.choice !== null)).toBe(true);
    expect(() => commitSavingsImport(s.deps, s.admin, again.id)).toThrow(SAVINGS_MESSAGES.importNothingNew);
  });

  it('asks about a group the saved settings haven\'t seen, and keeps the old choices with the new', () => {
    const s = setup();
    const hand = addHandAccount(s.t, { kind: 'cash' });
    s.t.db.insert(savingsImportProfiles).values({
      accountId: hand.id, header: ['Date', 'Description', 'Debit', 'Credit', 'Balance'], format: 'custom', mapping: BANK,
      choices: { 'CARD PURCHASE': 'withdrawal', 'OLD GROUP': 'not_counted' }, updatedByUserId: s.admin, createdAt: s.t.clock.now(), updatedAt: s.t.clock.now(),
    }).run();
    const d = start(s, hand.id, BANK_FILE);
    expect(d).toMatchObject({ prefilled: 'profile', mapping: BANK, results: null });
    expect(d.groups!.find((g) => g.label === 'CARD PURCHASE')).toMatchObject({ choice: 'withdrawal' });
    expect(d.groups!.find((g) => g.label === 'SALARY EXAMPLE')).toMatchObject({ choice: null, suggested: 'by_sign' });
    update(s, d.id, { mapping: BANK, choices: Object.fromEntries(d.groups!.map((g) => [g.label, g.choice ?? g.suggested])) });
    commitSavingsImport(s.deps, s.admin, d.id);
    expect(s.t.db.select().from(savingsImportProfiles).get()!.choices).toMatchObject({ 'OLD GROUP': 'not_counted', 'CARD PURCHASE': 'withdrawal', 'SALARY EXAMPLE': 'by_sign' });
  });

  it('says why saved columns don\'t fit a file, and opens the columns step with them', () => {
    const s = setup();
    const hand = addHandAccount(s.t, { kind: 'cash' });
    s.t.db.insert(savingsImportProfiles).values({
      accountId: hand.id, header: ['Date', 'Description', 'Debit', 'Credit', 'Balance'], format: 'custom', mapping: { ...BANK, date: { column: 0, format: 'mdy' } },
      choices: {}, updatedByUserId: s.admin, createdAt: s.t.clock.now(), updatedAt: s.t.clock.now(),
    }).run();
    const d = start(s, hand.id, BANK_FILE);
    expect(d).toMatchObject({ prefilled: 'profile', mapping: null, suggested: { date: { format: 'mdy' } }, problem: SAVINGS_MESSAGES.savedMappingDoesntFit(SAVINGS_MESSAGES.mapBadDate(5, 'M/D/YYYY')) });
  });

  it('edits and clears the saved settings', () => {
    const s = setup();
    const hand = addHandAccount(s.t, { kind: 'cash' });
    s.t.db.insert(savingsImportProfiles).values({
      accountId: hand.id, header: ['Date', 'Description', 'Debit', 'Credit', 'Balance'], format: 'custom', mapping: BANK,
      choices: { 'CARD PURCHASE': 'by_sign' }, updatedByUserId: s.admin, createdAt: s.t.clock.now(), updatedAt: s.t.clock.now(),
    }).run();
    updateImportProfile(s.deps, s.admin, hand.id, { 'CARD PURCHASE': 'not_counted' });
    expect(importProfilesOf(s.t.db, [hand.id])[0]!.groups).toEqual([{ label: 'CARD PURCHASE', choice: 'not_counted' }]);
    expect(() => updateImportProfile(s.deps, s.admin, hand.id, { NEW: 'by_sign' })).toThrow(SAVINGS_MESSAGES.profileUnknownGroup);
    // Only the profile's own labels: never an Object.prototype name.
    expect(() => updateImportProfile(s.deps, s.admin, hand.id, Object.fromEntries([['constructor', 'deposit' as const]]))).toThrow(SAVINGS_MESSAGES.profileUnknownGroup);
    expect(() => updateImportProfile(s.deps, s.admin, hand.id, JSON.parse('{"__proto__": "deposit", "toString": "deposit"}'))).toThrow(SAVINGS_MESSAGES.profileUnknownGroup);
    expect(importProfilesOf(s.t.db, [hand.id])[0]!.groups).toEqual([{ label: 'CARD PURCHASE', choice: 'not_counted' }]);
    clearImportProfile(s.deps, s.admin, hand.id);
    expect(importProfilesOf(s.t.db, [hand.id])).toEqual([]);
    expect(() => clearImportProfile(s.deps, s.admin, hand.id)).toThrow(SAVINGS_MESSAGES.profileNotFound);
  });
});

describe('importing Fidelity\'s files (built-in formats)', () => {
  it('goes straight to the results for a cash management file, every group decided', () => {
    const s = setup();
    const hand = addHandAccount(s.t, { kind: 'cash' });
    const d = start(s, hand.id, CASH_FILE);
    expect(d).toMatchObject({
      format: 'fidelity_cash', prefilled: 'builtin', problem: null,
      results: { dateRange: { from: '2026-10-28', to: '2026-11-12' }, deposits: { add: 2, already: 0 }, withdrawals: { add: 5, already: 0 }, balances: { add: 7, skipped: 0 }, warnings: [] },
    });
    expect(d.groups!.find((g) => g.label === 'INTEREST EARNED')).toMatchObject({ choice: 'not_counted' });
    expect(commitSavingsImport(s.deps, s.admin, d.id)).toBe('Imported History_for_Account_X00000001.csv: 2 deposits, 5 withdrawals, and 7 daily balances added.');
    expect(s.t.db.select().from(savingsImports).get()!.layout).toBe('fidelity_cash');
    expect(balanceRows(s.t)).toContainEqual(['csv', '2026-11-12', 4200_00]);
  });

  it('counts only a brokerage file\'s transfers, and goes custom when the admin changes the columns', () => {
    const s = setup();
    const hand = addHandAccount(s.t, { kind: 'investment' });
    const d = start(s, hand.id, BROKERAGE_FILE);
    expect(d).toMatchObject({ format: 'fidelity_brokerage', results: { deposits: { add: 1 }, withdrawals: { add: 1 }, balances: { add: 0, skipped: 0 } } });
    // Its Cash Balance as the value: no longer the built-in format, the groups keep their choices, and 6 days get a balance (not Processing's).
    const value = { ...d.mapping!, balance: { column: 15, isValue: true } };
    const changed = update(s, d.id, { mapping: value });
    expect(changed.format).toBe('custom');
    expect(changed.groups!.every((g) => g.choice !== null)).toBe(true);
    // A columns change always goes back to the groups step (plan decision 14), and the draft remembers where it started.
    expect(changed).toMatchObject({ prefilled: 'builtin', results: null });
    expect(() => commitSavingsImport(s.deps, s.admin, d.id)).toThrow(SAVINGS_MESSAGES.importNotReady);
    const confirmed = update(s, d.id, { mapping: value, choices: Object.fromEntries(changed.groups!.map((g) => [g.label, g.choice!])) });
    expect(confirmed).toMatchObject({ prefilled: 'builtin' });
    expect(confirmed.results!.balances.add).toBe(6);
  });

  it('warns about a Fidelity file on the other kind of account, or another account\'s number', () => {
    const s = setup();
    const item = addSavingsItem(s.t);
    const cash = addSavingsAccount(s.t, item.id, { plaidAccountId: 'acct-cash', kind: 'cash', nickname: 'Cash', mask: '4321' });
    expect(start(s, cash.id, BROKERAGE_FILE, 'History_for_Account_X00009999.csv').results!.warnings.map((w) => w.message)).toEqual([
      SAVINGS_MESSAGES.importBrokerageFormatOnCash('Cash'), SAVINGS_MESSAGES.importAccountMismatch('9999', '4321'),
    ]);
    expect(start(s, cash.id, CASH_FILE, 'History_for_Account_X00004321.csv').results!.warnings).toEqual([]);
  });
});

describe('overlap, Undo, and the draft\'s rules', () => {
  it('skips a flow Plaid already has, and balances from the first Plaid balance or on a hand-set day', () => {
    const s = setup();
    const item = addSavingsItem(s.t);
    const cash = addSavingsAccount(s.t, item.id, { plaidAccountId: 'acct-cash', kind: 'cash', mask: '0001' });
    upsertFlow(s.t.db, { accountId: cash.id, source: 'transactions', plaidId: 'tx-pay', date: '2026-11-13', kind: 'deposit', amountCents: 1500_00 }, s.t.clock.now());
    putSnapshot(s.t.db, cash.id, '2026-11-03', { currentCents: 2753_95, availableCents: null }, s.t.clock.now());
    s.t.db.insert(savingsBalances).values({ accountId: cash.id, date: '2026-10-30', currentCents: 1, fetchedAt: s.t.clock.now(), source: 'manual' }).run();
    const d = start(s, cash.id, CASH_FILE);
    expect(d.results).toMatchObject({ deposits: { add: 1, already: 1 }, withdrawals: { add: 5, already: 0 }, balances: { add: 3, skipped: 4 } });
    commitSavingsImport(s.deps, s.admin, d.id);
    expect(balanceRows(s.t).filter((b) => b[0] === 'csv').map((b) => b[1])).toEqual(['2026-10-28', '2026-11-01', '2026-11-02']);
  });

  it('undoes an import: exactly its rows go, and the file can come in again', () => {
    const s = setup();
    const hand = addHandAccount(s.t, { kind: 'cash' });
    commitSavingsImport(s.deps, s.admin, start(s, hand.id, CASH_FILE).id);
    const record = s.t.db.select().from(savingsImports).get()!;
    expect(listSavingsImports(s.t.db, [hand.id])).toEqual([expect.objectContaining({ id: record.id, format: 'fidelity_cash', uploadedBy: 'Alex', flowsLeft: 7, balancesLeft: 7 })]);
    expect(undoSavingsImport(s.deps, s.admin, hand.id, record.id)).toBe('Undid the import of History_for_Account_X00000001.csv: removed 7 deposits and withdrawals and 7 daily balances.');
    expect(flowRows(s.t)).toEqual([]);
    expect(balanceRows(s.t)).toEqual([]);
    expect(() => undoSavingsImport(s.deps, s.admin, hand.id, record.id)).toThrow(SAVINGS_MESSAGES.importRecordNotFound);
    expect(start(s, hand.id, CASH_FILE).results).toMatchObject({ deposits: { add: 2 }, balances: { add: 7 } });
  });

  it('binds a draft to its admin for an hour, one at a time; refuses an unfinished one; Cancel forgets it', () => {
    const s = setup();
    const hand = addHandAccount(s.t, { kind: 'cash' });
    const first = start(s, hand.id, BANK_FILE);
    expect(() => commitSavingsImport(s.deps, s.admin, first.id)).toThrow(SAVINGS_MESSAGES.importNotReady);
    expect(() => updateSavingsImport(s.deps, s.other, first.id, { mapping: BANK })).toThrow(SAVINGS_MESSAGES.importNotFound);
    const second = start(s, hand.id, CASH_FILE);
    expect(() => commitSavingsImport(s.deps, s.admin, first.id)).toThrow(SAVINGS_MESSAGES.importNotFound);
    cancelSavingsImport(s.deps, s.admin, second.id);
    expect(() => commitSavingsImport(s.deps, s.admin, second.id)).toThrow(SAVINGS_MESSAGES.importNotFound);
    const third = start(s, hand.id, CASH_FILE);
    s.t.clock.advance(60 * 60_000);
    expect(() => commitSavingsImport(s.deps, s.admin, third.id)).toThrow(SAVINGS_MESSAGES.importNotFound);
    expect(pruneSavingsImportPreviews(s.deps)).toBe(1);
  });

  it('refuses a file with no table or that isn\'t text, a removed account, and logs nothing from the file', () => {
    const lines: string[] = [];
    const s = setup({ logger: pino({ level: 'debug' }, { write: (l: string) => lines.push(l) }) });
    const hand = addHandAccount(s.t, { kind: 'cash' });
    expect(() => start(s, hand.id, 'nothing here\n')).toThrow(CSV_TABLE_MESSAGES.noTable);
    expect(() => SavingsImportDraftSchema.parse(startSavingsImport(s.deps, s.admin, { accountId: hand.id, fileName: null, bytes: new Uint8Array([0xff]) }))).toThrow(CSV_TABLE_MESSAGES.notText);
    commitSavingsImport(s.deps, s.admin, start(s, hand.id, CASH_FILE).id);
    // Words from the file only: pino's timestamps could hold any digits.
    expect(lines.join('\n')).not.toMatch(/EXAMPLE|DEPOSIT|Check Paid|History_for_Account|Run Date/);
    s.t.db.update(savingsAccounts).set({ removedAt: s.t.clock.now() }).where(eq(savingsAccounts.id, hand.id)).run();
    expect(() => start(s, hand.id, CASH_FILE)).toThrow(SAVINGS_MESSAGES.accountNotFound);
  });
});

describe('saved choices through the steps, Undo over an overlap, and re-checks at Import', () => {
  const CASH = BUILT_IN_FORMATS[0]!;
  const CASH_LABELS = ['DEBIT CARD', 'CHECK PAID', 'DIRECT DEBIT', 'DIRECT DEPOSIT', 'INTEREST EARNED', 'TRANSFER OF', 'TRANSFERRED FROM', 'TRANSFERRED TO'];
  const profileChoices = (s: Setup) => s.t.db.select().from(savingsImportProfiles).get()!.choices;

  it('keeps a saved choice through a columns-only answer with the built-in mapping, goes back to the groups step, and saves it again', () => {
    const s = setup();
    const hand = addHandAccount(s.t, { kind: 'cash' });
    s.t.db.insert(savingsImportProfiles).values({
      accountId: hand.id, header: [...CASH.header], format: 'fidelity_cash', mapping: CASH.mapping,
      choices: { ...Object.fromEntries(CASH_LABELS.map((l) => [l, l === 'INTEREST EARNED' ? 'not_counted' : 'by_sign'] as const)), 'DEBIT CARD': 'not_counted' },
      updatedByUserId: s.admin, createdAt: s.t.clock.now(), updatedAt: s.t.clock.now(),
    }).run();
    const d = start(s, hand.id, CASH_FILE);
    expect(d).toMatchObject({ prefilled: 'profile', results: { withdrawals: { add: 3 } } });
    const again = update(s, d.id, { mapping: CASH.mapping });
    expect(again).toMatchObject({ prefilled: 'profile', results: null });
    expect(again.groups!.find((g) => g.label === 'DEBIT CARD')).toMatchObject({ choice: 'not_counted' });
    const ready = update(s, d.id, { mapping: CASH.mapping, choices: Object.fromEntries(again.groups!.map((g) => [g.label, g.choice!])) });
    expect(ready.results!.withdrawals.add).toBe(3);
    commitSavingsImport(s.deps, s.admin, d.id);
    expect(profileChoices(s)['DEBIT CARD']).toBe('not_counted');
  });

  it('suggests the built-in rule for a group a columns change makes new, without deciding it', () => {
    const s = setup();
    const hand = addHandAccount(s.t, { kind: 'cash' });
    const d = start(s, hand.id, CASH_FILE);
    // Descriptions from the Type column ("Cash"): one new group.
    const changed = update(s, d.id, { mapping: { ...CASH.mapping, description: 4 } });
    expect(changed.results).toBeNull();
    expect(changed.groups).toEqual([{ label: 'CASH', count: 9, choice: null, suggested: 'by_sign' }]);
  });

  it('copies into the draft only the saved choices of groups in the file, and Import merges into the profile as it is then', () => {
    const s = setup();
    const hand = addHandAccount(s.t, { kind: 'cash' });
    s.t.db.insert(savingsImportProfiles).values({
      accountId: hand.id, header: ['Date', 'Description', 'Debit', 'Credit', 'Balance'], format: 'custom', mapping: BANK,
      choices: { 'CARD PURCHASE': 'withdrawal', 'OLD GROUP': 'not_counted' }, updatedByUserId: s.admin, createdAt: s.t.clock.now(), updatedAt: s.t.clock.now(),
    }).run();
    const d = start(s, hand.id, BANK_FILE);
    expect(s.t.db.select().from(savingsImportPreviews).get()!.plan.choices).toEqual({ 'CARD PURCHASE': 'withdrawal' });
    // An Edit in settings while the draft is open.
    updateImportProfile(s.deps, s.admin, hand.id, { 'OLD GROUP': 'deposit' });
    update(s, d.id, { mapping: BANK, choices: Object.fromEntries(d.groups!.map((g) => [g.label, g.choice ?? g.suggested])) });
    commitSavingsImport(s.deps, s.admin, d.id);
    expect(profileChoices(s)).toMatchObject({ 'OLD GROUP': 'deposit', 'CARD PURCHASE': 'withdrawal', 'SALARY EXAMPLE': 'by_sign' });
  });

  it('keeps identical rows apart across two overlapping downloads: only the later file\'s extra one is new', () => {
    const s = setup();
    const hand = addHandAccount(s.t, { kind: 'cash' });
    const file = (gymRows: number) => ['Date,Description,Amount,Balance', '2026-11-02,PAY IN,100.00,100.00',
      ...Array.from({ length: gymRows }, () => '2026-11-03,EXAMPLE GYM,-27.60,72.40'), ''].join('\n');
    const m: SavingsMapping = { date: { column: 0, format: 'ymd' }, amount: { kind: 'signed', column: 2, inIsNegative: false }, balance: null, description: 1 };
    const run = (text: string) => {
      const d = start(s, hand.id, text);
      update(s, d.id, { mapping: m });
      return update(s, d.id, { mapping: m, choices: { 'PAY IN': 'by_sign', 'EXAMPLE GYM': 'by_sign' } });
    };
    commitSavingsImport(s.deps, s.admin, run(file(1)).id);
    const later = run(file(2));
    expect(later.results).toMatchObject({ deposits: { add: 0, already: 1 }, withdrawals: { add: 1, already: 1 } });
    commitSavingsImport(s.deps, s.admin, later.id);
    expect(flowRows(s.t).filter((f) => f[3] === 27_60)).toHaveLength(2);
    expect(start(s, hand.id, file(2)).results).toMatchObject({ withdrawals: { add: 0, already: 2 } });
  });

  it('says when Undo would take rows a later import skipped as already here', () => {
    const s = setup();
    const hand = addHandAccount(s.t, { kind: 'cash' });
    commitSavingsImport(s.deps, s.admin, start(s, hand.id, CASH_FILE).id);
    const first = s.t.db.select().from(savingsImports).get()!;
    expect(listSavingsImports(s.t.db, [hand.id])[0]).toMatchObject({ id: first.id, overlaps: 0 });
    // A later download: the same rows and a newer day.
    const newer = fidelityFile(CASH_HEADER, [cashLine({ date: '11/14/2026', action: 'DIRECT DEPOSIT EXAMPLE CORPPAYROLL (Cash)', amount: '10.00', balance: '4210.00' }), ...CASH_SAMPLE.map(cashLine)]);
    s.t.clock.advance(60_000);
    commitSavingsImport(s.deps, s.admin, start(s, hand.id, newer).id);
    expect(listSavingsImports(s.t.db, [hand.id]).map((r) => [r.id, r.overlaps])).toEqual([[first.id + 1, 0], [first.id, 1]]);
    expect(undoSavingsImport(s.deps, s.admin, hand.id, first.id)).toBe(
      `Undid the import of History_for_Account_X00000001.csv: removed 7 deposits and withdrawals and 7 daily balances. ${SAVINGS_MESSAGES.importUndoOverlaps}`,
    );
  });

  it('leaves a Plaid balance written over an imported one when the import is undone', () => {
    const s = setup();
    const item = addSavingsItem(s.t);
    const cash = addSavingsAccount(s.t, item.id, { plaidAccountId: 'acct-cash', kind: 'cash', mask: '0001' });
    commitSavingsImport(s.deps, s.admin, start(s, cash.id, CASH_FILE).id);
    putSnapshot(s.t.db, cash.id, '2026-11-12', { currentCents: 4201_00, availableCents: null }, s.t.clock.now());
    const record = s.t.db.select().from(savingsImports).get()!;
    expect(listSavingsImports(s.t.db, [cash.id])[0]).toMatchObject({ balancesLeft: 6 });
    undoSavingsImport(s.deps, s.admin, cash.id, record.id);
    expect(balanceRows(s.t)).toEqual([['plaid', '2026-11-12', 4201_00]]);
  });

  it('re-checks at Import: a Plaid flow that arrived after the results covers its twin', () => {
    const s = setup();
    const item = addSavingsItem(s.t);
    const cash = addSavingsAccount(s.t, item.id, { plaidAccountId: 'acct-cash', kind: 'cash', mask: '0001' });
    const d = start(s, cash.id, CASH_FILE);
    expect(d.results).toMatchObject({ deposits: { add: 2, already: 0 } });
    upsertFlow(s.t.db, { accountId: cash.id, source: 'transactions', plaidId: 'tx-late', date: '2026-11-13', kind: 'deposit', amountCents: 1500_00 }, s.t.clock.now());
    expect(commitSavingsImport(s.deps, s.admin, d.id)).toBe('Imported History_for_Account_X00000001.csv: 1 deposit, 5 withdrawals, and 7 daily balances added, 1 already here.');
    expect(flowRows(s.t).filter((f) => f[3] === 1500_00)).toEqual([['transactions', '2026-11-13', 'deposit', 1500_00]]);
  });
});
