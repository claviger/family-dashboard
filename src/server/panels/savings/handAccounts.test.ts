import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { SAVINGS_MAX_BALANCE_CENTS, SAVINGS_MESSAGES, SavingsSettingsViewSchema } from '../../../shared/savings.js';
import { savingsAccounts, savingsBalances, savingsImports } from '../../db/schema.js';
import { addUser, makeTestApp } from '../../test/helpers.js';
import { setFamilySettings } from '../../settings.js';
import { addCsvImport, linkSavingsForTest } from '../../test/savingsFixtures.js';
import { savingsSettingsView, updateSavingsAccount, type SavingsViewDeps } from './connections.js';
import { addHandAccount, removeHandAccount, setSavingsBalance } from './handAccounts.js';
import { undoSavingsImport } from './imports.js';
import { putSnapshot } from './store.js';

// Synthetic. The clock is 2026-11-15 12:00 UTC; the family time zone is UTC. No Plaid unless asked.
function setup(opts: { plaid?: boolean } = {}) {
  const t = makeTestApp({ plaid: opts.plaid ?? false });
  const admin = addUser(t.db, t.clock, { email: 'alex@example.com', role: 'admin' });
  const v: SavingsViewDeps = { db: t.db, clock: t.clock, logger: t.logger, plaid: t.plaid ?? null };
  return { t, admin, v };
}
const view = (v: SavingsViewDeps) => SavingsSettingsViewSchema.parse(savingsSettingsView(v));
const balances = (s: ReturnType<typeof setup>) => s.t.db.select().from(savingsBalances).all().map((b) => [b.date, b.currentCents, b.source]);

describe('hand-added accounts', () => {
  it('adds one with no Plaid configured, and lists it in Savings settings', () => {
    const s = setup();
    addHandAccount(s.v, s.admin, { nickname: 'Hand brokerage', kind: 'investment' });
    expect(s.t.db.select().from(savingsAccounts).get()).toMatchObject({ source: 'manual', plaidItemId: null, plaidAccountId: null, nickname: 'Hand brokerage', kind: 'investment', mask: null });
    expect(view(s.v)).toMatchObject({
      plaidConfigured: false, keyMismatch: false, trial: null, connections: [], removed: [], notices: [], imports: [], profiles: [],
      handAccounts: [{ nickname: 'Hand brokerage', kind: 'investment', hidden: false, removed: false, latest: null }],
    });
  });

  it('renames and hides it like a linked account', () => {
    const s = setup();
    addHandAccount(s.v, s.admin, { nickname: 'Hand cash', kind: 'cash' });
    const id = view(s.v).handAccounts[0]!.id;
    updateSavingsAccount(s.v, id, { nickname: 'Rainy day' });
    expect(view(s.v).handAccounts[0]).toMatchObject({ nickname: 'Rainy day', hidden: false });
    updateSavingsAccount(s.v, id, { hidden: true });
    expect(view(s.v).handAccounts[0]).toMatchObject({ hidden: true });
  });

  it('sets a balance for today or a chosen day, never a future day or one Plaid has', () => {
    const s = setup();
    addHandAccount(s.v, s.admin, { nickname: 'Hand brokerage', kind: 'investment' });
    const id = view(s.v).handAccounts[0]!.id;
    setSavingsBalance(s.v, s.admin, id, { amount: '25,000.00' });
    setSavingsBalance(s.v, s.admin, id, { amount: ' $1,000 ', date: '2026-10-31' });
    expect(balances(s)).toEqual([['2026-11-15', 25000_00, 'manual'], ['2026-10-31', 1000_00, 'manual']]);
    expect(view(s.v).handAccounts[0]!.latest).toEqual({ date: '2026-11-15', cents: 25000_00, source: 'manual' });
    expect(() => setSavingsBalance(s.v, s.admin, id, { amount: 'lots' })).toThrow(SAVINGS_MESSAGES.balanceAmount);
    expect(() => setSavingsBalance(s.v, s.admin, id, { amount: '1', date: '2026-11-16' })).toThrow(SAVINGS_MESSAGES.balanceFuture);
    expect(() => setSavingsBalance(s.v, s.admin, id, { amount: '1', date: '1999-12-31' })).toThrow(SAVINGS_MESSAGES.balanceTooOld);
    putSnapshot(s.t.db, id, '2026-11-14', { currentCents: 5_00, availableCents: null }, s.t.clock.now());
    expect(() => setSavingsBalance(s.v, s.admin, id, { amount: '1', date: '2026-11-14' })).toThrow(SAVINGS_MESSAGES.balanceFromPlaid);
    expect(() => setSavingsBalance(s.v, s.admin, 999, { amount: '1' })).toThrow(SAVINGS_MESSAGES.accountNotFound);
  });

  it('takes over an imported day, which an Undo then leaves', () => {
    const s = setup();
    addHandAccount(s.v, s.admin, { nickname: 'Hand cash', kind: 'cash' });
    const id = view(s.v).handAccounts[0]!.id;
    const record = addCsvImport(s.t, id, s.admin, { balances: [{ date: '2026-10-31', cents: 1_00 }, { date: '2026-11-01', cents: 2_00 }] });
    setSavingsBalance(s.v, s.admin, id, { amount: '3.00', date: '2026-10-31' });
    undoSavingsImport(s.t, s.admin, id, record.id);
    expect(balances(s)).toEqual([['2026-10-31', 3_00, 'manual']]);
  });

  it('removes one keeping its data, or deletes it with its data, and refuses a linked account', () => {
    const s = setup();
    addHandAccount(s.v, s.admin, { nickname: 'Kept', kind: 'cash' });
    addHandAccount(s.v, s.admin, { nickname: 'Gone', kind: 'cash' });
    const [kept, gone] = view(s.v).handAccounts;
    setSavingsBalance(s.v, s.admin, kept!.id, { amount: '1' });
    addCsvImport(s.t, gone!.id, s.admin, { balances: [{ date: '2026-11-01', cents: 2_00 }] });
    removeHandAccount(s.v, s.admin, kept!.id, { deleteData: false });
    removeHandAccount(s.v, s.admin, gone!.id, { deleteData: true });
    expect(view(s.v).handAccounts).toEqual([expect.objectContaining({ nickname: 'Kept', removed: true })]);
    expect(balances(s)).toEqual([['2026-11-15', 1_00, 'manual']]);
    expect(s.t.db.select().from(savingsImports).all()).toEqual([]);
    expect(() => removeHandAccount(s.v, s.admin, kept!.id, { deleteData: true })).toThrow(SAVINGS_MESSAGES.accountNotFound);

    const p = setup({ plaid: true });
    const linked = linkSavingsForTest(p.t, p.admin);
    expect(() => removeHandAccount(p.v, p.admin, linked.accounts[0]!.id, { deleteData: true })).toThrow(SAVINGS_MESSAGES.linkedRemove);
    expect(p.t.db.select().from(savingsAccounts).where(eq(savingsAccounts.id, linked.accounts[0]!.id)).get()?.removedAt).toBeNull();
  });
});

describe('Set balance, and the view without Plaid (Batch C review)', () => {
  it('takes "today" in the family time zone, near midnight', () => {
    const s = setup();
    setFamilySettings(s.t.db, { name: 'The Family', timeZone: 'America/Los_Angeles' });
    s.t.clock.set(new Date('2026-11-16T03:00:00Z'));
    addHandAccount(s.v, s.admin, { nickname: 'Hand cash', kind: 'cash' });
    const id = view(s.v).handAccounts[0]!.id;
    setSavingsBalance(s.v, s.admin, id, { amount: '10' });
    expect(balances(s)).toEqual([['2026-11-15', 10_00, 'manual']]);
    expect(() => setSavingsBalance(s.v, s.admin, id, { amount: '1', date: '2026-11-16' })).toThrow(SAVINGS_MESSAGES.balanceFuture);
  });

  it('takes an overdrawn (negative) balance and a large one, up to its own limit', () => {
    const s = setup();
    addHandAccount(s.v, s.admin, { nickname: 'Hand cash', kind: 'cash' });
    const id = view(s.v).handAccounts[0]!.id;
    setSavingsBalance(s.v, s.admin, id, { amount: '-250.00', date: '2026-11-01' });
    // Over Spend's per-transaction limit, and exactly the balance limit.
    setSavingsBalance(s.v, s.admin, id, { amount: '25,000,000', date: '2026-11-02' });
    setSavingsBalance(s.v, s.admin, id, { amount: '$1,000,000,000.00', date: '2026-11-03' });
    expect(balances(s)).toEqual([['2026-11-01', -250_00, 'manual'], ['2026-11-02', 25_000_000_00, 'manual'], ['2026-11-03', SAVINGS_MAX_BALANCE_CENTS, 'manual']]);
    expect(() => setSavingsBalance(s.v, s.admin, id, { amount: '1,000,000,000.01' })).toThrow(SAVINGS_MESSAGES.balanceTooBig);
    expect(() => setSavingsBalance(s.v, s.admin, id, { amount: '-1000000000.01' })).toThrow(SAVINGS_MESSAGES.balanceTooBig);
    expect(SAVINGS_MESSAGES.balanceTooBig).toContain('$1,000,000,000.00');
  });

  it('sets a balance on a linked account for a day Plaid doesn\'t have, and on a hidden account', () => {
    const p = setup({ plaid: true });
    const linked = linkSavingsForTest(p.t, p.admin);
    const id = linked.accounts[0]!.id;
    setSavingsBalance(p.v, p.admin, id, { amount: '12.00', date: '2026-10-01' });
    updateSavingsAccount(p.v, id, { hidden: true });
    setSavingsBalance(p.v, p.admin, id, { amount: '13.00', date: '2026-10-02' });
    expect(p.t.db.select().from(savingsBalances).all().filter((b) => b.source === 'manual').map((b) => [b.date, b.currentCents])).toEqual([['2026-10-01', 12_00], ['2026-10-02', 13_00]]);
  });

  it('without Plaid, lists only hand-added accounts\' imports and saved settings', () => {
    const p = setup({ plaid: true });
    const linked = linkSavingsForTest(p.t, p.admin);
    addCsvImport(p.t, linked.accounts[0]!.id, p.admin, { balances: [{ date: '2026-09-01', cents: 1_00 }] });
    addHandAccount(p.v, p.admin, { nickname: 'Hand cash', kind: 'cash' });
    const hand = view(p.v).handAccounts[0]!.id;
    addCsvImport(p.t, hand, p.admin, { balances: [{ date: '2026-09-01', cents: 2_00 }] });
    expect(view(p.v).imports.map((i) => i.accountId).sort()).toEqual([linked.accounts[0]!.id, hand].sort());
    const off = view({ ...p.v, plaid: null });
    expect(off).toMatchObject({ plaidConfigured: false, connections: [] });
    expect(off.imports.map((i) => i.accountId)).toEqual([hand]);
  });
});
