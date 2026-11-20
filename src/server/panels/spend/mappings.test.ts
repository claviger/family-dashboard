import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { MAPPING_MESSAGES, PFC_V2_PRIMARIES, type MappingView } from '../../../shared/plaid.js';
import { SPEND_MESSAGES } from '../../../shared/spend.js';
import { categories, categoryMappings, transactions } from '../../db/schema.js';
import { addUser, call, cookieFor, makeTestApp, type TestApp } from '../../test/helpers.js';
import { addCard, addTransaction, categoryId, spendUser } from '../../test/spendFixtures.js';
import { mappedCategory } from './rules.js';
import { loadCategorizer } from './store.js';

// Plaid category codes are Plaid's own (research §2.4); the transactions are synthetic.
const P = '/api/panels/spend';

async function json<T>(res: Response, status = 200): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await res.json()) as T;
}

function setup(opts: { plaid?: boolean } = {}) {
  const t = makeTestApp({ plaid: opts.plaid ?? false });
  const admin = spendUser(t, { role: 'admin' });
  const card = addCard(t);
  return { t, admin, card };
}

/** A Plaid row with these PFC codes. */
function plaidRow(t: TestApp, cardId: number, primary: string, detailed: string, patch: Partial<Parameters<typeof addTransaction>[2]> = {}) {
  return addTransaction(t, cardId, {
    source: 'plaid', plaidTransactionId: `tx-${Math.random().toString(36).slice(2)}`, plaidPfcPrimary: primary, plaidPfcDetailed: detailed, plaidPfcVersion: 'v2', ...patch,
  });
}

const get = async (t: TestApp, cookie: string) => json<MappingView>(await call(t.app, 'GET', `${P}/mappings`, { cookie }));

describe('the Plaid category mapping editor (spec §12.7)', () => {
  it('is for admins with the Spend panel, behind the CSRF check, and works without Plaid configured', async () => {
    const { t, admin } = setup();
    const member = spendUser(t, { role: 'member' });
    const noPanel = cookieFor(t.db, t.clock, addUser(t.db, t.clock, { email: 'a2@example.com', role: 'admin', panels: ['todo'] }));
    const dining = categoryId(t, 'Dining');
    for (const [method, path, body] of [
      ['GET', '/mappings', undefined], ['PUT', '/mappings/FOOD_AND_DRINK', { categoryId: dining }], ['DELETE', '/mappings/FOOD_AND_DRINK_GROCERIES', undefined],
    ] as const) {
      expect((await call(t.app, method, `${P}${path}`, { body })).status).toBe(401);
      expect((await call(t.app, method, `${P}${path}`, { cookie: member.cookie, body })).status).toBe(403);
      expect((await call(t.app, method, `${P}${path}`, { cookie: noPanel, body })).status).toBe(403);
    }
    expect((await call(t.app, 'PUT', `${P}/mappings/FOOD_AND_DRINK`, { cookie: admin.cookie, body: { categoryId: dining }, csrf: false })).status).toBe(403);
    expect((await call(t.app, 'GET', `${P}/mappings`, { cookie: admin.cookie })).status).toBe(200);
  });

  it("lists the seeded rows, primary or detailed, with each detailed code's primary and the transactions using it", async () => {
    const { t, admin, card } = setup();
    plaidRow(t, card.id, 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES');
    plaidRow(t, card.id, 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES');
    plaidRow(t, card.id, 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES', { deletedAt: t.clock.now() });
    const { rows, unmapped } = await get(t, admin.cookie);
    expect(rows).toHaveLength(33);
    expect(rows.map((r) => r.code)).toEqual([...rows.map((r) => r.code)].sort());
    expect(rows.filter((r) => r.kind === 'primary').map((r) => r.code).sort()).toEqual([...PFC_V2_PRIMARIES].sort());
    expect(rows.find((r) => r.code === 'FOOD_AND_DRINK_GROCERIES')).toEqual({
      code: 'FOOD_AND_DRINK_GROCERIES', kind: 'detailed', primary: 'FOOD_AND_DRINK', taxonomyVersion: 'v2',
      category: { id: categoryId(t, 'Groceries'), name: 'Groceries', kind: 'normal', archived: false }, transactionCount: 2,
    });
    expect(rows.find((r) => r.code === 'FOOD_AND_DRINK')).toMatchObject({ kind: 'primary', primary: null, category: { name: 'Dining' }, transactionCount: 2 });
    expect(unmapped).toEqual([]);
  });

  it("gives a detailed code the longest primary it starts with, at a '_' boundary", async () => {
    const { t, admin, card } = setup();
    // An older taxonomy's primary that is a prefix of v2's LOAN_PAYMENTS, and a code under both.
    plaidRow(t, card.id, 'LOAN', 'LOAN_PAYMENTS_SYNTHETIC_THING', { plaidPfcVersion: 'v1' });
    plaidRow(t, card.id, 'LOAN', 'LOANX_SYNTHETIC_THING', { plaidPfcVersion: 'v1' });
    const { unmapped } = await get(t, admin.cookie);
    expect(unmapped.find((r) => r.code === 'LOAN_PAYMENTS_SYNTHETIC_THING')).toMatchObject({ kind: 'detailed', primary: 'LOAN_PAYMENTS' });
    expect(unmapped.find((r) => r.code === 'LOANX_SYNTHETIC_THING')).toMatchObject({ kind: 'detailed', primary: null });
    expect(unmapped.find((r) => r.code === 'LOAN')).toMatchObject({ kind: 'primary', primary: null });
  });

  it('lists codes seen on transactions without a row, with what they fall back to now', async () => {
    const { t, admin, card } = setup();
    plaidRow(t, card.id, 'TRANSPORTATION', 'TRANSPORTATION_GAS');
    plaidRow(t, card.id, 'TRANSPORTATION', 'TRANSPORTATION_GAS', { plaidPfcVersion: null });
    // A primary nothing maps, from an older taxonomy, and its detailed code.
    plaidRow(t, card.id, 'LEGACY_PRIMARY', 'LEGACY_PRIMARY_THING', { plaidPfcVersion: 'v1' });
    const { unmapped } = await get(t, admin.cookie);
    expect(unmapped).toEqual([
      { code: 'LEGACY_PRIMARY', kind: 'primary', primary: null, taxonomyVersion: 'v1', transactionCount: 1, fallsBackTo: null },
      { code: 'LEGACY_PRIMARY_THING', kind: 'detailed', primary: 'LEGACY_PRIMARY', taxonomyVersion: 'v1', transactionCount: 1, fallsBackTo: null },
      {
        code: 'TRANSPORTATION_GAS', kind: 'detailed', primary: 'TRANSPORTATION', taxonomyVersion: 'v2', transactionCount: 2,
        fallsBackTo: { id: categoryId(t, 'Gas and auto'), name: 'Gas and auto', kind: 'normal', archived: false },
      },
    ]);
  });

  it('changes a row, adds one for a code Plaid has sent, and refuses an archived category or a code it has never seen', async () => {
    const { t, admin, card } = setup();
    plaidRow(t, card.id, 'TRANSPORTATION', 'TRANSPORTATION_GAS', { plaidPfcVersion: null });
    const put = (code: string, id: number) => call(t.app, 'PUT', `${P}/mappings/${code}`, { cookie: admin.cookie, body: { categoryId: id } });
    const home = categoryId(t, 'Home');

    let v = await json<MappingView>(await put('FOOD_AND_DRINK', home));
    expect(v.rows.find((r) => r.code === 'FOOD_AND_DRINK')!.category.name).toBe('Home');
    v = await json<MappingView>(await put('TRANSPORTATION_GAS', home));
    // A code with no version on its transactions is v2's, the taxonomy Plaid sends now.
    expect(v.rows.find((r) => r.code === 'TRANSPORTATION_GAS')).toMatchObject({ kind: 'detailed', primary: 'TRANSPORTATION', taxonomyVersion: 'v2', category: { name: 'Home' } });
    expect(v.unmapped).toEqual([]);

    expect(await json(await put('NEVER_SENT_CODE', home), 404)).toEqual({ error: { code: 'not_found', message: MAPPING_MESSAGES.unknownCode } });
    expect((await put('lowercase_code', home)).status).toBe(404);
    t.db.update(categories).set({ archived: true }).where(eq(categories.id, categoryId(t, 'Kids'))).run();
    expect(await json(await put('FOOD_AND_DRINK', categoryId(t, 'Kids')), 400)).toEqual({ error: { code: 'validation', message: SPEND_MESSAGES.categoryArchived } });
    expect((await put('FOOD_AND_DRINK', 9999)).status).toBe(400);
    expect((await call(t.app, 'PUT', `${P}/mappings/FOOD_AND_DRINK`, { cookie: admin.cookie, body: {} })).status).toBe(400);
    expect(t.db.select().from(categoryMappings).where(eq(categoryMappings.plaidPfc, 'FOOD_AND_DRINK')).get()!.categoryId).toBe(home);
  });

  it('deletes a detailed row, so it falls back to its primary, but never a primary one', async () => {
    const { t, admin, card } = setup();
    plaidRow(t, card.id, 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES');
    const del = (code: string) => call(t.app, 'DELETE', `${P}/mappings/${code}`, { cookie: admin.cookie });
    const v = await json<MappingView>(await del('FOOD_AND_DRINK_GROCERIES'));
    expect(v.rows.some((r) => r.code === 'FOOD_AND_DRINK_GROCERIES')).toBe(false);
    expect(v.unmapped).toEqual([expect.objectContaining({ code: 'FOOD_AND_DRINK_GROCERIES', fallsBackTo: expect.objectContaining({ name: 'Dining' }) })]);
    expect(await json(await del('FOOD_AND_DRINK_GROCERIES'), 404)).toEqual({ error: { code: 'not_found', message: MAPPING_MESSAGES.notFound } });
    expect(await json(await del('FOOD_AND_DRINK'), 409)).toEqual({ error: { code: 'conflict', message: MAPPING_MESSAGES.primaryStays } });
    // A primary seen only on transactions counts as a primary too.
    plaidRow(t, card.id, 'LEGACY_PRIMARY', 'LEGACY_PRIMARY_THING', { plaidPfcVersion: 'v1' });
    await json(await call(t.app, 'PUT', `${P}/mappings/LEGACY_PRIMARY`, { cookie: admin.cookie, body: { categoryId: categoryId(t, 'Other') } }));
    expect((await del('LEGACY_PRIMARY')).status).toBe(409);
  });

  describe('PATCH /mappings, the one Save (review G4-I3)', () => {
    const patch = (t: TestApp, cookie: string, changes: unknown, opts: { csrf?: boolean } = {}) =>
      call(t.app, 'PATCH', `${P}/mappings`, { cookie, body: { changes }, ...opts });
    const stored = (t: TestApp) => new Map(t.db.select().from(categoryMappings).all().map((m) => [m.plaidPfc, m.categoryId]));

    it('saves every change in one request: a new row for a code Plaid sent, a changed row, and a deleted detailed row', async () => {
      const { t, admin, card } = setup();
      plaidRow(t, card.id, 'TRANSPORTATION', 'TRANSPORTATION_GAS', { plaidPfcVersion: 'v1' });
      plaidRow(t, card.id, 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES');
      const home = categoryId(t, 'Home');
      const before = stored(t);
      const v = await json<MappingView>(await patch(t, admin.cookie, [
        { code: 'TRANSPORTATION_GAS', categoryId: home, expected: null },
        { code: 'FOOD_AND_DRINK', categoryId: home, expected: before.get('FOOD_AND_DRINK') },
        { code: 'FOOD_AND_DRINK_GROCERIES', categoryId: null, expected: before.get('FOOD_AND_DRINK_GROCERIES') },
      ]));
      expect(v.rows.find((r) => r.code === 'TRANSPORTATION_GAS')).toMatchObject({ kind: 'detailed', taxonomyVersion: 'v1', category: { name: 'Home' } });
      expect(v.rows.find((r) => r.code === 'FOOD_AND_DRINK')!.category.name).toBe('Home');
      expect(v.rows.some((r) => r.code === 'FOOD_AND_DRINK_GROCERIES')).toBe(false);
      // It falls back to its primary now, which this same Save changed.
      expect(v.unmapped).toEqual([expect.objectContaining({ code: 'FOOD_AND_DRINK_GROCERIES', fallsBackTo: expect.objectContaining({ name: 'Home' }) })]);
      expect(stored(t).get('TRANSPORTATION_GAS')).toBe(home);
    });

    it("saves all or nothing: a category that can't be used names its code, and nothing else is saved", async () => {
      const { t, admin } = setup();
      const before = stored(t);
      t.db.update(categories).set({ archived: true }).where(eq(categories.id, categoryId(t, 'Kids'))).run();
      const res = await patch(t, admin.cookie, [
        { code: 'FOOD_AND_DRINK', categoryId: categoryId(t, 'Home'), expected: before.get('FOOD_AND_DRINK') },
        { code: 'TRAVEL', categoryId: categoryId(t, 'Kids'), expected: before.get('TRAVEL') },
      ]);
      expect(await json(res, 400)).toEqual({
        error: { code: 'validation', message: `Travel: ${SPEND_MESSAGES.categoryArchived}`, details: { code: 'TRAVEL', problem: SPEND_MESSAGES.categoryArchived } },
      });
      expect(stored(t)).toEqual(before);
      // A primary's row can be changed, never deleted.
      expect(await json(await patch(t, admin.cookie, [{ code: 'FOOD_AND_DRINK', categoryId: null, expected: before.get('FOOD_AND_DRINK') }]), 400)).toEqual({
        error: { code: 'validation', message: `Food and drink: ${MAPPING_MESSAGES.primaryStays}`, details: { code: 'FOOD_AND_DRINK', problem: MAPPING_MESSAGES.primaryStays } },
      });
      expect(stored(t)).toEqual(before);
    });

    it('refuses with a 409 when someone else changed a code since the page saw it, naming what it holds now, and saves nothing', async () => {
      const { t, admin } = setup();
      const before = stored(t);
      const dining = before.get('FOOD_AND_DRINK')!;
      const home = categoryId(t, 'Home');
      const other = categoryId(t, 'Other');
      // Someone else maps FOOD_AND_DRINK to Other meanwhile.
      await json(await call(t.app, 'PUT', `${P}/mappings/FOOD_AND_DRINK`, { cookie: admin.cookie, body: { categoryId: other } }));
      const res = await patch(t, admin.cookie, [
        { code: 'TRAVEL', categoryId: home, expected: before.get('TRAVEL') },
        { code: 'FOOD_AND_DRINK', categoryId: home, expected: dining },
      ]);
      expect(await json(res, 409)).toEqual({
        error: { code: 'conflict', message: MAPPING_MESSAGES.changedMeanwhile(1), details: { conflicts: [{ code: 'FOOD_AND_DRINK', current: other }] } },
      });
      expect(stored(t).get('TRAVEL')).toBe(before.get('TRAVEL'));
      expect(MAPPING_MESSAGES.changedMeanwhile(1)).toBe('Nothing was saved. Someone else changed one of these categories while you were editing. Check it, then save again.');
      expect(MAPPING_MESSAGES.changedMeanwhile(2)).toBe('Nothing was saved. Someone else changed 2 of these categories while you were editing. Check the flagged ones, then save again.');
      // Sent again with what it holds now as `expected`, it goes through; so does a change someone else already made the same way.
      await json(await patch(t, admin.cookie, [{ code: 'FOOD_AND_DRINK', categoryId: home, expected: other }, { code: 'TRAVEL', categoryId: before.get('TRAVEL'), expected: home }]));
      expect(stored(t).get('FOOD_AND_DRINK')).toBe(home);
    });

    it('refuses codes that are gone with a 404 naming them, and treats deleting a row that is already gone as done', async () => {
      const { t, admin, card } = setup();
      const before = stored(t);
      const res = await patch(t, admin.cookie, [
        { code: 'NEVER_SENT_CODE', categoryId: categoryId(t, 'Home'), expected: null },
        { code: 'TRAVEL', categoryId: categoryId(t, 'Home'), expected: before.get('TRAVEL') },
      ]);
      expect(await json(res, 404)).toEqual({ error: { code: 'not_found', message: MAPPING_MESSAGES.unknownCodes(1), details: { missingCodes: ['NEVER_SENT_CODE'] } } });
      expect(stored(t)).toEqual(before);
      // A detailed code seen on a transaction, with no row of its own: deleting is already done.
      plaidRow(t, card.id, 'TRANSPORTATION', 'TRANSPORTATION_GAS');
      await json(await patch(t, admin.cookie, [{ code: 'TRANSPORTATION_GAS', categoryId: null, expected: null }]));
      expect(stored(t)).toEqual(before);
    });

    it('is for admins, behind the CSRF check, and checks its body: codes once each, at most 500, in 64 KB', async () => {
      const { t, admin } = setup();
      const member = spendUser(t, { role: 'member' });
      const home = categoryId(t, 'Home');
      const one = [{ code: 'TRAVEL', categoryId: home }];
      expect((await call(t.app, 'PATCH', `${P}/mappings`, { body: { changes: one } })).status).toBe(401);
      expect((await patch(t, member.cookie, one)).status).toBe(403);
      expect((await patch(t, admin.cookie, one, { csrf: false })).status).toBe(403);
      expect((await patch(t, admin.cookie, [])).status).toBe(400);
      expect((await patch(t, admin.cookie, [...one, ...one])).status).toBe(400);
      expect((await patch(t, admin.cookie, [{ code: 'lowercase', categoryId: home }])).status).toBe(400);
      expect((await patch(t, admin.cookie, Array.from({ length: 501 }, (_, i) => ({ code: `CODE_${i}`, categoryId: home })))).status).toBe(400);
      const huge = await call(t.app, 'PATCH', `${P}/mappings`, { cookie: admin.cookie, body: { changes: one, pad: 'x'.repeat(70 * 1024) } });
      expect(huge.status).toBe(413);
      // Left out, `expected` isn't checked.
      expect((await patch(t, admin.cookie, one)).status).toBe(200);
    });
  });

  it('applies a change to transactions categorized afterwards, and to past ones through Apply rules to past transactions', async () => {
    const { t, admin, card } = setup();
    const row = plaidRow(t, card.id, 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_COFFEE', { categoryId: categoryId(t, 'Dining'), categorySource: 'mapping' });
    await json(await call(t.app, 'PUT', `${P}/mappings/FOOD_AND_DRINK_COFFEE`, { cookie: admin.cookie, body: { categoryId: categoryId(t, 'Groceries') } }));
    // A past row keeps its category until Apply rules; a row categorized now gets the new one.
    expect(t.db.select().from(transactions).where(eq(transactions.id, row.id)).get()).toMatchObject({ categoryId: categoryId(t, 'Dining'), categorySource: 'mapping' });
    expect(mappedCategory({ plaidPfcDetailed: 'FOOD_AND_DRINK_COFFEE', plaidPfcPrimary: 'FOOD_AND_DRINK' }, loadCategorizer(t.db))).toBe(categoryId(t, 'Groceries'));
    await json(await call(t.app, 'POST', `${P}/rules/apply`, { cookie: admin.cookie }));
    expect(t.db.select().from(transactions).where(eq(transactions.id, row.id)).get()).toMatchObject({ categoryId: categoryId(t, 'Groceries'), categorySource: 'mapping' });
  });
});
