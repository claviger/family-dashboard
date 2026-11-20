import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { RULE_PROBLEMS, SPEND_MESSAGES, type Card, type CardStatements, type Category, type Rule, type RuleSaveResponse } from '../../../shared/spend.js';
import { updateUser } from '../../admin/users.js';
import { categories, rules, statements } from '../../db/schema.js';
import { addUser, call, cookieFor, makeTestApp, type TestApp } from '../../test/helpers.js';
import { addCard, addTransaction, categoryId, spendUser, transaction } from '../../test/spendFixtures.js';

const P = '/api/panels/spend';

async function json<T>(res: Response, status = 200): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await res.json()) as T;
}

function setup() {
  const t = makeTestApp();
  const admin = spendUser(t, { role: 'admin', email: 'admin@example.com', name: 'Admin' });
  const member = spendUser(t, { role: 'member', email: 'kid@example.com', name: 'Kid' });
  return { t, admin, member };
}

const card = { nickname: 'Costco Visa', mask: '1234', included: true, usualClosingDay: 15 };
const rule = { matchText: 'netflix', matchType: 'contains', cardId: null, minCents: null, maxCents: null, setCategoryId: null, setPerson: null };

describe('Spend settings: permissions (spec §12.14)', () => {
  const adminRoutes: [string, string, unknown?][] = [
    ['GET', '/cards'],
    ['POST', '/cards', card],
    ['PUT', '/cards/1', card],
    ['POST', '/cards/1/archive'],
    ['POST', '/cards/1/unarchive'],
    ['DELETE', '/cards/1'],
    ['GET', '/cards/1/statements'],
    ['POST', '/cards/1/statements', { closingDate: '2026-11-15' }],
    ['PUT', '/statements/1', { closingDate: '2026-11-15' }],
    ['DELETE', '/statements/1'],
    ['POST', '/categories', { name: 'Pets' }],
    ['PUT', '/categories/1', { name: 'Food' }],
    ['POST', '/categories/1/archive'],
    ['POST', '/categories/1/unarchive'],
    ['POST', '/categories/1/move', { direction: 'up' }],
    ['DELETE', '/categories/1'],
    ['GET', '/rules'],
    ['POST', '/rules', { ...rule, setCategoryId: 1 }],
    ['PUT', '/rules/1', { ...rule, setCategoryId: 1 }],
    ['DELETE', '/rules/1'],
    ['POST', '/rules/1/move', { direction: 'up' }],
    ['POST', '/rules/apply'],
  ];

  it.each(adminRoutes)('%s %s is for admins with the Spend panel', async (method, path, body) => {
    const { t, member } = setup();
    addCard(t);
    const adminWithoutPanel = cookieFor(t.db, t.clock, addUser(t.db, t.clock, { email: 'other-admin@example.com', role: 'admin', panels: ['todo'] }));
    expect((await call(t.app, method, `${P}${path}`, { body })).status).toBe(401);
    expect(await json(await call(t.app, method, `${P}${path}`, { cookie: member.cookie, body }), 403)).toEqual({
      error: { code: 'forbidden', message: 'Only admins can do that.' },
    });
    expect((await call(t.app, method, `${P}${path}`, { cookie: adminWithoutPanel, body })).status).toBe(403);
    // And the CSRF check covers every change.
    if (method !== 'GET') expect((await call(t.app, method, `${P}${path}`, { cookie: member.cookie, body, csrf: false })).status).toBe(403);
  });

  it.each([['/people'], ['/categories']])('GET %s is for anyone with the Spend panel', async (path) => {
    const { t, member } = setup();
    const noPanel = cookieFor(t.db, t.clock, addUser(t.db, t.clock, { email: 'nopanel@example.com', panels: ['todo'] }));
    expect((await call(t.app, 'GET', `${P}${path}`)).status).toBe(401);
    expect((await call(t.app, 'GET', `${P}${path}`, { cookie: noPanel })).status).toBe(403);
    expect((await call(t.app, 'GET', `${P}${path}`, { cookie: member.cookie })).status).toBe(200);
  });
});

describe('Spend settings: people', () => {
  it('lists everyone by name, deactivated people included and marked', async () => {
    const { t, member } = setup();
    const gone = addUser(t.db, t.clock, { email: 'gone@example.com', displayName: 'Gone', panels: [] });
    updateUser(t.db, gone, { active: false });
    const people = await json<{ displayName: string; active: boolean }[]>(await call(t.app, 'GET', `${P}/people`, { cookie: member.cookie }));
    expect(people.map((p) => [p.displayName, p.active])).toEqual([['Admin', true], ['Gone', false], ['Kid', true]]);
  });
});

describe('Spend settings: cards', () => {
  it('creates a card by hand, with an optional last 4, included or not, and a usual closing day', async () => {
    const { t, admin } = setup();
    const created = await json<Card>(await call(t.app, 'POST', `${P}/cards`, { cookie: admin.cookie, body: card }), 201);
    expect(created).toEqual({
      id: created.id, nickname: 'Costco Visa', mask: '1234', archived: false, included: true, usualClosingDay: 15, plaidLinked: false, bankRemovedAt: null,
      transactionCount: 0, lastImportAt: null, deletable: true, deleteBlocker: null,
    });
    const plain = await json<Card>(await call(t.app, 'POST', `${P}/cards`, { cookie: admin.cookie, body: { ...card, nickname: ' Amex ', mask: '', included: false, usualClosingDay: null } }), 201);
    expect(plain).toMatchObject({ nickname: 'Amex', mask: null, included: false, usualClosingDay: null });
    expect((await json<Card[]>(await call(t.app, 'GET', `${P}/cards`, { cookie: admin.cookie }))).map((c) => c.nickname)).toEqual(['Amex', 'Costco Visa']);
  });

  it.each([
    [{ ...card, nickname: ' ' }, 'Enter a nickname'],
    [{ ...card, mask: '41111111' }, 'Enter the last 2 to 4 characters of the card number, or leave it empty'],
    [{ ...card, mask: '1' }, 'Enter the last 2 to 4 characters of the card number, or leave it empty'],
    [{ ...card, usualClosingDay: 0 }, 'Pick a closing day from 1 to 31, or none'],
    [{ ...card, usualClosingDay: 32 }, 'Pick a closing day from 1 to 31, or none'],
    [{ ...card, included: 'yes' }, 'Included must be true or false'],
  ])('refuses %j', async (body, message) => {
    const { t, admin } = setup();
    expect(await json(await call(t.app, 'POST', `${P}/cards`, { cookie: admin.cookie, body }), 400)).toEqual({ error: { code: 'validation', message } });
  });

  it('updates, archives, and unarchives a card', async () => {
    const { t, admin } = setup();
    const { id } = addCard(t);
    expect(await json<Card>(await call(t.app, 'PUT', `${P}/cards/${id}`, { cookie: admin.cookie, body: { ...card, usualClosingDay: 28 } }))).toMatchObject({
      nickname: 'Costco Visa', usualClosingDay: 28,
    });
    expect((await json<Card>(await call(t.app, 'POST', `${P}/cards/${id}/archive`, { cookie: admin.cookie }))).archived).toBe(true);
    expect((await json<Card>(await call(t.app, 'POST', `${P}/cards/${id}/unarchive`, { cookie: admin.cookie }))).archived).toBe(false);
    expect(await json(await call(t.app, 'PUT', `${P}/cards/999`, { cookie: admin.cookie, body: card }), 404)).toEqual({
      error: { code: 'not_found', message: SPEND_MESSAGES.cardNotFound },
    });
  });

  it('deletes a card without transactions, with its closing dates, and refuses one with transactions or rules', async () => {
    const { t, admin } = setup();
    const empty = addCard(t);
    t.db.insert(statements).values({ cardId: empty.id, closingDate: '2026-10-15', source: 'manual', createdAt: t.clock.now(), updatedAt: t.clock.now() }).run();
    expect((await call(t.app, 'DELETE', `${P}/cards/${empty.id}`, { cookie: admin.cookie })).status).toBe(204);
    expect(t.db.select().from(statements).all()).toEqual([]);

    const used = addCard(t);
    addTransaction(t, used.id, { deletedAt: t.clock.now() });
    // A deleted transaction isn't counted, but it still blocks deleting, so Delete isn't offered.
    expect((await json<Card[]>(await call(t.app, 'GET', `${P}/cards`, { cookie: admin.cookie }))).find((c) => c.id === used.id)).toMatchObject({
      transactionCount: 0, deletable: false, deleteBlocker: 'transactions',
    });
    expect(await json(await call(t.app, 'DELETE', `${P}/cards/${used.id}`, { cookie: admin.cookie }), 409)).toEqual({
      error: { code: 'conflict', message: SPEND_MESSAGES.cardHasTransactions },
    });

    const ruled = addCard(t);
    const made = await json<{ rule: { id: number } }>(await call(t.app, 'POST', `${P}/rules`, { cookie: admin.cookie, body: { ...rule, cardId: ruled.id, setCategoryId: categoryId(t, 'Dining') } }), 201);
    // A rule that names it blocks the delete too, and the card says so (review C-M2).
    const listed = async () => (await json<Card[]>(await call(t.app, 'GET', `${P}/cards`, { cookie: admin.cookie }))).find((c) => c.id === ruled.id);
    expect(await listed()).toMatchObject({ deletable: false, deleteBlocker: 'rules' });
    expect(await json(await call(t.app, 'DELETE', `${P}/cards/${ruled.id}`, { cookie: admin.cookie }), 409)).toEqual({
      error: { code: 'conflict', message: SPEND_MESSAGES.cardInRules },
    });
    await call(t.app, 'DELETE', `${P}/rules/${made.rule.id}`, { cookie: admin.cookie });
    expect(await listed()).toMatchObject({ deletable: true, deleteBlocker: null });
  });
});

describe('Spend settings: closing dates (spec §12.4)', () => {
  it('lists the dates that end a cycle with transactions, and the current one, newest first; inferred ones have no id', async () => {
    const { t, admin } = setup();
    const { id } = addCard(t, { usualClosingDay: 15 });
    addTransaction(t, id, { date: '2026-09-20' });
    const added = await json<CardStatements>(await call(t.app, 'POST', `${P}/cards/${id}/statements`, { cookie: admin.cookie, body: { closingDate: '2026-10-18' } }), 201);
    expect(added.mode).toBe('cycles');
    // Today is 2026-11-15 in the test app, so the current cycle ends today.
    expect(added.closings.map((c) => [c.date, c.source, c.id === null])).toEqual([
      ['2026-11-15', 'inferred', true],
      ['2026-10-18', 'manual', false],
    ]);
  });

  it('refuses the same date twice, and one more than two months ahead', async () => {
    const { t, admin } = setup();
    const { id } = addCard(t);
    await call(t.app, 'POST', `${P}/cards/${id}/statements`, { cookie: admin.cookie, body: { closingDate: '2026-10-18' } });
    expect(await json(await call(t.app, 'POST', `${P}/cards/${id}/statements`, { cookie: admin.cookie, body: { closingDate: '2026-10-18' } }), 409)).toEqual({
      error: { code: 'conflict', message: SPEND_MESSAGES.closingExists },
    });
    // Today is 2026-11-15 in the test app.
    expect((await call(t.app, 'POST', `${P}/cards/${id}/statements`, { cookie: admin.cookie, body: { closingDate: '2027-01-16' } })).status).toBe(201);
    expect(await json(await call(t.app, 'POST', `${P}/cards/${id}/statements`, { cookie: admin.cookie, body: { closingDate: '2027-01-17' } }), 400)).toEqual({
      error: { code: 'validation', message: SPEND_MESSAGES.closingTooLate },
    });
    expect((await call(t.app, 'POST', `${P}/cards/${id}/statements`, { cookie: admin.cookie, body: { closingDate: '2026-02-30' } })).status).toBe(400);
  });

  it('refuses a closing date before 2000, added or edited', async () => {
    const { t, admin } = setup();
    const { id } = addCard(t);
    expect(SPEND_MESSAGES.closingTooEarly).toBe('Pick a closing date in 2000 or later.');
    expect(await json(await call(t.app, 'POST', `${P}/cards/${id}/statements`, { cookie: admin.cookie, body: { closingDate: '1999-12-31' } }), 400)).toEqual({
      error: { code: 'validation', message: SPEND_MESSAGES.closingTooEarly },
    });
    const added = await json<CardStatements>(await call(t.app, 'POST', `${P}/cards/${id}/statements`, { cookie: admin.cookie, body: { closingDate: '2000-01-01' } }), 201);
    const stored = added.closings.find((c) => c.date === '2000-01-01')!;
    expect(await json(await call(t.app, 'PUT', `${P}/statements/${stored.id}`, { cookie: admin.cookie, body: { closingDate: '0001-01-01' } }), 400)).toEqual({
      error: { code: 'validation', message: SPEND_MESSAGES.closingTooEarly },
    });
  });

  it('turns an edited Plaid date into a manual one, deletes manual dates, and keeps Plaid ones', async () => {
    const { t, admin } = setup();
    const { id } = addCard(t);
    const now = t.clock.now();
    const plaid = t.db.insert(statements).values({ cardId: id, closingDate: '2026-10-14', source: 'plaid', createdAt: now, updatedAt: now }).returning().get();
    expect(await json(await call(t.app, 'DELETE', `${P}/statements/${plaid.id}`, { cookie: admin.cookie }), 409)).toEqual({
      error: { code: 'conflict', message: SPEND_MESSAGES.closingPlaid },
    });
    const edited = await json<CardStatements>(await call(t.app, 'PUT', `${P}/statements/${plaid.id}`, { cookie: admin.cookie, body: { closingDate: '2026-10-16' } }));
    expect(edited.closings.find((c) => c.id === plaid.id)).toEqual({ id: plaid.id, date: '2026-10-16', source: 'manual' });
    const deleted = await json<CardStatements>(await call(t.app, 'DELETE', `${P}/statements/${plaid.id}`, { cookie: admin.cookie }));
    expect(deleted.closings.some((c) => c.id === plaid.id)).toBe(false);
    expect((await call(t.app, 'DELETE', `${P}/statements/${plaid.id}`, { cookie: admin.cookie })).status).toBe(404);
  });

  it('says a card with no closing day and no dates groups by calendar month', async () => {
    const { t, admin } = setup();
    const { id } = addCard(t, { usualClosingDay: null });
    expect(await json<CardStatements>(await call(t.app, 'GET', `${P}/cards/${id}/statements`, { cookie: admin.cookie }))).toEqual({
      mode: 'calendar_month', closingDay: null, closings: [],
    });
  });
});

describe('Spend settings: categories (spec §12.5)', () => {
  async function list(t: TestApp, cookie: string) {
    return json<Category[]>(await call(t.app, 'GET', `${P}/categories`, { cookie }));
  }

  it('lists them in order, saying which are in use', async () => {
    const { t, member } = setup();
    const cats = await list(t, member.cookie);
    expect(cats).toHaveLength(16);
    expect(cats.find((c) => c.name === 'Subscriptions')).toEqual({ id: expect.any(Number), name: 'Subscriptions', kind: 'normal', archived: false, inUse: false });
    expect(cats.find((c) => c.name === 'Dining')?.inUse).toBe(true); // the Plaid mapping
    expect(cats.find((c) => c.name === 'Payments and transfers')).toMatchObject({ kind: 'excluded', inUse: true });
  });

  it('adds a category at the end, and refuses a name it already has in any case', async () => {
    const { t, admin } = setup();
    const pets = await json<Category>(await call(t.app, 'POST', `${P}/categories`, { cookie: admin.cookie, body: { name: ' Pets ' } }), 201);
    expect(pets).toMatchObject({ name: 'Pets', kind: 'normal', inUse: false });
    expect((await list(t, admin.cookie)).at(-1)?.name).toBe('Pets');
    expect(await json(await call(t.app, 'POST', `${P}/categories`, { cookie: admin.cookie, body: { name: 'dining' } }), 409)).toEqual({
      error: { code: 'conflict', message: SPEND_MESSAGES.categoryExists },
    });
    expect((await call(t.app, 'PUT', `${P}/categories/${pets.id}`, { cookie: admin.cookie, body: { name: 'GROCERIES' } })).status).toBe(409);
    expect((await json<Category>(await call(t.app, 'PUT', `${P}/categories/${pets.id}`, { cookie: admin.cookie, body: { name: 'Pet care' } }))).name).toBe('Pet care');
  });

  it("compares names ignoring case beyond ASCII too, which SQLite's lower() doesn't fold", async () => {
    const { t, admin } = setup();
    const food = await json<Category>(await call(t.app, 'POST', `${P}/categories`, { cookie: admin.cookie, body: { name: 'Épicerie' } }), 201);
    expect(await json(await call(t.app, 'POST', `${P}/categories`, { cookie: admin.cookie, body: { name: 'épicerie' } }), 409)).toEqual({
      error: { code: 'conflict', message: SPEND_MESSAGES.categoryExists },
    });
    const other = await json<Category>(await call(t.app, 'POST', `${P}/categories`, { cookie: admin.cookie, body: { name: 'Ørsted' } }), 201);
    expect((await call(t.app, 'PUT', `${P}/categories/${other.id}`, { cookie: admin.cookie, body: { name: 'éPICERIE' } })).status).toBe(409);
    // A category's own name in another case is fine.
    expect((await json<Category>(await call(t.app, 'PUT', `${P}/categories/${food.id}`, { cookie: admin.cookie, body: { name: 'ÉPICERIE' } }))).name).toBe('ÉPICERIE');
  });

  it('archives and unarchives a normal category, but not the special ones, which can still be renamed', async () => {
    const { t, admin } = setup();
    const dining = categoryId(t, 'Dining');
    expect((await json<Category>(await call(t.app, 'POST', `${P}/categories/${dining}/archive`, { cookie: admin.cookie }))).archived).toBe(true);
    expect((await json<Category>(await call(t.app, 'POST', `${P}/categories/${dining}/unarchive`, { cookie: admin.cookie }))).archived).toBe(false);
    for (const name of ['Payments and transfers', 'Uncategorized']) {
      const id = categoryId(t, name);
      expect(await json(await call(t.app, 'POST', `${P}/categories/${id}/archive`, { cookie: admin.cookie }), 409)).toEqual({
        error: { code: 'conflict', message: SPEND_MESSAGES.categorySpecial },
      });
      expect((await call(t.app, 'DELETE', `${P}/categories/${id}`, { cookie: admin.cookie })).status).toBe(409);
    }
    const renamed = await json<Category>(await call(t.app, 'PUT', `${P}/categories/${categoryId(t, 'Uncategorized')}`, { cookie: admin.cookie, body: { name: 'To sort' } }));
    expect(renamed).toMatchObject({ name: 'To sort', kind: 'uncategorized' });
  });

  it('moves a category up and down, and does nothing at either end', async () => {
    const { t, admin } = setup();
    const names = (cats: Category[]) => cats.map((c) => c.name).slice(0, 3);
    const groceries = categoryId(t, 'Groceries');
    expect(names(await json(await call(t.app, 'POST', `${P}/categories/${groceries}/move`, { cookie: admin.cookie, body: { direction: 'up' } })))).toEqual([
      'Groceries', 'Dining', 'Gas and auto',
    ]);
    expect(names(await json(await call(t.app, 'POST', `${P}/categories/${groceries}/move`, { cookie: admin.cookie, body: { direction: 'down' } })))).toEqual([
      'Dining', 'Groceries', 'Gas and auto',
    ]);
    const last = await json<Category[]>(await call(t.app, 'POST', `${P}/categories/${categoryId(t, 'Uncategorized')}/move`, { cookie: admin.cookie, body: { direction: 'down' } }));
    expect(last.at(-1)?.name).toBe('Uncategorized');
    expect((await call(t.app, 'POST', `${P}/categories/${groceries}/move`, { cookie: admin.cookie, body: { direction: 'sideways' } })).status).toBe(400);
  });

  it('deletes a category nothing uses, and refuses one a transaction, a rule, or the mapping uses', async () => {
    const { t, admin } = setup();
    const subs = categoryId(t, 'Subscriptions');
    const kids = categoryId(t, 'Kids'); // in the Plaid mapping
    addTransaction(t, addCard(t).id, { categoryId: subs, categorySource: 'manual' });
    for (const id of [subs, kids]) {
      expect(await json(await call(t.app, 'DELETE', `${P}/categories/${id}`, { cookie: admin.cookie }), 409)).toEqual({
        error: { code: 'conflict', message: SPEND_MESSAGES.categoryInUse },
      });
    }
    const pets = await json<Category>(await call(t.app, 'POST', `${P}/categories`, { cookie: admin.cookie, body: { name: 'Pets' } }), 201);
    await call(t.app, 'POST', `${P}/rules`, { cookie: admin.cookie, body: { ...rule, setCategoryId: pets.id } });
    expect((await call(t.app, 'DELETE', `${P}/categories/${pets.id}`, { cookie: admin.cookie })).status).toBe(409);
    t.db.delete(rules).where(eq(rules.setCategoryId, pets.id)).run();
    expect((await call(t.app, 'DELETE', `${P}/categories/${pets.id}`, { cookie: admin.cookie })).status).toBe(204);
    expect(t.db.select().from(categories).where(eq(categories.id, pets.id)).get()).toBeUndefined();
  });
});

describe('Spend settings: rules (spec §12.8)', () => {
  it('creates a rule at the end of the list, or first when asked', async () => {
    const { t, admin } = setup();
    const subs = categoryId(t, 'Subscriptions');
    const last = await json<RuleSaveResponse>(await call(t.app, 'POST', `${P}/rules`, { cookie: admin.cookie, body: { ...rule, setCategoryId: subs } }), 201);
    expect(last).toEqual({
      applied: null,
      rule: {
        id: last.rule.id, position: 2, matchText: 'netflix', matchType: 'contains', card: null, minCents: null, maxCents: null,
        setCategory: { id: subs, name: 'Subscriptions', kind: 'normal', archived: false }, setPerson: null, problems: [],
      },
    });
    const first = await json<RuleSaveResponse>(
      await call(t.app, 'POST', `${P}/rules`, { cookie: admin.cookie, body: { ...rule, matchText: 'hulu', setPerson: 'household', placeFirst: true } }),
      201,
    );
    expect(first.rule).toMatchObject({ position: 0, setPerson: { kind: 'household' }, setCategory: null });
    const list = await json<Rule[]>(await call(t.app, 'GET', `${P}/rules`, { cookie: admin.cookie }));
    expect(list.map((r) => r.matchText)).toEqual(['hulu', 'PAYMENT', 'netflix']);
  });

  it.each([
    [{ ...rule }, 'Pick a category, a person, or both'],
    [{ ...rule, setPerson: 'household', matchText: '  ' }, 'Enter the text to match'],
    [{ ...rule, setPerson: 'household', minCents: 500, maxCents: 100 }, "The smallest amount can't be more than the largest"],
    [{ ...rule, setPerson: 'household', matchType: 'regex' }, 'Pick contains or exact'],
    [{ ...rule, setPerson: 'someone' }, 'Pick a person from the list'],
  ])('refuses %j', async (body, message) => {
    const { t, admin } = setup();
    expect(await json(await call(t.app, 'POST', `${P}/rules`, { cookie: admin.cookie, body }), 400)).toEqual({ error: { code: 'validation', message } });
  });

  it('refuses an archived category, a deactivated person, or an archived card for a new rule', async () => {
    const { t, admin, member } = setup();
    const dining = categoryId(t, 'Dining');
    await call(t.app, 'POST', `${P}/categories/${dining}/archive`, { cookie: admin.cookie });
    expect(await json(await call(t.app, 'POST', `${P}/rules`, { cookie: admin.cookie, body: { ...rule, setCategoryId: dining } }), 400)).toEqual({
      error: { code: 'validation', message: SPEND_MESSAGES.categoryArchived },
    });
    updateUser(t.db, member.id, { active: false });
    expect(await json(await call(t.app, 'POST', `${P}/rules`, { cookie: admin.cookie, body: { ...rule, setPerson: member.id } }), 400)).toEqual({
      error: { code: 'validation', message: SPEND_MESSAGES.personInactive },
    });
    const archived = addCard(t, { archivedAt: t.clock.now() });
    expect(await json(await call(t.app, 'POST', `${P}/rules`, { cookie: admin.cookie, body: { ...rule, setPerson: 'household', cardId: archived.id } }), 400)).toEqual({
      error: { code: 'validation', message: SPEND_MESSAGES.cardArchived },
    });
  });

  it('flags a rule whose category was archived or whose person was deactivated, and lets it be saved unchanged', async () => {
    const { t, admin, member } = setup();
    const dining = categoryId(t, 'Dining');
    const body = { ...rule, setCategoryId: dining, setPerson: member.id };
    const { rule: saved } = await json<RuleSaveResponse>(await call(t.app, 'POST', `${P}/rules`, { cookie: admin.cookie, body }), 201);
    await call(t.app, 'POST', `${P}/categories/${dining}/archive`, { cookie: admin.cookie });
    updateUser(t.db, member.id, { active: false });
    const flagged = (await json<Rule[]>(await call(t.app, 'GET', `${P}/rules`, { cookie: admin.cookie }))).find((r) => r.id === saved.id)!;
    expect(flagged.problems).toEqual([RULE_PROBLEMS.archivedCategory, RULE_PROBLEMS.inactivePerson]);
    expect(flagged.setPerson).toEqual({ kind: 'user', person: { id: member.id, displayName: 'Kid', color: '#378ADD', active: false } });
    const resaved = await json<RuleSaveResponse>(await call(t.app, 'PUT', `${P}/rules/${saved.id}`, { cookie: admin.cookie, body: { ...body, matchText: 'netflix.com' } }));
    expect(resaved.rule).toMatchObject({ matchText: 'netflix.com', problems: [RULE_PROBLEMS.archivedCategory, RULE_PROBLEMS.inactivePerson] });
  });

  it('moves a rule up and down, and deletes it', async () => {
    const { t, admin } = setup();
    const { rule: r } = await json<RuleSaveResponse>(await call(t.app, 'POST', `${P}/rules`, { cookie: admin.cookie, body: { ...rule, setPerson: 'household' } }), 201);
    const order = (list: Rule[]) => list.map((x) => x.matchText);
    expect(order(await json(await call(t.app, 'POST', `${P}/rules/${r.id}/move`, { cookie: admin.cookie, body: { direction: 'up' } })))).toEqual(['netflix', 'PAYMENT']);
    expect(order(await json(await call(t.app, 'POST', `${P}/rules/${r.id}/move`, { cookie: admin.cookie, body: { direction: 'up' } })))).toEqual(['netflix', 'PAYMENT']);
    expect(order(await json(await call(t.app, 'POST', `${P}/rules/${r.id}/move`, { cookie: admin.cookie, body: { direction: 'down' } })))).toEqual(['PAYMENT', 'netflix']);
    expect((await call(t.app, 'DELETE', `${P}/rules/${r.id}`, { cookie: admin.cookie })).status).toBe(204);
    expect((await call(t.app, 'DELETE', `${P}/rules/${r.id}`, { cookie: admin.cookie })).status).toBe(404);
  });

  it("never erases history: a person a rule set who is then deactivated, and a category a rule or the mapping set that's then archived, survive applying rules", async () => {
    const { t, admin, member } = setup();
    const { id: cardId } = addCard(t);
    const subs = categoryId(t, 'Subscriptions');
    const dining = categoryId(t, 'Dining');
    const netflix = addTransaction(t, cardId, { rawName: 'NETFLIX.COM' });
    const mapped = addTransaction(t, cardId, { rawName: 'CAFE', categoryId: dining, categorySource: 'mapping', plaidPfcPrimary: 'FOOD_AND_DRINK' });
    const { rule: r } = await json<RuleSaveResponse>(
      await call(t.app, 'POST', `${P}/rules`, { cookie: admin.cookie, body: { ...rule, setCategoryId: subs, setPerson: member.id, applyToPast: true } }),
      201,
    );
    expect(transaction(t, netflix.id)).toMatchObject({ categoryId: subs, categorySource: 'rule', personUserId: member.id, personSource: 'rule' });

    updateUser(t.db, member.id, { active: false });
    await call(t.app, 'POST', `${P}/categories/${subs}/archive`, { cookie: admin.cookie });
    await call(t.app, 'POST', `${P}/categories/${dining}/archive`, { cookie: admin.cookie });
    // And the rule that set them goes, which would otherwise leave nothing to decide them.
    await call(t.app, 'DELETE', `${P}/rules/${r.id}`, { cookie: admin.cookie });
    expect(await json(await call(t.app, 'POST', `${P}/rules/apply`, { cookie: admin.cookie }))).toEqual({ applied: 0 });
    expect(transaction(t, netflix.id)).toMatchObject({ categoryId: subs, categorySource: 'rule', personUserId: member.id, personSource: 'rule' });
    expect(transaction(t, mapped.id)).toMatchObject({ categoryId: dining, categorySource: 'mapping' });
  });

  it('applies rules to past transactions when asked, leaving fields set by hand alone', async () => {
    const { t, admin, member } = setup();
    const { id: cardId } = addCard(t);
    const subs = categoryId(t, 'Subscriptions');
    const plain = addTransaction(t, cardId, { rawName: 'NETFLIX.COM' });
    const manualCategory = addTransaction(t, cardId, { rawName: 'NETFLIX.COM', categoryId: categoryId(t, 'Kids'), categorySource: 'manual' });
    const manualPerson = addTransaction(t, cardId, { rawName: 'NETFLIX.COM', personSource: 'manual' });
    const other = addTransaction(t, cardId, { rawName: 'SAFEWAY' });
    const body = { ...rule, setCategoryId: subs, setPerson: member.id };

    const notApplied = await json<RuleSaveResponse>(await call(t.app, 'POST', `${P}/rules`, { cookie: admin.cookie, body }), 201);
    expect(notApplied.applied).toBeNull();
    expect(transaction(t, plain.id).categorySource).toBe('default');

    const applied = await json<RuleSaveResponse>(await call(t.app, 'PUT', `${P}/rules/${notApplied.rule.id}`, { cookie: admin.cookie, body: { ...body, applyToPast: true } }));
    expect(applied.applied).toBe(3);
    expect(transaction(t, plain.id)).toMatchObject({ categoryId: subs, categorySource: 'rule', personUserId: member.id, personSource: 'rule' });
    expect(transaction(t, manualCategory.id)).toMatchObject({ categoryId: categoryId(t, 'Kids'), categorySource: 'manual', personUserId: member.id, personSource: 'rule' });
    expect(transaction(t, manualPerson.id)).toMatchObject({ categoryId: subs, categorySource: 'rule', personUserId: null, personSource: 'manual' });
    expect(transaction(t, other.id)).toMatchObject({ categorySource: 'default', personSource: 'default' });

    // Deleting the rule leaves its work until rules are applied again.
    await call(t.app, 'DELETE', `${P}/rules/${notApplied.rule.id}`, { cookie: admin.cookie });
    expect(transaction(t, plain.id).categorySource).toBe('rule');
    expect(await json(await call(t.app, 'POST', `${P}/rules/apply`, { cookie: admin.cookie }))).toEqual({ applied: 3 });
    expect(transaction(t, plain.id)).toMatchObject({ categorySource: 'default', personUserId: null, personSource: 'default' });
    expect(transaction(t, manualCategory.id)).toMatchObject({ categorySource: 'manual', personSource: 'default' });
  });
});
