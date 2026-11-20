import { eq } from 'drizzle-orm';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { PLAID_MESSAGES } from '../../../shared/plaid.js';
import { SAVINGS_MESSAGES, SavingsImportDraftSchema, SavingsOverviewSchema, SavingsSettingsViewSchema, SavingsSummarySchema } from '../../../shared/savings.js';
import { createApp } from '../../app.js';
import { plaidItems, savingsBalances, savingsImportProfiles } from '../../db/schema.js';
import { addUser, call, cookieFor, makeTestApp, TEST_BASE_URL, type TestApp } from '../../test/helpers.js';
import { BANK_FILE, BROKERAGE_FILE, bytes, CASH_FILE } from '../../test/importCsv.js';
import { addCsvImport, addSavingsAccount, addSavingsItem, linkSavingsForTest, savingsUser } from '../../test/savingsFixtures.js';

// Synthetic. The clock is 2026-11-15 12:00 UTC.
const P = '/api/panels/savings';

async function json<T>(res: Response, status = 200): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await res.json()) as T;
}

function setup(opts: { plaid?: boolean; logger?: pino.Logger } = {}) {
  const t = makeTestApp({ plaid: opts.plaid ?? true, logger: opts.logger });
  const admin = savingsUser(t, { role: 'admin', email: 'alex@example.com' });
  const member = savingsUser(t, { role: 'member', email: 'kid@example.com' });
  const noGrant = cookieFor(t.db, t.clock, addUser(t.db, t.clock, { email: 'other@example.com', role: 'admin', panels: ['spend'] }));
  return { t, admin, member, noGrant };
}

/** POSTs a multipart upload like the browser does. */
function upload(t: TestApp, cookie: string | undefined, accountId: number | string, text: string | null, opts: { name?: string; csrf?: boolean } = {}) {
  const form = new FormData();
  if (text !== null) form.set('file', new File([bytes(text)], opts.name ?? 'History_for_Account_X00000001.csv', { type: 'text/csv' }));
  const headers: Record<string, string> = cookie ? { cookie } : {};
  if (opts.csrf !== false) Object.assign(headers, { 'x-requested-with': 'dashboard', origin: TEST_BASE_URL });
  return Promise.resolve(t.app.request(`${P}/accounts/${accountId}/imports`, { method: 'POST', headers, body: form }));
}
const addHand = async (s: ReturnType<typeof setup>, kind: 'cash' | 'investment') =>
  (await json<{ handAccounts: { id: number }[] }>(await call(s.t.app, 'POST', `${P}/accounts`, { cookie: s.admin.cookie, body: { nickname: `Hand ${kind}`, kind } }))).handAccounts.at(-1)!.id;

describe('/api/panels/savings', () => {
  it('needs a session and the Savings grant, admins included', async () => {
    const s = setup();
    for (const path of ['/summary', '/overview']) {
      expect((await call(s.t.app, 'GET', `${P}${path}`)).status).toBe(401);
      expect(await json(await call(s.t.app, 'GET', `${P}${path}`, { cookie: s.noGrant }), 403)).toEqual({ error: { code: 'forbidden', message: "You don't have access to this panel." } });
    }
    SavingsSummarySchema.parse(await json(await call(s.t.app, 'GET', `${P}/summary`, { cookie: s.member.cookie })));
    SavingsOverviewSchema.parse(await json(await call(s.t.app, 'GET', `${P}/overview?month=2026-11`, { cookie: s.member.cookie })));
  });

  it('keeps settings and every change to admins with the grant, behind the CSRF check', async () => {
    const s = setup();
    const linked = linkSavingsForTest(s.t, s.admin.id);
    const id = linked.item.id;
    const accountId = linked.accounts[0]!.id;
    const routes = [
      ['GET', '/settings', undefined], ['POST', `/connections/${id}/accounts`, { accounts: [] }], ['POST', `/connections/${id}/refresh`, {}],
      ['POST', `/connections/${id}/load-accounts`, {}], ['POST', `/connections/${id}/remove`, { deleteData: false }], ['PATCH', `/accounts/${accountId}`, { hidden: true }],
    ] as const;
    for (const [method, path, body] of routes) {
      expect((await call(s.t.app, method, `${P}${path}`, { cookie: s.member.cookie, body })).status, path).toBe(403);
      expect((await call(s.t.app, method, `${P}${path}`, { cookie: s.noGrant, body })).status, path).toBe(403);
    }
    expect((await call(s.t.app, 'PATCH', `${P}/accounts/${accountId}`, { cookie: s.admin.cookie, body: { hidden: true }, csrf: false })).status).toBe(403);
    SavingsSettingsViewSchema.parse(await json(await call(s.t.app, 'GET', `${P}/settings`, { cookie: s.admin.cookie })));
    const hidden = await json<{ connections: { accounts: { state: string }[] }[] }>(await call(s.t.app, 'PATCH', `${P}/accounts/${accountId}`, { cookie: s.admin.cookie, body: { hidden: true } }));
    expect(hidden.connections[0]!.accounts[0]!.state).toBe('hidden');
  });

  it('has Savings settings without Plaid for hand-added accounts; the connection routes need Plaid', async () => {
    const s = setup({ plaid: false });
    expect(SavingsSettingsViewSchema.parse(await json(await call(s.t.app, 'GET', `${P}/settings`, { cookie: s.admin.cookie })))).toMatchObject({ plaidConfigured: false, trial: null, connections: [] });
    const id = await addHand(s, 'cash');
    expect((await json<{ handAccounts: { latest: unknown }[] }>(await call(s.t.app, 'POST', `${P}/accounts/${id}/balance`, { cookie: s.admin.cookie, body: { amount: '100.00' } }))).handAccounts[0]!.latest)
      .toEqual({ date: '2026-11-15', cents: 100_00, source: 'manual' });
    expect((await call(s.t.app, 'PATCH', `${P}/accounts/${id}`, { cookie: s.admin.cookie, body: { nickname: 'Rainy day' } })).status).toBe(200);
    expect((await call(s.t.app, 'POST', `${P}/connections/1/refresh`, { cookie: s.admin.cookie, body: {} })).status).toBe(404);
    expect((await call(s.t.app, 'GET', `${P}/summary`, { cookie: s.admin.cookie })).status).toBe(200);
  });

  it('keeps hand-added accounts, Set balance, imports, and saved settings to signed-in admins with the grant, behind the CSRF check', async () => {
    const s = setup({ plaid: false });
    const id = await addHand(s, 'cash');
    const draft = 'a'.repeat(22);
    const routes = [
      ['GET', '/settings', undefined],
      ['POST', '/accounts', { nickname: 'X', kind: 'cash' }], ['PATCH', `/accounts/${id}`, { hidden: true }], ['POST', `/accounts/${id}/balance`, { amount: '1' }],
      ['POST', `/accounts/${id}/remove`, { deleteData: false }],
      ['PUT', `/imports/${draft}`, { mapping: {} }], ['POST', `/imports/${draft}/commit`, {}], ['DELETE', `/imports/${draft}`, undefined],
      ['DELETE', `/accounts/${id}/imports/1`, undefined], ['PATCH', `/accounts/${id}/import-profile`, { choices: {} }], ['DELETE', `/accounts/${id}/import-profile`, undefined],
    ] as const;
    for (const [method, path, body] of routes) {
      expect((await call(s.t.app, method, `${P}${path}`, { body })).status, path).toBe(401);
      expect((await call(s.t.app, method, `${P}${path}`, { cookie: s.member.cookie, body })).status, path).toBe(403);
      expect((await call(s.t.app, method, `${P}${path}`, { cookie: s.noGrant, body })).status, path).toBe(403);
      if (method !== 'GET') expect((await call(s.t.app, method, `${P}${path}`, { cookie: s.admin.cookie, body, csrf: false })).status, path).toBe(403);
    }
    expect((await upload(s.t, undefined, id, CASH_FILE)).status).toBe(401);
    expect((await upload(s.t, s.member.cookie, id, CASH_FILE)).status).toBe(403);
    expect((await upload(s.t, s.noGrant, id, CASH_FILE)).status).toBe(403);
    expect((await upload(s.t, s.admin.cookie, id, CASH_FILE, { csrf: false })).status).toBe(403);
    // Nothing changed: the account is as added, with no balance and no draft.
    expect((await json<{ handAccounts: unknown[] }>(await call(s.t.app, 'GET', `${P}/settings`, { cookie: s.admin.cookie }))).handAccounts)
      .toEqual([expect.objectContaining({ id, nickname: 'Hand cash', hidden: false, removed: false, latest: null })]);
  });

  it('takes plain digits for account and import ids, a 22-character draft id, and plain messages for bad bodies', async () => {
    const s = setup({ plaid: false });
    const id = await addHand(s, 'cash');
    for (const [method, path, body] of [
      ['POST', '/accounts/1e1/balance', { amount: '1' }], ['POST', '/accounts/-1/remove', { deleteData: false }], ['POST', '/accounts/0x1/balance', { amount: '1' }],
      ['DELETE', `/accounts/${id}/imports/1.0`, undefined], ['PATCH', '/accounts/%201/import-profile', { choices: {} }],
      ['PUT', '/imports/short', { mapping: {} }], ['POST', `/imports/${'a'.repeat(21)}!/commit`, {}],
    ] as const) {
      expect((await call(s.t.app, method, `${P}${path}`, { cookie: s.admin.cookie, body })).status, path).toBe(404);
    }
    expect((await upload(s.t, s.admin.cookie, 'abc', CASH_FILE)).status).toBe(404);
    expect(await json(await call(s.t.app, 'POST', `${P}/accounts`, { cookie: s.admin.cookie, body: { nickname: ' ', kind: 'cash' } }), 400))
      .toEqual({ error: { code: 'validation', message: 'Give each account you show a nickname.' } });
    expect((await call(s.t.app, 'POST', `${P}/accounts`, { cookie: s.admin.cookie, body: { nickname: 'X', kind: 'savings' } })).status).toBe(400);
    expect(await json(await call(s.t.app, 'POST', `${P}/accounts/${id}/balance`, { cookie: s.admin.cookie, body: { amount: 'lots' } }), 400))
      .toEqual({ error: { code: 'validation', message: SAVINGS_MESSAGES.balanceAmount } });
    expect(await json(await call(s.t.app, 'POST', `${P}/accounts/${id}/balance`, { cookie: s.admin.cookie, body: { amount: '1', date: '2026-11-16' } }), 400))
      .toEqual({ error: { code: 'validation', message: SAVINGS_MESSAGES.balanceFuture } });
  });

  it('refuses Set balance on a day Plaid has, and removing a linked account, with the messages the web shows', async () => {
    const s = setup();
    const linked = linkSavingsForTest(s.t, s.admin.id);
    const accountId = linked.accounts[0]!.id;
    s.t.db.insert(savingsBalances).values({ accountId, date: '2026-11-14', currentCents: 5_00, availableCents: null, fetchedAt: s.t.clock.now(), source: 'plaid', importId: null }).run();
    expect(await json(await call(s.t.app, 'POST', `${P}/accounts/${accountId}/balance`, { cookie: s.admin.cookie, body: { amount: '1', date: '2026-11-14' } }), 409))
      .toEqual({ error: { code: 'conflict', message: SAVINGS_MESSAGES.balanceFromPlaid } });
    expect(await json(await call(s.t.app, 'POST', `${P}/accounts/${accountId}/remove`, { cookie: s.admin.cookie, body: { deleteData: true } }), 400))
      .toEqual({ error: { code: 'validation', message: SAVINGS_MESSAGES.linkedRemove } });
    // A hand-added account, kept or with its data.
    const kept = await addHand(s, 'cash');
    const view = SavingsSettingsViewSchema.parse(await json(await call(s.t.app, 'POST', `${P}/accounts/${kept}/remove`, { cookie: s.admin.cookie, body: { deleteData: false } })));
    expect(view.handAccounts).toEqual([expect.objectContaining({ id: kept, removed: true })]);
    expect((await call(s.t.app, 'POST', `${P}/accounts/${kept}/balance`, { cookie: s.admin.cookie, body: { amount: '1' } })).status).toBe(404);
    const gone = await addHand(s, 'investment');
    const after = SavingsSettingsViewSchema.parse(await json(await call(s.t.app, 'POST', `${P}/accounts/${gone}/remove`, { cookie: s.admin.cookie, body: { deleteData: true } })));
    expect(after.handAccounts.map((a) => a.id)).toEqual([kept]);
  });

  it('imports a bank\'s CSV through the steps: upload, columns, groups, Import, Undo, saved settings', async () => {
    const s = setup({ plaid: false });
    const id = await addHand(s, 'cash');
    expect(await json(await upload(s.t, s.admin.cookie, id, null), 400)).toEqual({ error: { code: 'validation', message: SAVINGS_MESSAGES.importNoFile } });
    expect((await json<{ error: { message: string } }>(await upload(s.t, s.admin.cookie, id, 'nothing here\n'), 400)).error.message).toMatch(/couldn't find a table/);
    expect((await upload(s.t, s.admin.cookie, 9999, BANK_FILE)).status).toBe(404);
    const d = SavingsImportDraftSchema.parse(await json(await upload(s.t, s.admin.cookie, id, BANK_FILE, { name: 'statement.csv' }), 201));
    expect(d).toMatchObject({ prefilled: 'guess', mapping: null, fileName: 'statement.csv' });
    const put = (body: unknown) => call(s.t.app, 'PUT', `${P}/imports/${d.id}`, { cookie: s.admin.cookie, body });
    expect((await json<{ error: { message: string } }>(await put({ mapping: { ...d.suggested!, date: { column: 0, format: 'mdy' } } }), 400)).error.message).toBe(SAVINGS_MESSAGES.mapBadDate(5, 'M/D/YYYY'));
    expect((await put({ mapping: { date: { column: 'x' } } })).status).toBe(400);
    expect((await put({ mapping: d.suggested, choices: { x: 'maybe' } })).status).toBe(400);
    expect((await put({ mapping: d.suggested, pad: 'x'.repeat(513 * 1024) })).status).toBe(413);
    // Another admin can't use this admin's draft.
    const other = savingsUser(s.t, { role: 'admin', email: 'other-admin@example.com' });
    expect((await call(s.t.app, 'PUT', `${P}/imports/${d.id}`, { cookie: other.cookie, body: { mapping: d.suggested } })).status).toBe(404);
    expect((await call(s.t.app, 'POST', `${P}/imports/${d.id}/commit`, { cookie: other.cookie, body: {} })).status).toBe(404);
    const mapped = SavingsImportDraftSchema.parse(await json(await put({ mapping: d.suggested })));
    expect(mapped.results).toBeNull();
    // Not before the groups step.
    expect(await json(await call(s.t.app, 'POST', `${P}/imports/${d.id}/commit`, { cookie: s.admin.cookie, body: {} }), 400))
      .toEqual({ error: { code: 'validation', message: SAVINGS_MESSAGES.importNotReady } });
    const ready = SavingsImportDraftSchema.parse(await json(await put({ mapping: d.suggested, choices: Object.fromEntries(mapped.groups!.map((g) => [g.label, g.suggested])) })));
    expect(ready.results).toMatchObject({ deposits: { add: 2 }, withdrawals: { add: 3 }, balances: { add: 5 } });
    const done = SavingsSettingsViewSchema.parse(await json(await call(s.t.app, 'POST', `${P}/imports/${d.id}/commit`, { cookie: s.admin.cookie, body: {} })));
    expect(done.message).toBe('Imported statement.csv: 2 deposits, 3 withdrawals, and 5 daily balances added.');
    expect(done.profiles).toEqual([expect.objectContaining({ accountId: id, format: 'custom' })]);
    const edited = SavingsSettingsViewSchema.parse(await json(await call(s.t.app, 'PATCH', `${P}/accounts/${id}/import-profile`, { cookie: s.admin.cookie, body: { choices: { 'CARD PURCHASE': 'not_counted' } } })));
    expect(edited.profiles[0]!.groups).toContainEqual({ label: 'CARD PURCHASE', choice: 'not_counted' });
    expect(await json(await call(s.t.app, 'PATCH', `${P}/accounts/${id}/import-profile`, { cookie: s.admin.cookie, body: { choices: { 'NEVER SEEN': 'deposit' } } }), 400))
      .toEqual({ error: { code: 'validation', message: SAVINGS_MESSAGES.profileUnknownGroup } });
    expect((await call(s.t.app, 'DELETE', `${P}/accounts/${id}/imports/9999`, { cookie: s.admin.cookie })).status).toBe(404);
    const undone = SavingsSettingsViewSchema.parse(await json(await call(s.t.app, 'DELETE', `${P}/accounts/${id}/imports/${done.imports[0]!.id}`, { cookie: s.admin.cookie })));
    expect(undone).toMatchObject({ imports: [], message: 'Undid the import of statement.csv: removed 5 deposits and withdrawals and 5 daily balances.' });
    expect(SavingsSettingsViewSchema.parse(await json(await call(s.t.app, 'DELETE', `${P}/accounts/${id}/import-profile`, { cookie: s.admin.cookie }))).profiles).toEqual([]);
    expect(await json(await call(s.t.app, 'DELETE', `${P}/accounts/${id}/import-profile`, { cookie: s.admin.cookie }), 404))
      .toEqual({ error: { code: 'not_found', message: SAVINGS_MESSAGES.profileNotFound } });
  });

  it('goes straight to the results for a Fidelity file; Cancel forgets the draft; a bad id is a 404', async () => {
    const s = setup({ plaid: false });
    const id = await addHand(s, 'investment');
    const d = SavingsImportDraftSchema.parse(await json(await upload(s.t, s.admin.cookie, id, BROKERAGE_FILE), 201));
    expect(d).toMatchObject({ format: 'fidelity_brokerage', prefilled: 'builtin', results: { deposits: { add: 1 }, withdrawals: { add: 1 } } });
    expect((await call(s.t.app, 'POST', `${P}/imports/not-an-id/commit`, { cookie: s.admin.cookie, body: {} })).status).toBe(404);
    expect((await call(s.t.app, 'DELETE', `${P}/imports/${d.id}`, { cookie: s.admin.cookie })).status).toBe(204);
    expect((await call(s.t.app, 'POST', `${P}/imports/${d.id}/commit`, { cookie: s.admin.cookie, body: {} })).status).toBe(404);
    // Cancel answers the same whether or not there was a draft.
    expect((await call(s.t.app, 'DELETE', `${P}/imports/${d.id}`, { cookie: s.admin.cookie })).status).toBe(204);
  });

  it('refuses a file over 5 MB', async () => {
    const s = setup({ plaid: false });
    const id = await addHand(s, 'cash');
    expect(await json(await upload(s.t, s.admin.cookie, id, `${CASH_FILE}${' '.repeat(5 * 1024 * 1024)}`), 413)).toEqual({ error: { code: 'validation', message: SAVINGS_MESSAGES.importTooBig } });
  });

  it('refuses a request body over 5 MB and the form\'s allowance with the same message, before reading it', async () => {
    const s = setup({ plaid: false });
    const id = await addHand(s, 'cash');
    const form = new FormData();
    form.set('file', new File([bytes('x'.repeat(5 * 1024 * 1024))], 'a.csv', { type: 'text/csv' }));
    form.set('pad', 'y'.repeat(128 * 1024));
    const res = await s.t.app.request(`${P}/accounts/${id}/imports`, { method: 'POST', headers: { cookie: s.admin.cookie, 'x-requested-with': 'dashboard', origin: TEST_BASE_URL }, body: form });
    expect(await json(res, 413)).toEqual({ error: { code: 'validation', message: SAVINGS_MESSAGES.importTooBig } });
  });

  it('without Plaid, refuses imports and saved settings for linked accounts, which the view leaves out', async () => {
    const s = setup({ plaid: false });
    const item = addSavingsItem(s.t);
    const linked = addSavingsAccount(s.t, item.id, { plaidAccountId: 'acc-cash', kind: 'cash' });
    const record = addCsvImport(s.t, linked.id, s.admin.id, { balances: [{ date: '2026-10-31', cents: 1_00 }] });
    const now = s.t.clock.now();
    s.t.db.insert(savingsImportProfiles).values({
      accountId: linked.id, header: ['Date', 'Amount'], format: 'custom', mapping: { date: { column: 0, format: 'ymd' }, amount: { kind: 'signed', column: 1, inIsNegative: false }, balance: null, description: null },
      choices: { '': 'by_sign' }, updatedByUserId: s.admin.id, createdAt: now, updatedAt: now,
    }).run();
    const refused = { error: { code: 'not_found', message: SAVINGS_MESSAGES.linkedNeedsPlaid } };
    expect(await json(await upload(s.t, s.admin.cookie, linked.id, CASH_FILE), 404)).toEqual(refused);
    expect(await json(await call(s.t.app, 'DELETE', `${P}/accounts/${linked.id}/imports/${record.id}`, { cookie: s.admin.cookie }), 404)).toEqual(refused);
    expect(await json(await call(s.t.app, 'PATCH', `${P}/accounts/${linked.id}/import-profile`, { cookie: s.admin.cookie, body: { choices: { '': 'deposit' } } }), 404)).toEqual(refused);
    expect(await json(await call(s.t.app, 'DELETE', `${P}/accounts/${linked.id}/import-profile`, { cookie: s.admin.cookie }), 404)).toEqual(refused);
    // Nothing changed: the import and the settings are still there for when Plaid is back.
    expect(s.t.db.select().from(savingsImportProfiles).all()).toHaveLength(1);
    expect(s.t.db.select().from(savingsBalances).all()).toHaveLength(1);
    const view = SavingsSettingsViewSchema.parse(await json(await call(s.t.app, 'GET', `${P}/settings`, { cookie: s.admin.cookie })));
    expect([view.imports, view.profiles]).toEqual([[], []]);
  });

  it('without Plaid, refuses to go on with or Import a draft for a linked account', async () => {
    // A draft made while Plaid was configured, then the server restarted without it: the same database, a new app.
    const withPlaid = setup();
    const linked = linkSavingsForTest(withPlaid.t, withPlaid.admin.id);
    const d = SavingsImportDraftSchema.parse(await json(await upload(withPlaid.t, withPlaid.admin.cookie, linked.accounts[0]!.id, CASH_FILE), 201));
    const app = createApp({ ...withPlaid.t, plaid: null, bank: null, savings: null });
    const refused = { error: { code: 'not_found', message: SAVINGS_MESSAGES.linkedNeedsPlaid } };
    expect(await json(await call(app, 'PUT', `${P}/imports/${d.id}`, { cookie: withPlaid.admin.cookie, body: { mapping: d.mapping } }), 404)).toEqual(refused);
    expect(await json(await call(app, 'POST', `${P}/imports/${d.id}/commit`, { cookie: withPlaid.admin.cookie, body: {} }), 404)).toEqual(refused);
    // With Plaid it still imports.
    expect((await call(withPlaid.t.app, 'POST', `${P}/imports/${d.id}/commit`, { cookie: withPlaid.admin.cookie, body: {} })).status).toBe(200);
  });

  it('takes a 124-character description\'s group, and the choices for 1,000 long groups, through the steps', async () => {
    const s = setup({ plaid: false });
    const id = await addHand(s, 'cash');
    const long = `${'A'.repeat(60)} ${'B'.repeat(63)}`;
    const file = ['Date,Description,Amount', `2026-10-05,${long} TAIL,100.00`, '2026-10-06,PAY IN,5.00'].join('\n');
    const d = SavingsImportDraftSchema.parse(await json(await upload(s.t, s.admin.cookie, id, file, { name: 'long.csv' }), 201));
    const mapping = { date: { column: 0, format: 'ymd' }, amount: { kind: 'signed', column: 2, inIsNegative: false }, balance: null, description: 1 };
    const put = (body: unknown) => call(s.t.app, 'PUT', `${P}/imports/${d.id}`, { cookie: s.admin.cookie, body });
    const mapped = SavingsImportDraftSchema.parse(await json(await put({ mapping })));
    expect(mapped.groups!.map((g) => g.label.length).sort()).toEqual([100, 6]);
    // Every group's choice, padded out to the schema's 1,000 groups of 100 characters: well over 64 KB, still accepted.
    const choices: Record<string, string> = Object.fromEntries(mapped.groups!.map((g) => [g.label, g.suggested]));
    for (let i = 0; Object.keys(choices).length < 1000; i++) choices[`${'X'.repeat(94)}${String(i).padStart(6, '0')}`] = 'not_counted';
    expect(JSON.stringify({ mapping, choices }).length).toBeGreaterThan(64 * 1024);
    const ready = SavingsImportDraftSchema.parse(await json(await put({ mapping, choices })));
    expect(ready.results).toMatchObject({ deposits: { add: 2 } });
    expect((await call(s.t.app, 'POST', `${P}/imports/${d.id}/commit`, { cookie: s.admin.cookie, body: {} })).status).toBe(200);
    // The saved settings' Edit takes the same size of body.
    const edit = Object.fromEntries(mapped.groups!.map((g) => [g.label, 'deposit']));
    expect((await call(s.t.app, 'PATCH', `${P}/accounts/${id}/import-profile`, { cookie: s.admin.cookie, body: { choices: edit, pad: 'p'.repeat(100 * 1024) } })).status).toBe(200);
    // Past the limit, a plain 413.
    expect(await json(await put({ mapping, pad: 'p'.repeat(512 * 1024) }), 413)).toEqual({ error: { code: 'validation', message: 'That request is too big.' } });
  });

  it('limits uploads to 20 a minute per admin', async () => {
    const s = setup({ plaid: false });
    const id = await addHand(s, 'cash');
    for (let i = 0; i < 20; i++) expect((await upload(s.t, s.admin.cookie, id, CASH_FILE)).status, `upload ${i}`).toBe(201);
    expect(await json(await upload(s.t, s.admin.cookie, id, CASH_FILE), 429))
      .toEqual({ error: { code: 'rate_limited', message: 'Too many attempts. Wait a minute and try again.' } });
    const other = savingsUser(s.t, { role: 'admin', email: 'other-admin@example.com' });
    expect((await upload(s.t, other.cookie, id, CASH_FILE)).status).toBe(201);
    s.t.clock.advance(61_000);
    expect((await upload(s.t, s.admin.cookie, id, CASH_FILE)).status).toBe(201);
  });

  it('never logs what the file says, or its name', async () => {
    const lines: string[] = [];
    const s = setup({ plaid: false, logger: pino({ level: 'debug' }, { write: (line: string) => { lines.push(line); } }) });
    const id = await addHand(s, 'cash');
    const d = SavingsImportDraftSchema.parse(await json(await upload(s.t, s.admin.cookie, id, BANK_FILE, { name: 'secret-name.csv' }), 201));
    await json(await upload(s.t, s.admin.cookie, id, 'nothing here\n', { name: 'secret-name.csv' }), 400);
    const put = (body: unknown) => call(s.t.app, 'PUT', `${P}/imports/${d.id}`, { cookie: s.admin.cookie, body });
    await json(await put({ mapping: { ...d.suggested!, date: { column: 0, format: 'mdy' } } }), 400);
    const mapped = SavingsImportDraftSchema.parse(await json(await put({ mapping: d.suggested })));
    await json(await put({ mapping: d.suggested, choices: Object.fromEntries(mapped.groups!.map((g) => [g.label, g.suggested])) }));
    const done = SavingsSettingsViewSchema.parse(await json(await call(s.t.app, 'POST', `${P}/imports/${d.id}/commit`, { cookie: s.admin.cookie, body: {} })));
    await json(await call(s.t.app, 'DELETE', `${P}/accounts/${id}/imports/${done.imports[0]!.id}`, { cookie: s.admin.cookie }));
    expect(lines.some((l) => l.includes('savings csv imported'))).toBe(true);
    const logged = lines.join('\n');
    for (const secret of ['secret-name', 'statement', 'CARD PURCHASE', 'SALARY', 'Example Bank', 'XXXX-0001', '45.10', '3,410.55', 'nothing here']) expect(logged).not.toContain(secret);
  });

  it('refuses a bad month, a bad id, and a bad body with plain messages', async () => {
    const s = setup();
    expect(await json(await call(s.t.app, 'GET', `${P}/overview?month=2026-13`, { cookie: s.member.cookie }), 400)).toEqual({ error: { code: 'validation', message: 'Pick a month.' } });
    expect(await json(await call(s.t.app, 'GET', `${P}/overview?month=2027-01`, { cookie: s.member.cookie }), 400)).toEqual({ error: { code: 'validation', message: "That month hasn't started yet." } });
    expect((await call(s.t.app, 'PATCH', `${P}/accounts/abc`, { cookie: s.admin.cookie, body: { hidden: true } })).status).toBe(404);
    expect(await json(await call(s.t.app, 'PATCH', `${P}/accounts/1`, { cookie: s.admin.cookie, body: {} }), 400)).toEqual({ error: { code: 'validation', message: 'There are no changes to save.' } });
  });

  it('links, picks, syncs, and shows on the home card, end to end through the routes', async () => {
    const s = setup();
    const start = await json<{ linkToken: string }>(await call(s.t.app, 'POST', '/connect/plaid/link-token', { cookie: s.admin.cookie, body: { purpose: 'savings' } }));
    const { publicToken, metadata } = s.t.fakePlaid.completeLink(start.linkToken, {
      institution: { institution_id: 'ins_fake_savings', name: 'Example Brokerage' },
      accounts: [{ name: 'Cash', mask: '1111', type: 'depository', subtype: 'cash management', current: 2500 }],
    });
    const { next } = await json<{ next: string }>(await call(s.t.app, 'POST', '/connect/plaid/exchange', { cookie: s.admin.cookie, body: { publicToken, metadata } }));
    const id = Number(new URL(next, 'http://x').searchParams.get('bank'));
    const accountId = s.t.plaid!.item(id)!.accounts![0]!.accountId;
    await json(await call(s.t.app, 'POST', `${P}/connections/${id}/accounts`, { cookie: s.admin.cookie, body: { accounts: [{ accountId, action: 'show', nickname: 'Rainy day' }] } }));
    const summary = await json<{ accounts: { account: { nickname: string }; balanceCents: number }[]; totalCents: number }>(await call(s.t.app, 'GET', `${P}/summary`, { cookie: s.member.cookie }));
    expect(summary.accounts.map((a) => [a.account.nickname, a.balanceCents])).toEqual([['Rainy day', 2500_00]]);
    expect(summary.totalCents).toBe(2500_00);
  });

  it('answers 404 for a Spend bank on every connection route, and never asks Plaid to remove it', async () => {
    const s = setup();
    const linked = linkSavingsForTest(s.t, s.admin.id);
    const id = linked.item.id;
    s.t.db.update(plaidItems).set({ purpose: 'spend' }).where(eq(plaidItems.id, id)).run();
    const notFound = { error: { code: 'not_found', message: PLAID_MESSAGES.notFound } };
    for (const [path, body] of [
      [`/connections/${id}/accounts`, { accounts: [] }], [`/connections/${id}/refresh`, {}], [`/connections/${id}/load-accounts`, {}],
      [`/connections/${id}/remove`, { deleteData: true }],
    ] as const) {
      expect(await json(await call(s.t.app, 'POST', `${P}${path}`, { cookie: s.admin.cookie, body }), 404), path).toEqual(notFound);
    }
    expect(s.t.fakePlaid.count('/item/remove')).toBe(0);
    expect(s.t.fakePlaid.count('/accounts/get')).toBe(0);
    expect(s.t.fakePlaid.count('/item/get')).toBe(0);
    expect(s.t.plaid!.item(id)!.removedAt).toBeNull();
  });

  it('answers 404 for renaming or hiding an account whose connection was removed', async () => {
    const s = setup();
    const linked = linkSavingsForTest(s.t, s.admin.id);
    await json(await call(s.t.app, 'POST', `${P}/connections/${linked.item.id}/remove`, { cookie: s.admin.cookie, body: { deleteData: false } }));
    for (const body of [{ hidden: true }, { nickname: 'Renamed' }]) {
      expect(await json(await call(s.t.app, 'PATCH', `${P}/accounts/${linked.accounts[0]!.id}`, { cookie: s.admin.cookie, body }), 404))
        .toEqual({ error: { code: 'not_found', message: SAVINGS_MESSAGES.accountNotFound } });
    }
  });

  it('limits Refresh and Load accounts to 10 a minute per admin, each on its own', async () => {
    const s = setup();
    const linked = linkSavingsForTest(s.t, s.admin.id);
    for (const action of ['refresh', 'load-accounts'] as const) {
      const path = `${P}/connections/${linked.item.id}/${action}`;
      for (let i = 0; i < 10; i++) expect((await call(s.t.app, 'POST', path, { cookie: s.admin.cookie, body: {} })).status, `${action} ${i}`).toBe(200);
      expect(await json(await call(s.t.app, 'POST', path, { cookie: s.admin.cookie, body: {} }), 429))
        .toEqual({ error: { code: 'rate_limited', message: 'Too many attempts. Wait a minute and try again.' } });
    }
    // Another admin has their own allowance, and a minute later it's back.
    const other = savingsUser(s.t, { role: 'admin', email: 'other-admin@example.com' });
    expect((await call(s.t.app, 'POST', `${P}/connections/${linked.item.id}/refresh`, { cookie: other.cookie, body: {} })).status).toBe(200);
    s.t.clock.advance(61_000);
    expect((await call(s.t.app, 'POST', `${P}/connections/${linked.item.id}/refresh`, { cookie: s.admin.cookie, body: {} })).status).toBe(200);
  });
});
