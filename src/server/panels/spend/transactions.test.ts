import { describe, expect, it } from 'vitest';
import { SPEND_MESSAGES, TRANSACTION_BATCH_MAX, type SpendOverview, type SpendSummary, type SpendTransaction } from '../../../shared/spend.js';
import { updateUser } from '../../admin/users.js';
import { csvImports, rules } from '../../db/schema.js';
import { addUser, call, cookieFor, makeTestApp } from '../../test/helpers.js';
import { addCard, addTransaction, categoryId, spendUser, transaction } from '../../test/spendFixtures.js';
import { datesWithDataQuery, RECENT_COUNT, recentRowsQuery, rowsInRangeQuery } from './transactions.js';

const P = '/api/panels/spend';

async function json<T>(res: Response, status = 200): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await res.json()) as T;
}

// The test app's clock is 2026-11-15 12:00 UTC, and the family time zone is UTC.
function setup() {
  const t = makeTestApp();
  const admin = spendUser(t, { role: 'admin', email: 'admin@example.com', name: 'Admin' });
  const member = spendUser(t, { role: 'member', email: 'kid@example.com', name: 'Kid' });
  return { t, admin, member };
}

describe('Spend transactions: permissions (spec §12.14)', () => {
  it.each([
    ['GET', '/summary', undefined],
    ['GET', '/overview', undefined],
    ['PATCH', '/transactions/ID', { note: 'Hi' }],
    ['POST', '/transactions/ID/reset', { fields: ['category'] }],
  ])('%s %s is for anyone with the Spend panel', async (method, path, body) => {
    const { t, member } = setup();
    const { id } = addTransaction(t, addCard(t).id);
    const url = `${P}${path.replace('ID', String(id))}`;
    const noPanel = cookieFor(t.db, t.clock, addUser(t.db, t.clock, { email: 'nopanel@example.com', role: 'admin', panels: ['todo'] }));
    expect((await call(t.app, method, url, { body })).status).toBe(401);
    expect((await call(t.app, method, url, { cookie: noPanel, body })).status).toBe(403);
    if (method !== 'GET') expect((await call(t.app, method, url, { cookie: member.cookie, body, csrf: false })).status).toBe(403);
    expect((await call(t.app, method, url, { cookie: member.cookie, body })).status).toBe(200);
  });
});

describe('Spend transactions: the home card (spec §12.11)', () => {
  it("shows each included card's current cycle and total so far, leaving out payments, with refunds subtracting", async () => {
    const { t, member } = setup();
    const visa = addCard(t, { nickname: 'Visa', usualClosingDay: 10 });
    addTransaction(t, visa.id, { date: '2026-11-11', amountCents: 10_000 });
    addTransaction(t, visa.id, { date: '2026-11-12', amountCents: -2_500 });
    addTransaction(t, visa.id, { date: '2026-11-12', amountCents: -50_000, categoryId: categoryId(t, 'Payments and transfers'), categorySource: 'rule' });
    addTransaction(t, visa.id, { date: '2026-11-10', amountCents: 99_999 }); // the previous cycle
    addTransaction(t, visa.id, { date: '2026-11-13', amountCents: 1_200, pending: true });
    addTransaction(t, visa.id, { date: '2026-11-14', amountCents: 7_777, deletedAt: t.clock.now() });
    addCard(t, { nickname: 'Hidden', included: false });
    addCard(t, { nickname: 'Old', archivedAt: t.clock.now() });
    t.db.insert(csvImports).values({ cardId: visa.id, fileSha256: 'x', uploadedByUserId: member.id, uploadedAt: new Date('2026-11-14T08:00:00Z'), rowCount: 1, importedCount: 1, skippedCount: 0 }).run();

    const summary = await json<SpendSummary>(await call(t.app, 'GET', `${P}/summary`, { cookie: member.cookie }));
    expect(summary.serverNow).toBe('2026-11-15T12:00:00.000Z');
    expect(summary.cards).toEqual([
      {
        id: visa.id, nickname: 'Visa', mask: '1234', archived: false, mode: 'cycles', currency: 'USD',
        cycle: { start: '2026-11-11', end: '2026-12-10', current: true, closingSource: 'inferred' },
        totalCents: 8_700, pendingCents: 1_200, otherCurrencyCount: 0, updatedAt: '2026-11-14T08:00:00.000Z', bank: null,
      },
    ]);
  });

  it('lists the last 8 transactions across the shown cards, newest first, with the person and pending label', async () => {
    const { t, member } = setup();
    const a = addCard(t, { nickname: 'A' });
    const b = addCard(t, { nickname: 'B' });
    const hidden = addCard(t, { nickname: 'Hidden', included: false });
    for (let d = 1; d <= 6; d++) addTransaction(t, a.id, { date: `2026-11-0${d}`, rawName: `A${d}` });
    addTransaction(t, b.id, { date: '2026-11-07', rawName: 'B7', personUserId: member.id, personSource: 'manual', pending: true });
    addTransaction(t, b.id, { date: '2026-11-08', rawName: 'B8', merchant: 'Bee Eight' });
    addTransaction(t, b.id, { date: '2026-11-09', rawName: 'B9' });
    addTransaction(t, hidden.id, { date: '2026-11-14', rawName: 'HIDDEN' });
    const { recent } = await json<SpendSummary>(await call(t.app, 'GET', `${P}/summary`, { cookie: member.cookie }));
    expect(recent.map((r) => r.merchant)).toEqual(['B9', 'Bee Eight', 'B7', 'A6', 'A5', 'A4', 'A3', 'A2']);
    expect(recent[2]).toMatchObject({ pending: true, person: { id: member.id, displayName: 'Kid', active: true }, personSource: 'manual' });
    expect(recent[1]).toMatchObject({ merchant: 'Bee Eight', rawName: 'B8' });
  });

  it('is empty with no cards', async () => {
    const { t, member } = setup();
    expect(await json(await call(t.app, 'GET', `${P}/summary`, { cookie: member.cookie }))).toEqual({ serverNow: '2026-11-15T12:00:00.000Z', cards: [], recent: [] });
  });
});

describe('Spend transactions: the drill-down (spec §12.12)', () => {
  function overview(t: ReturnType<typeof setup>['t'], cookie: string, q = '') {
    return call(t.app, 'GET', `${P}/overview${q}`, { cookie }).then((r) => json<SpendOverview>(r));
  }

  it('shows the first card and its current cycle, compared with the previous one, by category and by person', async () => {
    const { t, member } = setup();
    const visa = addCard(t, { nickname: 'Visa', usualClosingDay: 10 });
    const groceries = categoryId(t, 'Groceries');
    const dining = categoryId(t, 'Dining');
    addTransaction(t, visa.id, { date: '2026-11-12', amountCents: 6_000, categoryId: groceries, categorySource: 'rule' });
    addTransaction(t, visa.id, { date: '2026-11-13', amountCents: 2_000, categoryId: dining, categorySource: 'manual', personUserId: member.id, personSource: 'manual' });
    addTransaction(t, visa.id, { date: '2026-11-14', amountCents: -1_000, categoryId: groceries, categorySource: 'rule' });
    addTransaction(t, visa.id, { date: '2026-10-20', amountCents: 3_000, categoryId: dining, categorySource: 'rule' });
    addTransaction(t, visa.id, { date: '2026-09-01', amountCents: 500 });

    const o = await overview(t, member.cookie);
    expect(o.card).toEqual({ id: visa.id, nickname: 'Visa', mask: '1234', archived: false });
    expect(o.mode).toBe('cycles');
    expect(o.cycle).toEqual({ start: '2026-11-11', end: '2026-12-10', current: true, closingSource: 'inferred' });
    expect(o.previous).toMatchObject({ start: '2026-10-11', end: '2026-11-10' });
    // The current cycle, and past ones with transactions (not 2026-09-11 to 2026-10-10).
    expect(o.cycles.map((c) => c.start)).toEqual(['2026-11-11', '2026-10-11', '2026-08-11']);
    expect(o.totals).toMatchObject({ currency: 'USD', totalCents: 7_000, pendingCents: 0, previousCents: 3_000, otherCurrencyCount: 0 });
    expect(o.totals.byCategory.map((b) => [b.category.name, b.cents, b.previousCents])).toEqual([['Groceries', 5_000, 0], ['Dining', 2_000, 3_000]]);
    expect(o.totals.byPerson.map((b) => [b.person?.displayName ?? 'Household', b.cents, b.previousCents])).toEqual([['Household', 5_000, 3_000], ['Kid', 2_000, 0]]);
    expect(o.transactions.map((x) => x.date)).toEqual(['2026-11-14', '2026-11-13', '2026-11-12']);
  });

  it('opens a past cycle, and an older one has no previous cycle', async () => {
    const { t, member } = setup();
    const visa = addCard(t, { usualClosingDay: 10 });
    addTransaction(t, visa.id, { date: '2026-10-20', amountCents: 3_000 });
    const past = await overview(t, member.cookie, `?card=${visa.id}&cycle=2026-10-11`);
    expect(past.cycle).toEqual({ start: '2026-10-11', end: '2026-11-10', current: false, closingSource: 'inferred' });
    expect(past.previous).toBeNull();
    expect(past.totals).toMatchObject({ totalCents: 3_000, previousCents: null });
    // A cycle that isn't one falls back to the current cycle.
    expect((await overview(t, member.cookie, `?card=${visa.id}&cycle=2026-10-12`)).cycle?.current).toBe(true);
  });

  it("picks a card from the query, and falls back from one that isn't shown", async () => {
    const { t, member } = setup();
    const a = addCard(t, { nickname: 'A' });
    const b = addCard(t, { nickname: 'B' });
    const hidden = addCard(t, { nickname: 'Hidden', included: false });
    const old = addCard(t, { nickname: 'Old', archivedAt: t.clock.now() });
    const o = await overview(t, member.cookie, `?card=${b.id}`);
    expect(o.card?.id).toBe(b.id);
    expect(o.cards.map((c) => [c.nickname, c.archived])).toEqual([['A', false], ['B', false], ['Old', true]]);
    expect((await overview(t, member.cookie, `?card=${hidden.id}`)).card?.id).toBe(a.id);
    expect((await overview(t, member.cookie, `?card=${old.id}`)).card?.id).toBe(old.id);
    expect(await json(await call(t.app, 'GET', `${P}/overview?card=abc`, { cookie: member.cookie }), 400)).toEqual({
      error: { code: 'validation', message: 'Pick a card from the list' },
    });
  });

  it("totals only the card's currency, taking a row's unofficial currency when it has no official one", async () => {
    const { t, member } = setup();
    const visa = addCard(t, { usualClosingDay: 10 });
    addTransaction(t, visa.id, { date: '2026-11-12', amountCents: 1_000 });
    addTransaction(t, visa.id, { date: '2026-11-12', amountCents: 5_000, isoCurrencyCode: 'EUR' });
    addTransaction(t, visa.id, { date: '2026-11-12', amountCents: 7_000, isoCurrencyCode: null, unofficialCurrencyCode: 'BTC' });
    const o = await overview(t, member.cookie);
    expect(o.totals).toMatchObject({ currency: 'USD', totalCents: 1_000, otherCurrencyCount: 2 });
    expect(o.transactions.map((x) => x.currency).sort()).toEqual(['BTC', 'EUR', 'USD']);
    // The home card says how many it left out too (review C-M9).
    const summary = await json<SpendSummary>(await call(t.app, 'GET', `${P}/summary`, { cookie: member.cookie }));
    expect(summary.cards[0]).toMatchObject({ currency: 'USD', totalCents: 1_000, otherCurrencyCount: 2 });
  });

  it('groups by calendar month for a card with no closing day', async () => {
    const { t, member } = setup();
    const visa = addCard(t, { usualClosingDay: null });
    addTransaction(t, visa.id, { date: '2026-10-31' });
    const o = await overview(t, member.cookie);
    expect(o.mode).toBe('calendar_month');
    expect(o.cycles.map((c) => [c.start, c.end, c.closingSource])).toEqual([['2026-11-01', '2026-11-30', null], ['2026-10-01', '2026-10-31', null]]);
  });

  it('is empty with no included cards', async () => {
    const { t, member } = setup();
    addCard(t, { included: false });
    const o = await overview(t, member.cookie);
    expect(o).toMatchObject({ card: null, cards: [], cycles: [], cycle: null, transactions: [], totals: { totalCents: 0 } });
  });

  it("lists past cycles from the dates that have live transactions, and totals only the two cycles it shows", async () => {
    const { t, member } = setup();
    const visa = addCard(t, { usualClosingDay: 10 });
    const other = addCard(t, { nickname: 'Other', usualClosingDay: 10 });
    addTransaction(t, visa.id, { date: '2026-06-20', amountCents: 1 });
    addTransaction(t, visa.id, { date: '2026-08-11', amountCents: 10 });
    addTransaction(t, visa.id, { date: '2026-09-10', amountCents: 100 });
    addTransaction(t, visa.id, { date: '2026-10-01', amountCents: 1_000, deletedAt: t.clock.now() });
    addTransaction(t, other.id, { date: '2026-07-20', amountCents: 10_000 });
    const o = await overview(t, member.cookie, `?card=${visa.id}&cycle=2026-08-11`);
    // Not 2026-09-11 (only a deleted row), nor 2026-07-11 (only another card's).
    expect(o.cycles.map((c) => c.start)).toEqual(['2026-11-11', '2026-08-11', '2026-06-11']);
    expect(o.totals).toMatchObject({ totalCents: 110, previousCents: 0 });
    expect(o.transactions.map((x) => x.date)).toEqual(['2026-09-10', '2026-08-11']);
  });

  it('reads transactions by card and date range, on the (card_id, date) index', () => {
    const { t } = setup();
    const plan = (q: { toSQL(): { sql: string; params: unknown[] } }) => {
      const { sql, params } = q.toSQL();
      return (t.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((r) => r.detail).join('\n');
    };
    for (const q of [rowsInRangeQuery(t.db, 1, '2026-10-11', '2026-11-10'), datesWithDataQuery(t.db, 1), recentRowsQuery(t.db, 1, RECENT_COUNT)]) {
      const detail = plan(q);
      expect(detail).toContain('transactions_card_date_idx');
      expect(detail).not.toContain('TEMP B-TREE FOR ORDER BY');
      expect(detail).not.toMatch(/SCAN transactions(?! USING)/);
    }
  });

  it('keeps a deactivated person on their past transactions, by name', async () => {
    const { t, admin, member } = setup();
    const visa = addCard(t);
    addTransaction(t, visa.id, { date: '2026-11-14', personUserId: member.id, personSource: 'manual' });
    updateUser(t.db, member.id, { active: false });
    const o = await overview(t, admin.cookie);
    expect(o.transactions[0]!.person).toEqual({ id: member.id, displayName: 'Kid', color: '#378ADD', active: false });
  });
});

describe('Spend transactions: editing (spec §12.6, §12.9)', () => {
  it('sets the category by hand; an archived one only if it was already there', async () => {
    const { t, member, admin } = setup();
    const tx = addTransaction(t, addCard(t).id);
    const dining = categoryId(t, 'Dining');
    const res = await json<SpendTransaction>(await call(t.app, 'PATCH', `${P}/transactions/${tx.id}`, { cookie: member.cookie, body: { categoryId: dining } }));
    expect(res).toMatchObject({ category: { id: dining, name: 'Dining' }, categorySource: 'manual' });
    await call(t.app, 'POST', `${P}/categories/${dining}/archive`, { cookie: admin.cookie });
    const kids = categoryId(t, 'Kids');
    await call(t.app, 'POST', `${P}/categories/${kids}/archive`, { cookie: admin.cookie });
    expect(await json(await call(t.app, 'PATCH', `${P}/transactions/${tx.id}`, { cookie: member.cookie, body: { categoryId: kids } }), 400)).toEqual({
      error: { code: 'validation', message: SPEND_MESSAGES.categoryArchived },
    });
    expect((await call(t.app, 'PATCH', `${P}/transactions/${tx.id}`, { cookie: member.cookie, body: { categoryId: dining, note: 'x' } })).status).toBe(200);
  });

  it('assigns any active person, even without the Spend panel, or Household; never a deactivated one', async () => {
    const { t, member } = setup();
    const tx = addTransaction(t, addCard(t).id);
    const noPanel = addUser(t.db, t.clock, { email: 'teen@example.com', displayName: 'Teen', panels: [] });
    const res = await json<SpendTransaction>(await call(t.app, 'PATCH', `${P}/transactions/${tx.id}`, { cookie: member.cookie, body: { personUserId: noPanel } }));
    expect(res).toMatchObject({ person: { displayName: 'Teen' }, personSource: 'manual' });
    expect(transaction(t, tx.id).personUserId).toBe(noPanel);
    const household = await json<SpendTransaction>(await call(t.app, 'PATCH', `${P}/transactions/${tx.id}`, { cookie: member.cookie, body: { personUserId: null } }));
    expect(household).toMatchObject({ person: null, personSource: 'manual' });
    updateUser(t.db, noPanel, { active: false });
    expect(await json(await call(t.app, 'PATCH', `${P}/transactions/${tx.id}`, { cookie: member.cookie, body: { personUserId: noPanel } }), 400)).toEqual({
      error: { code: 'validation', message: SPEND_MESSAGES.personInactive },
    });
  });

  it('adds, edits, and clears a note', async () => {
    const { t, member } = setup();
    const tx = addTransaction(t, addCard(t).id);
    expect((await json<SpendTransaction>(await call(t.app, 'PATCH', `${P}/transactions/${tx.id}`, { cookie: member.cookie, body: { note: '  Birthday gift ' } }))).note).toBe('Birthday gift');
    expect((await json<SpendTransaction>(await call(t.app, 'PATCH', `${P}/transactions/${tx.id}`, { cookie: member.cookie, body: { note: '   ' } }))).note).toBeNull();
    expect(await json(await call(t.app, 'PATCH', `${P}/transactions/${tx.id}`, { cookie: member.cookie, body: { note: 'x'.repeat(1001) } }), 400)).toEqual({
      error: { code: 'validation', message: 'Keep the note to 1,000 characters or fewer' },
    });
    expect((await call(t.app, 'PATCH', `${P}/transactions/${tx.id}`, { cookie: member.cookie, body: {} })).status).toBe(400);
    // The note doesn't make the category or person manual.
    expect(transaction(t, tx.id)).toMatchObject({ categorySource: 'default', personSource: 'default' });
  });

  it("can't see or change a deleted transaction, or one on an excluded card", async () => {
    const { t, member } = setup();
    const deleted = addTransaction(t, addCard(t).id, { deletedAt: t.clock.now() });
    const hidden = addTransaction(t, addCard(t, { included: false }).id);
    for (const id of [deleted.id, hidden.id, 99_999]) {
      expect(await json(await call(t.app, 'PATCH', `${P}/transactions/${id}`, { cookie: member.cookie, body: { note: 'x' } }), 404)).toEqual({
        error: { code: 'not_found', message: SPEND_MESSAGES.transactionNotFound },
      });
      expect((await call(t.app, 'POST', `${P}/transactions/${id}/reset`, { cookie: member.cookie, body: { fields: ['category'] } })).status).toBe(404);
    }
    expect((await call(t.app, 'PATCH', `${P}/transactions/1e3`, { cookie: member.cookie, body: { note: 'x' } })).status).toBe(404);
  });

  it('resets a field to automatic: rules decide it again, and Household is the default', async () => {
    const { t, member } = setup();
    const subs = categoryId(t, 'Subscriptions');
    const now = t.clock.now();
    t.db.insert(rules).values({ position: 5, matchText: 'netflix', matchType: 'contains', setCategoryId: subs, createdAt: now, updatedAt: now }).run();
    const tx = addTransaction(t, addCard(t).id, {
      rawName: 'NETFLIX.COM', categoryId: categoryId(t, 'Kids'), categorySource: 'manual', personUserId: member.id, personSource: 'manual',
    });
    const category = await json<SpendTransaction>(await call(t.app, 'POST', `${P}/transactions/${tx.id}/reset`, { cookie: member.cookie, body: { fields: ['category'] } }));
    expect(category).toMatchObject({ category: { id: subs }, categorySource: 'rule', person: { id: member.id }, personSource: 'manual' });
    const both = await json<SpendTransaction>(await call(t.app, 'POST', `${P}/transactions/${tx.id}/reset`, { cookie: member.cookie, body: { fields: ['category', 'person'] } }));
    expect(both).toMatchObject({ categorySource: 'rule', person: null, personSource: 'default' });
    expect((await call(t.app, 'POST', `${P}/transactions/${tx.id}/reset`, { cookie: member.cookie, body: { fields: [] } })).status).toBe(400);
  });

  it('resets only the fields named: the other stays as it is, even when rules would now decide it differently', async () => {
    const { t, member } = setup();
    const subs = categoryId(t, 'Subscriptions');
    const kids = categoryId(t, 'Kids');
    const now = t.clock.now();
    // A rule set both fields; since then the rule changed to set the category only.
    t.db.insert(rules).values({ position: 5, matchText: 'netflix', matchType: 'contains', setCategoryId: subs, createdAt: now, updatedAt: now }).run();
    const tx = addTransaction(t, addCard(t).id, { rawName: 'NETFLIX.COM', categoryId: kids, categorySource: 'manual', personUserId: member.id, personSource: 'rule' });
    const category = await json<SpendTransaction>(await call(t.app, 'POST', `${P}/transactions/${tx.id}/reset`, { cookie: member.cookie, body: { fields: ['category'] } }));
    expect(category).toMatchObject({ category: { id: subs }, categorySource: 'rule', person: { id: member.id }, personSource: 'rule' });

    const other = addTransaction(t, addCard(t).id, { rawName: 'NETFLIX.COM', categoryId: kids, categorySource: 'rule', personUserId: member.id, personSource: 'manual' });
    const person = await json<SpendTransaction>(await call(t.app, 'POST', `${P}/transactions/${other.id}/reset`, { cookie: member.cookie, body: { fields: ['person'] } }));
    expect(person).toMatchObject({ category: { id: kids }, categorySource: 'rule', person: null, personSource: 'default' });
  });

  it("leaves a field's source alone when a change sets the value it already has", async () => {
    const { t, member } = setup();
    const kids = categoryId(t, 'Kids');
    const tx = addTransaction(t, addCard(t).id, { categoryId: kids, categorySource: 'rule', personUserId: member.id, personSource: 'rule' });
    const same = await json<SpendTransaction>(await call(t.app, 'PATCH', `${P}/transactions/${tx.id}`, { cookie: member.cookie, body: { categoryId: kids, personUserId: member.id } }));
    expect(same).toMatchObject({ categorySource: 'rule', personSource: 'rule' });
    const household = addTransaction(t, addCard(t).id, { personUserId: null, personSource: 'default' });
    expect((await json<SpendTransaction>(await call(t.app, 'PATCH', `${P}/transactions/${household.id}`, { cookie: member.cookie, body: { personUserId: null } }))).personSource).toBe('default');
    // A different value is still set by hand.
    const changed = await json<SpendTransaction>(await call(t.app, 'PATCH', `${P}/transactions/${tx.id}`, { cookie: member.cookie, body: { personUserId: null } }));
    expect(changed).toMatchObject({ categorySource: 'rule', person: null, personSource: 'manual' });
  });

  it('a single-row PATCH refuses a deactivated person without changing the category it was also given', async () => {
    const { t, member, admin } = setup();
    const tx = addTransaction(t, addCard(t).id);
    updateUser(t.db, member.id, { active: false });
    expect((await call(t.app, 'PATCH', `${P}/transactions/${tx.id}`, { cookie: admin.cookie, body: { categoryId: categoryId(t, 'Dining'), personUserId: member.id } })).status).toBe(400);
    expect(transaction(t, tx.id)).toMatchObject({ categoryId: categoryId(t, 'Uncategorized'), categorySource: 'default' });
  });

  it('resets a value that can no longer be assigned, which applying rules keeps', async () => {
    const { t, admin, member } = setup();
    const kids = categoryId(t, 'Kids');
    const tx = addTransaction(t, addCard(t).id, { categoryId: kids, categorySource: 'rule', personUserId: member.id, personSource: 'rule' });
    await call(t.app, 'POST', `${P}/categories/${kids}/archive`, { cookie: admin.cookie });
    updateUser(t.db, member.id, { active: false });
    const reset = await json<SpendTransaction>(await call(t.app, 'POST', `${P}/transactions/${tx.id}/reset`, { cookie: admin.cookie, body: { fields: ['category', 'person'] } }));
    expect(reset).toMatchObject({ category: { name: 'Uncategorized' }, categorySource: 'default', person: null, personSource: 'default' });
  });
});

describe('Spend transactions: one save for many changes (PATCH /transactions, spec §12.12)', () => {
  const batch = (t: ReturnType<typeof setup>['t'], cookie: string | undefined, changes: unknown, csrf = true) =>
    call(t.app, 'PATCH', `${P}/transactions`, { cookie, body: { changes }, csrf });

  it('is for anyone with the Spend panel, behind the CSRF check', async () => {
    const { t, member } = setup();
    const { id } = addTransaction(t, addCard(t).id);
    const changes = [{ id, categoryId: categoryId(t, 'Dining') }];
    const noPanel = cookieFor(t.db, t.clock, addUser(t.db, t.clock, { email: 'nopanel@example.com', role: 'admin', panels: ['todo'] }));
    expect((await batch(t, undefined, changes)).status).toBe(401);
    expect((await batch(t, noPanel, changes)).status).toBe(403);
    expect((await batch(t, member.cookie, changes, false)).status).toBe(403);
    expect(transaction(t, id).categorySource).toBe('default');
    expect((await batch(t, member.cookie, changes)).status).toBe(200);
  });

  it('sets categories and people across rows by hand, and returns the saved rows in the order sent', async () => {
    const { t, member } = setup();
    const card = addCard(t).id;
    const a = addTransaction(t, card, { rawName: 'A' });
    const b = addTransaction(t, card, { rawName: 'B', personUserId: member.id, personSource: 'rule' });
    const dining = categoryId(t, 'Dining');
    const saved = await json<SpendTransaction[]>(await batch(t, member.cookie, [
      { id: b.id, personUserId: null },
      { id: a.id, categoryId: dining, personUserId: member.id },
    ]));
    expect(saved.map((s) => s.id)).toEqual([b.id, a.id]);
    expect(saved[0]).toMatchObject({ person: null, personSource: 'manual', categorySource: 'default' });
    expect(saved[1]).toMatchObject({ category: { id: dining }, categorySource: 'manual', person: { id: member.id }, personSource: 'manual' });
    expect(transaction(t, a.id)).toMatchObject({ categoryId: dining, personUserId: member.id });
    expect(transaction(t, b.id)).toMatchObject({ personUserId: null, personSource: 'manual' });
  });

  it("leaves a field's source alone when a change sets the value it already has", async () => {
    const { t, member } = setup();
    const kids = categoryId(t, 'Kids');
    const tx = addTransaction(t, addCard(t).id, { categoryId: kids, categorySource: 'rule', personUserId: member.id, personSource: 'rule' });
    const household = addTransaction(t, addCard(t).id);
    const [same, alsoSame] = await json<SpendTransaction[]>(await batch(t, member.cookie, [
      { id: tx.id, categoryId: kids, personUserId: member.id },
      { id: household.id, personUserId: null },
    ]));
    expect(same).toMatchObject({ categorySource: 'rule', personSource: 'rule' });
    expect(alsoSame).toMatchObject({ personSource: 'default' });
  });

  it('saves nothing when one change is refused: an archived category, a deactivated person, or a row that is gone or hidden', async () => {
    const { t, admin, member } = setup();
    const card = addCard(t).id;
    const good = addTransaction(t, card, { rawName: 'GOOD' });
    const other = addTransaction(t, card, { rawName: 'OTHER', merchant: 'Corner Store' });
    const dining = categoryId(t, 'Dining');
    const kids = categoryId(t, 'Kids');
    await call(t.app, 'POST', `${P}/categories/${kids}/archive`, { cookie: admin.cookie });
    const teen = addUser(t.db, t.clock, { email: 'teen@example.com', displayName: 'Teen', panels: [] });
    updateUser(t.db, teen, { active: false });
    const deleted = addTransaction(t, card, { deletedAt: t.clock.now() });
    const excluded = addTransaction(t, addCard(t, { included: false }).id);

    const invalid = (field: 'category' | 'person', problem: string) => ({
      code: 'validation', message: `Corner Store: ${problem}`, details: { transactionId: other.id, field, problem },
    });
    const missing = (id: number) => ({ code: 'not_found', message: SPEND_MESSAGES.transactionNotFound, details: { missingIds: [id] } });
    const cases: [unknown, number, unknown][] = [
      [{ id: other.id, categoryId: kids }, 400, invalid('category', SPEND_MESSAGES.categoryArchived)],
      [{ id: other.id, personUserId: teen }, 400, invalid('person', SPEND_MESSAGES.personInactive)],
      [{ id: other.id, categoryId: 99_999 }, 400, invalid('category', SPEND_MESSAGES.categoryNotFound)],
      [{ id: deleted.id, categoryId: dining }, 404, missing(deleted.id)],
      [{ id: excluded.id, categoryId: dining }, 404, missing(excluded.id)],
      [{ id: 99_999, categoryId: dining }, 404, missing(99_999)],
    ];
    const goodChange = { id: good.id, categoryId: dining, personUserId: member.id };
    const untouched = { categoryId: categoryId(t, 'Uncategorized'), categorySource: 'default', personUserId: null, personSource: 'default' };
    for (const [bad, status, error] of cases) {
      // The bad change after the good one, and before it: either way the good one isn't kept.
      for (const changes of [[goodChange, bad], [bad, goodChange]]) {
        expect(await json(await batch(t, member.cookie, changes), status)).toEqual({ error });
        expect(transaction(t, good.id)).toMatchObject(untouched);
      }
    }
    expect(transaction(t, excluded.id).categorySource).toBe('default');
  });

  it('lists every missing or hidden transaction first, even beside a value that would be refused', async () => {
    const { t, admin, member } = setup();
    const card = addCard(t).id;
    const other = addTransaction(t, card);
    const kids = categoryId(t, 'Kids');
    await call(t.app, 'POST', `${P}/categories/${kids}/archive`, { cookie: admin.cookie });
    const excluded = addTransaction(t, addCard(t, { included: false }).id);
    const deleted = addTransaction(t, card, { deletedAt: t.clock.now() });
    const res = await batch(t, member.cookie, [{ id: other.id, categoryId: kids }, { id: excluded.id, categoryId: kids }, { id: deleted.id, personUserId: null }]);
    expect(await json(res, 404)).toEqual({
      error: { code: 'not_found', message: '2 of these transactions no longer exist.', details: { missingIds: [excluded.id, deleted.id] } },
    });
  });

  it("refuses, saving nothing, when someone else changed a field since the page saw it, and lists each one with what's saved now", async () => {
    const { t, member } = setup();
    const card = addCard(t).id;
    const [uncategorized, dining, kids, groceries] = ['Uncategorized', 'Dining', 'Kids', 'Groceries'].map((n) => categoryId(t, n));
    const a = addTransaction(t, card, { rawName: 'A', merchant: 'Corner Store', categoryId: kids, categorySource: 'manual' });
    const b = addTransaction(t, card, { rawName: 'B', personUserId: member.id, personSource: 'manual' });
    const c = addTransaction(t, card, { rawName: 'C' });

    // A was Uncategorized when the page saw it; someone made it Kids since.
    const one = await batch(t, member.cookie, [
      { id: c.id, categoryId: dining, expected: { categoryId: uncategorized } },
      { id: a.id, categoryId: dining, expected: { categoryId: uncategorized } },
    ]);
    expect(await json(one, 409)).toEqual({
      error: {
        code: 'conflict',
        message: 'Someone else changed Corner Store while you were editing, so nothing was saved.',
        details: { conflicts: [{ transactionId: a.id, field: 'category', current: kids }] },
      },
    });
    expect(transaction(t, c.id).categorySource).toBe('default');

    const two = await batch(t, member.cookie, [
      { id: a.id, categoryId: dining, expected: { categoryId: uncategorized } },
      { id: b.id, personUserId: null, expected: { personUserId: null } },
    ]);
    expect(await json(two, 409)).toEqual({
      error: {
        code: 'conflict',
        message: 'Someone else changed 2 of these transactions while you were editing, so nothing was saved.',
        details: { conflicts: [{ transactionId: a.id, field: 'category', current: kids }, { transactionId: b.id, field: 'person', current: member.id }] },
      },
    });

    // Expecting what's saved now goes through; so does a field that already holds the new value,
    // and a change sent without `expected` (the API's older form).
    const ok = await json<SpendTransaction[]>(await batch(t, member.cookie, [
      { id: a.id, categoryId: groceries, expected: { categoryId: kids } },
      { id: b.id, personUserId: member.id, expected: { personUserId: null } },
      { id: c.id, categoryId: dining },
    ]));
    expect(ok.map((r) => [r.category.id, r.person?.id ?? null])).toEqual([[groceries, null], [uncategorized, member.id], [dining, null]]);
  });

  it('refuses a body over 64 KB before reading it', async () => {
    const { t, member } = setup();
    const tx = addTransaction(t, addCard(t).id);
    const res = await call(t.app, 'PATCH', `${P}/transactions`, { cookie: member.cookie, body: { changes: [{ id: tx.id, categoryId: 1 }], pad: 'x'.repeat(70 * 1024) } });
    expect(await json(res, 413)).toEqual({ error: { code: 'validation', message: SPEND_MESSAGES.batchTooBig } });
    expect(transaction(t, tx.id).categorySource).toBe('default');
  });

  it('keeps an archived category or deactivated person a row already has', async () => {
    const { t, admin, member } = setup();
    const kids = categoryId(t, 'Kids');
    const tx = addTransaction(t, addCard(t).id, { categoryId: kids, categorySource: 'manual', personUserId: member.id, personSource: 'manual' });
    await call(t.app, 'POST', `${P}/categories/${kids}/archive`, { cookie: admin.cookie });
    updateUser(t.db, member.id, { active: false });
    const [saved] = await json<SpendTransaction[]>(await batch(t, admin.cookie, [{ id: tx.id, categoryId: kids, personUserId: member.id }]));
    expect(saved).toMatchObject({ category: { id: kids, archived: true }, person: { id: member.id, active: false } });
  });

  it('refuses an empty list, a change with nothing in it, a note, a transaction listed twice, and more than 500', async () => {
    const { t, member } = setup();
    const tx = addTransaction(t, addCard(t).id);
    const dining = categoryId(t, 'Dining');
    const refused = async (changes: unknown) => (await json<{ error: { message: string } }>(await batch(t, member.cookie, changes), 400)).error.message;
    expect(await refused([])).toBe('There are no changes to save');
    expect(await refused([{ id: tx.id }])).toBe('Change the category or the person');
    expect(await refused([{ id: tx.id, note: 'x' }])).toBe('Change the category or the person');
    expect(await refused([{ id: tx.id, categoryId: dining }, { id: tx.id, personUserId: null }])).toBe('Each transaction can only be listed once');
    expect(await refused('nope')).toBe('Send the changes as a list');
    const many = Array.from({ length: TRANSACTION_BATCH_MAX + 1 }, (_, i) => ({ id: i + 1, categoryId: dining }));
    expect(await refused(many)).toBe("That's too many changes at once. Save changes on 500 transactions or fewer at a time.");
    expect(transaction(t, tx.id).categorySource).toBe('default');
  });

  it('saves 500 changes in one request', async () => {
    const { t, member } = setup();
    const card = addCard(t).id;
    const dining = categoryId(t, 'Dining');
    const rows = Array.from({ length: TRANSACTION_BATCH_MAX }, (_, i) => addTransaction(t, card, { rawName: `R${i}` }));
    const saved = await json<SpendTransaction[]>(await batch(t, member.cookie, rows.map((r) => ({ id: r.id, categoryId: dining }))));
    expect(saved).toHaveLength(TRANSACTION_BATCH_MAX);
    expect(saved.every((s) => s.categorySource === 'manual')).toBe(true);
  });
});
