import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { addDays, daysBetween } from '../../../shared/dates.js';
import { MAX_AMOUNT_CENTS } from '../../../shared/money.js';
import { NOTE_MAX } from '../../../shared/spend.js';
import { categories, plaidItems, rules, transactions, type PlaidItemAccount, type TransactionRow } from '../../db/schema.js';
import { PlaidClient, type PlaidTransaction } from '../../integrations/plaid/client.js';
import { FAKE_PLAID_CLIENT_ID, FAKE_PLAID_SECRET, FakePlaid } from '../../test/fakePlaid.js';
import { call, makeTestApp, type TestApp } from '../../test/helpers.js';
import { addCard, addCsvImport, addTransaction, categoryId, spendUser, transaction } from '../../test/spendFixtures.js';
import { DUPLICATE_TEST, similarMerchants } from './duplicates.js';
import { undoImport } from './imports.js';
import { applySyncRun, emptySyncCounts, pruneRemovedTransactions, REMOVED_KEEP_MS, type SyncApplyCounts, type SyncRun } from './plaidApply.js';

// Everything here is synthetic: the Items, accounts, merchants, and transaction ids.
// The test app's clock is 2026-11-15 12:00 UTC.

const DAY = 24 * 60 * 60 * 1000;
const COFFEE = { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_COFFEE', confidence_level: 'VERY_HIGH', version: 'v2' };

/** A posted Plaid transaction on `acct-1`, as the client returns it. */
function ptx(id: string, fields: Partial<PlaidTransaction> = {}): PlaidTransaction {
  return {
    transaction_id: id,
    account_id: 'acct-1',
    amount: 12.34,
    iso_currency_code: 'USD',
    unofficial_currency_code: null,
    date: '2026-11-10',
    authorized_date: null,
    pending: false,
    pending_transaction_id: null,
    merchant_name: 'Corner Cafe',
    name: 'CORNER CAFE 123',
    original_description: null,
    personal_finance_category: COFFEE,
    merchant_entity_id: null,
    logo_url: null,
    counterparties: [],
    ...fields,
  };
}

interface Changes {
  added?: PlaidTransaction[];
  modified?: PlaidTransaction[];
  removed?: string[];
}

function page(c: Changes) {
  return {
    added: c.added ?? [],
    modified: c.modified ?? [],
    removed: (c.removed ?? []).map((id) => ({ transaction_id: id, account_id: 'acct-1' })),
  };
}

/** One run of one page, or of several. */
function run(changes: Changes | Changes[], cursor = 'cursor-1', status: string | null = 'HISTORICAL_UPDATE_COMPLETE'): SyncRun {
  return { pages: (Array.isArray(changes) ? changes : [changes]).map(page), nextCursor: cursor, transactionsUpdateStatus: status };
}

/** The Item's account list, as `/accounts/get` gave it. */
function accountList(...ids: string[]): PlaidItemAccount[] {
  return ids.map((accountId) => ({
    accountId, name: `Account ${accountId}`, officialName: null, mask: null, type: 'credit', subtype: 'credit card', isoCurrencyCode: 'USD', unofficialCurrencyCode: null,
  }));
}

function setup() {
  const t = makeTestApp();
  const now = t.clock.now();
  const item = t.db.insert(plaidItems).values({
    plaidItemId: 'item-synthetic-1', institutionName: 'Example Bank', accounts: accountList('acct-1', 'acct-2'), pickedAt: now, createdAt: now, updatedAt: now,
  }).returning().get();
  const card = addCard(t, { nickname: 'Rewards', plaidItemId: item.id, plaidAccountId: 'acct-1' });
  const apply = (r: SyncRun) => applySyncRun(t, item, r);
  return { t, item, card, apply };
}

function byPlaid(t: TestApp, id: string): TransactionRow {
  const row = t.db.select().from(transactions).where(eq(transactions.plaidTransactionId, id)).get();
  if (!row) throw new Error(`no row ${id}`);
  return row;
}

function maybePlaid(t: TestApp, id: string): TransactionRow | undefined {
  return t.db.select().from(transactions).where(eq(transactions.plaidTransactionId, id)).get();
}

function allRows(t: TestApp): TransactionRow[] {
  return t.db.select().from(transactions).orderBy(asc(transactions.id)).all();
}

function itemRow(t: TestApp, id: number) {
  return t.db.select().from(plaidItems).where(eq(plaidItems.id, id)).get()!;
}

/** Sets fields by hand, as the drill-down's Save would. */
function edit(t: TestApp, id: number, set: Partial<typeof transactions.$inferInsert>) {
  t.db.update(transactions).set(set).where(eq(transactions.id, id)).run();
}

function counts(partial: Partial<SyncApplyCounts>): SyncApplyCounts {
  return { ...emptySyncCounts(), ...partial };
}

describe('applySyncRun: storing transactions (spec §12.3)', () => {
  it("stores a new transaction with Plaid's fields and its mapped category, and saves the cursor with it", () => {
    const { t, item, card, apply } = setup();
    const result = apply(run({
      added: [ptx('tx-1', {
        name: '  CORNER   CAFE\t123 ', authorized_date: '2026-11-09', merchant_entity_id: 'ent-synthetic', logo_url: 'https://logos.example/cafe.png',
        counterparties: [{ name: 'Corner Cafe', type: 'merchant' }],
      })],
    }, 'cursor-after'));
    expect(result).toEqual(counts({ added: 1 }));
    expect(byPlaid(t, 'tx-1')).toMatchObject({
      cardId: card.id, source: 'plaid', plaidAccountId: 'acct-1', pending: false, pendingTransactionId: null, date: '2026-11-10', authorizedDate: '2026-11-09',
      amountCents: 1234, isoCurrencyCode: 'USD', unofficialCurrencyCode: null, merchant: 'Corner Cafe', rawName: 'CORNER CAFE 123',
      plaidPfcPrimary: 'FOOD_AND_DRINK', plaidPfcDetailed: 'FOOD_AND_DRINK_COFFEE', plaidPfcConfidence: 'VERY_HIGH', plaidPfcVersion: 'v2',
      merchantEntityId: 'ent-synthetic', logoUrl: 'https://logos.example/cafe.png', counterparties: [{ name: 'Corner Cafe', type: 'merchant' }],
      // FOOD_AND_DRINK_COFFEE has no mapping of its own, so its primary's.
      categoryId: categoryId(t, 'Dining'), categorySource: 'mapping', personUserId: null, personSource: 'default', note: null,
      removedAt: null, deletedAt: null, replacedById: null, csvReference: null,
    });
    expect(itemRow(t, item.id)).toMatchObject({ cursor: 'cursor-after', transactionsStatus: 'HISTORICAL_UPDATE_COMPLETE', lastSyncAt: t.clock.now() });
  });

  it('saves a "" cursor as null, and keeps the stored status when Plaid sends none', () => {
    const { t, item, apply } = setup();
    apply(run({}, 'cursor-1', 'INITIAL_UPDATE_COMPLETE'));
    apply(run({}, '', null));
    expect(itemRow(t, item.id)).toMatchObject({ cursor: null, transactionsStatus: 'INITIAL_UPDATE_COMPLETE' });
  });

  it('falls back to the merchant name when Plaid has no name, and stores a blank merchant name as none', () => {
    const { t, apply } = setup();
    apply(run({ added: [ptx('tx-1', { name: null, merchant_name: ' Corner  Cafe ' }), ptx('tx-2', { merchant_name: '   ', amount: 5 })] }));
    expect(byPlaid(t, 'tx-1')).toMatchObject({ merchant: 'Corner Cafe', rawName: 'Corner Cafe' });
    expect(byPlaid(t, 'tx-2')).toMatchObject({ merchant: null, rawName: 'CORNER CAFE 123' });
  });

  it('decides categories by a rule first, then the mapping (detailed code, then primary), else Uncategorized (spec §12.9)', () => {
    const { t, apply } = setup();
    const now = t.clock.now();
    t.db.insert(rules).values({ position: 2, matchText: 'tutor', matchType: 'contains', setCategoryId: categoryId(t, 'Kids'), createdAt: now, updatedAt: now }).run();
    apply(run({
      added: [
        ptx('rule', { merchant_name: 'Math Tutor Co', personal_finance_category: { ...COFFEE } }),
        ptx('detailed', { merchant_name: 'Fresh Market', personal_finance_category: { ...COFFEE, detailed: 'FOOD_AND_DRINK_GROCERIES' } }),
        ptx('none', { merchant_name: 'Mystery', personal_finance_category: null }),
        ptx('payment', { merchant_name: null, name: 'PAYMENT THANK YOU', amount: -500, personal_finance_category: null }),
      ],
    }));
    expect(byPlaid(t, 'rule')).toMatchObject({ categoryId: categoryId(t, 'Kids'), categorySource: 'rule' });
    expect(byPlaid(t, 'detailed')).toMatchObject({ categoryId: categoryId(t, 'Groceries'), categorySource: 'mapping' });
    expect(byPlaid(t, 'none')).toMatchObject({ categoryId: categoryId(t, 'Uncategorized'), categorySource: 'default', plaidPfcPrimary: null, plaidPfcVersion: null });
    // Migration 0007's payment rule.
    expect(byPlaid(t, 'payment')).toMatchObject({ amountCents: -50_000, categoryId: categoryId(t, 'Payments and transfers'), categorySource: 'rule' });
  });

  it('treats an id it already has in added as modified, and adds a modified id it does not have', () => {
    const { t, apply } = setup();
    apply(run({ added: [ptx('tx-1')] }));
    const first = byPlaid(t, 'tx-1');
    t.clock.advance(DAY);
    expect(apply(run({ added: [ptx('tx-1', { amount: 15 })], modified: [ptx('tx-2')] }))).toEqual(counts({ added: 1, modified: 1 }));
    expect(byPlaid(t, 'tx-1')).toMatchObject({ id: first.id, amountCents: 1500, createdAt: first.createdAt, updatedAt: t.clock.now() });
    expect(byPlaid(t, 'tx-2').source).toBe('plaid');
    expect(allRows(t)).toHaveLength(2);
  });

  it("updates Plaid's fields on a modified row and decides it again, keeping what was set by hand and never erasing history", () => {
    const { t, apply } = setup();
    const kid = spendUser(t, { role: 'member', name: 'Kid' });
    apply(run({ added: [ptx('manual'), ptx('auto', { amount: 3 }), ptx('archived', { amount: 4 })] }));
    edit(t, byPlaid(t, 'manual').id, { categoryId: categoryId(t, 'Kids'), categorySource: 'manual', personUserId: kid.id, personSource: 'manual', note: 'Birthday' });
    const shopping = { primary: 'GENERAL_MERCHANDISE', detailed: 'GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE', confidence_level: 'HIGH', version: 'v2' };
    apply(run({ modified: [ptx('auto', { amount: 3, personal_finance_category: shopping })] }));
    expect(byPlaid(t, 'auto')).toMatchObject({ categoryId: categoryId(t, 'Shopping'), categorySource: 'mapping', plaidPfcPrimary: 'GENERAL_MERCHANDISE' });

    // Dining is archived now: a row that has it keeps it, whatever set it.
    t.db.update(categories).set({ archived: true }).where(eq(categories.id, categoryId(t, 'Dining'))).run();
    apply(run({
      modified: [
        ptx('manual', { amount: 20, merchant_name: 'Corner Cafe Downtown', personal_finance_category: shopping }),
        ptx('archived', { amount: 4, personal_finance_category: shopping }),
      ],
    }));
    expect(byPlaid(t, 'manual')).toMatchObject({
      amountCents: 2000, merchant: 'Corner Cafe Downtown', plaidPfcPrimary: 'GENERAL_MERCHANDISE',
      categoryId: categoryId(t, 'Kids'), categorySource: 'manual', personUserId: kid.id, personSource: 'manual', note: 'Birthday',
    });
    expect(byPlaid(t, 'archived')).toMatchObject({ categoryId: categoryId(t, 'Dining'), categorySource: 'mapping', plaidPfcPrimary: 'GENERAL_MERCHANDISE' });
  });

  it('stores an unofficial currency with a null ISO code, never the USD default, and a missing one as null', () => {
    const { t, apply } = setup();
    apply(run({
      added: [
        ptx('crypto', { iso_currency_code: null, unofficial_currency_code: 'SYN' }),
        ptx('none', { iso_currency_code: null, amount: 2 }),
        ptx('cad', { iso_currency_code: 'CAD', amount: 3 }),
      ],
    }));
    expect(byPlaid(t, 'crypto')).toMatchObject({ isoCurrencyCode: null, unofficialCurrencyCode: 'SYN' });
    expect(byPlaid(t, 'none')).toMatchObject({ isoCurrencyCode: null, unofficialCurrencyCode: null });
    expect(byPlaid(t, 'cad')).toMatchObject({ isoCurrencyCode: 'CAD' });
  });

  it('rounds amounts past the cent and counts them, keeps credits negative, and drops and counts amounts past the limit', () => {
    const { t, apply } = setup();
    const result = apply(run({
      added: [
        ptx('rounded', { amount: 4.105 }),
        ptx('credit', { amount: -25.5 }),
        ptx('tenth', { amount: 4.1 }),
        ptx('huge', { amount: MAX_AMOUNT_CENTS / 100 + 1 }),
      ],
    }));
    expect(result).toEqual(counts({ added: 3, roundedAmounts: 1, droppedAmounts: 1 }));
    expect(byPlaid(t, 'rounded').amountCents).toBe(411);
    expect(byPlaid(t, 'credit').amountCents).toBe(-2550);
    expect(byPlaid(t, 'tenth').amountCents).toBe(410);
    expect(maybePlaid(t, 'huge')).toBeUndefined();
  });

  it("drops and counts transactions of listed accounts that are skipped or on a removed card, and those with a date that isn't real", () => {
    const { t, item, apply } = setup();
    t.db.update(plaidItems).set({ accounts: accountList('acct-1', 'acct-skipped', 'acct-gone') }).where(eq(plaidItems.id, item.id)).run();
    addCard(t, { nickname: 'Gone', plaidItemId: item.id, plaidAccountId: 'acct-gone', removedAt: t.clock.now() });
    const result = apply(run({
      added: [
        ptx('skipped', { account_id: 'acct-skipped' }),
        ptx('gone', { account_id: 'acct-gone' }),
        ptx('bad-date', { date: '2026-02-30' }),
        ptx('bad-authorized', { authorized_date: '11/09/2026' }),
      ],
    }));
    expect(result).toEqual(counts({ added: 1, droppedAccounts: 2, unreadableDates: 1 }));
    expect(allRows(t).map((r) => r.plaidTransactionId)).toEqual(['bad-authorized']);
    expect(byPlaid(t, 'bad-authorized').authorizedDate).toBeNull();
    expect(itemRow(t, item.id).newAccountsAt).toBeNull();
  });

  it("drops and counts an account the Item's list doesn't have, notes new accounts once, and a resync after attaching it brings everything", () => {
    const { t, item, apply } = setup();
    const unknown = [ptx('new-1', { account_id: 'acct-new' }), ptx('new-2', { account_id: 'acct-new', amount: 5 })];
    expect(apply(run({ added: [...unknown, ptx('known')] }))).toEqual(counts({ added: 1, unknownAccounts: 2 }));
    const noticed = t.clock.now();
    expect(itemRow(t, item.id)).toMatchObject({ newAccountsAt: noticed, cursor: 'cursor-1' });
    t.clock.advance(DAY);
    // Already noted: the date stays.
    expect(apply(run({ added: [ptx('new-3', { account_id: 'acct-new', amount: 6 })] }, 'cursor-2'))).toEqual(counts({ unknownAccounts: 1 }));
    expect(itemRow(t, item.id).newAccountsAt).toEqual(noticed);
    // Loading the accounts lists it, attaching it asks for a full resync, and the pass from no cursor adds what was dropped.
    t.db.update(plaidItems).set({ accounts: accountList('acct-1', 'acct-2', 'acct-new'), cursor: null, newAccountsAt: null }).where(eq(plaidItems.id, item.id)).run();
    addCard(t, { nickname: 'New', plaidItemId: item.id, plaidAccountId: 'acct-new' });
    expect(apply(run({ added: [...unknown, ptx('new-3', { account_id: 'acct-new', amount: 6 }), ptx('known')] }, 'cursor-3'))).toEqual(counts({ added: 3, unchanged: 1 }));
    expect(itemRow(t, item.id).newAccountsAt).toBeNull();
  });

  it('treats an account the list keeps as no longer listed like an unknown one, unless a card still holds it', () => {
    const { t, item, apply } = setup();
    const accounts = accountList('acct-1', 'acct-unlisted', 'acct-unlisted-card').map((a) => (a.accountId === 'acct-1' ? a : { ...a, listed: false as const }));
    t.db.update(plaidItems).set({ accounts }).where(eq(plaidItems.id, item.id)).run();
    addCard(t, { nickname: 'Still attached', plaidItemId: item.id, plaidAccountId: 'acct-unlisted-card' });
    expect(apply(run({ added: [ptx('back', { account_id: 'acct-unlisted' }), ptx('kept', { account_id: 'acct-unlisted-card' })] }))).toEqual(counts({ added: 1, unknownAccounts: 1 }));
    expect(itemRow(t, item.id).newAccountsAt).toEqual(t.clock.now());
    expect(allRows(t).map((r) => r.plaidTransactionId)).toEqual(['kept']);
  });

  it("leaves a stored row alone when its account isn't attached any more", () => {
    const { t, card, apply } = setup();
    apply(run({ added: [ptx('tx-1')] }));
    const before = byPlaid(t, 'tx-1');
    expect(apply(run({ modified: [ptx('tx-1', { account_id: 'acct-2', amount: 99 })] }))).toEqual(counts({ droppedAccounts: 1 }));
    expect(byPlaid(t, 'tx-1')).toEqual(before);
    expect(before.cardId).toBe(card.id);
  });

  it('folds the pages of a run: a later page wins, so a transaction added then removed is never stored', () => {
    const { t, apply } = setup();
    const result = apply(run([
      { added: [ptx('gone', { pending: true }), ptx('changed', { amount: 1 })] },
      { modified: [ptx('changed', { amount: 2 })], removed: ['gone'] },
    ]));
    expect(result).toEqual(counts({ added: 1 }));
    expect(maybePlaid(t, 'gone')).toBeUndefined();
    expect(byPlaid(t, 'changed').amountCents).toBe(200);
  });

  it('applies nothing, cursor included, when a run fails part way', () => {
    const { t, item, apply } = setup();
    apply(run({ added: [ptx('kept')] }, 'cursor-1'));
    const before = allRows(t);
    const broken = ptx('broken');
    Object.defineProperty(broken, 'merchant_name', { get: () => { throw new Error('synthetic failure'); } });
    expect(() => apply(run({ removed: ['kept'], added: [ptx('new'), broken] }, 'cursor-2'))).toThrow('synthetic failure');
    expect(allRows(t)).toEqual(before);
    expect(itemRow(t, item.id).cursor).toBe('cursor-1');
  });

  it("doesn't move the cursor of an Item removed meanwhile", () => {
    const { t, item, apply } = setup();
    apply(run({}, 'cursor-1'));
    t.db.update(plaidItems).set({ removedAt: t.clock.now() }).where(eq(plaidItems.id, item.id)).run();
    apply(run({}, 'cursor-2'));
    expect(itemRow(t, item.id).cursor).toBe('cursor-1');
  });
});

describe('applySyncRun: removed transactions (spec §12.3)', () => {
  it("soft-deletes what Plaid removed, counts the posted ones, and ignores ids it doesn't have or already removed", () => {
    const { t, apply } = setup();
    apply(run({ added: [ptx('pending', { pending: true }), ptx('posted', { amount: 2 })] }));
    const removedAt = t.clock.now();
    expect(apply(run({ removed: ['pending', 'posted', 'unknown'] }))).toEqual(counts({ removed: 2, removedPosted: 1 }));
    expect(byPlaid(t, 'pending')).toMatchObject({ removedAt, deletedAt: removedAt });
    expect(byPlaid(t, 'posted')).toMatchObject({ removedAt, deletedAt: removedAt });
    t.clock.advance(DAY);
    // Removed again: its first removal date stays, so the 7 days aren't restarted.
    expect(apply(run({ removed: ['posted'] }))).toEqual(counts({}));
    expect(byPlaid(t, 'posted').removedAt).toEqual(removedAt);
  });

  it('brings back a removed row that Plaid lists again', () => {
    const { t, apply } = setup();
    apply(run({ added: [ptx('tx-1')] }));
    apply(run({ removed: ['tx-1'] }));
    expect(apply(run({ modified: [ptx('tx-1')] }))).toEqual(counts({ modified: 1 }));
    expect(byPlaid(t, 'tx-1')).toMatchObject({ removedAt: null, deletedAt: null });
  });

  it('prunes rows removed more than 7 days ago, and keeps replaced CSV rows and carried-over pending rows Plaid has not removed', () => {
    const { t, card, apply } = setup();
    const csv = addTransaction(t, card.id, { rawName: 'CORNER CAFE', amountCents: 500, date: '2026-11-10', csvReference: 'ref-1' });
    apply(run({ added: [ptx('old'), ptx('pending', { pending: true, amount: 7 })] }));
    apply(run({ removed: ['old'] }));
    t.clock.advance(3 * DAY);
    apply(run({ added: [ptx('recent', { amount: 3 }), ptx('posted', { pending_transaction_id: 'pending', amount: 7 }), ptx('csv-twin', { amount: 5 })] }));
    apply(run({ removed: ['recent'] }));
    expect(transaction(t, csv.id).replacedById).toBe(byPlaid(t, 'csv-twin').id);

    t.clock.advance(REMOVED_KEEP_MS - 3 * DAY);
    expect(pruneRemovedTransactions(t.db, t.clock.now())).toBe(0); // exactly 7 days: not yet
    t.clock.advance(1);
    expect(pruneRemovedTransactions(t.db, t.clock.now())).toBe(1);
    expect(maybePlaid(t, 'old')).toBeUndefined();
    expect(maybePlaid(t, 'recent')).toBeDefined();
    expect(byPlaid(t, 'pending').deletedAt).not.toBeNull();
    expect(transaction(t, csv.id)).toBeDefined();
  });
});

describe('applySyncRun: pending to posted (spec §12.3)', () => {
  function pendingWithEdits(s: ReturnType<typeof setup>) {
    const kid = spendUser(s.t, { role: 'member', name: 'Kid' });
    s.apply(run({ added: [ptx('pending', { pending: true, amount: 40, name: 'FUEL STOP 9' })] }));
    const pending = byPlaid(s.t, 'pending');
    edit(s.t, pending.id, { categoryId: categoryId(s.t, 'Travel'), categorySource: 'manual', personUserId: kid.id, personSource: 'manual', note: 'Road trip' });
    return { kid, pending };
  }
  const postedOf = (fields: Partial<PlaidTransaction> = {}) => ptx('posted', { pending_transaction_id: 'pending', amount: 52.5, name: 'FUEL STOP 9 TIP', ...fields });

  it('carries the manual category, person and note over when the removal comes first, in an earlier run', () => {
    const s = setup();
    const { kid, pending } = pendingWithEdits(s);
    s.t.clock.advance(DAY);
    s.apply(run({ removed: ['pending'] }));
    s.t.clock.advance(6 * DAY - 1);
    expect(s.apply(run({ added: [postedOf()] }))).toEqual(counts({ added: 1, carriedPending: 1 }));
    const posted = byPlaid(s.t, 'posted');
    expect(posted).toMatchObject({
      pending: false, amountCents: 5250, categoryId: categoryId(s.t, 'Travel'), categorySource: 'manual', personUserId: kid.id, personSource: 'manual', note: 'Road trip',
    });
    expect(transaction(s.t, pending.id)).toMatchObject({ replacedById: posted.id, deletedAt: expect.any(Date) });
  });

  it('carries them over when the posted row comes first, soft-deleting the live pending row, and records its removal later', () => {
    const s = setup();
    const { pending } = pendingWithEdits(s);
    s.t.clock.advance(DAY);
    const postedAt = s.t.clock.now();
    expect(s.apply(run({ added: [postedOf()] }))).toEqual(counts({ added: 1, carriedPending: 1 }));
    const posted = byPlaid(s.t, 'posted');
    expect(posted).toMatchObject({ categorySource: 'manual', note: 'Road trip' });
    expect(transaction(s.t, pending.id)).toMatchObject({ replacedById: posted.id, deletedAt: postedAt, removedAt: null });
    s.t.clock.advance(DAY);
    expect(s.apply(run({ removed: ['pending'] }))).toEqual(counts({ removed: 1 }));
    expect(transaction(s.t, pending.id)).toMatchObject({ replacedById: posted.id, deletedAt: postedAt, removedAt: s.t.clock.now() });
    // A later change Plaid sends for the pending row doesn't bring it back.
    expect(s.apply(run({ modified: [ptx('pending', { pending: true, amount: 40 })] }))).toEqual(counts({ unchanged: 1 }));
    expect(transaction(s.t, pending.id).deletedAt).toEqual(postedAt);
  });

  it.each([
    ['the removal on the first page', [{ removed: ['pending'] }, { added: [postedOf()] }]],
    ['the posted row on the first page', [{ added: [postedOf()] }, { removed: ['pending'] }]],
    ['both on one page', [{ added: [postedOf()], removed: ['pending'] }]],
  ])('carries them over within one run, with %s', (_, pages) => {
    const s = setup();
    const { pending } = pendingWithEdits(s);
    expect(s.apply(run(pages as Changes[]))).toEqual(counts({ added: 1, removed: 1, carriedPending: 1 }));
    expect(byPlaid(s.t, 'posted')).toMatchObject({ categorySource: 'manual', note: 'Road trip' });
    expect(transaction(s.t, pending.id)).toMatchObject({ replacedById: byPlaid(s.t, 'posted').id, removedAt: s.t.clock.now() });
  });

  it('carries nothing from a pending row removed more than 7 days ago', () => {
    const s = setup();
    pendingWithEdits(s);
    s.apply(run({ removed: ['pending'] }));
    s.t.clock.advance(REMOVED_KEEP_MS + 1);
    expect(s.apply(run({ added: [postedOf()] }))).toEqual(counts({ added: 1 }));
    expect(byPlaid(s.t, 'posted')).toMatchObject({ categorySource: 'mapping', personSource: 'default', note: null });
  });

  it('carries over only what was set by hand: the posted row decides the rest itself', () => {
    const s = setup();
    s.apply(run({ added: [ptx('pending', { pending: true, amount: 40 })] }));
    edit(s.t, byPlaid(s.t, 'pending').id, { note: 'Ask about this' });
    s.apply(run({ added: [postedOf({ personal_finance_category: { ...COFFEE, primary: 'TRAVEL', detailed: 'TRAVEL_FLIGHTS' } })] }));
    expect(byPlaid(s.t, 'posted')).toMatchObject({ categoryId: categoryId(s.t, 'Travel'), categorySource: 'mapping', personSource: 'default', note: 'Ask about this' });
  });

  it('carries a pending row over once: a second posted row naming it gets nothing', () => {
    const s = setup();
    pendingWithEdits(s);
    s.apply(run({ added: [postedOf()] }));
    expect(s.apply(run({ added: [postedOf({ transaction_id: 'posted-again', date: '2026-11-20' })] }))).toEqual(counts({ added: 1 }));
    expect(byPlaid(s.t, 'posted-again')).toMatchObject({ categorySource: 'mapping', note: null });
  });

  it('a new pending row and its posted version in one run: the pending one is replaced', () => {
    const s = setup();
    expect(s.apply(run({ added: [ptx('pending', { pending: true, amount: 40 }), postedOf()] }))).toEqual(counts({ added: 2, carriedPending: 1 }));
    expect(byPlaid(s.t, 'pending')).toMatchObject({ replacedById: byPlaid(s.t, 'posted').id, deletedAt: s.t.clock.now() });
  });

  describe('when Plaid names no pending version', () => {
    const unnamed = (id: string, fields: Partial<PlaidTransaction> = {}) => ptx(id, { pending_transaction_id: null, amount: 40, name: 'FUEL STOP 9', date: '2026-11-11', ...fields });

    it.each([
      ['in an earlier run', true],
      ['in the same run', false],
    ])('takes a removed pending row of its card that passes the duplicate test (removal %s)', (_, apart) => {
      const s = setup();
      const { kid, pending } = pendingWithEdits(s);
      if (apart) {
        s.apply(run({ removed: ['pending'] }));
        s.t.clock.advance(DAY);
        expect(s.apply(run({ added: [unnamed('posted')] }))).toEqual(counts({ added: 1, carriedPending: 1 }));
      } else {
        expect(s.apply(run({ removed: ['pending'], added: [unnamed('posted')] }))).toEqual(counts({ added: 1, removed: 1, carriedPending: 1 }));
      }
      const posted = byPlaid(s.t, 'posted');
      expect(posted).toMatchObject({ categorySource: 'manual', personUserId: kid.id, note: 'Road trip' });
      expect(transaction(s.t, pending.id).replacedById).toBe(posted.id);
    });

    it('never takes a live pending row, one removed more than 7 days ago, one of another card, or one that fails the duplicate test', () => {
      const s = setup();
      addCard(s.t, { nickname: 'Other', plaidItemId: s.item.id, plaidAccountId: 'acct-2' });
      pendingWithEdits(s);
      // Still live: Plaid hasn't removed it, so it may post later under its own id.
      expect(s.apply(run({ added: [unnamed('live')] }))).toEqual(counts({ added: 1 }));
      s.apply(run({ removed: ['pending'] }));
      expect(s.apply(run({
        added: [unnamed('other-card', { account_id: 'acct-2' }), unnamed('other-amount', { amount: 41 }), unnamed('other-name', { merchant_name: 'Garden Shed', name: 'GARDEN SHED' })],
      }))).toEqual(counts({ added: 3 }));
      s.t.clock.advance(REMOVED_KEEP_MS + 1);
      expect(s.apply(run({ added: [unnamed('late')] }))).toEqual(counts({ added: 1 }));
    });

    it('takes a removed pending row once: one of two matching posted rows gets it, and a later one gets nothing', () => {
      const s = setup();
      const { pending } = pendingWithEdits(s);
      s.apply(run({ removed: ['pending'] }));
      // Two posted rows in one run that both pass the duplicate test against it.
      expect(s.apply(run({ added: [unnamed('posted-a'), unnamed('posted-b', { date: '2026-11-12' })] }))).toEqual(counts({ added: 2, carriedPending: 1 }));
      const taker = transaction(s.t, pending.id).replacedById;
      const notes = ['posted-a', 'posted-b'].map((id) => byPlaid(s.t, id)).map((r) => [r.id === taker, r.note]);
      expect(notes.sort()).toEqual([[false, null], [true, 'Road trip']]);
      // Carried over, it's never a source again, in a later run either.
      expect(s.apply(run({ added: [unnamed('posted-c')] }))).toEqual(counts({ added: 1 }));
      expect(byPlaid(s.t, 'posted-c').note).toBeNull();
      expect(transaction(s.t, pending.id).replacedById).toBe(taker);
    });

    it('prefers the removed pending row to a removed posted one (churn), and leaves a posted row that names a missing id to churn', () => {
      const s = setup();
      const { pending } = pendingWithEdits(s);
      s.apply(run({ added: [ptx('old-posted', { amount: 40, name: 'FUEL STOP 9', date: '2026-11-10' })] }));
      edit(s.t, byPlaid(s.t, 'old-posted').id, { note: 'Posted note' });
      s.apply(run({ removed: ['pending', 'old-posted'] }));
      expect(s.apply(run({ added: [unnamed('posted')] }))).toEqual(counts({ added: 1, carriedPending: 1 }));
      expect(byPlaid(s.t, 'posted').note).toBe('Road trip');
      expect(transaction(s.t, pending.id).replacedById).toBe(byPlaid(s.t, 'posted').id);
      // A posted row naming a pending id nobody has: the removed posted row is churn for it.
      expect(s.apply(run({ added: [unnamed('named', { pending_transaction_id: 'never-seen' })] }))).toEqual(counts({ added: 1, churned: 1 }));
      expect(byPlaid(s.t, 'named').note).toBe('Posted note');
    });
  });
});

describe('applySyncRun: churn (research §5.3)', () => {
  function postedWithEdits(s: ReturnType<typeof setup>) {
    s.apply(run({ added: [ptx('old', { amount: 45, date: '2026-11-05', merchant_name: 'Hardware Barn', name: 'HARDWARE BARN #44' })] }));
    const old = byPlaid(s.t, 'old');
    edit(s.t, old.id, { categoryId: categoryId(s.t, 'Home'), categorySource: 'manual', note: 'Deck boards' });
    return old;
  }
  const churned = (id: string, fields: Partial<PlaidTransaction> = {}) =>
    ptx(id, { amount: 45, date: '2026-11-06', merchant_name: 'Hardware Barn', name: 'HARDWARE BARN 44 SPRINGFIELD', ...fields });

  it.each([
    ['in the same run', false],
    ['in a later run', true],
  ])('a new posted row takes the fields of a posted row Plaid removed, on the same card, that passes the duplicate test (%s)', (_, apart) => {
    const s = setup();
    const old = postedWithEdits(s);
    if (apart) {
      s.apply(run({ removed: ['old'] }));
      s.t.clock.advance(6 * DAY);
      expect(s.apply(run({ added: [churned('new')] }))).toEqual(counts({ added: 1, churned: 1 }));
    } else {
      expect(s.apply(run({ removed: ['old'], added: [churned('new')] }))).toEqual(counts({ added: 1, removed: 1, removedPosted: 1, churned: 1 }));
    }
    const next = byPlaid(s.t, 'new');
    expect(next).toMatchObject({ categoryId: categoryId(s.t, 'Home'), categorySource: 'manual', note: 'Deck boards' });
    expect(transaction(s.t, old.id)).toMatchObject({ replacedById: next.id, deletedAt: expect.any(Date) });
  });

  it('carries a removed row over only once, across runs and within one', () => {
    const s = setup();
    postedWithEdits(s);
    expect(s.apply(run({ removed: ['old'], added: [churned('first'), churned('second', { date: '2026-11-05' })] }))).toMatchObject({ churned: 1 });
    // The nearest in date took it.
    expect(byPlaid(s.t, 'second')).toMatchObject({ categorySource: 'manual', note: 'Deck boards' });
    expect(byPlaid(s.t, 'first')).toMatchObject({ categorySource: 'mapping', note: null });
    expect(s.apply(run({ added: [churned('third')] }))).toEqual(counts({ added: 1 }));
    expect(byPlaid(s.t, 'third').note).toBeNull();
  });

  it('needs the duplicate test, a posted row, the same card, and a removal in the last 7 days', () => {
    const s = setup();
    const other = addCard(s.t, { nickname: 'Other', plaidItemId: s.item.id, plaidAccountId: 'acct-2' });
    s.apply(run({ added: [ptx('pending-old', { pending: true, amount: 45, date: '2026-11-05', merchant_name: 'Hardware Barn' })] }));
    postedWithEdits(s);
    edit(s.t, byPlaid(s.t, 'pending-old').id, { note: 'Pending note' });
    s.apply(run({ removed: ['old', 'pending-old'] }));
    const result = s.apply(run({
      added: [
        churned('other-amount', { amount: 46 }),
        churned('other-card', { account_id: 'acct-2' }),
        churned('too-far', { date: '2026-11-09' }),
        churned('other-merchant', { merchant_name: 'Garden Shed', name: 'GARDEN SHED' }),
      ],
    }));
    expect(result).toEqual(counts({ added: 4 }));
    expect(byPlaid(s.t, 'other-card').cardId).toBe(other.id);
    s.t.clock.advance(REMOVED_KEEP_MS + 1);
    expect(s.apply(run({ added: [churned('late')] }))).toEqual(counts({ added: 1 }));
  });

  it('takes a removed pending row as the pending version of a posted row naming one we never had, not as churn (review C-S-I2)', () => {
    const s = setup();
    s.apply(run({ added: [ptx('pending-old', { pending: true, amount: 45, date: '2026-11-05', merchant_name: 'Hardware Barn' })] }));
    edit(s.t, byPlaid(s.t, 'pending-old').id, { note: 'Pending note' });
    s.apply(run({ removed: ['pending-old'] }));
    // The history sent again under new ids names a pending id that was never stored here.
    expect(s.apply(run({ added: [churned('x', { pending_transaction_id: 'never-seen' })] }))).toEqual(counts({ added: 1, carriedPending: 1 }));
    expect(byPlaid(s.t, 'x').note).toBe('Pending note');
    expect(byPlaid(s.t, 'pending-old').replacedById).toBe(byPlaid(s.t, 'x').id);
  });

  it('sends a posted row naming a pending id we never had on to churn when no removed pending row matches', () => {
    const s = setup();
    postedWithEdits(s);
    s.apply(run({ added: [ptx('pending-other', { pending: true, amount: 12, date: '2026-11-05', merchant_name: 'Coffee Cart' })] }));
    s.apply(run({ removed: ['pending-other'] }));
    expect(s.apply(run({ removed: ['old'], added: [churned('x', { pending_transaction_id: 'never-seen' })] }))).toMatchObject({ churned: 1, carriedPending: 0 });
    expect(byPlaid(s.t, 'x').note).toBe('Deck boards');
    expect(byPlaid(s.t, 'pending-other').replacedById).toBeNull();
  });

  it('sends a posted row naming a pending id we stored and already carried over on to churn, not to a removed pending row', () => {
    const s = setup();
    const person = spendUser(s.t);
    const pending = (id: string) => ptx(id, { pending: true, amount: 45, date: '2026-11-05', merchant_name: 'Hardware Barn' });
    // X2 is a voided duplicate pre-auth, edited by hand, that passes the duplicate test against P1'.
    s.apply(run({ added: [pending('x1'), pending('x2')] }));
    edit(s.t, byPlaid(s.t, 'x2').id, { categoryId: categoryId(s.t, 'Dining'), categorySource: 'manual', note: 'Voided hold' });
    expect(s.apply(run({ added: [churned('p1', { pending_transaction_id: 'x1' })] }))).toMatchObject({ carriedPending: 1 });
    const p1 = byPlaid(s.t, 'p1');
    expect(byPlaid(s.t, 'x1').replacedById).toBe(p1.id);
    const edits = { categoryId: categoryId(s.t, 'Home'), categorySource: 'manual' as const, personUserId: person.id, personSource: 'manual' as const, note: 'Deck boards' };
    edit(s.t, p1.id, edits);
    // Plaid churns P1 into P1', which still names X1, and voids X2 in the same run.
    const result = s.apply(run({ removed: ['p1', 'x2'], added: [churned('p1-new', { pending_transaction_id: 'x1' })] }));
    expect(result).toMatchObject({ churned: 1, carriedPending: 0 });
    const next = byPlaid(s.t, 'p1-new');
    expect(next).toMatchObject(edits);
    expect(transaction(s.t, p1.id).replacedById).toBe(next.id);
    expect(byPlaid(s.t, 'x1').replacedById).toBe(next.id);
    expect(byPlaid(s.t, 'x2').replacedById).toBeNull();
  });

  it("is tested with the new row's merchant name, then its raw name", () => {
    const s = setup();
    s.apply(run({ added: [ptx('old', { amount: 8, merchant_name: null, name: 'SQ *FARM STAND' })] }));
    edit(s.t, byPlaid(s.t, 'old').id, { note: 'Eggs' });
    s.apply(run({ removed: ['old'], added: [ptx('new', { amount: 8, merchant_name: 'Green Acres', name: 'SQ *FARM STAND' })] }));
    expect(byPlaid(s.t, 'new').note).toBe('Eggs');
  });

  it('a posted row whose pending source was found is not matched as churn', () => {
    const s = setup();
    postedWithEdits(s);
    s.apply(run({ added: [ptx('pending', { pending: true, amount: 45, date: '2026-11-06', merchant_name: 'Hardware Barn' })] }));
    s.apply(run({ removed: ['old'], added: [churned('posted', { pending_transaction_id: 'pending' })] }));
    expect(byPlaid(s.t, 'posted').note).toBeNull();
    expect(byPlaid(s.t, 'old').replacedById).toBeNull();
  });

  it('points what pointed at the churned row (the CSV row it replaced) at the new row, so the prune leaves no dangling link', () => {
    const s = setup();
    const csv = addTransaction(s.t, s.card.id, { date: '2026-11-10', amountCents: 1234, rawName: 'CORNER CAFE 123', csvReference: 'ref-1', note: 'First coffee' });
    s.apply(run({ added: [ptx('p-1')] }));
    const first = byPlaid(s.t, 'p-1');
    expect(transaction(s.t, csv.id).replacedById).toBe(first.id);
    s.t.clock.advance(DAY);
    expect(s.apply(run({ removed: ['p-1'], added: [ptx('p-2', { date: '2026-11-11' })] }))).toEqual(counts({ added: 1, removed: 1, removedPosted: 1, churned: 1 }));
    const second = byPlaid(s.t, 'p-2');
    expect(second.note).toBe('First coffee');
    expect(transaction(s.t, csv.id)).toMatchObject({ replacedById: second.id, deletedAt: expect.any(Date) });
    expect(transaction(s.t, first.id).replacedById).toBe(second.id);
    s.t.clock.advance(REMOVED_KEEP_MS + DAY);
    expect(pruneRemovedTransactions(s.t.db, s.t.clock.now())).toBe(1);
    expect(maybePlaid(s.t, 'p-1')).toBeUndefined();
    expect(transaction(s.t, csv.id).replacedById).toBe(second.id);
  });

  it("a churned row that took over its source's CSV row doesn't take a second one", () => {
    const s = setup();
    const c1 = addTransaction(s.t, s.card.id, { date: '2026-11-10', amountCents: 1234, rawName: 'CORNER CAFE 123', csvReference: 'ref-1', note: 'First coffee' });
    const c2 = addTransaction(s.t, s.card.id, { date: '2026-11-12', amountCents: 1234, rawName: 'CORNER CAFE 123', csvReference: 'ref-2', note: 'Second coffee' });
    s.apply(run({ added: [ptx('p-1')] }));
    expect(s.apply(run({ removed: ['p-1'], added: [ptx('p-1b', { date: '2026-11-11' })] }))).toEqual(counts({ added: 1, removed: 1, removedPosted: 1, churned: 1 }));
    const next = byPlaid(s.t, 'p-1b');
    expect(transaction(s.t, c1.id).replacedById).toBe(next.id);
    // The second coffee is still its own purchase, waiting for its own Plaid row.
    expect(transaction(s.t, c2.id)).toMatchObject({ replacedById: null, deletedAt: null, note: 'Second coffee' });
    expect(next.note).toBe('First coffee');
    expect(s.apply(run({ added: [ptx('p-2', { date: '2026-11-12' })] }))).toEqual(counts({ added: 1, replacedCsv: 1 }));
    expect(transaction(s.t, c2.id).replacedById).toBe(byPlaid(s.t, 'p-2').id);
  });
});

describe('applySyncRun: a replacing row Plaid removes', () => {
  /** A CSV row from a file (its import still there), replaced by Plaid row `id`. */
  function replacedCsv(s: ReturnType<typeof setup>, id: string, csv: Partial<typeof transactions.$inferInsert> = {}, tx: Partial<PlaidTransaction> = {}) {
    const file = addCsvImport(s.t, s.card.id);
    const row = addTransaction(s.t, s.card.id, { date: '2026-11-08', amountCents: 1234, rawName: 'CORNER CAFE 123', csvReference: `ref-${id}`, csvImportId: file.id, ...csv });
    s.apply(run({ added: [ptx(id, tx)] }));
    expect(transaction(s.t, row.id).replacedById).toBe(byPlaid(s.t, id).id);
    return row;
  }

  it('brings the CSV row back when Plaid removes its replacement with no re-add, with what was set by hand on the pair', () => {
    const s = setup();
    const kid = spendUser(s.t, { role: 'member', name: 'Kid' });
    const csv = replacedCsv(s, 'p-1', { note: 'From the file' });
    // Edited on the Plaid row after it replaced the CSV row.
    edit(s.t, byPlaid(s.t, 'p-1').id, { categoryId: categoryId(s.t, 'Kids'), categorySource: 'manual', personUserId: kid.id, personSource: 'manual', note: 'Snacks' });
    s.t.clock.advance(DAY);
    expect(s.apply(run({ removed: ['p-1'] }))).toEqual(counts({ removed: 1, removedPosted: 1, restoredReplaced: 1 }));
    // Both notes are kept, its own first (review C-S-M1); category and person are the latest edit's.
    expect(transaction(s.t, csv.id)).toMatchObject({
      replacedById: null, deletedAt: null, categoryId: categoryId(s.t, 'Kids'), categorySource: 'manual', personUserId: kid.id, personSource: 'manual',
      note: 'From the file\nSnacks',
    });
  });

  it('keeps one note when both say the same, and caps two at the note limit, its own first (review C-S-M1)', () => {
    const s = setup();
    const same = replacedCsv(s, 'p-1', { note: 'Same note' });
    edit(s.t, byPlaid(s.t, 'p-1').id, { note: 'Same note' });
    const long = replacedCsv(s, 'p-2', { note: 'a'.repeat(900), csvReference: 'ref-long', amountCents: 2222 }, { amount: 22.22 });
    edit(s.t, byPlaid(s.t, 'p-2').id, { note: 'b'.repeat(900) });
    s.apply(run({ removed: ['p-1', 'p-2'] }));
    expect(transaction(s.t, same.id).note).toBe('Same note');
    expect(transaction(s.t, long.id).note).toBe(`${'a'.repeat(900)}\n${'b'.repeat(99)}`);
    expect(transaction(s.t, long.id).note).toHaveLength(NOTE_MAX);
  });

  it('decides a field again on the restored row when it was reset to automatic on the replacing row', () => {
    const s = setup();
    const now = s.t.clock.now();
    const kid = spendUser(s.t, { role: 'member', name: 'Kid' });
    s.t.db.insert(rules).values({ position: 2, matchText: 'corner cafe', matchType: 'contains', setCategoryId: categoryId(s.t, 'Dining'), createdAt: now, updatedAt: now }).run();
    const csv = replacedCsv(s, 'p-1', {
      categoryId: categoryId(s.t, 'Kids'), categorySource: 'manual', personUserId: kid.id, personSource: 'manual', note: 'From the file',
    });
    const plaid = byPlaid(s.t, 'p-1');
    expect(plaid).toMatchObject({ categorySource: 'manual', personSource: 'manual' });
    // "Reset to automatic" on the Plaid row's category only.
    edit(s.t, plaid.id, { categoryId: categoryId(s.t, 'Dining'), categorySource: 'rule' });
    s.apply(run({ removed: ['p-1'] }));
    expect(transaction(s.t, csv.id)).toMatchObject({
      replacedById: null, deletedAt: null, categoryId: categoryId(s.t, 'Dining'), categorySource: 'rule', personUserId: kid.id, personSource: 'manual', note: 'From the file',
    });
  });

  it('restores it before the CSV pass, so a re-add that churn misses takes it again in the same run', () => {
    const s = setup();
    const csv = replacedCsv(s, 'p-1', { note: 'From the file' }, { date: '2026-11-10' });
    s.t.clock.advance(DAY);
    // Four days off the removed row, so not churn; two off the CSV row, so its twin.
    const result = s.apply(run({ removed: ['p-1'], added: [ptx('p-2', { date: '2026-11-06' })] }));
    expect(result).toEqual(counts({ added: 1, removed: 1, removedPosted: 1, restoredReplaced: 1, replacedCsv: 1 }));
    expect(transaction(s.t, csv.id)).toMatchObject({ replacedById: byPlaid(s.t, 'p-2').id, deletedAt: expect.any(Date) });
    expect(byPlaid(s.t, 'p-2').note).toBe('From the file');
  });

  it('leaves alone what churn pointed at the new row, and a pending row carried into the removed one', () => {
    const s = setup();
    const csv = replacedCsv(s, 'p-1', {}, { pending_transaction_id: 'pend-1' });
    s.apply(run({ added: [ptx('pend-x', { pending: true, amount: 3 })] }));
    s.apply(run({ removed: ['pend-x'], added: [ptx('p-x', { pending_transaction_id: 'pend-x', amount: 3 })] }));
    const pending = byPlaid(s.t, 'pend-x');
    expect(pending.replacedById).toBe(byPlaid(s.t, 'p-x').id);
    s.t.clock.advance(DAY);
    // p-1 churns into p-2 (the CSV row follows it); p-x goes with no re-add.
    expect(s.apply(run({ removed: ['p-1', 'p-x'], added: [ptx('p-2', { date: '2026-11-11' })] })))
      .toEqual(counts({ added: 1, removed: 2, removedPosted: 2, churned: 1 }));
    expect(transaction(s.t, csv.id)).toMatchObject({ replacedById: byPlaid(s.t, 'p-2').id, deletedAt: expect.any(Date) });
    // Plaid removed the pending row itself: it stays deleted.
    expect(transaction(s.t, pending.id)).toMatchObject({ deletedAt: expect.any(Date), removedAt: expect.any(Date) });
  });

  it('brings back a CSV row whose import was undone by deleting it instead, which frees its reference number', () => {
    const s = setup();
    const csv = replacedCsv(s, 'p-1');
    edit(s.t, csv.id, { csvImportId: null });
    expect(s.apply(run({ removed: ['p-1'] }))).toEqual(counts({ removed: 1, removedPosted: 1, purgedReplaced: 1 }));
    expect(s.t.db.select().from(transactions).where(eq(transactions.id, csv.id)).get()).toBeUndefined();
  });

  it('the prune restores any row still pointing at a row it hard-deletes', () => {
    const s = setup();
    const csv = replacedCsv(s, 'p-1', { note: 'From the file' });
    // Removed before restores happened in the run (an older build), so the CSV row still points at it.
    edit(s.t, byPlaid(s.t, 'p-1').id, { removedAt: s.t.clock.now(), deletedAt: s.t.clock.now() });
    s.t.clock.advance(REMOVED_KEEP_MS + DAY);
    expect(pruneRemovedTransactions(s.t.db, s.t.clock.now())).toBe(1);
    expect(maybePlaid(s.t, 'p-1')).toBeUndefined();
    expect(transaction(s.t, csv.id)).toMatchObject({ replacedById: null, deletedAt: null, note: 'From the file' });
  });
});

describe('applySyncRun: CSV replacement (spec §12.13, departure 6)', () => {
  it("replaces the live CSV row a new posted Plaid row duplicates: copies its manual fields and note, and soft-deletes it", () => {
    const { t, card, apply } = setup();
    const kid = spendUser(t, { role: 'member', name: 'Kid' });
    const csv = addTransaction(t, card.id, {
      date: '2026-11-08', amountCents: 1234, rawName: 'CORNER CAFE 123 SPRINGFIELD', csvReference: 'ref-1',
      categoryId: categoryId(t, 'Kids'), categorySource: 'manual', personUserId: kid.id, personSource: 'manual', note: 'Snacks',
    });
    expect(apply(run({ added: [ptx('plaid')] }))).toEqual(counts({ added: 1, replacedCsv: 1 }));
    const plaid = byPlaid(t, 'plaid');
    expect(plaid).toMatchObject({ categoryId: categoryId(t, 'Kids'), categorySource: 'manual', personUserId: kid.id, personSource: 'manual', note: 'Snacks', deletedAt: null });
    expect(transaction(t, csv.id)).toMatchObject({ deletedAt: t.clock.now(), replacedById: plaid.id, csvReference: 'ref-1', removedAt: null });
  });

  it('replaces a CSV row with nothing set by hand too, leaving the Plaid row its own category', () => {
    const { t, card, apply } = setup();
    const csv = addTransaction(t, card.id, { date: '2026-11-10', amountCents: 1234, rawName: 'CORNER CAFE', csvReference: 'ref-1' });
    apply(run({ added: [ptx('plaid')] }));
    expect(byPlaid(t, 'plaid')).toMatchObject({ categoryId: categoryId(t, 'Dining'), categorySource: 'mapping', note: null });
    expect(transaction(t, csv.id).replacedById).toBe(byPlaid(t, 'plaid').id);
  });

  it("keeps what the Plaid row already has: its pending version's manual fields win, the CSV row fills the rest", () => {
    const { t, card, apply } = setup();
    const kid = spendUser(t, { role: 'member', name: 'Kid' });
    apply(run({ added: [ptx('pending', { pending: true })] }));
    edit(t, byPlaid(t, 'pending').id, { categoryId: categoryId(t, 'Kids'), categorySource: 'manual', note: 'From pending' });
    const csv = addTransaction(t, card.id, {
      date: '2026-11-10', amountCents: 1234, rawName: 'CORNER CAFE', csvReference: 'ref-1',
      categoryId: categoryId(t, 'Groceries'), categorySource: 'manual', personUserId: kid.id, personSource: 'manual', note: 'From CSV',
    });
    expect(apply(run({ removed: ['pending'], added: [ptx('posted', { pending_transaction_id: 'pending' })] }))).toEqual(counts({ added: 1, removed: 1, carriedPending: 1, replacedCsv: 1 }));
    expect(byPlaid(t, 'posted')).toMatchObject({ categoryId: categoryId(t, 'Kids'), categorySource: 'manual', personUserId: kid.id, personSource: 'manual', note: 'From pending' });
    expect(transaction(t, csv.id).replacedById).toBe(byPlaid(t, 'posted').id);
  });

  it('never replaces with a pending row, and replaces once it posts', () => {
    const { t, card, apply } = setup();
    const csv = addTransaction(t, card.id, { date: '2026-11-10', amountCents: 1234, rawName: 'CORNER CAFE', csvReference: 'ref-1' });
    expect(apply(run({ added: [ptx('pending', { pending: true })] }))).toEqual(counts({ added: 1 }));
    expect(transaction(t, csv.id)).toMatchObject({ deletedAt: null, replacedById: null });
    apply(run({ removed: ['pending'], added: [ptx('posted', { pending_transaction_id: 'pending' })] }));
    expect(transaction(t, csv.id).replacedById).toBe(byPlaid(t, 'posted').id);
  });

  it('never matches a CSV row that was already replaced, and only live CSV rows of the same card', () => {
    const { t, card, item, apply } = setup();
    const other = addCard(t, { nickname: 'Other', plaidItemId: item.id, plaidAccountId: 'acct-2' });
    const csv = addTransaction(t, card.id, { date: '2026-11-10', amountCents: 1234, rawName: 'CORNER CAFE', csvReference: 'ref-1' });
    addTransaction(t, other.id, { date: '2026-11-10', amountCents: 999, rawName: 'CORNER CAFE', csvReference: 'ref-2' });
    apply(run({ added: [ptx('first')] }));
    expect(apply(run({ added: [ptx('second'), ptx('other-card', { amount: 9.99 })] }))).toEqual(counts({ added: 2 }));
    expect(transaction(t, csv.id).replacedById).toBe(byPlaid(t, 'first').id);
    expect(byPlaid(t, 'other-card').cardId).toBe(card.id);
  });

  it("is tested with the Plaid row's merchant name, then its raw name", () => {
    const { t, card, apply } = setup();
    const csv = addTransaction(t, card.id, { date: '2026-11-10', amountCents: 1234, rawName: 'SQ *CORNER CAFE', csvReference: 'ref-1' });
    apply(run({ added: [ptx('plaid', { merchant_name: 'Bean There', name: 'SQ *CORNER CAFE' })] }));
    expect(transaction(t, csv.id).replacedById).toBe(byPlaid(t, 'plaid').id);
  });

  it('matches in date order within each card and amount, so the order Plaid sends rows in changes nothing', () => {
    // Taken in Plaid's order, "late" would take the CSV row on 11-03 (one day off) and leave "early"
    // with nothing in its window. In date order both find a CSV row.
    const csvRows = [
      { date: '2026-11-03', ref: 'ref-a' },
      { date: '2026-11-06', ref: 'ref-b' },
    ];
    const plaidRows = [
      ptx('late', { date: '2026-11-04' }),
      ptx('early', { date: '2026-11-01' }),
      ptx('other-amount', { date: '2026-11-03', amount: 99 }),
      ptx('lone', { date: '2026-11-20' }),
    ];
    const outcome = (order: PlaidTransaction[]) => {
      const { t, card, apply } = setup();
      const ids = csvRows.map((c) => addTransaction(t, card.id, { date: c.date, amountCents: 1234, rawName: 'CORNER CAFE', csvReference: c.ref }).id);
      apply(run({ added: order }));
      return ids.map((id) => {
        const by = transaction(t, id).replacedById;
        return by === null ? null : allRows(t).find((r) => r.id === by)!.plaidTransactionId;
      });
    };
    const expected = ['early', 'late'];
    expect(outcome(plaidRows)).toEqual(expected);
    expect(outcome([...plaidRows].reverse())).toEqual(expected);
    expect(outcome([plaidRows[2]!, plaidRows[0]!, plaidRows[3]!, plaidRows[1]!])).toEqual(expected);
  });
});

describe("applySyncRun: a bank linked again (the old bank's rows)", () => {
  /**
   * The card's old bank was removed with its transactions kept (or forgotten by a key reset), and
   * the bank linked again is attached to the same card: `item` is the new Item on `acct-1`, and the
   * old Item's rows are on `acct-old`.
   */
  function relinked() {
    const s = setup();
    const now = s.t.clock.now();
    const old = s.t.db.insert(plaidItems).values({ plaidItemId: 'item-synthetic-old', institutionName: 'Example Bank', removedAt: now, removedReason: 'removed', createdAt: now, updatedAt: now }).returning().get();
    const oldRow = (id: string, patch: Partial<typeof transactions.$inferInsert> = {}) =>
      addTransaction(s.t, s.card.id, { source: 'plaid', plaidTransactionId: id, plaidAccountId: 'acct-old', merchant: 'Corner Cafe', rawName: 'CORNER CAFE 123', amountCents: 1234, ...patch });
    return { ...s, old, oldRow };
  }

  it("replaces the old bank's row a new posted row duplicates, carrying its manual fields and note", () => {
    const { t, apply, oldRow } = relinked();
    const old = oldRow('old-1', { categoryId: categoryId(t, 'Groceries'), categorySource: 'manual', note: 'Birthday cake' });
    expect(apply(run({ added: [ptx('new-1')] }))).toEqual(counts({ added: 1, replacedOldBank: 1 }));
    const fresh = byPlaid(t, 'new-1');
    expect(fresh).toMatchObject({ categoryId: categoryId(t, 'Groceries'), categorySource: 'manual', note: 'Birthday cake', deletedAt: null });
    expect(transaction(t, old.id)).toMatchObject({ replacedById: fresh.id, deletedAt: t.clock.now(), removedAt: null });
    // Applying the run again changes nothing: the old row was replaced once.
    expect(apply(run({ added: [ptx('new-1')] }))).toEqual(counts({ unchanged: 1 }));
  });

  it("never replaces an old bank's pending row: only posted rows are replacement candidates (departure 6)", () => {
    const s = relinked();
    const pending = s.oldRow('old-pending', { pending: true });
    expect(s.apply(run({ added: [ptx('new-1')] }))).toEqual(counts({ added: 1 }));
    expect(transaction(s.t, pending.id)).toMatchObject({ deletedAt: null, replacedById: null });
  });

  it("never replaces a row of a bank that's still linked, the new one's own included", () => {
    const { t, item, card, apply, oldRow } = relinked();
    // Another linked bank on another account of the same card's Item, and the new Item's own earlier row.
    const now = t.clock.now();
    const other = t.db.insert(plaidItems).values({ plaidItemId: 'item-synthetic-2', pickedAt: now, createdAt: now, updatedAt: now }).returning().get();
    addCard(t, { nickname: 'Other bank', plaidItemId: other.id, plaidAccountId: 'acct-other' });
    const linkedRow = addTransaction(t, card.id, { source: 'plaid', plaidTransactionId: 'other-1', plaidAccountId: 'acct-other', merchant: 'Corner Cafe', rawName: 'CORNER CAFE 123', amountCents: 1234 });
    apply(run({ added: [ptx('own-1', { date: '2026-11-09' })] }));
    expect(apply(run({ added: [ptx('own-2')] }))).toEqual(counts({ added: 1 }));
    expect(transaction(t, linkedRow.id).replacedById).toBeNull();
    expect(byPlaid(t, 'own-1')).toMatchObject({ replacedById: null, deletedAt: null });
    expect(item.id).not.toBe(other.id);
    // An old row already replaced isn't a candidate either.
    oldRow('old-gone', { deletedAt: now, replacedById: 999 });
    expect(apply(run({ added: [ptx('own-3', { date: '2026-11-11' })] }))).toEqual(counts({ added: 1 }));
  });

  it('matches CSV rows and old bank rows in one date-ordered pass, so the order Plaid sends rows in changes nothing', () => {
    const plaidRows = [
      ptx('late', { date: '2026-11-04' }),
      ptx('early', { date: '2026-11-01' }),
      ptx('other-amount', { date: '2026-11-03', amount: 99 }),
      ptx('lone', { date: '2026-11-20' }),
    ];
    const outcome = (order: PlaidTransaction[]) => {
      const { t, card, apply, oldRow } = relinked();
      const ids = [
        oldRow('old-a', { date: '2026-11-03' }).id,
        addTransaction(t, card.id, { date: '2026-11-06', amountCents: 1234, rawName: 'CORNER CAFE', csvReference: 'ref-b' }).id,
      ];
      const result = apply(run({ added: order }));
      return {
        replacedBy: ids.map((id) => {
          const by = transaction(t, id).replacedById;
          return by === null ? null : allRows(t).find((r) => r.id === by)!.plaidTransactionId;
        }),
        replacedCsv: result.replacedCsv,
        replacedOldBank: result.replacedOldBank,
      };
    };
    const expected = { replacedBy: ['early', 'late'], replacedCsv: 1, replacedOldBank: 1 };
    expect(outcome(plaidRows)).toEqual(expected);
    expect(outcome([...plaidRows].reverse())).toEqual(expected);
    expect(outcome([plaidRows[2]!, plaidRows[0]!, plaidRows[3]!, plaidRows[1]!])).toEqual(expected);
  });

  it("a churned row that took over its source's old-bank row doesn't take a second one", () => {
    const { t, apply, oldRow } = relinked();
    const first = oldRow('old-1', { date: '2026-11-10', note: 'First coffee' });
    const second = oldRow('old-2', { date: '2026-11-12', note: 'Second coffee' });
    apply(run({ added: [ptx('p-1')] }));
    expect(transaction(t, first.id).replacedById).toBe(byPlaid(t, 'p-1').id);
    expect(apply(run({ removed: ['p-1'], added: [ptx('p-1b', { date: '2026-11-11' })] }))).toMatchObject({ churned: 1, replacedOldBank: 0 });
    expect(transaction(t, first.id).replacedById).toBe(byPlaid(t, 'p-1b').id);
    expect(transaction(t, second.id)).toMatchObject({ replacedById: null, deletedAt: null });
  });
});

describe('applySyncRun: idempotency', () => {
  it('applying the same run twice changes nothing the second time', () => {
    const { t, card, apply } = setup();
    const csv = addTransaction(t, card.id, { date: '2026-11-08', amountCents: 999, rawName: 'BOOK NOOK #12', csvReference: 'ref-1', note: 'Gift' });
    apply(run({
      added: [
        ptx('pending', { pending: true, amount: 40, date: '2026-11-07', merchant_name: 'Fuel Stop' }),
        ptx('old', { amount: 45, date: '2026-11-05', merchant_name: 'Hardware Barn' }),
        ptx('kept', { amount: 3, merchant_name: 'Kiosk' }),
      ],
    }));
    edit(t, byPlaid(t, 'pending').id, { note: 'Road trip' });
    edit(t, byPlaid(t, 'old').id, { categoryId: categoryId(t, 'Home'), categorySource: 'manual' });
    t.clock.advance(DAY);

    const theRun = run([
      { removed: ['pending', 'old'], added: [ptx('posted', { pending_transaction_id: 'pending', amount: 42, date: '2026-11-08', merchant_name: 'Fuel Stop' })] },
      { added: [ptx('churned', { amount: 45, date: '2026-11-06', merchant_name: 'Hardware Barn' }), ptx('book', { amount: 9.99, merchant_name: null, name: 'BOOK NOOK' })] },
      { modified: [ptx('kept', { amount: 3.5, merchant_name: 'Kiosk' })], removed: ['never-stored'] },
    ], 'cursor-2');
    expect(apply(theRun)).toEqual(counts({ added: 3, modified: 1, removed: 2, removedPosted: 1, carriedPending: 1, churned: 1, replacedCsv: 1 }));
    expect(byPlaid(t, 'posted').note).toBe('Road trip');
    expect(byPlaid(t, 'churned').categorySource).toBe('manual');
    expect(byPlaid(t, 'book').note).toBe('Gift');
    expect(transaction(t, csv.id).replacedById).toBe(byPlaid(t, 'book').id);

    const once = allRows(t);
    t.clock.advance(DAY);
    expect(apply(theRun)).toEqual(counts({ unchanged: 4 }));
    expect(allRows(t)).toEqual(once);
  });

  it('a full resync from no cursor (after attaching an account) adds only what is new', () => {
    const { t, item, apply } = setup();
    apply(run({ added: [ptx('a'), ptx('b', { account_id: 'acct-2', amount: 2 })] }));
    expect(allRows(t)).toHaveLength(1);
    addCard(t, { nickname: 'Second', plaidItemId: item.id, plaidAccountId: 'acct-2' });
    expect(apply(run({ added: [ptx('a'), ptx('b', { account_id: 'acct-2', amount: 2 })] }))).toEqual(counts({ added: 1, unchanged: 1 }));
  });
});

describe('applySyncRun: replacement invariants over many generated cases', () => {
  const merchants = ['CORNER CAFE', 'CORNER CAFE 123', 'SHELL OIL 5523', 'SHELL', 'AMZN MKTP US', 'Amazon', 'TOLL ROAD', 'TOLL ROAD AUTH'];
  const amounts = [500, 1234, 1234, 2000];
  /** A small seeded generator (an LCG), so every run checks the same cases. */
  function generator(seed: number) {
    let state = seed >>> 0;
    const next = () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    return { next, pick: <T>(list: readonly T[]) => list[Math.floor(next() * list.length)]! };
  }
  const shape = (t: TestApp) => JSON.stringify(allRows(t).map((x) => [x.id, x.replacedById, x.deletedAt?.getTime() ?? null, x.note]));

  /**
   * Each case: CSV rows (from a file) and posted Plaid rows on two cards, the Plaid rows split over
   * two runs in a random order, then a full resync and a replay (nothing changes), then each Plaid
   * row meets one fate: left alone; churned (removed and re-added under a new id a day later or on
   * the same day); removed with no re-add; re-added with changed merchant text or amount;
   * re-added outside the duplicate test's date window; or re-added in an earlier run than its
   * removal. Then the prune. Every CSV row is live or points at a live Plaid row of its card with
   * its amount, no Plaid row is pointed at by two CSV rows, and every deleted CSV row has its
   * replacement.
   */
  it('one-to-one, same card and amount, never dangling or hidden, and idempotent', { timeout: 30_000 }, () => {
    let pairs = 0;
    const fates = { kept: 0, churned: 0, gone: 0, changed: 0, far: 0, early: 0 };
    for (let seed = 1; seed <= 120; seed++) {
      const g = generator(seed);
      const s = setup();
      const cardB = addCard(s.t, { nickname: 'B', plaidItemId: s.item.id, plaidAccountId: 'acct-2' });
      const files = new Map([s.card.id, cardB.id].map((id) => [id, addCsvImport(s.t, id).id]));
      const nCsv = 1 + Math.floor(g.next() * 8);
      for (let i = 0; i < nCsv; i++) {
        const cardId = g.next() < 0.5 ? s.card.id : cardB.id;
        addTransaction(s.t, cardId, {
          date: addDays('2026-11-05', Math.floor(g.next() * 10)), amountCents: g.pick(amounts), rawName: g.pick(merchants), csvReference: `ref-${i}`, note: `csv ${i}`,
          csvImportId: files.get(cardId)!,
        });
      }
      const nPlaid = 1 + Math.floor(g.next() * 8);
      const txs = Array.from({ length: nPlaid }, (_, i) => {
        const m = g.pick(merchants);
        return ptx(`p-${i}`, {
          account_id: g.next() < 0.5 ? 'acct-1' : 'acct-2', date: addDays('2026-11-05', Math.floor(g.next() * 10)), amount: g.pick(amounts) / 100,
          merchant_name: g.next() < 0.5 ? m : null, name: m,
        });
      });
      const shuffled = txs.map((tx) => ({ tx, key: g.next() })).sort((a, b) => a.key - b.key).map((x) => x.tx);
      const cut = Math.floor(g.next() * shuffled.length);
      s.apply(run({ added: shuffled.slice(0, cut) }));
      s.apply(run({ added: shuffled.slice(cut) }));
      const once = shape(s.t);
      s.apply(run({ added: txs }));
      s.apply(run({ added: [...txs].reverse() }));
      expect(shape(s.t), `seed ${seed}`).toBe(once);
      // Each replaced CSV row's text passes the duplicate test against its Plaid row.
      const plaidById = new Map(allRows(s.t).map((x) => [x.id, x]));
      for (const c of allRows(s.t).filter((x) => x.source === 'csv' && x.replacedById !== null)) {
        const p = plaidById.get(c.replacedById!)!;
        expect(similarMerchants(c.rawName, p.merchant ?? p.rawName) || similarMerchants(c.rawName, p.rawName), `seed ${seed}`).toBe(true);
        expect(Math.abs(daysBetween(c.date, p.date)), `seed ${seed}`).toBeLessThanOrEqual(3);
      }

      // Each Plaid row's fate, a day later. `early` re-adds run before their removals' run.
      s.t.clock.advance(DAY);
      const removedIds: string[] = [];
      const added: PlaidTransaction[] = [];
      const earlyAdded: PlaidTransaction[] = [];
      const lateRemoved: string[] = [];
      const again = (tx: PlaidTransaction, f: Partial<PlaidTransaction>) => ({ ...tx, transaction_id: `${tx.transaction_id}-c`, ...f });
      for (const tx of txs) {
        const fate = g.pick(['kept', 'kept', 'churned', 'churned', 'gone', 'changed', 'far', 'early'] as const);
        fates[fate]++;
        if (fate === 'kept') continue;
        if (fate === 'early') {
          earlyAdded.push(again(tx, { date: addDays(tx.date, Math.floor(g.next() * 2)) }));
          lateRemoved.push(tx.transaction_id);
          continue;
        }
        removedIds.push(tx.transaction_id);
        if (fate === 'churned') added.push(again(tx, { date: addDays(tx.date, Math.floor(g.next() * 2)) }));
        if (fate === 'changed') {
          added.push(again(tx, g.next() < 0.5
            ? { merchant_name: null, name: g.pick(['ZZZ UNRELATED STORE', 'QUUX WIDGETS', ...merchants]) }
            : { amount: g.pick(amounts) / 100 + (g.next() < 0.5 ? 0.01 : 0) }));
        }
        if (fate === 'far') added.push(again(tx, { date: addDays(tx.date, DUPLICATE_TEST.dateWindowDays + 1 + Math.floor(g.next() * 5)) }));
      }
      const runs = [run({ added: earlyAdded }), run({ removed: removedIds, added }), run({ removed: lateRemoved })];
      for (const r of runs) s.apply(r);
      const afterFates = shape(s.t);
      for (const r of runs) s.apply(r);
      expect(shape(s.t), `seed ${seed}`).toBe(afterFates);
      s.t.clock.advance(REMOVED_KEEP_MS + DAY);
      pruneRemovedTransactions(s.t.db, s.t.clock.now());

      const all = allRows(s.t);
      const byId = new Map(all.map((x) => [x.id, x]));
      const targets = new Map<number, number>();
      for (const c of all.filter((x) => x.source === 'csv')) {
        if (c.replacedById === null) {
          // Never hidden: a CSV row nothing replaces is live.
          expect(c.deletedAt, `seed ${seed}: CSV row ${c.id} is hidden with no replacement`).toBeNull();
          continue;
        }
        pairs++;
        const p = byId.get(c.replacedById);
        expect(p, `seed ${seed}: CSV row ${c.id} points at a row that's gone`).toBeDefined();
        expect(p!, `seed ${seed}: CSV row ${c.id} points at a row that isn't live`).toMatchObject({ source: 'plaid', cardId: c.cardId, amountCents: c.amountCents, deletedAt: null });
        // The CSV row's note went with it.
        expect(p!.note, `seed ${seed}`).not.toBeNull();
        targets.set(p!.id, (targets.get(p!.id) ?? 0) + 1);
      }
      for (const [id, n] of targets) expect(n, `seed ${seed}: row ${id} replaced ${n} CSV rows`).toBe(1);
    }
    // The cases do exercise replacement, and every fate.
    expect(pairs).toBeGreaterThan(10);
    for (const [fate, n] of Object.entries(fates)) expect(n, fate).toBeGreaterThan(10);
  });
});

describe('the batch PATCH after a sync (spec §12.12)', () => {
  const P = '/api/panels/spend';
  const batch = (t: TestApp, cookie: string, changes: unknown) => call(t.app, 'PATCH', `${P}/transactions`, { cookie, body: { changes } });

  it('gives an open draft the 404 missingIds path for a row Plaid removed or replaced, and for a CSV row a Plaid row replaced', async () => {
    const { t, card, apply } = setup();
    const member = spendUser(t, { role: 'member' });
    const csv = addTransaction(t, card.id, { date: '2026-11-10', amountCents: 1234, rawName: 'CORNER CAFE', csvReference: 'ref-1' });
    apply(run({ added: [ptx('removed', { amount: 1 }), ptx('pending', { pending: true, amount: 2 })] }));
    const removed = byPlaid(t, 'removed');
    const pending = byPlaid(t, 'pending');
    // The page has drafts for all three. Then a sync runs.
    apply(run({ removed: ['removed'], added: [ptx('posted', { pending_transaction_id: 'pending', amount: 2 }), ptx('csv-twin')] }));
    const dining = categoryId(t, 'Dining');
    const uncategorized = categoryId(t, 'Uncategorized');
    const res = await batch(t, member.cookie, [
      { id: removed.id, categoryId: dining, expected: { categoryId: removed.categoryId } },
      { id: pending.id, categoryId: dining, expected: { categoryId: pending.categoryId } },
      { id: csv.id, categoryId: dining, expected: { categoryId: uncategorized } },
    ]);
    expect(res.status).toBe(404);
    // The replaced ones say which row holds their place now, so the page can move those drafts.
    expect(((await res.json()) as { error: { details: unknown } }).error.details).toEqual({
      missingIds: [removed.id, pending.id, csv.id],
      replacedBy: { [pending.id]: byPlaid(t, 'posted').id, [csv.id]: byPlaid(t, 'csv-twin').id },
    });
  });

  it('follows a replacement chain to the shown row, and lists none for a chain that ends at nothing shown', async () => {
    const { t, card, apply } = setup();
    const member = spendUser(t, { role: 'member' });
    apply(run({ added: [ptx('pending', { pending: true, amount: 2 }), ptx('hidden', { amount: 3 })] }));
    const pending = byPlaid(t, 'pending');
    apply(run({ removed: ['pending'], added: [ptx('posted', { pending_transaction_id: 'pending', amount: 2 })] }));
    const posted = byPlaid(t, 'posted');
    // A CSV row whose replacement was itself replaced later: pending -> posted is the second hop.
    const csv = addTransaction(t, card.id, { date: '2026-11-01', amountCents: 2, rawName: 'CORNER CAFE', csvReference: 'ref-1' });
    edit(t, csv.id, { replacedById: pending.id, deletedAt: t.clock.now() });
    // Chains that end at a deleted row, at a row that's gone, and in a loop.
    const dead = addTransaction(t, card.id, { date: '2026-11-02', amountCents: 5, rawName: 'SHOP', csvReference: 'ref-2' });
    const gone = addTransaction(t, card.id, { date: '2026-11-03', amountCents: 6, rawName: 'SHOP', csvReference: 'ref-3' });
    const loopA = addTransaction(t, card.id, { date: '2026-11-04', amountCents: 7, rawName: 'SHOP', csvReference: 'ref-4' });
    const loopB = addTransaction(t, card.id, { date: '2026-11-05', amountCents: 8, rawName: 'SHOP', csvReference: 'ref-5' });
    const hidden = byPlaid(t, 'hidden');
    edit(t, hidden.id, { deletedAt: t.clock.now() });
    edit(t, dead.id, { replacedById: hidden.id, deletedAt: t.clock.now() });
    edit(t, gone.id, { replacedById: 999_999, deletedAt: t.clock.now() });
    edit(t, loopA.id, { replacedById: loopB.id, deletedAt: t.clock.now() });
    edit(t, loopB.id, { replacedById: loopA.id, deletedAt: t.clock.now() });
    const dining = categoryId(t, 'Dining');
    const res = await batch(t, member.cookie, [csv, dead, gone, loopA].map((r) => ({ id: r.id, categoryId: dining })));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { details: unknown } }).error.details).toEqual({
      missingIds: [csv.id, dead.id, gone.id, loopA.id],
      replacedBy: { [csv.id]: posted.id },
    });
  });

  it('a sync that decides a row to the category it already has changes nothing stored, so a stale draft still saves', async () => {
    const { t, apply } = setup();
    const member = spendUser(t, { role: 'member' });
    apply(run({ added: [ptx('tx-1')] }));
    const seen = byPlaid(t, 'tx-1');
    t.clock.advance(DAY);
    // Plaid sends it again unchanged: nothing is written, not even updated_at.
    expect(apply(run({ modified: [ptx('tx-1')] }))).toEqual(counts({ unchanged: 1 }));
    expect(byPlaid(t, 'tx-1')).toEqual(seen);
    // A new detailed code under the same primary: still Dining, by the same mapping.
    apply(run({ modified: [ptx('tx-1', { personal_finance_category: { ...COFFEE, detailed: 'FOOD_AND_DRINK_FAST_FOOD' } })] }));
    expect(byPlaid(t, 'tx-1')).toMatchObject({ categoryId: seen.categoryId, categorySource: seen.categorySource, plaidPfcDetailed: 'FOOD_AND_DRINK_FAST_FOOD' });
    const res = await batch(t, member.cookie, [{ id: seen.id, categoryId: categoryId(t, 'Kids'), expected: { categoryId: seen.categoryId } }]);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(byPlaid(t, 'tx-1')).toMatchObject({ categoryId: categoryId(t, 'Kids'), categorySource: 'manual' });
  });

  it('a sync that really changes the category makes a stale draft a 409, naming what is saved now', async () => {
    const { t, apply } = setup();
    const member = spendUser(t, { role: 'member' });
    apply(run({ added: [ptx('tx-1')] }));
    const seen = byPlaid(t, 'tx-1');
    apply(run({ modified: [ptx('tx-1', { personal_finance_category: { primary: 'GENERAL_MERCHANDISE', detailed: 'GENERAL_MERCHANDISE_BOOKSTORES_AND_NEWSSTANDS', confidence_level: 'HIGH', version: 'v2' } })] }));
    const shopping = categoryId(t, 'Shopping');
    expect(byPlaid(t, 'tx-1').categoryId).toBe(shopping);
    const res = await batch(t, member.cookie, [{ id: seen.id, categoryId: categoryId(t, 'Kids'), expected: { categoryId: seen.categoryId } }]);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { details: unknown } }).error.details).toEqual({ conflicts: [{ transactionId: seen.id, field: 'category', current: shopping }] });
    expect(byPlaid(t, 'tx-1').categorySource).toBe('mapping');
  });
});

describe('applySyncRun with the fake Plaid', () => {
  /** A linked Item in the fake, its local row, and one attached card. */
  function linked() {
    const s = setup();
    const fake = new FakePlaid();
    fake.origin = 'https://plaid.test';
    const client = new PlaidClient({ clientId: FAKE_PLAID_CLIENT_ID, secret: FAKE_PLAID_SECRET, apiBaseUrl: 'https://plaid.test' }, fake.fetch, { sleep: async () => {} });
    const fakeItem = fake.createItem({ accounts: [{ name: 'Example Card', mask: '1111' }] });
    const accountId = fakeItem.accounts[0]!.account_id;
    s.t.db.update(plaidItems).set({ plaidItemId: fakeItem.itemId }).where(eq(plaidItems.id, s.item.id)).run();
    const fakeCard = addCard(s.t, { nickname: 'Example', plaidItemId: s.item.id, plaidAccountId: accountId });
    /** One whole run from the stored cursor, a page per `count` changes, applied. */
    const sync = async (count = 1) => {
      const pages = [];
      let cursor = itemRow(s.t, s.item.id).cursor;
      for (;;) {
        const p = await client.syncTransactions(fakeItem.accessToken, { cursor, count });
        pages.push(p);
        cursor = p.nextCursor;
        if (!p.hasMore) return s.apply({ pages, nextCursor: p.nextCursor, transactionsUpdateStatus: p.transactionsUpdateStatus });
      }
    };
    return { ...s, fake, fakeItem, fakeCard, accountId, sync };
  }

  it.each([true, false])('carries a pending row over when it posts across pages (removal first: %s)', async (removedFirst) => {
    const s = linked();
    const pending = s.fake.addTransaction(s.fakeItem.itemId, { account_id: s.accountId, pending: true, amount: 30, name: 'FUEL STOP 9', date: '2026-11-12' });
    expect(await s.sync()).toMatchObject({ added: 1 });
    edit(s.t, byPlaid(s.t, pending.transaction_id).id, { note: 'Road trip' });
    const posted = s.fake.postPending(pending.transaction_id, { amount: 34.5, date: '2026-11-13' }, { removedFirst });
    expect(await s.sync()).toMatchObject({ added: 1, removed: 1, carriedPending: 1 });
    expect(byPlaid(s.t, posted.transaction_id)).toMatchObject({ amountCents: 3450, pending: false, note: 'Road trip', deletedAt: null });
    expect(byPlaid(s.t, pending.transaction_id)).toMatchObject({ replacedById: byPlaid(s.t, posted.transaction_id).id });
    expect(itemRow(s.t, s.item.id).cursor).not.toBeNull();
    expect(await s.sync()).toEqual(counts({}));
  });

  it('carries a churned posted row over, and replaces the CSV row a first sync meets', async () => {
    const s = linked();
    const csv = addTransaction(s.t, s.fakeCard.id, { date: '2026-11-03', amountCents: 2500, rawName: 'HARDWARE BARN #44', csvReference: 'ref-1', note: 'Paint' });
    const tx = s.fake.addTransaction(s.fakeItem.itemId, { account_id: s.accountId, amount: 25, date: '2026-11-04', merchant_name: 'Hardware Barn', name: 'HARDWARE BARN #44' });
    expect(await s.sync(100)).toMatchObject({ added: 1, replacedCsv: 1 });
    expect(transaction(s.t, csv.id).replacedById).toBe(byPlaid(s.t, tx.transaction_id).id);
    s.fake.churn(tx.transaction_id, 'tx-churned-synthetic', { date: '2026-11-05' });
    expect(await s.sync()).toMatchObject({ added: 1, removed: 1, removedPosted: 1, churned: 1 });
    expect(byPlaid(s.t, 'tx-churned-synthetic')).toMatchObject({ note: 'Paint', deletedAt: null });
  });
});

describe('applySyncRun: rows removed as duplicates stay removed (spec §12.12)', () => {
  /** Removes `id` as a duplicate of `of`, as Remove duplicate leaves it. */
  const removeAsDuplicate = (t: TestApp, id: number, of: number) =>
    edit(t, id, { deletedAt: t.clock.now(), deletedReason: 'duplicate', duplicateOfId: of });

  it('a modified or re-added entry for a posted row removed as a duplicate leaves it deleted', () => {
    const { t, card, apply } = setup();
    apply(run({ added: [ptx('tx-1')] }));
    const row = byPlaid(t, 'tx-1');
    const csv = addTransaction(t, card.id, { date: row.date, amountCents: row.amountCents, rawName: 'CORNER CAFE', csvReference: 'ref-1' });
    removeAsDuplicate(t, row.id, csv.id);
    apply(run({ modified: [ptx('tx-1', { name: 'CORNER CAFE 123 SEATTLE' })] }));
    expect(byPlaid(t, 'tx-1')).toMatchObject({ rawName: 'CORNER CAFE 123 SEATTLE', deletedReason: 'duplicate' });
    expect(byPlaid(t, 'tx-1').deletedAt).not.toBeNull();
    apply(run({ added: [ptx('tx-1')] }));
    expect(byPlaid(t, 'tx-1')).toMatchObject({ rawName: 'CORNER CAFE 123', deletedReason: 'duplicate' });
    expect(byPlaid(t, 'tx-1').deletedAt).not.toBeNull();
    // Plaid removes it, then lists it again: it's back from Plaid's side, still removed by hand.
    apply(run({ removed: ['tx-1'] }));
    expect(transaction(t, csv.id).deletedAt).toBeNull();
    apply(run({ added: [ptx('tx-1')] }));
    expect(byPlaid(t, 'tx-1')).toMatchObject({ removedAt: null, deletedReason: 'duplicate' });
    expect(byPlaid(t, 'tx-1').deletedAt).not.toBeNull();
    expect(allRows(t).filter((r) => r.deletedAt === null).map((r) => r.id)).toEqual([csv.id]);
  });

  it("a pending row removed as a duplicate posts removed too, and its twin isn't replaced by it", () => {
    const { t, card, apply } = setup();
    const csv = addTransaction(t, card.id, { date: '2026-11-10', amountCents: 1234, rawName: 'CORNER CAFE', csvReference: 'ref-1', csvImportId: addCsvImport(t, card.id).id });
    apply(run({ added: [ptx('pend-1', { pending: true })] }));
    removeAsDuplicate(t, byPlaid(t, 'pend-1').id, csv.id);
    apply(run({ added: [ptx('post-1', { pending_transaction_id: 'pend-1' })], removed: ['pend-1'] }));
    expect(byPlaid(t, 'post-1')).toMatchObject({ deletedReason: 'duplicate', duplicateOfId: csv.id });
    expect(byPlaid(t, 'post-1').deletedAt).not.toBeNull();
    expect(transaction(t, csv.id)).toMatchObject({ deletedAt: null, replacedById: null });
  });

  it('a row removed as the duplicate of a pending row follows it when it posts, and comes back if it never does', () => {
    const { t, card, apply } = setup();
    apply(run({ added: [ptx('pend-1', { pending: true })] }));
    const csv = addTransaction(t, card.id, { date: '2026-11-10', amountCents: 1234, rawName: 'CORNER CAFE', csvReference: 'ref-1', csvImportId: addCsvImport(t, card.id).id });
    removeAsDuplicate(t, csv.id, byPlaid(t, 'pend-1').id);
    apply(run({ added: [ptx('post-1', { pending_transaction_id: 'pend-1' })], removed: ['pend-1'] }));
    expect(transaction(t, csv.id)).toMatchObject({ deletedReason: 'duplicate', duplicateOfId: byPlaid(t, 'post-1').id });
    // The pending row is pruned: the CSV row stays removed, since its twin posted.
    t.clock.advance(REMOVED_KEEP_MS + DAY);
    pruneRemovedTransactions(t.db, t.clock.now());
    expect(transaction(t, csv.id).deletedReason).toBe('duplicate');

    // Another pending row that Plaid drops without posting: the CSV row removed against it comes back.
    apply(run({ added: [ptx('pend-2', { pending: true, amount: 9.99, date: '2026-11-11' })] }));
    const other = addTransaction(t, card.id, { date: '2026-11-11', amountCents: 999, rawName: 'CORNER CAFE', csvReference: 'ref-2', csvImportId: addCsvImport(t, card.id).id });
    removeAsDuplicate(t, other.id, byPlaid(t, 'pend-2').id);
    apply(run({ removed: ['pend-2'] }));
    t.clock.advance(REMOVED_KEEP_MS + DAY);
    pruneRemovedTransactions(t.db, t.clock.now());
    expect(transaction(t, other.id)).toMatchObject({ deletedAt: null, deletedReason: null, duplicateOfId: null });
  });

  it("a CSV row whose import was undone is deleted for good, not brought back, when its twin goes", () => {
    const { t, card, apply } = setup();
    apply(run({ added: [ptx('tx-1')] }));
    const admin = spendUser(t);
    const imp = addCsvImport(t, card.id);
    const csv = addTransaction(t, card.id, { date: '2026-11-10', amountCents: 1234, rawName: 'CORNER CAFE', csvReference: 'ref-1', csvImportId: imp.id });
    removeAsDuplicate(t, csv.id, byPlaid(t, 'tx-1').id);
    undoImport(t, admin.id, card.id, imp.id);
    expect(transaction(t, csv.id)).toMatchObject({ csvImportId: null, deletedReason: 'duplicate' });
    // Plaid reverses the charge: the orphan isn't brought back with nothing to undo it; its reference is free again.
    apply(run({ removed: ['tx-1'] }));
    expect(transaction(t, csv.id)).toBeUndefined();
    t.clock.advance(REMOVED_KEEP_MS + DAY);
    pruneRemovedTransactions(t.db, t.clock.now());
    expect(allRows(t).filter((r) => r.deletedAt === null)).toEqual([]);
  });

  it('a pending row removed as a duplicate that posts for another amount (a tip) is no twin any more, so it stays live', () => {
    const { t, card, apply } = setup();
    const csv = addTransaction(t, card.id, { date: '2026-11-10', amountCents: 1234, rawName: 'CORNER CAFE', csvReference: 'ref-1', csvImportId: addCsvImport(t, card.id).id });
    apply(run({ added: [ptx('pend-1', { pending: true })] }));
    removeAsDuplicate(t, byPlaid(t, 'pend-1').id, csv.id);
    apply(run({ added: [ptx('post-1', { pending_transaction_id: 'pend-1', amount: 15.34 })], removed: ['pend-1'] }));
    expect(byPlaid(t, 'post-1')).toMatchObject({ deletedAt: null, deletedReason: null, duplicateOfId: null, amountCents: 1534 });
    expect(transaction(t, csv.id).deletedAt).toBeNull();
  });

  it('a row removed as the duplicate of a pending row that posts for another amount comes back', () => {
    const { t, card, apply } = setup();
    apply(run({ added: [ptx('pend-1', { pending: true })] }));
    const csv = addTransaction(t, card.id, { date: '2026-11-10', amountCents: 1234, rawName: 'SOMEWHERE ELSE', csvReference: 'ref-1', csvImportId: addCsvImport(t, card.id).id });
    removeAsDuplicate(t, csv.id, byPlaid(t, 'pend-1').id);
    apply(run({ added: [ptx('post-1', { pending_transaction_id: 'pend-1', amount: 15.34 })], removed: ['pend-1'] }));
    expect(transaction(t, csv.id)).toMatchObject({ deletedAt: null, deletedReason: null, duplicateOfId: null });
  });

  it.each([['pend-a', 'pend-b'], ['pend-b', 'pend-a']])('two pending twins that post in one run: the one removed (%s) posts removed, pointing at the other posted row', (removedId, keptId) => {
    const { t, apply } = setup();
    apply(run({ added: [ptx('pend-a', { pending: true }), ptx('pend-b', { pending: true })] }));
    removeAsDuplicate(t, byPlaid(t, removedId).id, byPlaid(t, keptId).id);
    apply(run({
      added: [ptx('post-a', { pending_transaction_id: 'pend-a' }), ptx('post-b', { pending_transaction_id: 'pend-b' })],
      removed: ['pend-a', 'pend-b'],
    }));
    const removedPost = byPlaid(t, removedId.replace('pend', 'post'));
    const keptPost = byPlaid(t, keptId.replace('pend', 'post'));
    expect(removedPost).toMatchObject({ deletedReason: 'duplicate', duplicateOfId: keptPost.id });
    expect(removedPost.deletedAt).not.toBeNull();
    expect(keptPost).toMatchObject({ deletedAt: null, deletedReason: null });
  });

  it('a CSV row removed as the duplicate of a posted row Plaid removes comes back, unless churn brings the row back', () => {
    const { t, card, apply } = setup();
    apply(run({ added: [ptx('tx-1'), ptx('tx-2', { amount: 5, merchant_name: 'Book Nook', name: 'BOOK NOOK' })] }));
    const a = addTransaction(t, card.id, { date: '2026-11-10', amountCents: 1234, rawName: 'CORNER CAFE', csvReference: 'ref-1', csvImportId: addCsvImport(t, card.id).id });
    const b = addTransaction(t, card.id, { date: '2026-11-10', amountCents: 500, rawName: 'BOOK NOOK', csvReference: 'ref-2', csvImportId: addCsvImport(t, card.id).id });
    removeAsDuplicate(t, a.id, byPlaid(t, 'tx-1').id);
    removeAsDuplicate(t, b.id, byPlaid(t, 'tx-2').id);
    // tx-1 churns to tx-1b; tx-2 is reversed.
    apply(run({ added: [ptx('tx-1b')], removed: ['tx-1', 'tx-2'] }));
    expect(transaction(t, a.id)).toMatchObject({ deletedReason: 'duplicate', duplicateOfId: byPlaid(t, 'tx-1b').id });
    expect(transaction(t, b.id)).toMatchObject({ deletedAt: null, deletedReason: null });
  });
});
