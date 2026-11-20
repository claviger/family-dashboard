import { describe, expect, it } from 'vitest';
import { SPEND_MESSAGES, type DuplicateRemoval, type DuplicateRestore, type ImportPreview, type SpendOverview, type SpendSummary } from '../../../shared/spend.js';
import { eq } from 'drizzle-orm';
import { transactions } from '../../db/schema.js';
import { bofaCsv, bytes, reference } from '../../test/bofaCsv.js';
import { call, makeTestApp, TEST_BASE_URL, type TestApp } from '../../test/helpers.js';
import { addCard, addCsvImport, addTransaction, categoryId, spendUser, transaction } from '../../test/spendFixtures.js';
import { twinIdsOf } from './twins.js';

// Remove duplicate and its Undo (spec §12.12). Synthetic rows; the test clock is 2026-11-15 12:00 UTC.
const P = '/api/panels/spend';

async function json<T>(res: Response, status = 200): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await res.json()) as T;
}

function setup() {
  const t = makeTestApp();
  const admin = spendUser(t, { role: 'admin', email: 'admin@example.com', name: 'Admin' });
  const member = spendUser(t, { role: 'member', email: 'kid@example.com', name: 'Kid' });
  const card = addCard(t, { nickname: 'Visa', mask: '1234', usualClosingDay: 15 });
  return { t, admin, member, card };
}

/** A Plaid row and its CSV twin: same card, date, and amount, other names. */
function pair(t: TestApp, cardId: number, opts: { date?: string; amountCents?: number } = {}) {
  const date = opts.date ?? '2026-11-02';
  const amountCents = opts.amountCents ?? 1099;
  const plaid = addTransaction(t, cardId, { source: 'plaid', plaidTransactionId: `p-${date}-${amountCents}-${Math.random()}`, date, amountCents, merchant: "McDonald's", rawName: "McDonald's" });
  // From an import, as every CSV row is (one whose import was undone can't be brought back).
  const csv = addTransaction(t, cardId, { date, amountCents, rawName: 'McDonalds 5795 142-5483579 W', csvReference: reference(20, amountCents), csvImportId: addCsvImport(t, cardId).id });
  return { plaid, csv };
}

const overview = async (t: TestApp, cookie: string, cardId = 1) => json<SpendOverview>(await call(t.app, 'GET', `${P}/overview?card=${cardId}`, { cookie }));
const removeDup = (t: TestApp, cookie: string, id: number) => call(t.app, 'POST', `${P}/transactions/${id}/remove-duplicate`, { cookie });
const restoreDup = (t: TestApp, cookie: string, id: number) => call(t.app, 'POST', `${P}/transactions/${id}/restore-duplicate`, { cookie });

describe('twins (spec §12.12)', () => {
  it('are live rows on the same card with the same date and amount, whatever their names', async () => {
    const { t, admin, card } = setup();
    const { plaid, csv } = pair(t, card.id);
    const third = addTransaction(t, card.id, { date: '2026-11-02', amountCents: 1099, rawName: 'SOMETHING ELSE' });
    // Not twins: another day, another amount, another card, deleted, or removed by the bank.
    addTransaction(t, card.id, { date: '2026-11-03', amountCents: 1099 });
    addTransaction(t, card.id, { date: '2026-11-02', amountCents: 1098 });
    addTransaction(t, addCard(t, { nickname: 'Other' }).id, { date: '2026-11-02', amountCents: 1099 });
    addTransaction(t, card.id, { date: '2026-11-02', amountCents: 1099, deletedAt: t.clock.now() });
    addTransaction(t, card.id, { source: 'plaid', plaidTransactionId: 'gone', date: '2026-11-02', amountCents: 1099, removedAt: t.clock.now(), deletedAt: t.clock.now() });
    const o = await overview(t, admin.cookie);
    const twins = new Map(o.transactions.map((r) => [r.id, r.twinIds]));
    expect(twins.get(plaid.id)).toEqual([csv.id, third.id]);
    expect(twins.get(csv.id)).toEqual([plaid.id, third.id]);
    expect(o.transactions.filter((r) => r.twinIds.length === 0)).toHaveLength(2);
    // The home card's rows, and an edit's answer, carry them too.
    const summary = await json<SpendSummary>(await call(t.app, 'GET', `${P}/summary`, { cookie: admin.cookie }));
    expect(summary.recent.find((r) => r.id === csv.id)!.twinIds).toEqual([plaid.id, third.id]);
    const patched = await json<{ twinIds: number[] }>(await call(t.app, 'PATCH', `${P}/transactions/${csv.id}`, { cookie: admin.cookie, body: { note: 'x' } }));
    expect(patched.twinIds).toEqual([plaid.id, third.id]);
  });

  it('are found for many rows in a few queries', () => {
    const { t, card } = setup();
    const ids = Array.from({ length: 1200 }, (_, i) => addTransaction(t, card.id, { date: '2026-11-02', amountCents: 100 + (i >> 1) }).id);
    const twins = twinIdsOf(t.db, ids);
    expect(twins.get(ids[0]!)).toEqual([ids[1]]);
    expect(twins.get(ids[1199]!)).toEqual([ids[1198]]);
  });
});

describe('Remove duplicate (spec §12.12)', () => {
  it('is for admins, behind the CSRF check', async () => {
    const { t, admin, member, card } = setup();
    const { csv } = pair(t, card.id);
    expect((await call(t.app, 'POST', `${P}/transactions/${csv.id}/remove-duplicate`, {})).status).toBe(401);
    expect((await removeDup(t, member.cookie, csv.id)).status).toBe(403);
    expect((await call(t.app, 'POST', `${P}/transactions/${csv.id}/remove-duplicate`, { cookie: admin.cookie, csrf: false })).status).toBe(403);
    expect((await restoreDup(t, member.cookie, csv.id)).status).toBe(403);
    expect(transaction(t, csv.id).deletedAt).toBeNull();
  });

  it('soft-deletes the row as a duplicate, so it leaves the list, the totals, and its twin', async () => {
    const { t, admin, card } = setup();
    const { plaid, csv } = pair(t, card.id);
    const before = await overview(t, admin.cookie);
    expect(before.totals.totalCents).toBe(2198);
    const removed = await json<DuplicateRemoval>(await removeDup(t, admin.cookie, csv.id));
    expect(removed).toEqual({ id: csv.id, copiedTo: null, copied: [] });
    expect(transaction(t, csv.id)).toMatchObject({ deletedAt: t.clock.now(), deletedReason: 'duplicate', duplicateOfId: plaid.id, duplicateCarry: null });
    const after = await overview(t, admin.cookie);
    expect(after.transactions.map((r) => [r.id, r.twinIds])).toEqual([[plaid.id, []]]);
    expect(after.totals.totalCents).toBe(1099);
    expect(after.totals.byCategory.reduce((n, b) => n + b.cents, 0)).toBe(1099);
    expect(after.totals.byPerson.reduce((n, b) => n + b.cents, 0)).toBe(1099);
  });

  it('refuses a row with no twin, one already removed, and one that is gone or hidden', async () => {
    const { t, admin, card } = setup();
    const lone = addTransaction(t, card.id, { date: '2026-11-04', amountCents: 500 });
    expect(await json(await removeDup(t, admin.cookie, lone.id), 409)).toEqual({ error: { code: 'conflict', message: SPEND_MESSAGES.duplicateNoTwin } });
    const { plaid, csv } = pair(t, card.id);
    await json(await removeDup(t, admin.cookie, csv.id));
    expect(await json(await removeDup(t, admin.cookie, csv.id), 409)).toEqual({ error: { code: 'conflict', message: SPEND_MESSAGES.duplicateAlreadyRemoved } });
    // Its twin has none left now.
    expect(await json(await removeDup(t, admin.cookie, plaid.id), 409)).toEqual({ error: { code: 'conflict', message: SPEND_MESSAGES.duplicateNoTwin } });
    expect((await removeDup(t, admin.cookie, 999_999)).status).toBe(404);
    const hidden = addCard(t, { nickname: 'Hidden', included: false });
    const h = pair(t, hidden.id);
    expect((await removeDup(t, admin.cookie, h.csv.id)).status).toBe(404);
  });

  it("copies a manual category, a manual person, and a note to its one twin, only where the twin has none of its own", async () => {
    const { t, admin, member, card } = setup();
    const { plaid, csv } = pair(t, card.id);
    const dining = categoryId(t, 'Dining');
    // Through the API, as people would: the CSV row has all three by hand.
    await json(await call(t.app, 'PATCH', `${P}/transactions/${csv.id}`, { cookie: admin.cookie, body: { categoryId: dining, personUserId: member.id, note: 'Birthday lunch' } }));
    const removed = await json<DuplicateRemoval>(await removeDup(t, admin.cookie, csv.id));
    expect(removed).toEqual({ id: csv.id, copiedTo: plaid.id, copied: ['category', 'person', 'note'] });
    expect(transaction(t, plaid.id)).toMatchObject({ categoryId: dining, categorySource: 'manual', personUserId: member.id, personSource: 'manual', note: 'Birthday lunch' });
    expect(transaction(t, csv.id).duplicateCarry).toEqual({ categoryId: dining, personUserId: member.id, note: 'Birthday lunch' });
    // The removed row keeps its own values.
    expect(transaction(t, csv.id)).toMatchObject({ categoryId: dining, personUserId: member.id, note: 'Birthday lunch' });
  });

  it("leaves a twin's own manual values and note alone, and copies nothing when there are several twins", async () => {
    const { t, admin, member, card } = setup();
    const { plaid, csv } = pair(t, card.id);
    const dining = categoryId(t, 'Dining');
    const health = categoryId(t, 'Health');
    await json(await call(t.app, 'PATCH', `${P}/transactions/${csv.id}`, { cookie: admin.cookie, body: { categoryId: dining, personUserId: member.id, note: 'Mine' } }));
    await json(await call(t.app, 'PATCH', `${P}/transactions/${plaid.id}`, { cookie: admin.cookie, body: { categoryId: health, note: 'Theirs' } }));
    expect(await json<DuplicateRemoval>(await removeDup(t, admin.cookie, csv.id))).toEqual({ id: csv.id, copiedTo: plaid.id, copied: ['person'] });
    expect(transaction(t, plaid.id)).toMatchObject({ categoryId: health, personUserId: member.id, note: 'Theirs' });

    const three = pair(t, card.id, { date: '2026-11-05', amountCents: 400 });
    const extra = addTransaction(t, card.id, { date: '2026-11-05', amountCents: 400, rawName: 'ANOTHER' });
    await json(await call(t.app, 'PATCH', `${P}/transactions/${three.csv.id}`, { cookie: admin.cookie, body: { note: 'Which one?' } }));
    expect(await json<DuplicateRemoval>(await removeDup(t, admin.cookie, three.csv.id))).toEqual({ id: three.csv.id, copiedTo: null, copied: [] });
    expect(transaction(t, three.plaid.id).note).toBeNull();
    expect(transaction(t, extra.id).note).toBeNull();
    // It points at the lowest-id twin.
    expect(transaction(t, three.csv.id).duplicateOfId).toBe(three.plaid.id);
  });
});

describe('Undo of Remove duplicate', () => {
  it('brings the row back and takes back what it copied to its twin', async () => {
    const { t, admin, member, card } = setup();
    const { plaid, csv } = pair(t, card.id);
    const before = transaction(t, plaid.id);
    const dining = categoryId(t, 'Dining');
    await json(await call(t.app, 'PATCH', `${P}/transactions/${csv.id}`, { cookie: admin.cookie, body: { categoryId: dining, personUserId: member.id, note: 'Lunch' } }));
    await json(await removeDup(t, admin.cookie, csv.id));
    const restored = await json<DuplicateRestore>(await restoreDup(t, admin.cookie, csv.id));
    expect(restored.reverted).toEqual(['category', 'person', 'note']);
    expect(restored.transaction).toMatchObject({ id: csv.id, twinIds: [plaid.id], note: 'Lunch', category: { id: dining } });
    expect(transaction(t, csv.id)).toMatchObject({ deletedAt: null, deletedReason: null, duplicateOfId: null, duplicateCarry: null });
    expect(transaction(t, plaid.id)).toMatchObject({
      categoryId: before.categoryId, categorySource: before.categorySource, personUserId: null, personSource: 'default', note: null,
    });
    const o = await overview(t, admin.cookie);
    expect(o.totals.totalCents).toBe(2198);
  });

  it("keeps what someone changed on the twin since, and takes back only what's still the copy", async () => {
    const { t, admin, member, card } = setup();
    const { plaid, csv } = pair(t, card.id);
    const dining = categoryId(t, 'Dining');
    const health = categoryId(t, 'Health');
    await json(await call(t.app, 'PATCH', `${P}/transactions/${csv.id}`, { cookie: admin.cookie, body: { categoryId: dining, personUserId: member.id, note: 'Lunch' } }));
    await json(await removeDup(t, admin.cookie, csv.id));
    await json(await call(t.app, 'PATCH', `${P}/transactions/${plaid.id}`, { cookie: admin.cookie, body: { categoryId: health, note: 'Edited' } }));
    const restored = await json<DuplicateRestore>(await restoreDup(t, admin.cookie, csv.id));
    expect(restored.reverted).toEqual(['person']);
    expect(transaction(t, plaid.id)).toMatchObject({ categoryId: health, categorySource: 'manual', personUserId: null, personSource: 'default', note: 'Edited' });
  });

  it('refuses a row that is not a removed duplicate, or that the bank has removed since', async () => {
    const { t, admin, card } = setup();
    const { plaid, csv } = pair(t, card.id);
    expect(await json(await restoreDup(t, admin.cookie, csv.id), 409)).toEqual({ error: { code: 'conflict', message: SPEND_MESSAGES.duplicateNotRemoved } });
    const other = addTransaction(t, card.id, { deletedAt: t.clock.now() });
    expect((await restoreDup(t, admin.cookie, other.id)).status).toBe(409);
    await json(await removeDup(t, admin.cookie, plaid.id));
    t.db.update(transactions).set({ removedAt: t.clock.now() }).where(eq(transactions.id, plaid.id)).run();
    expect(await json(await restoreDup(t, admin.cookie, plaid.id), 409)).toEqual({ error: { code: 'conflict', message: SPEND_MESSAGES.duplicateBankRemoved } });
  });
});

describe('a removed duplicate stays removed', () => {
  const upload = async (t: TestApp, cookie: string, cardId: number, file: string) => {
    const form = new FormData();
    form.set('cardId', String(cardId));
    form.set('file', new File([bytes(file)], 'currentTransaction_1234.csv', { type: 'text/csv' }));
    const res = await t.app.request(`${P}/imports`, { method: 'POST', headers: { cookie, 'x-requested-with': 'dashboard', origin: TEST_BASE_URL }, body: form });
    return json<ImportPreview>(res, 201);
  };

  it("when its CSV file is imported again: its reference number is still stored", async () => {
    const { t, admin, card } = setup();
    const { csv } = pair(t, card.id);
    await json(await removeDup(t, admin.cookie, csv.id));
    const preview = await upload(t, admin.cookie, card.id, bofaCsv([{ date: '11/02/2026', reference: csv.csvReference!, payee: 'McDonalds 5795 142-5483579 W', amount: '-10.99' }]));
    expect(preview.rows.map((r) => r.status)).toEqual(['already_imported']);
  });

  it("when its import is undone: it stays hidden, holding its reference number, and a re-import still skips it", async () => {
    const { t, admin, card } = setup();
    const imp = addCsvImport(t, card.id);
    const { plaid } = pair(t, card.id);
    const csv = addTransaction(t, card.id, { date: '2026-11-02', amountCents: 1099, rawName: 'McDonalds 5795', csvReference: reference(21, 1), csvImportId: imp.id });
    const kept = addTransaction(t, card.id, { date: '2026-11-06', amountCents: 700, rawName: 'OTHER', csvReference: reference(21, 2), csvImportId: imp.id });
    await json(await removeDup(t, admin.cookie, csv.id));
    expect(await json(await call(t.app, 'DELETE', `${P}/cards/${card.id}/imports/${imp.id}`, { cookie: admin.cookie }))).toEqual({ removed: 1 });
    expect(transaction(t, kept.id)).toBeUndefined();
    expect(transaction(t, csv.id)).toMatchObject({ deletedReason: 'duplicate', csvImportId: null, csvReference: reference(21, 1) });
    expect(transaction(t, plaid.id).deletedAt).toBeNull();
    const preview = await upload(t, admin.cookie, card.id, bofaCsv([{ date: '11/02/2026', reference: reference(21, 1), payee: 'McDonalds 5795', amount: '-10.99' }]));
    expect(preview.rows.map((r) => r.status)).toEqual(['already_imported']);
  });

  it('comes back when an import undo deletes its only twin', async () => {
    const { t, admin, card } = setup();
    const imp = addCsvImport(t, card.id);
    const plaid = addTransaction(t, card.id, { source: 'plaid', plaidTransactionId: 'p-1', date: '2026-11-02', amountCents: 1099, merchant: 'Cafe', rawName: 'Cafe' });
    const csv = addTransaction(t, card.id, { date: '2026-11-02', amountCents: 1099, rawName: 'CAFE 12', csvReference: reference(22, 1), csvImportId: imp.id });
    // The Plaid row was the one removed: undoing the import would leave neither.
    await json(await removeDup(t, admin.cookie, plaid.id));
    expect(await json(await call(t.app, 'DELETE', `${P}/cards/${card.id}/imports/${imp.id}`, { cookie: admin.cookie }))).toEqual({ removed: 1 });
    expect(transaction(t, csv.id)).toBeUndefined();
    expect(transaction(t, plaid.id)).toMatchObject({ deletedAt: null, deletedReason: null, duplicateOfId: null });
  });

  it("can't be brought back once its import was undone (there'd be no way to remove it again)", async () => {
    const { t, admin, card } = setup();
    const imp = addCsvImport(t, card.id);
    pair(t, card.id);
    const csv = addTransaction(t, card.id, { date: '2026-11-02', amountCents: 1099, rawName: 'McDonalds 5795', csvReference: reference(23, 1), csvImportId: imp.id });
    await json(await removeDup(t, admin.cookie, csv.id));
    await json(await call(t.app, 'DELETE', `${P}/cards/${card.id}/imports/${imp.id}`, { cookie: admin.cookie }));
    expect(await json(await restoreDup(t, admin.cookie, csv.id), 409)).toEqual({ error: { code: 'conflict', message: SPEND_MESSAGES.duplicateImportUndone } });
    expect(transaction(t, csv.id).deletedAt).not.toBeNull();
  });

  it('is left out of rules applied to past transactions', async () => {
    const { t, admin, card } = setup();
    const { csv } = pair(t, card.id);
    await json(await removeDup(t, admin.cookie, csv.id));
    const before = transaction(t, csv.id);
    await json(await call(t.app, 'POST', `${P}/rules`, {
      cookie: admin.cookie,
      body: { matchText: 'McDonalds', matchType: 'contains', cardId: null, minCents: null, maxCents: null, setCategoryId: categoryId(t, 'Dining'), setPerson: null, applyToPast: true },
    }), 201);
    expect(transaction(t, csv.id)).toMatchObject({ categoryId: before.categoryId, deletedReason: 'duplicate' });
  });
});
