import { eq, sql } from 'drizzle-orm';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import {
  IMPORT_REPLACED_ROW, POSSIBLE_DUPLICATE, SPEND_MESSAGES, startsTicked, type Card, type CardMapping, type CsvImportRecord, type ImportPreview, type ImportResult, type SpendSummary,
} from '../../../shared/spend.js';
import { CSV_TABLE_MESSAGES } from '../../csv/table.js';
import { csvImportPreviews, csvImports, spendImportProfiles, transactions } from '../../db/schema.js';
import { bofaCsv, bytes, reference } from '../../test/bofaCsv.js';
import { DEBIT_CREDIT_SAMPLE, debitCreditCsv, signedCsv } from '../../test/cardCsv.js';
import { addUser, call, cookieFor, makeTestApp, TEST_BASE_URL, type TestApp } from '../../test/helpers.js';
import { addCard, addCsvImport, addTransaction, categoryId, spendUser } from '../../test/spendFixtures.js';
import { BOFA_FORMAT, BOFA_HEADER, BOFA_MESSAGES } from './bofa.js';
import { isRowKey, rowKey } from './cardCsv.js';
import { ALREADY_IMPORTED, clearImportProfile, commitImport, importProfileOf, listImports, PREVIEW_TTL_MS, previewImport, updateImport } from './imports.js';
import { spendPanel } from './index.js';

const P = '/api/panels/spend';

async function json<T>(res: Response, status = 200): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await res.json()) as T;
}

/** POSTs a multipart upload like the browser does. */
function upload(t: TestApp, cookie: string | undefined, cardId: number | string, file: string | Uint8Array<ArrayBuffer> | null, opts: { name?: string; csrf?: boolean } = {}) {
  const form = new FormData();
  form.set('cardId', String(cardId));
  if (file !== null) form.set('file', new File([typeof file === 'string' ? bytes(file) : file], opts.name ?? 'currentTransaction_1234.csv', { type: 'text/csv' }));
  const headers: Record<string, string> = cookie ? { cookie } : {};
  if (opts.csrf !== false) Object.assign(headers, { 'x-requested-with': 'dashboard', origin: TEST_BASE_URL });
  return Promise.resolve(t.app.request(`${P}/imports`, { method: 'POST', headers, body: form }));
}

// SYNTHETIC rows in the documented BofA shape (see src/server/test/bofaCsv.ts). The test clock is 2026-11-15.
const coffee = { date: '11/02/2026', reference: reference(7, 1), payee: 'BLUE BOTTLE COFFEE', address: 'OAKLAND CA', amount: '-12.74' };
const netflix = { date: '11/03/2026', reference: reference(7, 2), payee: 'NETFLIX.COM', address: 'LOS GATOS CA', amount: '-15.49' };
const payment = { date: '11/05/2026', reference: reference(7, 3), payee: 'PAYMENT - THANK YOU', address: '', amount: '500.00' };
const refund = { date: '11/06/2026', reference: reference(7, 4), payee: 'REI #12', address: 'BERKELEY CA', amount: '25.00' };
const tempCredit = { date: '', reference: 'TEMPRET', payee: 'REI #12', address: '', amount: '10.00' };
const FILE = bofaCsv([coffee, netflix, payment, refund, tempCredit]);

// SYNTHETIC files from another issuer (src/server/test/cardCsv.ts): Debit and Credit, D/M/YYYY, no reference numbers.
const GENERIC = debitCreditCsv(DEBIT_CREDIT_SAMPLE);
const DEBIT_CREDIT: CardMapping = { date: { column: 0, format: 'dmy' }, amount: { kind: 'split', charges: 3, credits: 4 }, description: 1, reference: null, address: null };
const draft = (t: TestApp, userId: number, cardId: number, text: string, fileName: string | null = 'activity.csv') => previewImport(t, userId, { cardId, fileName, bytes: bytes(text) });

function setup(opts: { logger?: pino.Logger } = {}) {
  const t = makeTestApp(opts);
  const admin = spendUser(t, { role: 'admin', email: 'admin@example.com' });
  const card = addCard(t, { nickname: 'Visa', mask: '1234', usualClosingDay: 15 });
  return { t, admin, card };
}

describe('CSV import: permissions (spec §12.14)', () => {
  it('is for admins with the Spend panel, behind the CSRF check', async () => {
    const { t, admin, card } = setup();
    const member = spendUser(t, { role: 'member' });
    const otherAdmin = cookieFor(t.db, t.clock, addUser(t.db, t.clock, { email: 'a2@example.com', role: 'admin', panels: ['todo'] }));
    expect((await upload(t, undefined, card.id, FILE)).status).toBe(401);
    expect((await upload(t, member.cookie, card.id, FILE)).status).toBe(403);
    expect((await upload(t, otherAdmin, card.id, FILE)).status).toBe(403);
    expect((await upload(t, admin.cookie, card.id, FILE, { csrf: false })).status).toBe(403);
    const { id } = await json<ImportPreview>(await upload(t, admin.cookie, card.id, FILE), 201);
    for (const cookie of [member.cookie, otherAdmin]) {
      expect((await call(t.app, 'POST', `${P}/imports/${id}/commit`, { cookie, body: { include: [2] } })).status).toBe(403);
      expect((await call(t.app, 'DELETE', `${P}/imports/${id}`, { cookie })).status).toBe(403);
    }
    expect((await call(t.app, 'POST', `${P}/imports/${id}/commit`, { cookie: admin.cookie, body: { include: [2] }, csrf: false })).status).toBe(403);
  });

  it("binds a preview to the admin who uploaded it: another admin can't save or see it", async () => {
    const { t, admin, card } = setup();
    const other = spendUser(t, { role: 'admin', email: 'other@example.com' });
    const { id } = await json<ImportPreview>(await upload(t, admin.cookie, card.id, FILE), 201);
    expect(await json(await call(t.app, 'POST', `${P}/imports/${id}/commit`, { cookie: other.cookie, body: { include: [2] } }), 404)).toEqual({
      error: { code: 'not_found', message: SPEND_MESSAGES.importNotFound },
    });
    await call(t.app, 'DELETE', `${P}/imports/${id}`, { cookie: other.cookie });
    expect(t.db.select().from(csvImportPreviews).all()).toHaveLength(1);
  });
});

describe('CSV import: the preview (spec §12.13)', () => {
  it('shows every row with its status, the date range, and the rows it can not import', async () => {
    const { t, admin, card } = setup();
    const preview = await json<ImportPreview>(await upload(t, admin.cookie, card.id, FILE), 201);
    expect(preview.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(preview.card).toEqual({ id: card.id, nickname: 'Visa', mask: '1234', archived: false });
    expect(preview.fileName).toBe('currentTransaction_1234.csv');
    expect(preview.dateRange).toEqual({ from: '2026-11-02', to: '2026-11-06' });
    expect(preview.rows.map((r) => [r.line, r.status, r.amountCents])).toEqual([
      [2, 'new', 1274],
      [3, 'new', 1549],
      [4, 'new', -50000],
      [5, 'new', -2500],
      [6, 'pending_credit', -1000],
    ]);
    expect(preview.warnings).toEqual([]);
    expect(preview.expiresAt).toBe(new Date(t.clock.now().getTime() + PREVIEW_TTL_MS).toISOString());
  });

  it("maps a file it doesn't know instead of refusing it, says the checking export belongs in Savings, and refuses a file with no table", async () => {
    const { t, admin, card } = setup();
    const checking = 'Description,,Summary Amt.\r\nBeginning balance as of 10/01/2026,,"1,000.00"\r\n\r\nDate,Description,Amount,Running Bal.\r\n';
    const columns = await json<ImportPreview>(await upload(t, admin.cookie, card.id, checking), 201);
    expect(columns).toMatchObject({ step: 'columns', format: 'custom', prefilled: 'guess', mapping: null, rows: [], dateRange: null, warnings: [] });
    expect(columns.columns).toMatchObject({ header: ['Description', '', 'Summary Amt.'], hint: SPEND_MESSAGES.importCheckingHint, suggested: null, problem: null });
    expect(await json(await upload(t, admin.cookie, card.id, 'Date,Payee,Amount\r\n'), 400)).toEqual({ error: { code: 'validation', message: CSV_TABLE_MESSAGES.noTable } });
    // The refusal left the draft as it was.
    expect(t.db.select().from(csvImportPreviews).all().map((p) => p.id)).toEqual([columns.id]);
  });

  it('flags likely duplicates of stored transactions, and rows whose reference number is already stored, deleted ones included', async () => {
    const { t, admin, card } = setup();
    addTransaction(t, card.id, { date: '2026-11-04', amountCents: 1274, rawName: 'Blue Bottle Coffee' });
    const gone = addTransaction(t, card.id, { date: '2026-10-01', amountCents: 1, rawName: 'X', csvReference: netflix.reference, deletedAt: t.clock.now() });
    const preview = await json<ImportPreview>(await upload(t, admin.cookie, card.id, FILE), 201);
    expect(preview.rows[0]).toMatchObject({ status: 'duplicate', duplicateOf: { date: '2026-11-04', merchant: 'Blue Bottle Coffee', amountCents: 1274 } });
    expect(preview.rows[1]).toMatchObject({ status: 'already_imported', reason: ALREADY_IMPORTED });
    expect(gone.deletedAt).not.toBeNull();
    // Another card's rows don't count.
    const other = addCard(t, { nickname: 'Other', mask: null });
    expect((await json<ImportPreview>(await upload(t, admin.cookie, other.id, FILE), 201)).rows[0]!.status).toBe('new');
  });

  it("flags a stored Plaid row as a likely duplicate by its merchant name or its raw name (the bank's text)", async () => {
    const { t, admin, card } = setup();
    // Plaid rows as a sync stores them: Plaid's merchant_name, its name as the raw name, no reference.
    // The pairs are the shapes seen in a real year of imports (made-up amounts and dates).
    const plaid = (n: number, merchant: string, rawName: string) =>
      addTransaction(t, card.id, { source: 'plaid', plaidTransactionId: `p-${n}`, date: '2026-11-02', amountCents: 1000 + n, merchant, rawName });
    plaid(1, "McDonald's", "McDonald's");
    plaid(2, 'Needles & Hooks', 'Needles & Hooks');
    plaid(3, 'Haleakala National Park', 'Haleakala National Park');
    plaid(4, 'Seattle Childrens Hospital', 'Seattle Childrens Hospital');
    // Plaid cleaned the merchant name, and only its raw name looks like the bank's text.
    plaid(5, 'Tinynonsens', 'PAYPAL *TINYNONSENS');
    const line = (n: number, payee: string) => ({ date: '11/02/2026', reference: reference(10, n), payee, amount: `-${((1000 + n) / 100).toFixed(2)}` });
    const file = bofaCsv([
      line(1, 'McDonalds 5795 142-5483579 W'),
      line(2, 'Needles Hooks Lake Forest PW'),
      line(3, 'HALEAKALA NATIONAL PARK KULA'),
      line(4, 'MED*SEATTLE CHILDRENS HOS206'),
      line(5, 'PAYPAL *TINYNONSENS 207-200-'),
    ], { pad: false });
    const { rows } = await json<ImportPreview>(await upload(t, admin.cookie, card.id, file), 201);
    expect(rows.map((r) => r.status)).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate', 'duplicate']);
    // Shown by the name the table shows: the merchant.
    expect(rows[4]!.duplicateOf).toMatchObject({ merchant: 'Tinynonsens' });
    expect(startsTicked(rows)).toEqual([]);
  });

  it('matches duplicates one to one, and never against a stored CSV row with another reference number', async () => {
    const { t, admin, card } = setup();
    // One stored toll without a reference (as a Plaid row will be), and one CSV row the bank numbered.
    addTransaction(t, card.id, { date: '2026-11-01', amountCents: 275, rawName: 'FASTRAK CSC' });
    addTransaction(t, card.id, { date: '2026-11-08', amountCents: 999, rawName: 'PARKING', csvReference: reference(8, 99) });
    const tolls = bofaCsv([
      { date: '11/02/2026', reference: reference(8, 1), payee: 'FASTRAK CSC', amount: '-2.75' },
      { date: '11/03/2026', reference: reference(8, 2), payee: 'FASTRAK CSC', amount: '-2.75' },
      { date: '11/08/2026', reference: reference(8, 3), payee: 'PARKING', amount: '-9.99' },
    ]);
    const { rows } = await json<ImportPreview>(await upload(t, admin.cookie, card.id, tolls), 201);
    expect(rows.map((r) => r.status)).toEqual(['duplicate', 'new', 'new']);
  });

  it('warns about a row that matches a stored one in every way but its reference number, and leaves it ticked', async () => {
    const { t, admin, card } = setup();
    const parking = addTransaction(t, card.id, { date: '2026-11-08', amountCents: 999, rawName: 'PARKING GARAGE', csvReference: reference(8, 99) });
    // Its own row in the file accounts for this one, so it's never offered as a near match.
    addTransaction(t, card.id, { date: '2026-11-02', amountCents: 1274, rawName: 'BLUE BOTTLE COFFEE', csvReference: coffee.reference });
    const file = bofaCsv([
      coffee,
      { date: '11/03/2026', reference: reference(8, 1), payee: 'BLUE BOTTLE COFFEE', amount: '-12.74' },
      { date: '11/09/2026', reference: reference(8, 2), payee: 'PARKING GARAGE #2', amount: '-9.99' },
      { date: '11/09/2026', reference: reference(8, 3), payee: 'PARKING GARAGE #2', amount: '-9.98' },
    ]);
    const { rows } = await json<ImportPreview>(await upload(t, admin.cookie, card.id, file), 201);
    expect(rows.map((r) => [r.status, r.reason])).toEqual([
      ['already_imported', ALREADY_IMPORTED],
      ['new', null],
      ['new', POSSIBLE_DUPLICATE],
      ['new', null],
    ]);
    expect(POSSIBLE_DUPLICATE).toBe('Possible duplicate (different reference number)');
    expect(rows[2]!.duplicateOf).toEqual({ id: parking.id, date: '2026-11-08', merchant: 'PARKING GARAGE', amountCents: 999 });
    expect(rows[3]!.duplicateOf).toBeNull();
  });

  it('names each stored transaction in at most one possible-duplicate warning', async () => {
    const { t, admin, card } = setup();
    const first = addTransaction(t, card.id, { date: '2026-11-02', amountCents: 275, rawName: 'FASTRAK CSC', csvReference: reference(8, 1) });
    const second = addTransaction(t, card.id, { date: '2026-11-02', amountCents: 275, rawName: 'FASTRAK CSC', csvReference: reference(8, 2) });
    // The bank renumbered both tolls, and there's a third, genuinely new one.
    const file = bofaCsv([1, 2, 3].map((n) => ({ date: '11/02/2026', reference: reference(9, n), payee: 'FASTRAK CSC', amount: '-2.75' })));
    const { rows } = await json<ImportPreview>(await upload(t, admin.cookie, card.id, file), 201);
    expect(rows.map((r) => [r.reason, r.duplicateOf?.id ?? null])).toEqual([
      [POSSIBLE_DUPLICATE, first.id],
      [POSSIBLE_DUPLICATE, second.id],
      [null, null],
    ]);
  });

  it('says so, and starts them unticked, when possible duplicates are more than half of the new rows', async () => {
    const { t, admin, card } = setup();
    for (const n of [1, 2]) addTransaction(t, card.id, { date: '2026-11-02', amountCents: 275 * n, rawName: 'FASTRAK CSC', csvReference: reference(8, n) });
    const renumbered = [1, 2].map((n) => ({ date: '11/02/2026', reference: reference(9, n), payee: 'FASTRAK CSC', amount: `-${(2.75 * n).toFixed(2)}` }));
    const mostly = await json<ImportPreview>(await upload(t, admin.cookie, card.id, bofaCsv([...renumbered, coffee])), 201);
    expect(mostly.rows.map((r) => r.reason)).toEqual([POSSIBLE_DUPLICATE, POSSIBLE_DUPLICATE, null]);
    expect(mostly.warnings).toEqual([{ id: 'mostly_possible_duplicates', message: SPEND_MESSAGES.importMostlyPossibleDuplicates }]);
    expect(SPEND_MESSAGES.importMostlyPossibleDuplicates).toBe(
      "Most of this file's new rows look like transactions already here with a different reference number. The bank may have renumbered them, so they start unticked. Tick only the ones that are really new.",
    );
    // Half isn't more than half: no warning.
    const half = await json<ImportPreview>(await upload(t, admin.cookie, card.id, bofaCsv([renumbered[0]!, coffee])), 201);
    expect(half.warnings).toEqual([]);
  });

  it('drops control and format characters from the file name', () => {
    const { t, admin, card } = setup();
    const name = (fileName: string) => previewImport(t, admin.id, { cardId: card.id, fileName, bytes: bytes(FILE) }).fileName;
    // A right-to-left override would show "currentTransaction_1234.csv" reversed in part; a bell and a zero-width space hide.
    expect(name('C:\\Downloads\\current\u202eTransaction\u0007_12\u200b34.csv\u0000')).toBe('currentTransaction_1234.csv');
    expect(name('\u202e\u200b\u0001')).toBeNull();
    // The last 4 is read from the cleaned name.
    expect(previewImport(t, admin.id, { cardId: card.id, fileName: 'April2026_98\u200b76.csv', bytes: bytes(FILE) }).warnings.map((w) => w.id)).toEqual(['card_mismatch']);
  });

  it('warns when the file name names another card, or most rows are credits', async () => {
    const { t, admin, card } = setup();
    const named = await json<ImportPreview>(await upload(t, admin.cookie, card.id, FILE, { name: 'April2026_9876.csv' }), 201);
    expect(named.warnings).toEqual([{ id: 'card_mismatch', message: SPEND_MESSAGES.importCardMismatch('9876', '1234') }]);
    const flipped = bofaCsv([coffee, netflix].map((l) => ({ ...l, amount: l.amount.replace('-', '') })));
    expect((await json<ImportPreview>(await upload(t, admin.cookie, card.id, flipped), 201)).warnings).toEqual([{ id: 'mostly_credits', message: BOFA_MESSAGES.mostlyCredits }]);
  });

  it('refuses no file, a card that is gone or archived, and a file over 5 MB', async () => {
    const { t, admin, card } = setup();
    expect(await json(await upload(t, admin.cookie, card.id, null), 400)).toEqual({ error: { code: 'validation', message: SPEND_MESSAGES.importNoFile } });
    expect(await json(await upload(t, admin.cookie, card.id, ''), 400)).toEqual({ error: { code: 'validation', message: SPEND_MESSAGES.importNoFile } });
    expect((await upload(t, admin.cookie, 'abc', FILE)).status).toBe(400);
    expect(await json(await upload(t, admin.cookie, 999, FILE), 400)).toEqual({ error: { code: 'validation', message: SPEND_MESSAGES.cardNotFound } });
    const archived = addCard(t, { archivedAt: t.clock.now() });
    expect(await json(await upload(t, admin.cookie, archived.id, FILE), 400)).toEqual({ error: { code: 'validation', message: SPEND_MESSAGES.cardArchived } });
    const big = new Uint8Array(5 * 1024 * 1024 + 1).fill(0x41);
    expect(await json(await upload(t, admin.cookie, card.id, big), 413)).toEqual({ error: { code: 'validation', message: SPEND_MESSAGES.importTooBig } });
    const huge = new Uint8Array(6 * 1024 * 1024).fill(0x41);
    expect(await json(await upload(t, admin.cookie, card.id, huge), 413)).toEqual({ error: { code: 'validation', message: SPEND_MESSAGES.importTooBig } });
  });

  it("keeps one preview per admin, and forgets it after an hour", async () => {
    const { t, admin, card } = setup();
    const first = await json<ImportPreview>(await upload(t, admin.cookie, card.id, FILE), 201);
    const second = await json<ImportPreview>(await upload(t, admin.cookie, card.id, FILE), 201);
    expect(t.db.select().from(csvImportPreviews).all().map((p) => p.id)).toEqual([second.id]);
    expect((await call(t.app, 'POST', `${P}/imports/${first.id}/commit`, { cookie: admin.cookie, body: { include: [2] } })).status).toBe(404);
    t.clock.advance(PREVIEW_TTL_MS);
    expect((await call(t.app, 'POST', `${P}/imports/${second.id}/commit`, { cookie: admin.cookie, body: { include: [2] } })).status).toBe(404);
    expect(t.db.select().from(csvImportPreviews).all()).toHaveLength(1);
    await spendPanel.jobs!(t)[0]!.run();
    expect(t.db.select().from(csvImportPreviews).all()).toEqual([]);
  });

  it('checkpoints the WAL each time it prunes, so a deleted draft does not linger in old WAL frames', async () => {
    const { t } = setup();
    const pragmas: string[] = [];
    const pragma = t.sqlite.pragma.bind(t.sqlite);
    t.sqlite.pragma = ((source: string, options?: Parameters<typeof pragma>[1]) => {
      pragmas.push(source);
      return pragma(source, options);
    }) as typeof t.sqlite.pragma;
    await spendPanel.jobs!(t)[0]!.run();
    expect(pragmas).toContain('wal_checkpoint(TRUNCATE)');
  });

  it('cancels a preview', async () => {
    const { t, admin, card } = setup();
    const { id } = await json<ImportPreview>(await upload(t, admin.cookie, card.id, FILE), 201);
    expect((await call(t.app, 'DELETE', `${P}/imports/${id}`, { cookie: admin.cookie })).status).toBe(204);
    expect(t.db.select().from(csvImportPreviews).all()).toEqual([]);
    expect((await call(t.app, 'DELETE', `${P}/imports/not-an-id`, { cookie: admin.cookie })).status).toBe(404);
  });
});

describe('CSV import: saving', () => {
  it('imports the rows kept, with rules applied and the source, reference, and import recorded', async () => {
    const { t, admin, card } = setup();
    const now = t.clock.now();
    const { id } = await json<ImportPreview>(await upload(t, admin.cookie, card.id, FILE), 201);
    // Lines 2 to 5 are readable; 6 (TEMPRET) is offered too and ignored; 3 is left out.
    const result = await json<ImportResult>(await call(t.app, 'POST', `${P}/imports/${id}/commit`, { cookie: admin.cookie, body: { include: [2, 4, 5, 6] } }));
    expect(result).toEqual({ imported: 3, skipped: 2 });
    const rows = t.db.select().from(transactions).all();
    expect(rows.map((r) => [r.date, r.amountCents, r.rawName, r.csvReference, r.source, r.isoCurrencyCode, r.merchant])).toEqual([
      ['2026-11-02', 1274, 'BLUE BOTTLE COFFEE', coffee.reference, 'csv', 'USD', null],
      ['2026-11-05', -50000, 'PAYMENT - THANK YOU', payment.reference, 'csv', 'USD', null],
      ['2026-11-06', -2500, 'REI #12', refund.reference, 'csv', 'USD', null],
    ]);
    // The seeded rule catches the payment; nothing else matches a rule, so it's Uncategorized and Household.
    expect(rows.map((r) => [r.categoryId, r.categorySource, r.personUserId, r.personSource])).toEqual([
      [categoryId(t, 'Uncategorized'), 'default', null, 'default'],
      [categoryId(t, 'Payments and transfers'), 'rule', null, 'default'],
      [categoryId(t, 'Uncategorized'), 'default', null, 'default'],
    ]);
    const [imp] = t.db.select().from(csvImports).all();
    expect(imp).toMatchObject({ cardId: card.id, fileName: 'currentTransaction_1234.csv', uploadedByUserId: admin.id, rowCount: 5, importedCount: 3, skippedCount: 2, uploadedAt: now });
    expect(imp!.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rows.every((r) => r.csvImportId === imp!.id)).toBe(true);
    expect(t.db.select().from(csvImportPreviews).all()).toEqual([]);

    // The card's "Updated X ago" is the import's time, and the refund subtracts from the total.
    const summary = await json<SpendSummary>(await call(t.app, 'GET', `${P}/summary`, { cookie: admin.cookie }));
    expect(summary.cards[0]).toMatchObject({ updatedAt: now.toISOString(), totalCents: 1274 - 2500 });
  });

  it('lists every row as already imported when the same file is previewed again, and refuses to save it', async () => {
    const { t, admin, card } = setup();
    const first = await json<ImportPreview>(await upload(t, admin.cookie, card.id, FILE), 201);
    await call(t.app, 'POST', `${P}/imports/${first.id}/commit`, { cookie: admin.cookie, body: { include: [2, 3, 4, 5] } });
    const again = await json<ImportPreview>(await upload(t, admin.cookie, card.id, FILE), 201);
    expect(again.rows.map((r) => r.status)).toEqual(['already_imported', 'already_imported', 'already_imported', 'already_imported', 'pending_credit']);
    expect(again.dateRange).toBeNull();
    // Every line picked can't be imported, so the save is refused, nothing is recorded, and the preview stays.
    expect(await json(await call(t.app, 'POST', `${P}/imports/${again.id}/commit`, { cookie: admin.cookie, body: { include: [2, 3, 4, 5, 6] } }), 400)).toEqual({
      error: { code: 'validation', message: SPEND_MESSAGES.importNothingPicked },
    });
    expect(SPEND_MESSAGES.importNothingPicked).toBe("None of the rows you picked can be imported.");
    expect(t.db.select().from(transactions).all()).toHaveLength(4);
    expect(t.db.select().from(csvImports).all()).toHaveLength(1);
    expect(t.db.select().from(csvImportPreviews).all()).toHaveLength(1);
  });

  it('skips reference numbers stored after the preview, and imports a duplicate only when it was chosen', async () => {
    const { t, admin, card } = setup();
    addTransaction(t, card.id, { date: '2026-11-03', amountCents: 1274, rawName: 'BLUE BOTTLE' });
    const { id, rows } = await json<ImportPreview>(await upload(t, admin.cookie, card.id, FILE), 201);
    expect(rows[0]!.status).toBe('duplicate');
    addTransaction(t, card.id, { csvReference: netflix.reference, rawName: 'NETFLIX.COM', amountCents: 1549 });
    const result = await json<ImportResult>(await call(t.app, 'POST', `${P}/imports/${id}/commit`, { cookie: admin.cookie, body: { include: [2, 3] } }));
    expect(result).toEqual({ imported: 1, skipped: 4 });
    expect(t.db.select().from(transactions).where(eq(transactions.csvReference, coffee.reference)).all()).toHaveLength(1);
  });

  it('refuses a save with no rows picked, and keeps the preview', async () => {
    const { t, admin, card } = setup();
    const { id } = await json<ImportPreview>(await upload(t, admin.cookie, card.id, FILE), 201);
    expect(await json(await call(t.app, 'POST', `${P}/imports/${id}/commit`, { cookie: admin.cookie, body: { include: [] } }), 400)).toEqual({
      error: { code: 'validation', message: 'Pick at least one row to import.' },
    });
    expect(t.db.select().from(csvImports).all()).toEqual([]);
    expect(t.db.select().from(csvImportPreviews).all()).toHaveLength(1);
  });

  it('records the import when every row picked was stored after the preview', async () => {
    const { t, admin, card } = setup();
    const { id } = await json<ImportPreview>(await upload(t, admin.cookie, card.id, FILE), 201);
    addTransaction(t, card.id, { csvReference: coffee.reference, rawName: 'BLUE BOTTLE COFFEE', amountCents: 1274 });
    expect(await json(await call(t.app, 'POST', `${P}/imports/${id}/commit`, { cookie: admin.cookie, body: { include: [2] } }))).toEqual({ imported: 0, skipped: 5 });
    expect(t.db.select().from(csvImports).all()).toEqual([expect.objectContaining({ cardId: card.id, importedCount: 0, skippedCount: 5 })]);
  });

  it("refuses to save into a card archived since the preview", async () => {
    const { t, admin, card } = setup();
    const { id } = await json<ImportPreview>(await upload(t, admin.cookie, card.id, FILE), 201);
    await call(t.app, 'POST', `${P}/cards/${card.id}/archive`, { cookie: admin.cookie });
    expect(await json(await call(t.app, 'POST', `${P}/imports/${id}/commit`, { cookie: admin.cookie, body: { include: [2] } }), 400)).toEqual({
      error: { code: 'validation', message: SPEND_MESSAGES.cardArchived },
    });
    expect(t.db.select().from(transactions).all()).toEqual([]);
  });

  it('never logs anything from the file', async () => {
    const lines: string[] = [];
    const { t, admin, card } = setup({ logger: pino({ level: 'debug' }, { write: (line: string) => void lines.push(line) }) });
    const { id } = await json<ImportPreview>(await upload(t, admin.cookie, card.id, FILE), 201);
    await call(t.app, 'POST', `${P}/imports/${id}/commit`, { cookie: admin.cookie, body: { include: [2, 3, 4, 5] } });
    // Another issuer's layout is a draft at the columns step now; a file that isn't text is refused.
    await upload(t, admin.cookie, card.id, 'Posted Date,Reference Number,Payee,Amount\r\n11/02/2026,1,SECRET SHOP,-1.00\r\n');
    await upload(t, admin.cookie, card.id, new Uint8Array([0xff, 0xfe, 0x00]));
    const log = lines.join('\n');
    for (const msg of ['spend csv draft', 'spend csv preview', 'spend csv imported', 'spend csv refused']) expect(log).toContain(msg);
    for (const text of ['BLUE BOTTLE', 'NETFLIX', 'OAKLAND', '12.74', '1274', coffee.reference, 'SECRET', 'currentTransaction', 'Payee', 'Reference Number']) expect(log).not.toContain(text);
  });
});

describe('CSV import: undo (review C-I1)', () => {
  /** Uploads `file` and saves every row the preview starts with ticked. */
  async function importFile(t: TestApp, cookie: string, cardId: number, file: string, name?: string): Promise<ImportResult> {
    const preview = await json<ImportPreview>(await upload(t, cookie, cardId, file, { name }), 201);
    return json<ImportResult>(await call(t.app, 'POST', `${P}/imports/${preview.id}/commit`, { cookie, body: { include: startsTicked(preview.rows) } }));
  }
  const history = async (t: TestApp, cookie: string, cardId: number) => json<CsvImportRecord[]>(await call(t.app, 'GET', `${P}/cards/${cardId}/imports`, { cookie }));
  const undo = (t: TestApp, cookie: string, cardId: number, importId: number, opts: { csrf?: boolean } = {}) =>
    call(t.app, 'DELETE', `${P}/cards/${cardId}/imports/${importId}`, { cookie, ...opts });

  it('is for admins with the Spend panel, behind the CSRF check', async () => {
    const { t, admin, card } = setup();
    const member = spendUser(t, { role: 'member' });
    const otherAdmin = cookieFor(t.db, t.clock, addUser(t.db, t.clock, { email: 'a2@example.com', role: 'admin', panels: ['todo'] }));
    await importFile(t, admin.cookie, card.id, FILE);
    const [imp] = t.db.select().from(csvImports).all();
    for (const [method, path] of [['GET', `/cards/${card.id}/imports`], ['DELETE', `/cards/${card.id}/imports/${imp!.id}`]] as const) {
      expect((await call(t.app, method, `${P}${path}`)).status).toBe(401);
      expect(await json(await call(t.app, method, `${P}${path}`, { cookie: member.cookie }), 403)).toEqual({ error: { code: 'forbidden', message: 'Only admins can do that.' } });
      expect((await call(t.app, method, `${P}${path}`, { cookie: otherAdmin })).status).toBe(403);
    }
    expect((await undo(t, admin.cookie, card.id, imp!.id, { csrf: false })).status).toBe(403);
    // Nothing was undone.
    expect(t.db.select().from(transactions).all()).toHaveLength(4);
    expect(t.db.select().from(csvImports).all()).toHaveLength(1);
  });

  it("lists a card's recent imports, newest first, with how many of their transactions are still there", async () => {
    const { t, admin, card } = setup();
    expect(await history(t, admin.cookie, card.id)).toEqual([]);
    const first = t.clock.now();
    await importFile(t, admin.cookie, card.id, bofaCsv([coffee, netflix]), 'October.csv');
    t.clock.advance(60_000);
    await importFile(t, admin.cookie, card.id, bofaCsv([payment]), 'November.csv');
    const other = addCard(t, { nickname: 'Other', mask: null });
    await importFile(t, admin.cookie, other.id, bofaCsv([refund]));
    const list = await history(t, admin.cookie, card.id);
    expect(list.map((i) => [i.fileName, i.uploadedAt, i.uploadedBy, i.importedCount, i.transactionCount])).toEqual([
      ['November.csv', new Date(first.getTime() + 60_000).toISOString(), 'admin', 1, 1],
      ['October.csv', first.toISOString(), 'admin', 2, 2],
    ]);
    expect((await call(t.app, 'GET', `${P}/cards/999/imports`, { cookie: admin.cookie })).status).toBe(404);
  });

  it('hard-deletes the import and its transactions in one go, so the same file can be imported again', async () => {
    const { t, admin, card } = setup();
    const kept = addTransaction(t, card.id, { rawName: 'ENTERED BY HAND' });
    await importFile(t, admin.cookie, card.id, bofaCsv([coffee]), 'Earlier.csv');
    t.clock.advance(60_000);
    expect(await importFile(t, admin.cookie, card.id, FILE)).toEqual({ imported: 3, skipped: 2 });
    const [latest] = await history(t, admin.cookie, card.id);
    expect(await json(await undo(t, admin.cookie, card.id, latest!.id))).toEqual({ removed: 3 });
    // The earlier import and the row entered by hand stay; the undone import's record is gone.
    expect(t.db.select().from(transactions).all().map((r) => r.rawName).sort()).toEqual(['BLUE BOTTLE COFFEE', kept.rawName]);
    expect((await history(t, admin.cookie, card.id)).map((i) => i.fileName)).toEqual(['Earlier.csv']);
    // Its reference numbers are free again: the same file previews as new and imports.
    const again = await json<ImportPreview>(await upload(t, admin.cookie, card.id, FILE), 201);
    expect(again.rows.map((r) => r.status)).toEqual(['already_imported', 'new', 'new', 'new', 'pending_credit']);
    expect(await json(await call(t.app, 'POST', `${P}/imports/${again.id}/commit`, { cookie: admin.cookie, body: { include: [3, 4, 5] } }))).toEqual({ imported: 3, skipped: 2 });
    // The card's "last imported" follows the imports that are left.
    expect((await json<Card[]>(await call(t.app, 'GET', `${P}/cards`, { cookie: admin.cookie })))[0]!.lastImportAt).toBe(t.clock.now().toISOString());
  });

  it('undoes an import that saved no rows, and puts "last imported" back to the import before it', async () => {
    const { t, admin, card } = setup();
    const { id } = await json<ImportPreview>(await upload(t, admin.cookie, card.id, FILE), 201);
    addTransaction(t, card.id, { csvReference: coffee.reference, rawName: 'BLUE BOTTLE COFFEE', amountCents: 1274 });
    await call(t.app, 'POST', `${P}/imports/${id}/commit`, { cookie: admin.cookie, body: { include: [2] } });
    const [imp] = await history(t, admin.cookie, card.id);
    expect(imp!.transactionCount).toBe(0);
    expect(await json(await undo(t, admin.cookie, card.id, imp!.id))).toEqual({ removed: 0 });
    expect((await json<Card[]>(await call(t.app, 'GET', `${P}/cards`, { cookie: admin.cookie })))[0]!.lastImportAt).toBeNull();
  });

  it.each([
    ['a category set by hand', (t: TestApp) => ({ categoryId: categoryId(t, 'Dining') })],
    ['a person set by hand', (_t: TestApp, userId: number) => ({ personUserId: userId })],
    ['a note', () => ({ note: 'Birthday dinner' })],
  ])('refuses, and changes nothing, when a transaction has %s', async (_what, patch) => {
    const { t, admin, card } = setup();
    await importFile(t, admin.cookie, card.id, FILE);
    const rows = t.db.select().from(transactions).all();
    for (const r of rows.slice(0, 2)) {
      expect((await call(t.app, 'PATCH', `${P}/transactions/${r.id}`, { cookie: admin.cookie, body: patch(t, admin.id) })).status).toBe(200);
    }
    const [imp] = await history(t, admin.cookie, card.id);
    expect(await json(await undo(t, admin.cookie, card.id, imp!.id), 409)).toEqual({ error: { code: 'conflict', message: SPEND_MESSAGES.importUndoEdited(2, 4) } });
    expect(SPEND_MESSAGES.importUndoEdited(2, 3)).toBe(
      "This import can't be undone because 2 of its 3 transactions have a category, person, or note set by hand. Undo those changes first.",
    );
    expect(SPEND_MESSAGES.importUndoEdited(1, 1)).toBe(
      "This import can't be undone because 1 of its 1 transactions has a category, person, or note set by hand. Undo those changes first.",
    );
    expect(t.db.select().from(transactions).all()).toHaveLength(4);
    expect(t.db.select().from(csvImports).all()).toHaveLength(1);
  });

  it('allows it again once the hand-set values are reset and the note cleared', async () => {
    const { t, admin, card } = setup();
    await importFile(t, admin.cookie, card.id, FILE);
    const [row] = t.db.select().from(transactions).all();
    await call(t.app, 'PATCH', `${P}/transactions/${row!.id}`, { cookie: admin.cookie, body: { categoryId: categoryId(t, 'Dining'), note: 'x' } });
    const [imp] = await history(t, admin.cookie, card.id);
    expect((await undo(t, admin.cookie, card.id, imp!.id)).status).toBe(409);
    await call(t.app, 'POST', `${P}/transactions/${row!.id}/reset`, { cookie: admin.cookie, body: { fields: ['category'] } });
    await call(t.app, 'PATCH', `${P}/transactions/${row!.id}`, { cookie: admin.cookie, body: { note: '' } });
    expect(await json(await undo(t, admin.cookie, card.id, imp!.id))).toEqual({ removed: 4 });
  });

  it('keeps the rows a Plaid transaction replaced, holding their reference numbers, and a re-import adopts them, still hidden (departure 8)', async () => {
    const { t, admin, card } = setup();
    await importFile(t, admin.cookie, card.id, FILE);
    const rows = t.db.select().from(transactions).all();
    const replaced = rows.find((r) => r.rawName === 'BLUE BOTTLE COFFEE')!;
    const plaid = addTransaction(t, card.id, { source: 'plaid', plaidTransactionId: 'tx-synthetic-1', rawName: 'BLUE BOTTLE COFFEE', amountCents: replaced.amountCents });
    // As plaidApply leaves a replaced CSV row: soft-deleted, pointing at its Plaid twin, its hand-set fields copied there.
    t.db.update(transactions)
      .set({ deletedAt: t.clock.now(), replacedById: plaid.id, categoryId: categoryId(t, 'Dining'), categorySource: 'manual', note: 'Moved to the Plaid row' })
      .where(eq(transactions.id, replaced.id))
      .run();

    const [imp] = await history(t, admin.cookie, card.id);
    // Only the live rows are what an undo deletes, and only they count toward "set by hand".
    expect(imp!.transactionCount).toBe(3);
    expect(await json(await undo(t, admin.cookie, card.id, imp!.id))).toEqual({ removed: 3 });
    const left = t.db.select().from(transactions).all();
    expect(left.map((r) => r.id).sort()).toEqual([replaced.id, plaid.id].sort());
    expect(left.find((r) => r.id === replaced.id)).toMatchObject({ csvImportId: null, csvReference: coffee.reference, deletedAt: t.clock.now(), replacedById: plaid.id });
    expect(t.db.select().from(csvImports).all()).toEqual([]);

    // The same file again: the replaced row is part of it, as a row the import adopts rather than adds.
    const again = await json<ImportPreview>(await upload(t, admin.cookie, card.id, FILE), 201);
    expect(again.rows.map((r) => r.status)).toEqual(['new', 'new', 'new', 'new', 'pending_credit']);
    expect(again.rows[0]).toMatchObject({ reference: coffee.reference, reason: IMPORT_REPLACED_ROW });
    expect(await json<ImportResult>(await call(t.app, 'POST', `${P}/imports/${again.id}/commit`, { cookie: admin.cookie, body: { include: [2, 3, 4, 5] } })))
      .toEqual({ imported: 4, skipped: 1 });
    const [second] = t.db.select().from(csvImports).all();
    const now = t.db.select().from(transactions).all();
    expect(now.filter((r) => r.csvReference === coffee.reference)).toEqual([
      expect.objectContaining({ id: replaced.id, csvImportId: second!.id, deletedAt: expect.any(Date), replacedById: plaid.id }),
    ]);
    expect(now.filter((r) => r.source === 'csv' && r.deletedAt === null)).toHaveLength(3);
  });

  it('runs in one transaction: a failure part way leaves every row in place', async () => {
    const { t, admin, card } = setup();
    await importFile(t, admin.cookie, card.id, FILE);
    const [imp] = await history(t, admin.cookie, card.id);
    // The last step, deleting the import's record, fails after its transactions were deleted.
    t.db.run(sql.raw("CREATE TEMP TRIGGER fail_undo BEFORE DELETE ON csv_imports BEGIN SELECT RAISE(ABORT, 'test failure'); END"));
    expect((await undo(t, admin.cookie, card.id, imp!.id)).status).toBe(500);
    expect(t.db.select().from(transactions).all()).toHaveLength(4);
    expect(t.db.select().from(csvImports).all()).toHaveLength(1);
  });

  it("answers not found for an import that's gone or belongs to another card", async () => {
    const { t, admin, card } = setup();
    await importFile(t, admin.cookie, card.id, FILE);
    const [imp] = await history(t, admin.cookie, card.id);
    const other = addCard(t, { nickname: 'Other', mask: null });
    expect(await json(await undo(t, admin.cookie, other.id, imp!.id), 404)).toEqual({ error: { code: 'not_found', message: SPEND_MESSAGES.importRecordNotFound } });
    expect((await undo(t, admin.cookie, card.id, 999)).status).toBe(404);
    expect((await call(t.app, 'DELETE', `${P}/cards/${card.id}/imports/abc`, { cookie: admin.cookie })).status).toBe(404);
    expect(t.db.select().from(transactions).all()).toHaveLength(4);
    expect(await json(await undo(t, admin.cookie, card.id, imp!.id))).toEqual({ removed: 4 });
    expect((await undo(t, admin.cookie, card.id, imp!.id)).status).toBe(404);
  });

  it('logs counts only', async () => {
    const lines: string[] = [];
    const { t, admin, card } = setup({ logger: pino({ level: 'debug' }, { write: (line: string) => void lines.push(line) }) });
    await importFile(t, admin.cookie, card.id, FILE);
    const [imp] = await history(t, admin.cookie, card.id);
    await undo(t, admin.cookie, card.id, imp!.id);
    const log = lines.join('\n');
    expect(log).toContain('spend csv import undone');
    for (const text of ['BLUE BOTTLE', 'currentTransaction', coffee.reference]) expect(log).not.toContain(text);
  });
});

describe('CSV import: the columns step (the generic import design)', () => {
  it('takes a Bank of America file straight to the preview, read with its built-in format', () => {
    const { t, admin, card } = setup();
    const p = draft(t, admin.id, card.id, FILE, 'currentTransaction_1234.csv');
    expect(p).toMatchObject({ step: 'preview', format: 'bofa_credit', prefilled: 'builtin', mapping: BOFA_FORMAT.mapping });
    expect(p.columns).toMatchObject({ header: [...BOFA_HEADER], rowCount: 5, trailingSkipped: 0, suggested: null, problem: null, hint: null });
    expect(p.columns.sample).toHaveLength(5);
  });

  it("lists a Bank of America file's truncated final row as unreadable: its files have no footer", () => {
    const { t, admin, card } = setup();
    const p = draft(t, admin.id, card.id, `${FILE}11/07/2026,${reference(7, 9)},"TRUNCATED SHO`);
    expect(p).toMatchObject({ step: 'preview', columns: { rowCount: 6, trailingSkipped: 0 } });
    expect(p.rows.at(-1)).toMatchObject({ line: 7, status: 'unreadable', payee: null });
  });

  it("says how many lines after another issuer's table it skipped, a truncated final row included, and never what they say", () => {
    const { t, admin, card } = setup();
    const p = draft(t, admin.id, card.id, `${GENERIC}18/10/2026,TRUNCATED SHO`);
    expect(p).toMatchObject({ step: 'columns', columns: { rowCount: 6, trailingSkipped: 1 } });
    expect(JSON.stringify(p)).not.toContain('TRUNCATED');
  });

  it("opens the columns step for another issuer's file: a guess, the first 8 rows, and each column's date formats", () => {
    const { t, admin, card } = setup();
    const p = draft(t, admin.id, card.id, debitCreditCsv([...DEBIT_CREDIT_SAMPLE, ...DEBIT_CREDIT_SAMPLE]));
    expect(p).toMatchObject({ step: 'columns', format: 'custom', prefilled: 'guess', mapping: null, rows: [], dateRange: null, warnings: [] });
    expect(p.columns.suggested).toEqual(DEBIT_CREDIT);
    expect(p.columns.sample).toHaveLength(8);
    expect(p.columns.sample[0]).toEqual(['13/10/2026', 'CORNER CAFE 0042', 'Dining', '4.50', '']);
    expect(p.columns.rowCount).toBe(12);
    expect(p.columns.dateFormats[0]).toEqual(['dmy']);
    // Nothing can be imported before the columns are chosen.
    expect(() => commitImport(t, admin.id, p.id, [2])).toThrow(SPEND_MESSAGES.importNotReady);
  });

  it("reads the rows with the columns chosen, and refuses columns that can't read the file, keeping the draft", () => {
    const { t, admin, card } = setup();
    const p = draft(t, admin.id, card.id, GENERIC);
    expect(() => updateImport(t, admin.id, p.id, { ...DEBIT_CREDIT, date: { column: 0, format: 'mdy' } })).toThrow(SPEND_MESSAGES.importBadDate(2, 'M/D/YYYY'));
    expect(() => updateImport(t, admin.id, p.id, { ...DEBIT_CREDIT, description: 0 })).toThrow(SPEND_MESSAGES.importSameColumn);
    expect(() => updateImport(t, admin.id, p.id, { ...DEBIT_CREDIT, address: 9 })).toThrow(SPEND_MESSAGES.importColumnMissing);
    expect(t.db.select().from(csvImportPreviews).get()!.plan!.mapping).toBeNull();
    const read = updateImport(t, admin.id, p.id, DEBIT_CREDIT);
    expect(read).toMatchObject({ step: 'preview', format: 'custom', prefilled: 'guess', mapping: DEBIT_CREDIT, dateRange: { from: '2026-10-13', to: '2026-10-17' } });
    expect(read.rows.map((r) => [r.line, r.status, r.date, r.payee, r.amountCents])).toEqual([
      [2, 'new', '2026-10-13', 'CORNER CAFE 0042', 450],
      [3, 'new', '2026-10-14', 'BOOK NOOK', 102499],
      [4, 'new', '2026-10-15', 'CORNER CAFE 0042', 450],
      [5, 'new', '2026-10-15', 'CORNER CAFE 0042', 450],
      [6, 'new', '2026-10-16', 'ONLINE PAYMENT THANK YOU', -50000],
      [7, 'new', '2026-10-17', 'HARDWARE BARN #12', -1200],
    ]);
    expect(read.rows.every((r) => isRowKey(r.reference))).toBe(true);
  });

  it('saves the columns on the card at Import, and the next file with the same header goes straight to the preview', () => {
    const { t, admin, card } = setup();
    const first = draft(t, admin.id, card.id, debitCreditCsv(DEBIT_CREDIT_SAMPLE.slice(0, 3)));
    updateImport(t, admin.id, first.id, DEBIT_CREDIT);
    expect(commitImport(t, admin.id, first.id, [2, 3, 4])).toEqual({ imported: 3, skipped: 0 });
    expect(t.db.select().from(csvImports).get()).toMatchObject({ format: 'custom', importedCount: 3 });
    expect(t.db.select().from(spendImportProfiles).get()).toMatchObject({
      cardId: card.id, header: ['Transaction Date', 'Description', 'Category', 'Debit', 'Credit'], mapping: DEBIT_CREDIT, updatedByUserId: admin.id,
    });
    const next = draft(t, admin.id, card.id, GENERIC);
    expect(next).toMatchObject({ step: 'preview', prefilled: 'profile', format: 'custom', mapping: DEBIT_CREDIT });
    expect(next.rows.map((r) => r.status)).toEqual(['already_imported', 'already_imported', 'already_imported', 'new', 'new', 'new']);
    // Another card, or another header, doesn't use them.
    const other = addCard(t, { nickname: 'Other', mask: null });
    expect(draft(t, admin.id, other.id, GENERIC)).toMatchObject({ step: 'columns', prefilled: 'guess' });
    expect(draft(t, admin.id, card.id, signedCsv([{ date: '2026-11-02', merchant: 'SHOP', amount: '4.50' }]))).toMatchObject({ step: 'columns', prefilled: 'guess' });
  });

  it('replaces the saved columns at the next Import: one per card', () => {
    const { t, admin, card } = setup();
    const first = draft(t, admin.id, card.id, GENERIC);
    updateImport(t, admin.id, first.id, DEBIT_CREDIT);
    commitImport(t, admin.id, first.id, [2]);
    // The next file comes in with the saved columns; the admin also maps Category as the location.
    const next = draft(t, admin.id, card.id, GENERIC);
    expect(next.prefilled).toBe('profile');
    const changed = updateImport(t, admin.id, next.id, { ...DEBIT_CREDIT, address: 2 });
    expect(changed.rows[1]).toMatchObject({ address: 'Shopping' });
    commitImport(t, admin.id, next.id, startsTicked(changed.rows));
    expect(t.db.select().from(spendImportProfiles).all()).toEqual([expect.objectContaining({ cardId: card.id, mapping: { ...DEBIT_CREDIT, address: 2 } })]);
  });

  it("opens the columns step with the saved columns filled in, and why, when they don't fit the file", () => {
    const { t, admin, card } = setup();
    const first = draft(t, admin.id, card.id, GENERIC);
    updateImport(t, admin.id, first.id, DEBIT_CREDIT);
    commitImport(t, admin.id, first.id, [2]);
    // Saved for D/M/YYYY; this file's date has a month of 20 that way round.
    const p = draft(t, admin.id, card.id, debitCreditCsv([{ date: '10/20/2026', description: 'CORNER CAFE 0042', debit: '4.50' }]));
    expect(p).toMatchObject({ step: 'columns', prefilled: 'profile', mapping: null, rows: [] });
    expect(p.columns).toMatchObject({ suggested: DEBIT_CREDIT, problem: SPEND_MESSAGES.importSavedDoesntFit(SPEND_MESSAGES.importBadDate(2, 'D/M/YYYY')) });
  });

  it('puts saved columns ahead of the built-in format, and Clear goes back to it', () => {
    const { t, admin, card } = setup();
    const custom: CardMapping = { ...BOFA_FORMAT.mapping, amount: { kind: 'signed', column: 4, purchasesNegative: false } };
    const p = draft(t, admin.id, card.id, FILE);
    const read = updateImport(t, admin.id, p.id, custom);
    expect(read).toMatchObject({ format: 'custom', mapping: custom });
    expect(read.rows[0]!.amountCents).toBe(-1274);
    commitImport(t, admin.id, p.id, [2]);
    expect(draft(t, admin.id, card.id, FILE)).toMatchObject({ step: 'preview', prefilled: 'profile', format: 'custom', mapping: custom });
    expect(importProfileOf(t, card.id)).toMatchObject({ cardId: card.id, format: 'custom', header: [...BOFA_HEADER], mapping: custom, updatedBy: 'admin' });
    clearImportProfile(t, admin.id, card.id);
    expect(importProfileOf(t, card.id)).toBeNull();
    expect(() => clearImportProfile(t, admin.id, card.id)).toThrow(SPEND_MESSAGES.importProfileNotFound);
    expect(draft(t, admin.id, card.id, FILE)).toMatchObject({ prefilled: 'builtin', format: 'bofa_credit' });
    expect(() => importProfileOf(t, 999)).toThrow(SPEND_MESSAGES.cardNotFound);
  });

  it('saves a built-in import as Bank of America format, and lists an import from before 0015 as one too', () => {
    const { t, admin, card } = setup();
    addCsvImport(t, card.id);
    t.clock.advance(60_000);
    const p = draft(t, admin.id, card.id, FILE);
    commitImport(t, admin.id, p.id, [2]);
    t.clock.advance(60_000);
    const g = draft(t, admin.id, card.id, GENERIC);
    updateImport(t, admin.id, g.id, DEBIT_CREDIT);
    commitImport(t, admin.id, g.id, [2]);
    expect(listImports(t, card.id).map((i) => i.format)).toEqual(['custom', 'bofa_credit', 'bofa_credit']);
    expect(t.db.select().from(csvImports).all().map((i) => i.format)).toEqual([null, 'bofa_credit', 'custom']);
  });

  it('treats a preview from before migration 0015 as expired', () => {
    const { t, admin, card } = setup();
    const now = t.clock.now();
    const id = 'A'.repeat(22);
    t.db.insert(csvImportPreviews).values({ id, userId: admin.id, cardId: card.id, fileName: null, fileSha256: '0'.repeat(64), rows: [], plan: null, createdAt: now, expiresAt: new Date(now.getTime() + PREVIEW_TTL_MS) }).run();
    expect(() => commitImport(t, admin.id, id, [2])).toThrow(SPEND_MESSAGES.importNotFound);
    expect(() => updateImport(t, admin.id, id, DEBIT_CREDIT)).toThrow(SPEND_MESSAGES.importNotFound);
  });
});

describe('CSV import: the columns step over HTTP', () => {
  const put = (t: TestApp, cookie: string | undefined, id: string, body: unknown, opts: { csrf?: boolean } = {}) => call(t.app, 'PUT', `${P}/imports/${id}`, { cookie, body, ...opts });
  const profilePath = (cardId: number | string) => `${P}/cards/${cardId}/import-profile`;

  it("is for admins with the Spend panel, behind the CSRF check, and a draft is its uploader's", async () => {
    const { t, admin, card } = setup();
    const member = spendUser(t, { role: 'member' });
    const otherAdmin = cookieFor(t.db, t.clock, addUser(t.db, t.clock, { email: 'a2@example.com', role: 'admin', panels: ['todo'] }));
    const other = spendUser(t, { role: 'admin', email: 'other@example.com' });
    const { id } = await json<ImportPreview>(await upload(t, admin.cookie, card.id, GENERIC), 201);
    expect((await put(t, undefined, id, { mapping: DEBIT_CREDIT })).status).toBe(401);
    for (const cookie of [member.cookie, otherAdmin]) {
      expect((await put(t, cookie, id, { mapping: DEBIT_CREDIT })).status).toBe(403);
      expect((await call(t.app, 'GET', profilePath(card.id), { cookie })).status).toBe(403);
      expect((await call(t.app, 'DELETE', profilePath(card.id), { cookie })).status).toBe(403);
    }
    expect((await put(t, admin.cookie, id, { mapping: DEBIT_CREDIT }, { csrf: false })).status).toBe(403);
    expect((await call(t.app, 'DELETE', profilePath(card.id), { cookie: admin.cookie, csrf: false })).status).toBe(403);
    expect(await json(await put(t, other.cookie, id, { mapping: DEBIT_CREDIT }), 404)).toEqual({ error: { code: 'not_found', message: SPEND_MESSAGES.importNotFound } });
    expect((await put(t, admin.cookie, 'not-an-id', { mapping: DEBIT_CREDIT })).status).toBe(404);
    expect(t.db.select().from(csvImportPreviews).get()!.plan!.mapping).toBeNull();
  });

  it("answers the preview for columns that read the file and a plain message for columns that don't; Import saves them, and they can be read and cleared", async () => {
    const { t, admin, card } = setup();
    const { id } = await json<ImportPreview>(await upload(t, admin.cookie, card.id, GENERIC), 201);
    expect(await json(await put(t, admin.cookie, id, { mapping: { ...DEBIT_CREDIT, date: { column: 0, format: 'mdy' } } }), 400)).toEqual({
      error: { code: 'validation', message: SPEND_MESSAGES.importBadDate(2, 'M/D/YYYY') },
    });
    expect(await json(await put(t, admin.cookie, id, { mapping: { ...DEBIT_CREDIT, description: -1 } }), 400)).toEqual({ error: { code: 'validation', message: 'Choose a column.' } });
    expect((await put(t, admin.cookie, id, {})).status).toBe(400);
    const preview = await json<ImportPreview>(await put(t, admin.cookie, id, { mapping: DEBIT_CREDIT }));
    expect(preview).toMatchObject({ step: 'preview', mapping: DEBIT_CREDIT });
    expect(await json(await call(t.app, 'POST', `${P}/imports/${id}/commit`, { cookie: admin.cookie, body: { include: startsTicked(preview.rows) } }))).toEqual({ imported: 6, skipped: 0 });

    const saved = await json<{ profile: unknown }>(await call(t.app, 'GET', profilePath(card.id), { cookie: admin.cookie }));
    expect(saved).toEqual({
      profile: { cardId: card.id, format: 'custom', header: ['Transaction Date', 'Description', 'Category', 'Debit', 'Credit'], mapping: DEBIT_CREDIT, updatedAt: t.clock.now().toISOString(), updatedBy: 'admin' },
    });
    expect((await call(t.app, 'DELETE', profilePath(card.id), { cookie: admin.cookie })).status).toBe(204);
    expect(await json(await call(t.app, 'GET', profilePath(card.id), { cookie: admin.cookie }))).toEqual({ profile: null });
    expect(await json(await call(t.app, 'DELETE', profilePath(card.id), { cookie: admin.cookie }), 404)).toEqual({ error: { code: 'not_found', message: SPEND_MESSAGES.importProfileNotFound } });
    expect((await call(t.app, 'GET', profilePath(999), { cookie: admin.cookie })).status).toBe(404);
    expect((await call(t.app, 'GET', profilePath('abc'), { cookie: admin.cookie })).status).toBe(404);
  });

  it('refuses columns for a draft that expired, or a card archived since the upload', async () => {
    const { t, admin, card } = setup();
    const first = await json<ImportPreview>(await upload(t, admin.cookie, card.id, GENERIC), 201);
    await call(t.app, 'POST', `${P}/cards/${card.id}/archive`, { cookie: admin.cookie });
    expect(await json(await put(t, admin.cookie, first.id, { mapping: DEBIT_CREDIT }), 400)).toEqual({ error: { code: 'validation', message: SPEND_MESSAGES.cardArchived } });
    await call(t.app, 'POST', `${P}/cards/${card.id}/unarchive`, { cookie: admin.cookie });
    t.clock.advance(PREVIEW_TTL_MS);
    expect((await put(t, admin.cookie, first.id, { mapping: DEBIT_CREDIT })).status).toBe(404);
  });

  it('refuses a columns body over 64 KB', async () => {
    const { t, admin, card } = setup();
    const { id } = await json<ImportPreview>(await upload(t, admin.cookie, card.id, GENERIC), 201);
    expect(await json(await put(t, admin.cookie, id, { mapping: DEBIT_CREDIT, padding: 'x'.repeat(70_000) }), 413)).toEqual({ error: { code: 'validation', message: SPEND_MESSAGES.batchTooBig } });
  });

  it('takes 20 uploads a minute per admin, as before, and the columns step is not counted', async () => {
    const { t, admin, card } = setup();
    for (let n = 0; n < 19; n++) expect((await upload(t, admin.cookie, card.id, FILE)).status).toBe(201);
    const { id } = await json<ImportPreview>(await upload(t, admin.cookie, card.id, GENERIC), 201);
    for (let n = 0; n < 3; n++) expect((await put(t, admin.cookie, id, { mapping: DEBIT_CREDIT })).status).toBe(200);
    expect((await upload(t, admin.cookie, card.id, FILE)).status).toBe(429);
    t.clock.advance(60_000);
    expect((await upload(t, admin.cookie, card.id, FILE)).status).toBe(201);
  });
});

describe('CSV import: files without a reference number (the generic import design)', () => {
  /** Uploads `text` for the card, maps it as Debit and Credit unless saved columns did, and saves the rows that start ticked. */
  function importGeneric(t: TestApp, userId: number, cardId: number, text: string): ImportResult {
    const p = draft(t, userId, cardId, text);
    const read = p.step === 'columns' ? updateImport(t, userId, p.id, DEBIT_CREDIT) : p;
    return commitImport(t, userId, p.id, startsTicked(read.rows));
  }

  it('re-importing an overlapping file adds only the rows not there yet, identical same-day rows included', () => {
    const { t, admin, card } = setup();
    expect(importGeneric(t, admin.id, card.id, debitCreditCsv(DEBIT_CREDIT_SAMPLE.slice(0, 3)))).toEqual({ imported: 3, skipped: 0 });
    // The second identical coffee on the 15th is new; the first is already here.
    const later = draft(t, admin.id, card.id, GENERIC);
    expect(later.rows.map((r) => [r.line, r.status])).toEqual([[2, 'already_imported'], [3, 'already_imported'], [4, 'already_imported'], [5, 'new'], [6, 'new'], [7, 'new']]);
    expect(commitImport(t, admin.id, later.id, startsTicked(later.rows))).toEqual({ imported: 3, skipped: 3 });
    const stored = t.db.select().from(transactions).all();
    expect(stored).toHaveLength(6);
    expect(stored.every((r) => isRowKey(r.csvReference))).toBe(true);
    expect(new Set(stored.map((r) => r.csvReference)).size).toBe(6);
    expect(draft(t, admin.id, card.id, GENERIC).rows.every((r) => r.status === 'already_imported')).toBe(true);
  });

  it("tests a key-only row as one without a reference number: it's a likely duplicate of a stored row that has one", () => {
    const { t, admin, card } = setup();
    const book = addTransaction(t, card.id, { date: '2026-10-14', amountCents: 102499, rawName: 'BOOK NOOK', csvReference: reference(30, 1) });
    const p = draft(t, admin.id, card.id, GENERIC);
    const read = updateImport(t, admin.id, p.id, DEBIT_CREDIT);
    expect(read.rows[1]).toMatchObject({ line: 3, status: 'duplicate', reason: null, duplicateOf: { id: book.id } });
  });

  it("tests a stored key-only row the same way: a Bank of America row is its likely duplicate, not a possible one", () => {
    const { t, admin, card } = setup();
    const keyed = addTransaction(t, card.id, { date: '2026-11-02', amountCents: 1274, rawName: 'BLUE BOTTLE COFFEE', csvReference: rowKey(card.id, '2026-11-02', 1274, 'BLUE BOTTLE COFFEE', 0) });
    const p = draft(t, admin.id, card.id, bofaCsv([coffee]));
    expect(p.rows[0]).toMatchObject({ status: 'duplicate', reason: null, duplicateOf: { id: keyed.id } });
  });

  it('keeps a key-only row removed as a duplicate skipped on re-import, also after its import is undone', async () => {
    const { t, admin, card } = setup();
    const file = debitCreditCsv(DEBIT_CREDIT_SAMPLE.slice(0, 3));
    importGeneric(t, admin.id, card.id, file);
    const [imp] = t.db.select().from(csvImports).all();
    const csvBook = t.db.select().from(transactions).all().find((r) => r.date === '2026-10-14')!;
    // The bank's copy arrives; the admin removes the CSV row as its duplicate. (The book, not a
    // coffee: a Plaid coffee would also be a likely duplicate of the coffee two days later.)
    addTransaction(t, card.id, { source: 'plaid', plaidTransactionId: 'p-synthetic-1', date: '2026-10-14', amountCents: 102499, merchant: 'Book Nook', rawName: 'BOOK NOOK' });
    expect((await call(t.app, 'POST', `${P}/transactions/${csvBook.id}/remove-duplicate`, { cookie: admin.cookie })).status).toBe(200);
    expect(draft(t, admin.id, card.id, file).rows[1]!.status).toBe('already_imported');
    // Undo deletes the two live rows and keeps the removed one, holding its key.
    expect(await json(await call(t.app, 'DELETE', `${P}/cards/${card.id}/imports/${imp!.id}`, { cookie: admin.cookie }))).toEqual({ removed: 2 });
    expect(t.db.select().from(transactions).where(eq(transactions.id, csvBook.id)).get()).toMatchObject({ deletedReason: 'duplicate', csvImportId: null, csvReference: csvBook.csvReference });
    expect(draft(t, admin.id, card.id, file).rows.map((r) => r.status)).toEqual(['new', 'already_imported', 'new']);
  });
});

describe('CSV import: saved columns and the built-in format (the Batch B review)', () => {
  // Saved for a Bank of America header, but day first: every day in FILE fits that too (2, 3, 5, 6 November read as 11 February and on).
  const DAY_FIRST: CardMapping = { ...BOFA_FORMAT.mapping, date: { column: 0, format: 'dmy' } };
  const saveDayFirst = (t: TestApp, userId: number, cardId: number) => {
    const p = draft(t, userId, cardId, FILE);
    updateImport(t, userId, p.id, DAY_FIRST);
    commitImport(t, userId, p.id, [2]);
  };
  // 15 November: not a day-first date, so the saved columns don't fit.
  const LATER = bofaCsv([{ ...coffee, date: '11/15/2026', reference: reference(7, 20) }]);

  it("uses Bank of America's format when the saved columns don't fit its file, says so, and keeps the saved columns at Import", () => {
    const { t, admin, card } = setup();
    saveDayFirst(t, admin.id, card.id);
    const p = draft(t, admin.id, card.id, LATER);
    expect(p).toMatchObject({ step: 'preview', prefilled: 'builtin', format: 'bofa_credit', mapping: BOFA_FORMAT.mapping, columns: { problem: SPEND_MESSAGES.importSavedNotUsed } });
    expect(p.rows[0]).toMatchObject({ status: 'new', date: '2026-11-15' });
    commitImport(t, admin.id, p.id, [2]);
    expect(t.db.select().from(csvImports).all().at(-1)).toMatchObject({ format: 'bofa_credit' });
    expect(importProfileOf(t, card.id)).toMatchObject({ format: 'custom', mapping: DAY_FIRST });
  });

  it('replaces the saved columns once the admin chooses columns, the built-in ones included', () => {
    const { t, admin, card } = setup();
    saveDayFirst(t, admin.id, card.id);
    const p = draft(t, admin.id, card.id, LATER);
    const chosen = updateImport(t, admin.id, p.id, BOFA_FORMAT.mapping);
    expect(chosen).toMatchObject({ prefilled: 'builtin', format: 'bofa_credit', columns: { problem: null } });
    commitImport(t, admin.id, p.id, [2]);
    expect(importProfileOf(t, card.id)).toMatchObject({ format: 'bofa_credit', mapping: BOFA_FORMAT.mapping });
  });

  it("takes Bank of America's own columns back at PUT with its odd rows listed, as at upload, and records the import as its format", () => {
    const { t, admin, card } = setup();
    const odd = bofaCsv([coffee, { ...netflix, date: '13/01/2026' }]);
    const p = draft(t, admin.id, card.id, odd);
    expect(p.rows.map((r) => r.status)).toEqual(['new', 'unreadable']);
    // A cell-level check would refuse line 3's date; the built-in format lists it instead.
    const back = updateImport(t, admin.id, p.id, BOFA_FORMAT.mapping);
    expect(back).toMatchObject({ step: 'preview', format: 'bofa_credit' });
    expect(back.rows.map((r) => [r.line, r.status])).toEqual([[2, 'new'], [3, 'unreadable']]);
    commitImport(t, admin.id, p.id, [2]);
    expect(t.db.select().from(csvImports).get()).toMatchObject({ format: 'bofa_credit' });
    // Other columns still get the check.
    const again = draft(t, admin.id, card.id, odd);
    // The saved columns are Bank of America's own, so they apply as the built-in format does: no note that they didn't fit.
    expect(again).toMatchObject({ prefilled: 'profile', format: 'bofa_credit', columns: { problem: null } });
    expect(again.rows.map((r) => r.status)).toEqual(['already_imported', 'unreadable']);
    expect(() => updateImport(t, admin.id, again.id, { ...BOFA_FORMAT.mapping, amount: { kind: 'signed', column: 4, purchasesNegative: false } })).toThrow(SPEND_MESSAGES.importBadDate(3, 'M/D/YYYY'));
  });

  it("reads a later Bank of America file with an odd row with the saved Bank of America columns, without saying they didn't fit", () => {
    const { t, admin, card } = setup();
    const first = draft(t, admin.id, card.id, FILE);
    commitImport(t, admin.id, first.id, [2]);
    expect(importProfileOf(t, card.id)).toMatchObject({ format: 'bofa_credit' });
    const later = draft(t, admin.id, card.id, bofaCsv([{ ...coffee, reference: reference(7, 30) }, { ...netflix, reference: reference(7, 31), date: '13/01/2026' }]));
    expect(later).toMatchObject({ step: 'preview', prefilled: 'profile', format: 'bofa_credit', columns: { problem: null } });
    expect(later.rows.map((r) => [r.line, r.status])).toEqual([[2, 'new'], [3, 'unreadable']]);
  });

  it('opens the columns step, with why, when the saved columns fit the header but read no row', () => {
    const { t, admin, card } = setup();
    const first = draft(t, admin.id, card.id, GENERIC);
    updateImport(t, admin.id, first.id, DEBIT_CREDIT);
    commitImport(t, admin.id, first.id, [2]);
    // Every row's description is empty: the dates and amounts read, but nothing can be imported.
    const p = draft(t, admin.id, card.id, debitCreditCsv([{ date: '13/10/2026', description: '', debit: '4.50' }, { date: '14/10/2026', description: '', debit: '5.00' }]));
    expect(p).toMatchObject({ step: 'columns', prefilled: 'profile', mapping: null, rows: [] });
    expect(p.columns).toMatchObject({ suggested: DEBIT_CREDIT, problem: SPEND_MESSAGES.importSavedDoesntFit(SPEND_MESSAGES.importSavedReadNothing) });
  });
});

describe('CSV import: the work a columns step costs (the final review)', () => {
  const put = (t: TestApp, cookie: string, id: string, body: unknown) => call(t.app, 'PUT', `${P}/imports/${id}`, { cookie, body });

  it("works out each column's date formats once, at upload, and answers every later step with them", () => {
    const { t, admin, card } = setup();
    const p = draft(t, admin.id, card.id, GENERIC);
    const stored = t.db.select().from(csvImportPreviews).get()!;
    expect(stored.plan!.dateFormats).toEqual(p.columns.dateFormats);
    expect(p.columns.dateFormats[0]).toEqual(['dmy']);
    // What PUT answers comes from the draft, not from reading every cell again.
    t.db.update(csvImportPreviews).set({ plan: { ...stored.plan!, dateFormats: stored.plan!.dateFormats!.map(() => ['ymd' as const]) } }).run();
    expect(updateImport(t, admin.id, p.id, DEBIT_CREDIT).columns.dateFormats[0]).toEqual(['ymd']);
  });

  it('works them out for a draft saved before they were kept', () => {
    const { t, admin, card } = setup();
    const p = draft(t, admin.id, card.id, GENERIC);
    const stored = t.db.select().from(csvImportPreviews).get()!;
    const { dateFormats: _gone, ...older } = stored.plan!;
    t.db.update(csvImportPreviews).set({ plan: older }).run();
    expect(updateImport(t, admin.id, p.id, DEBIT_CREDIT).columns.dateFormats[0]).toEqual(['dmy']);
  });

  it('takes 30 column choices a minute per admin, apart from the 20 uploads', async () => {
    const { t, admin, card } = setup();
    const { id } = await json<ImportPreview>(await upload(t, admin.cookie, card.id, GENERIC), 201);
    for (let n = 0; n < 30; n++) expect((await put(t, admin.cookie, id, { mapping: DEBIT_CREDIT })).status).toBe(200);
    expect((await put(t, admin.cookie, id, { mapping: DEBIT_CREDIT })).status).toBe(429);
    // Uploads have their own count.
    expect((await upload(t, admin.cookie, card.id, FILE)).status).toBe(201);
    t.clock.advance(60_000);
    const again = await json<ImportPreview>(await upload(t, admin.cookie, card.id, GENERIC), 201);
    expect((await put(t, admin.cookie, again.id, { mapping: DEBIT_CREDIT })).status).toBe(200);
  });
});
