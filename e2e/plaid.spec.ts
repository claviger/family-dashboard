import { devices, expect, test, type Locator, type Page, type Response, type TestInfo } from '@playwright/test';

/**
 * Banks through Plaid, end to end (spec §12.2, §12.3, the phase 6b design), against the fake Plaid
 * that playwright.config.ts starts on port 3103 (src/server/test/fakePlaidServer.ts; its controls
 * are listed in fakePlaidHttp.ts). The browser runs the real Link page, which loads the fake's
 * `link-initialize.js`; the tests act "at the bank" through the fake's `/__fake/*` controls.
 *
 * The fake's Items, like Spend's categories and rules, are shared by the whole run, so these run in
 * the `spend` project, one at a time, at both sizes. Every test is its own admin with its own
 * institution, account names, masks and cards (each carrying the test's stamp), names its Item to
 * the fake explicitly, and never assumes a bank list is empty. Everything is synthetic.
 */

const MUTATION_HEADERS = { 'x-requested-with': 'dashboard', origin: 'http://localhost:3100' };
/** The fake Plaid's controls, on the origin the app calls the API at. */
const FAKE_PLAID = 'http://127.0.0.1:3103';
/** What playwright.config.ts sets as PLAID_LINK_SCRIPT_URL and PLAID_API_BASE_URL. */
const LINK_SCRIPT_URL = 'http://localhost:3103/link/v2/stable/link-initialize.js';
const LINK_SCRIPT_ORIGIN = 'http://localhost:3103';
const PLAID_API_ORIGIN = 'http://127.0.0.1:3103';

async function signIn(page: Page, email: string) {
  await page.context().clearCookies();
  const res = await page.request.post('/auth/test-login', { data: { email }, headers: MUTATION_HEADERS });
  expect(res.status()).toBe(204);
}

function newStamp(info: TestInfo): string {
  return `${info.titlePath[1]}-${info.repeatEachIndex}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/** As in spend.spec.ts: a describe group can't set `defaultBrowserType`; both devices are Chromium. */
function size(device: (typeof devices)[string]) {
  const { defaultBrowserType: _browser, ...use } = device;
  return use;
}
const SIZES = [
  { name: 'desktop', use: size(devices['Desktop Chrome']) },
  { name: 'phone', use: size(devices['Pixel 7']) },
] as const;

/** A local date `days` from today, as the server's family time zone sees it (the test machine's zone). */
function localDay(days: number): Date {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d;
}
const pad = (n: number) => String(n).padStart(2, '0');
const mmddyyyy = (d: Date) => `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
/** Plaid's dates: YYYY-MM-DD. */
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const longDay = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** A closing day 10 days from now, so the current cycle began about 20 days ago and the last 5 days are in it. */
function closingDay(): number {
  return localDay(10).getDate();
}

/** Against the layout width, not `innerWidth`, which includes a vertical scrollbar (as in spend.spec.ts). */
async function noSidewaysScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

/**
 * No sideways scroll at 320 px, the narrowest phone, with what's open now, and `inside` (a dialog or
 * a bar) within the screen and not scrolling sideways itself; then back to the test's size (review C-M10).
 */
async function noSidewaysScrollAt320(page: Page, inside?: Locator) {
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 320, height: 800 });
  await noSidewaysScroll(page);
  if (inside) {
    expect(await inside.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return box.left >= 0 && box.right <= document.documentElement.clientWidth + 0.5 && el.scrollWidth <= el.clientWidth;
    })).toBe(true);
  }
  await page.setViewportSize(size);
}

/**
 * A last 4 no other test's card has: four letters or digits (a card's mask allows both). The pick
 * suggests the one card with an account's mask, so a mask shared with another test's card would
 * change what's suggested.
 */
function newMask(taken: Set<string>): string {
  for (;;) {
    const mask = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 34)]).join('');
    if (!taken.has(mask) && mask !== '1234') {
      taken.add(mask);
      return mask;
    }
  }
}

interface TestAccount {
  name: string;
  mask: string;
}
interface TestBank {
  name: string;
  institutionId: string;
  accounts: TestAccount[];
}

/** A bank of this test's own: its institution, and an account per kind, each named with the stamp. */
function testBank(stamp: string, kinds: readonly string[]): TestBank {
  const taken = new Set<string>();
  return {
    name: `Bank ${stamp}`,
    institutionId: `ins_e2e_${stamp}`,
    accounts: kinds.map((kind) => ({ name: `${kind} ${stamp}`, mask: newMask(taken) })),
  };
}

/** "Gold desktop-0-… ·AB12", as the pick and the bank list name an account (and cardName a card). */
const accountLabel = (a: TestAccount) => `${a.name} ·${a.mask}`;

/** A control of the fake Plaid: GET without data, POST with it. Fails the test on a refusal, with the fake's reason. */
async function fake<T = Record<string, unknown>>(page: Page, path: string, data?: Record<string, unknown>): Promise<T> {
  const url = `${FAKE_PLAID}/__fake/${path}`;
  const res = data === undefined ? await page.request.get(url) : await page.request.post(url, { data });
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as T;
}

interface FakeItemView {
  itemId: string;
  institution: { institution_id: string; name: string } | null;
  accounts: { account_id: string; name: string; mask: string | null }[];
  removed: boolean;
  webhook: string | null;
}

/** This test's Item at the fake, found by its own institution (never "the newest one"). */
async function fakeItem(page: Page, bank: TestBank): Promise<FakeItemView> {
  const { items } = await fake<{ items: FakeItemView[] }>(page, 'items');
  const mine = items.filter((i) => i.institution?.institution_id === bank.institutionId && !i.removed);
  expect(mine).toHaveLength(1);
  return mine[0]!;
}

/** A transaction at the bank, on one of this test's accounts. */
async function bankTransaction(page: Page, itemId: string, account: TestAccount, fields: Record<string, unknown>): Promise<{ transaction_id: string }> {
  return fake(page, 'transactions/add', { itemId, mask: account.mask, ...fields });
}

/**
 * A signed webhook to the Item's own webhook URL (the app's, from its link token); the app must
 * answer 200. Two with the same body in the same second are one delivery to the app's replay set
 * (review fix G1-I1), but a replayed sync webhook still asks for a sync, so they go out unspaced.
 */
async function webhook(page: Page, itemId: string, payload: Record<string, unknown>) {
  const { status } = await fake<{ status: number }>(page, 'webhook', { itemId, payload: { environment: 'sandbox', ...payload } });
  expect(status).toBe(200);
}

const SYNC_UPDATES = { webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', initial_update_complete: true, historical_update_complete: true };

/** How many /transactions/sync calls the fake has had for this Item (matched by its token inside the fake). */
async function syncCalls(page: Page, itemId: string): Promise<number> {
  return (await fake<{ count: number }>(page, `count?path=/transactions/sync&itemId=${encodeURIComponent(itemId)}`)).count;
}

/** A new admin with the Spend panel, signed in. Link and bank routes are limited per admin, and `--repeat-each` runs these back to back. */
async function signInAsNewAdmin(page: Page, stamp: string): Promise<string> {
  await signIn(page, 'admin@example.com');
  const email = `bank-admin-${stamp}@example.com`;
  const res = await page.request.post('/api/admin/users', {
    data: { email, displayName: `Bank admin ${stamp}`, color: '#378ADD', role: 'admin', panels: ['spend'] },
    headers: MUTATION_HEADERS,
  });
  expect(res.status()).toBe(201);
  await signIn(page, email);
  return email;
}

/** A card shown in Spend, through the API. */
async function createCard(page: Page, nickname: string, mask: string): Promise<{ id: number; nickname: string; mask: string }> {
  const res = await page.request.post('/api/panels/spend/cards', {
    data: { nickname, mask, included: true, usualClosingDay: closingDay() },
    headers: MUTATION_HEADERS,
  });
  expect(res.status()).toBe(201);
  return { ...((await res.json()) as { id: number }), nickname, mask };
}

/**
 * A SYNTHETIC Bank of America credit-card CSV (spend.spec.ts has the full one): purchases are
 * negative, the payment and the refund positive. Merchants carry the stamp. Totals: $1,237.79 in
 * this cycle (the payment isn't counted, the refund subtracts).
 */
async function importCsv(page: Page, card: { id: number; mask: string }, stamp: string) {
  const m = {
    coffee: `BLUE BOTTLE COFFEE ${stamp}`,
    groceries: `SAFEWAY #1234 ${stamp}`,
    netflix: `NETFLIX.COM ${stamp}`,
    payment: `PAYMENT - THANK YOU ${stamp}`,
    refund: `REI #12 ${stamp}`,
  };
  const ref = (n: number) => `${Date.now()}${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}${String(n).padStart(6, '0')}`;
  const line = (days: number, n: number, payee: string, address: string, amount: string) =>
    `${mmddyyyy(localDay(days))},${ref(n)},"${payee.padEnd(22)}","${address.padEnd(15)}",${amount.includes(',') ? `"${amount}"` : amount.padStart(10)}`;
  const text = [
    'Posted Date,Reference Number,Payee,Address,Amount',
    line(-5, 1, m.coffee, 'OAKLAND CA', '-12.74'),
    line(-4, 2, m.groceries, 'OAKLAND CA', '-1,234.56'),
    line(-3, 3, m.netflix, 'LOS GATOS CA', '-15.49'),
    line(-2, 4, m.payment, '', '500.00'),
    line(-1, 5, m.refund, 'BERKELEY CA', '25.00'),
  ].join('\r\n');
  const preview = await page.request.post('/api/panels/spend/imports', {
    multipart: { cardId: String(card.id), file: { name: `currentTransaction_${card.mask}.csv`, mimeType: 'text/csv', buffer: Buffer.from(`${text}\r\n`, 'utf8') } },
    headers: MUTATION_HEADERS,
  });
  expect(preview.status()).toBe(201);
  const { id } = (await preview.json()) as { id: string };
  const commit = await page.request.post(`/api/panels/spend/imports/${id}/commit`, { data: { include: [2, 3, 4, 5, 6] }, headers: MUTATION_HEADERS });
  expect(await commit.json()).toEqual({ imported: 5, skipped: 0 });
  return m;
}

interface OverviewRow {
  id: number;
  source: 'plaid' | 'csv';
  merchant: string;
  amountCents: number;
  pending: boolean;
  date: string;
  category: { name: string };
  note: string | null;
}

/** The card's transactions in its current cycle, as the overview answers them. */
async function cardRows(page: Page, cardId: number): Promise<OverviewRow[]> {
  const res = await page.request.get(`/api/panels/spend/overview?card=${cardId}`);
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { transactions: OverviewRow[] }).transactions;
}

interface BankApiView {
  id: number;
  institutionName: string | null;
  status: string;
  lastSyncAt: string | null;
  needsPick: boolean;
  accountsLoaded: boolean;
  newAccountsAt: string | null;
}

/** This test's bank in Spend's bank list, by its own name. */
async function bankView(page: Page, bank: TestBank): Promise<BankApiView> {
  const res = await page.request.get('/api/panels/spend/banks');
  expect(res.ok()).toBe(true);
  const mine = ((await res.json()) as { banks: BankApiView[] }).banks.filter((b) => b.institutionName === bank.name);
  expect(mine).toHaveLength(1);
  return mine[0]!;
}

const banksRegion = (page: Page) => page.getByRole('region', { name: 'Banks', exact: true });
/** The bank's row in the connected list: the list item with its heading (its accounts are list items too, without one). */
const bankRow = (page: Page, bank: TestBank) =>
  page.getByRole('list', { name: 'Connected banks' }).getByRole('listitem').filter({ has: page.getByRole('heading', { name: bank.name, exact: true }) });
/** A transaction's row: a table row at desktop sizes, a list item on a phone. */
const transactionRow = (page: Page, text: string) => page.getByRole('row').or(page.getByRole('listitem')).filter({ hasText: text });
const pickForm = (page: Page, bank: TestBank) => page.getByRole('form', { name: `Choose cards for ${bank.name}` });

/** A CSP header as directive name to its sources. */
function cspOf(header: string | null): Map<string, string[]> {
  expect(header).not.toBeNull();
  return new Map(
    header!.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
      const [name, ...sources] = d.split(/\s+/);
      return [name!, sources] as const;
    }),
  );
}

/**
 * The Link pages' relaxed CSP (the design's departure 4): Plaid's exact script, its iframe, and the
 * API. Their opener policy lets Link keep its handle on the bank's OAuth popup.
 */
function expectLinkCsp(res: Response | import('@playwright/test').APIResponse) {
  expect(res.headers()['cross-origin-opener-policy']).toBe('same-origin-allow-popups');
  const csp = cspOf(res.headers()['content-security-policy'] ?? null);
  expect(csp.get('script-src')).toEqual(["'self'", LINK_SCRIPT_URL]);
  expect(csp.get('frame-src')).toEqual([LINK_SCRIPT_ORIGIN]);
  expect(csp.get('connect-src')).toEqual(["'self'", PLAID_API_ORIGIN]);
  expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
  expect(csp.get('object-src')).toEqual(["'none'"]);
}

/** Every other page's strict CSP, nothing from Plaid, and the default opener policy. */
function expectStrictCsp(res: Response | import('@playwright/test').APIResponse) {
  expect(res.headers()['cross-origin-opener-policy']).toBe('same-origin');
  const csp = cspOf(res.headers()['content-security-policy'] ?? null);
  expect(csp.get('script-src')).toEqual(["'self'"]);
  expect(csp.get('connect-src')).toEqual(["'self'"]);
  expect(csp.get('default-src')).toEqual(["'self'"]);
  expect(csp.has('frame-src')).toBe(false);
  expect(csp.get('style-src')).toEqual(["'self'"]);
}

/**
 * Connect bank, through the Link page and the fake Link, as the signed-in admin: the next Link run
 * ends in a success with this bank's institution and accounts. Lands back in Spend settings with
 * the pick open and focused. Returns the Link page's response (for its headers) and the bank's ids.
 */
async function connectBank(page: Page, bank: TestBank) {
  await fake(page, 'link/next', {
    outcome: 'success',
    institution: { institution_id: bank.institutionId, name: bank.name },
    accounts: bank.accounts.map((a) => ({ name: a.name, mask: a.mask })),
  });
  await page.goto('/spend?tab=settings');
  const linkPage = page.waitForResponse((r) => new URL(r.url()).pathname === '/connect/plaid/link');
  await banksRegion(page).getByRole('link', { name: 'Connect bank', exact: true }).click();
  const linkResponse = await linkPage;
  // Back from Link: `?bank=` opened this bank's pick and focused it, then left the URL.
  const form = pickForm(page, bank);
  await expect(form.locator('legend')).toBeFocused();
  await expect(page).toHaveURL(/\/spend\?tab=settings$/);
  const item = await fakeItem(page, bank);
  const view = await bankView(page, bank);
  return { linkResponse, plaidItemId: item.itemId, bankId: view.id, item };
}

/** Each account's choice by its option's text, then Save; the status line says what was saved, then `then` when given. */
async function saveCards(page: Page, bank: TestBank, choices: readonly string[], saved: string, opts: { then?: string } = {}) {
  const form = pickForm(page, bank);
  for (const [i, a] of bank.accounts.entries()) await form.getByRole('combobox', { name: `Card for ${accountLabel(a)}` }).selectOption({ label: choices[i]! });
  await form.getByRole('button', { name: 'Save cards' }).click();
  await expect(banksRegion(page).getByRole('status')).toHaveText(`Saved the cards for ${bank.name}: ${saved}.${opts.then ? ` ${opts.then}` : ''}`);
  await expect(form).toHaveCount(0);
}

/**
 * Answers the page's next call to `pattern` with a gateway's 504 (not the app's own answer), while
 * the request still goes on to the server, sent by the test with the page's cookies (as a request
 * nginx gave up on would). The 504 comes at once, or with `afterServer` once the server has
 * answered. `landed` resolves with the server's own status.
 */
async function answerWith504(page: Page, pattern: string, opts: { afterServer?: boolean } = {}): Promise<{ landed: Promise<number> }> {
  let resolve!: (status: number) => void;
  const landed = new Promise<number>((r) => { resolve = r; });
  await page.route(pattern, async (route) => {
    const req = route.request();
    const sent = page.request.fetch(req.url(), { method: req.method(), headers: { ...MUTATION_HEADERS, 'content-type': 'application/json' }, data: req.postData() ?? undefined })
      .then((res) => resolve(res.status()), () => resolve(0));
    if (opts.afterServer) await sent;
    await route.fulfill({ status: 504, contentType: 'text/html', body: '<html><body><h1>504 Gateway Time-out</h1></body></html>' });
  }, { times: 1 });
  return { landed };
}

/** Records the next dialog's type and message, then accepts or dismisses it. Read `seen` after the action that opens it. */
function nextDialog(page: Page, answer: 'accept' | 'dismiss') {
  const seen: { type: string | null; message: string | null } = { type: null, message: null };
  page.once('dialog', (d) => {
    seen.type = d.type();
    seen.message = d.message();
    void (answer === 'accept' ? d.accept() : d.dismiss());
  });
  return seen;
}

/**
 * A new admin with a bank of this test's own, connected and picked onto a new Visa with the
 * account's last 4. `before` runs at the bank before the pick, so its transactions come in with
 * the first sync.
 */
async function linkedBank(page: Page, info: TestInfo, before?: (plaidItemId: string, account: TestAccount, stamp: string) => Promise<void>) {
  const stamp = newStamp(info);
  await signInAsNewAdmin(page, stamp);
  const bank = testBank(stamp, ['Gold']);
  const gold = bank.accounts[0]!;
  const visa = await createCard(page, `Visa ${stamp}`, gold.mask);
  const { plaidItemId, bankId } = await connectBank(page, bank);
  await before?.(plaidItemId, gold, stamp);
  await saveCards(page, bank, [`${visa.nickname} ·${visa.mask}`], '1 attached');
  return { stamp, bank, gold, visa, plaidItemId, bankId };
}

const banksHeading = (page: Page) => banksRegion(page).getByRole('heading', { name: 'Banks', exact: true });

// A test that failed before using what it queued (a Link result, a failure, a delay) mustn't leave it for the next one.
test.beforeEach(async ({ request }) => {
  const res = await request.post(`${FAKE_PLAID}/__fake/reset-queues`, { data: {} });
  expect(res.ok(), await res.text()).toBe(true);
});

for (const sized of SIZES) {
  test.describe(sized.name, () => {
    test.use(sized.use);
    // Long flows, one at a time beside the other projects' tests: more than the default 30 seconds.
    test.describe.configure({ timeout: 90_000 });

    test('an admin connects a bank through Plaid Link: a cancelled Link changes nothing, and the Link pages alone get the relaxed CSP and opener policy', async ({ page }, info) => {
      const stamp = newStamp(info);
      await signInAsNewAdmin(page, stamp);
      const bank = testBank(stamp, ['Gold']);

      // Leaving Link comes back with a plain message, focused, and no bank.
      await fake(page, 'link/next', { outcome: 'exit', error: null, status: 'choose_institution' });
      await page.goto('/spend?tab=settings');
      await banksRegion(page).getByRole('link', { name: 'Connect bank', exact: true }).click();
      const exited = banksRegion(page).getByRole('status').filter({ hasText: "The bank wasn't connected. Nothing changed." });
      await expect(exited).toBeFocused();
      await expect(page).toHaveURL(/\/spend\?tab=settings$/);
      const { items } = await fake<{ items: FakeItemView[] }>(page, 'items');
      expect(items.some((i) => i.institution?.institution_id === bank.institutionId)).toBe(false);

      // Now through to the end.
      const { linkResponse, item } = await connectBank(page, bank);
      expectLinkCsp(linkResponse);
      // A new Item, linked with the app's own webhook and OAuth return URLs.
      const sessions = await fake<{ mode: string; itemId: string | null; outcome: string; linkTokenRequest: Record<string, unknown> }[]>(page, 'link/sessions');
      const session = sessions.filter((s) => s.itemId === item.itemId);
      expect(session).toHaveLength(1);
      expect(session[0]).toMatchObject({ mode: 'new', outcome: 'success' });
      expect(session[0]!.linkTokenRequest).toMatchObject({
        client_name: 'Family Dashboard',
        webhook: 'http://localhost:3100/webhooks/plaid',
        redirect_uri: 'http://localhost:3100/connect/plaid/oauth-return',
      });
      expect(item.webhook).toBe('http://localhost:3100/webhooks/plaid');

      // The bank waits for its cards; Cancel leaves it waiting, with a notice, and focus on Choose cards.
      const row = bankRow(page, bank);
      await expect(row).toContainText('Waiting for you to choose cards');
      await expect(row.getByRole('list', { name: `Accounts at ${bank.name}` })).toHaveText(`${accountLabel(bank.accounts[0]!)}: Waiting for a card`);
      await noSidewaysScroll(page);
      await pickForm(page, bank).getByRole('button', { name: 'Cancel' }).click();
      await expect(pickForm(page, bank)).toHaveCount(0);
      await expect(row.getByRole('button', { name: `Choose cards for ${bank.name}`, exact: true })).toBeFocused();
      await expect(row).toContainText("Choose cards for this bank's accounts. It isn't synced until you do.");
      // Nothing to refresh before the first pick (review G4-M4).
      await expect(row.getByRole('button', { name: `Refresh ${bank.name}`, exact: true })).toHaveCount(0);
      await expect(banksRegion(page)).toContainText(/\d+ of \d+ Plaid Trial connections used\. Removed banks still count\./);

      // Admin Integrations lists it and points at Spend settings.
      await page.goto('/admin');
      await expect(page.getByRole('list', { name: 'Bank connections' }).getByRole('listitem').filter({ hasText: bank.name })).toHaveText(
        // The exchange reached Plaid, but nothing is synced until the pick (review C-M9).
        `${bank.name}: waiting for cards`,
      );
      await page.getByRole('link', { name: 'Manage banks in Spend settings' }).click();
      await expect(page).toHaveURL(/\/spend\?tab=settings$/);
      await expect(bankRow(page, bank)).toBeVisible();

      // The two Link pages carry the relaxed CSP and the popup-friendly opener policy (the return page
      // too, which needs no link in progress to be served); Spend, the API, a 404 and the app's other
      // pages keep the strict ones.
      expectLinkCsp(await page.request.get('/connect/plaid/link'));
      expectLinkCsp(await page.request.get('/connect/plaid/oauth-return'));
      expectLinkCsp(await page.request.get(`/connect/plaid/link?item=${(await bankView(page, bank)).id}`));
      expectStrictCsp((await page.goto('/spend?tab=settings'))!);
      expectStrictCsp(await page.request.get('/api/panels/spend/banks'));
      expectStrictCsp(await page.request.get('/connect/plaid/nowhere'));
      expectStrictCsp(await page.request.get('/'));

      await page.setViewportSize({ width: 320, height: 800 });
      await noSidewaysScroll(page);
      // The category mapping, opened (only looked at: mappings are the family's, shared by every test).
      const mapping = page.getByRole('region', { name: 'Bank categories', exact: true });
      await mapping.locator('summary').click();
      await expect(mapping.getByRole('combobox', { name: 'Category for Food and drink', exact: true })).toBeVisible();
      // One Save for the whole editor (review G4-I3): nothing to save until a code is changed.
      await expect(mapping.getByRole('region', { name: 'Unsaved bank category changes' })).toHaveCount(0);
      await expect(mapping.getByRole('button', { name: /^Save/ })).toHaveCount(0);
      await noSidewaysScroll(page);
    });

    test("a bank whose accounts couldn't be fetched right after linking offers Load accounts, which opens the pick", async ({ page }, info) => {
      const stamp = newStamp(info);
      await signInAsNewAdmin(page, stamp);
      const bank = testBank(stamp, ['Gold']);
      const gold = bank.accounts[0]!;
      const visa = await createCard(page, `Visa ${stamp}`, gold.mask);
      const visaName = `${visa.nickname} ·${visa.mask}`;

      // Right after the exchange, /accounts/get fails in passing, its retries too: the bank is kept, without its accounts.
      for (let i = 0; i < 3; i++) await fake(page, 'fail', { path: '/accounts/get', error: 'INSTITUTION_DOWN' });
      await fake(page, 'link/next', {
        outcome: 'success',
        institution: { institution_id: bank.institutionId, name: bank.name },
        accounts: bank.accounts.map((a) => ({ name: a.name, mask: a.mask })),
      });
      await page.goto('/spend?tab=settings');
      await banksRegion(page).getByRole('link', { name: 'Connect bank', exact: true }).click();

      // Back in Spend settings: no pick yet, and focus on Load accounts.
      const row = bankRow(page, bank);
      const load = row.getByRole('button', { name: `Load accounts from ${bank.name}`, exact: true });
      await expect(load).toBeFocused();
      await expect(page).toHaveURL(/\/spend\?tab=settings$/);
      await expect(row).toContainText(`The dashboard couldn't get the list of accounts from ${bank.name} yet. Load them, then choose cards.`);
      await expect(row.getByRole('button', { name: `Choose cards for ${bank.name}`, exact: true })).toHaveCount(0);
      await expect(pickForm(page, bank)).toHaveCount(0);
      expect(await bankView(page, bank)).toMatchObject({ accountsLoaded: false, needsPick: true });
      await noSidewaysScroll(page);

      // Connecting another bank now asks to load these accounts first: the duplicate check can't see a
      // second link of this login without them (review C-S-M3). The next press goes on to Link.
      const connect = banksRegion(page).getByRole('link', { name: 'Connect bank', exact: true });
      await connect.click();
      await expect(banksRegion(page).getByRole('alert')).toHaveText(
        `Load the accounts for ${bank.name} first, so the dashboard can tell if you're linking the same login twice. To connect a bank anyway, press Connect bank again.`,
      );
      await expect(page).toHaveURL(/\/spend\?tab=settings$/);
      await noSidewaysScroll(page);
      await fake(page, 'link/next', { outcome: 'exit', error: null, status: 'choose_institution' });
      await connect.click();
      await expect(banksRegion(page).getByRole('status').filter({ hasText: "The bank wasn't connected. Nothing changed." })).toBeFocused();
      await page.goto('/spend?tab=settings');

      // Load accounts fetches them, and the pick opens with the matching card suggested.
      await load.click();
      await expect(banksRegion(page).getByRole('status')).toHaveText(`Loaded the accounts from ${bank.name}. Choose a card for the new account.`);
      const form = pickForm(page, bank);
      await expect(form.locator('legend')).toBeFocused();
      await expect(form.getByRole('combobox', { name: `Card for ${accountLabel(gold)}` }).locator('option:checked')).toHaveText(visaName);
      await saveCards(page, bank, [visaName], '1 attached');
      await expect(row.getByRole('list', { name: `Accounts at ${bank.name}` })).toHaveText(`${accountLabel(gold)}: on ${visaName}`);
      expect(await bankView(page, bank)).toMatchObject({ accountsLoaded: true, needsPick: false });
    });

    test('an admin picks a card for each account: one goes on an existing card, one makes a new card, one is skipped', async ({ page }, info) => {
      const stamp = newStamp(info);
      await signInAsNewAdmin(page, stamp);
      const bank = testBank(stamp, ['Gold', 'Cash', 'Travel']);
      const [gold, cash, travel] = bank.accounts as [TestAccount, TestAccount, TestAccount];
      // The existing card has Gold's last 4, so the pick suggests it.
      const visa = await createCard(page, `Visa ${stamp}`, gold.mask);
      const visaName = `${visa.nickname} ·${visa.mask}`;

      const { plaidItemId } = await connectBank(page, bank);
      const form = pickForm(page, bank);
      const goldSelect = form.getByRole('combobox', { name: `Card for ${accountLabel(gold)}` });
      const cashSelect = form.getByRole('combobox', { name: `Card for ${accountLabel(cash)}` });
      await expect(goldSelect.locator('option:checked')).toHaveText(visaName);
      await expect(cashSelect.locator('option:checked')).toHaveText('Choose a card');
      await expect(cashSelect.getByRole('option')).toContainText(['Choose a card', 'New card', 'Skip this account']);
      await noSidewaysScroll(page);
      await noSidewaysScrollAt320(page, form);

      // An undecided account: said, and its select gets the focus.
      await form.getByRole('button', { name: 'Save cards' }).click();
      await expect(form.getByRole('alert')).toHaveText('Choose a card, a new card, or Skip for every account before saving.');
      await expect(cashSelect).toBeFocused();
      // One card can't take two accounts.
      await cashSelect.selectOption({ label: visaName });
      await form.getByRole('combobox', { name: `Card for ${accountLabel(travel)}` }).selectOption({ label: 'Skip this account' });
      await form.getByRole('button', { name: 'Save cards' }).click();
      await expect(form.getByRole('alert')).toHaveText('Each card can take only one bank account.');
      await expect(cashSelect).toBeFocused();

      // A bank transaction on each account: only the attached and new cards' are kept.
      await bankTransaction(page, plaidItemId, gold, { name: `GOLD SHOP ${stamp}`, amount: 21.5, date: isoDay(localDay(-2)) });
      await bankTransaction(page, plaidItemId, cash, { name: `CASH SHOP ${stamp}`, amount: 7.25, date: isoDay(localDay(-2)) });
      await bankTransaction(page, plaidItemId, travel, { name: `TRAVEL SHOP ${stamp}`, amount: 300, date: isoDay(localDay(-2)) });
      await saveCards(page, bank, [visaName, 'New card', 'Skip this account'], '1 attached, 1 new card, 1 skipped');

      // The bank synced at once, and lists each account where it went. Focus is on the bank.
      const row = bankRow(page, bank);
      await expect(row.getByRole('heading', { name: bank.name })).toBeFocused();
      await expect(row).toContainText(/Synced (just now|\d+ (second|minute)s? ago)/);
      await expect(row.getByRole('list', { name: `Accounts at ${bank.name}` }).getByRole('listitem')).toHaveText([
        `${accountLabel(gold)}: on ${visaName}`,
        `${accountLabel(cash)}: on ${accountLabel(cash)}`,
        `${accountLabel(travel)}: Skipped, not tracked`,
      ]);
      // The skipped account can still be put on a card later.
      await expect(row.getByRole('button', { name: `Choose cards for ${bank.name}`, exact: true })).toBeVisible();

      // The new card is named from Plaid's account name, with the last 4 beside it, and starts hidden from Spend.
      const cards = page.getByRole('region', { name: 'Cards', exact: true });
      const newCard = cards.getByRole('listitem').filter({ hasText: accountLabel(cash) });
      await expect(newCard).toContainText('Not shown');
      await expect(newCard).toContainText('1 transaction · connected to a bank');
      await expect(cards.getByRole('listitem').filter({ hasText: visaName })).toContainText('1 transaction · connected to a bank');

      // The existing card shows its bank transaction; nothing from the skipped account was saved.
      await page.goto(`/spend?card=${visa.id}`);
      await expect(page.getByRole('combobox', { name: `Category for GOLD SHOP ${stamp}, ${longDay(localDay(-2))}, $21.50` })).toBeVisible();
      const res = await page.request.get('/api/panels/spend/cards');
      const all = (await res.json()) as { nickname: string; mask: string | null }[];
      expect(all.some((c) => c.mask === travel.mask)).toBe(false);
      await noSidewaysScroll(page);
    });

    test("the first sync brings in the bank's transactions and they replace the CSV rows they match, keeping what was set by hand", async ({ page }, info) => {
      const stamp = newStamp(info);
      await signInAsNewAdmin(page, stamp);
      const bank = testBank(stamp, ['Gold']);
      const gold = bank.accounts[0]!;
      const visa = await createCard(page, `Visa ${stamp}`, gold.mask);
      const csv = await importCsv(page, visa, stamp);
      const day = (n: number) => longDay(localDay(n));

      // The CSV coffee gets a category and a note by hand.
      const categories = (await (await page.request.get('/api/panels/spend/categories')).json()) as { id: number; name: string }[];
      const groceries = categories.find((c) => c.name === 'Groceries')!;
      const coffeeCsv = (await cardRows(page, visa.id)).find((r) => r.merchant === csv.coffee)!;
      const patched = await page.request.patch(`/api/panels/spend/transactions/${coffeeCsv.id}`, {
        data: { categoryId: groceries.id, note: `Beans ${stamp}` },
        headers: MUTATION_HEADERS,
      });
      expect(patched.ok()).toBe(true);

      const { plaidItemId } = await connectBank(page, bank);
      // At the bank: the same coffee (Plaid's merchant name and description, not the CSV's text),
      // a purchase the CSV doesn't have, and one still pending.
      const coffee = `Blue Bottle Coffee ${stamp}`;
      await bankTransaction(page, plaidItemId, gold, {
        merchant_name: coffee, name: `BLUE BOTTLE COFFEE ${stamp} OAKLAND CA`, amount: 12.74, date: isoDay(localDay(-5)),
      });
      await bankTransaction(page, plaidItemId, gold, {
        merchant_name: `Trader Joe's ${stamp}`, name: `TRADER JOE S #123 ${stamp}`, amount: 45, date: isoDay(localDay(-3)),
        personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_GROCERIES', confidence_level: 'VERY_HIGH', version: 'v2' },
      });
      await bankTransaction(page, plaidItemId, gold, { merchant_name: `Corner Gas ${stamp}`, name: `CORNER GAS ${stamp}`, amount: 30, date: isoDay(localDay(-1)), pending: true });
      await saveCards(page, bank, [`${visa.nickname} ·${visa.mask}`], '1 attached');

      // The coffee is the bank's row now, once, with the category and note set by hand; the CSV row is gone.
      const rows = await cardRows(page, visa.id);
      expect(rows.filter((r) => r.merchant === csv.coffee)).toEqual([]);
      expect(rows.filter((r) => r.merchant === coffee)).toEqual([
        expect.objectContaining({ source: 'plaid', amountCents: 1274, category: expect.objectContaining({ name: 'Groceries' }), note: `Beans ${stamp}` }),
      ]);
      // The CSV rows the bank doesn't have stay.
      expect(rows.filter((r) => r.source === 'csv').map((r) => r.merchant).sort()).toEqual([csv.groceries, csv.netflix, csv.payment, csv.refund].sort());

      await page.goto(`/spend?card=${visa.id}`);
      const coffeeRow = page.getByRole('combobox', { name: `Category for ${coffee}, ${day(-5)}, $12.74` });
      await expect(coffeeRow.locator('option:checked')).toHaveText('Groceries');
      await expect(coffeeRow).toHaveAccessibleDescription('Set by hand');
      await expect(page.getByText(`Beans ${stamp}`)).toBeVisible();
      await expect(page.getByRole('combobox', { name: new RegExp(`^Category for ${csv.coffee}`) })).toHaveCount(0);
      // Plaid's category, through the mapping.
      await expect(page.getByRole('combobox', { name: `Category for Trader Joe's ${stamp}, ${day(-3)}, $45.00` }).locator('option:checked')).toHaveText('Groceries');
      await expect(transactionRow(page, `Corner Gas ${stamp}`)).toContainText('Pending');
      // The CSV's $1,237.79, plus Trader Joe's and the pending gas.
      const totals = page.getByRole('region', { name: /to .*\d{4}$/ });
      await expect(totals.getByText('$1,312.79')).toBeVisible();
      await noSidewaysScroll(page);

      // The home card says the card was just updated.
      await page.goto('/');
      await expect(page.getByRole('region', { name: 'Spend' }).getByRole('listitem').filter({ hasText: visa.nickname })).toContainText(
        /Updated (just now|\d+ (second|minute)s? ago)/,
      );
    });

    test('a webhook from Plaid drives a sync: new, posted and removed transactions show up without a Refresh', async ({ page }, info) => {
      const stamp = newStamp(info);
      await signInAsNewAdmin(page, stamp);
      const bank = testBank(stamp, ['Gold']);
      const gold = bank.accounts[0]!;
      const visa = await createCard(page, `Visa ${stamp}`, gold.mask);
      const { plaidItemId } = await connectBank(page, bank);
      await saveCards(page, bank, [`${visa.nickname} ·${visa.mask}`], '1 attached');
      expect(await cardRows(page, visa.id)).toEqual([]);

      // New transactions at the bank, and Plaid says so.
      const bakery = `Corner Bakery ${stamp}`;
      const gas = `Corner Gas ${stamp}`;
      await bankTransaction(page, plaidItemId, gold, { merchant_name: bakery, name: bakery.toUpperCase(), amount: 8.5, date: isoDay(localDay(-2)) });
      const pending = await bankTransaction(page, plaidItemId, gold, { merchant_name: gas, name: gas.toUpperCase(), amount: 30, date: isoDay(localDay(-1)), pending: true });
      await webhook(page, plaidItemId, SYNC_UPDATES);
      await expect.poll(async () => (await cardRows(page, visa.id)).map((r) => `${r.merchant} ${r.amountCents}${r.pending ? ' pending' : ''}`).sort()).toEqual(
        [`${bakery} 850`, `${gas} 3000 pending`].sort(),
      );
      await page.goto(`/spend?card=${visa.id}`);
      await expect(page.getByRole('combobox', { name: `Category for ${bakery}, ${longDay(localDay(-2))}, $8.50` })).toBeVisible();
      await expect(transactionRow(page, gas)).toContainText('Pending');

      // The gas posts for a different amount, and the bakery is taken back.
      await fake(page, 'transactions/post', { pendingId: pending.transaction_id, posted: { amount: 32 } });
      const { items } = await fake<{ items: (FakeItemView & { transactions: { transaction_id: string; name: string }[] })[] }>(page, 'items');
      const bakeryId = items.find((i) => i.itemId === plaidItemId)!.transactions.find((t) => t.name === bakery.toUpperCase())!.transaction_id;
      await fake(page, 'transactions/remove', { transactionId: bakeryId });
      await webhook(page, plaidItemId, SYNC_UPDATES);
      await expect.poll(async () => (await cardRows(page, visa.id)).map((r) => `${r.merchant} ${r.amountCents}${r.pending ? ' pending' : ''}`)).toEqual([`${gas} 3200`]);
      await page.reload();
      const gasRow = transactionRow(page, gas);
      await expect(page.getByRole('combobox', { name: `Category for ${gas}, ${longDay(localDay(-1))}, $32.00` })).toBeVisible();
      await expect(gasRow).not.toContainText('Pending');
      await expect(page.getByRole('combobox', { name: new RegExp(`^Category for ${bakery}`) })).toHaveCount(0);
      await noSidewaysScroll(page);

      // A webhook for a bank the app doesn't have is still answered 200, and starts no sync. Webhooks are handled
      // in the order they came, so once a real one sent after it has landed, the first one has been handled too.
      const before = await syncCalls(page, plaidItemId);
      await webhook(page, plaidItemId, { ...SYNC_UPDATES, item_id: `unknown-${stamp}` });
      const deli = `Corner Deli ${stamp}`;
      await bankTransaction(page, plaidItemId, gold, { merchant_name: deli, name: deli.toUpperCase(), amount: 6, date: isoDay(localDay(-1)) });
      await webhook(page, plaidItemId, SYNC_UPDATES);
      await expect.poll(async () => (await cardRows(page, visa.id)).map((r) => r.merchant).sort()).toEqual([deli, gas].sort());
      // One sync: the real webhook's.
      expect(await syncCalls(page, plaidItemId)).toBe(before + 1);
    });

    test('a bank that needs its login again is reconnected through update mode from the home card, and then offers new accounts', async ({ page }, info) => {
      const stamp = newStamp(info);
      await signInAsNewAdmin(page, stamp);
      const bank = testBank(stamp, ['Gold']);
      const gold = bank.accounts[0]!;
      const visa = await createCard(page, `Visa ${stamp}`, gold.mask);
      const { plaidItemId, bankId } = await connectBank(page, bank);
      await saveCards(page, bank, [`${visa.nickname} ·${visa.mask}`], '1 attached');
      const trialUsed = async () => ((await (await page.request.get('/api/panels/spend/banks')).json()) as { trial: { used: number } }).trial.used;
      const usedBefore = await trialUsed();
      const createdBefore = (await fake<{ itemsCreated: number }>(page, 'items')).itemsCreated;

      // The bank wants the login again: Plaid says so by webhook, and calls fail until it's fixed.
      await fake(page, 'items/break', { itemId: plaidItemId, error: 'ITEM_LOGIN_REQUIRED' });
      await webhook(page, plaidItemId, {
        webhook_type: 'ITEM', webhook_code: 'ERROR',
        error: { error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'the login details of this item have changed' },
      });
      await expect.poll(async () => (await bankView(page, bank)).status).toBe('needs_reconnect');
      const late = `Late Purchase ${stamp}`;
      await bankTransaction(page, plaidItemId, gold, { merchant_name: late, name: late.toUpperCase(), amount: 19.99, date: isoDay(localDay(-1)) });

      // The home card says so, with Reconnect for an admin.
      await page.goto('/');
      const homeCard = page.getByRole('region', { name: 'Spend' }).getByRole('listitem').filter({ hasText: visa.nickname });
      await expect(homeCard).toContainText(`${bank.name} needs to be reconnected, so this card isn't updating.`);
      await noSidewaysScroll(page);
      await fake(page, 'link/next', { outcome: 'success' });
      await homeCard.getByRole('link', { name: `Reconnect ${bank.name}`, exact: true }).click();

      // Back in Spend settings on the bank, which is fine again and caught up.
      const row = bankRow(page, bank);
      await expect(row.getByRole('heading', { name: bank.name })).toBeFocused();
      await expect(page).toHaveURL(/\/spend\?tab=settings$/);
      const sessions = await fake<{ mode: string; itemId: string | null; outcome: string }[]>(page, 'link/sessions');
      expect(sessions.filter((s) => s.itemId === plaidItemId).map((s) => `${s.mode} ${s.outcome}`)).toEqual(['new success', 'update success']);
      await expect.poll(async () => (await cardRows(page, visa.id)).map((r) => r.merchant)).toEqual([late]);
      await expect.poll(async () => (await bankView(page, bank)).status).toBe('ok');
      await page.reload();
      await expect(row).not.toContainText('Needs reconnecting');
      await expect(row).toContainText(/Synced (just now|\d+ (second|minute)s? ago)/);
      // Reconnecting is never a new Trial connection: the app's count and Plaid's are where they were.
      expect(await trialUsed()).toBe(usedBefore);
      const after = await fake<{ itemsCreated: number; items: FakeItemView[] }>(page, 'items');
      expect(after.itemsCreated).toBe(createdBefore);
      expect(after.items.filter((i) => i.institution?.institution_id === bank.institutionId)).toHaveLength(1);

      // Later the login has a new account: Add accounts runs update mode with Account Select, and the new account waits for the pick.
      await webhook(page, plaidItemId, { webhook_type: 'ITEM', webhook_code: 'NEW_ACCOUNTS_AVAILABLE' });
      // The webhook is handled after its 200: wait for it, then the page shows the notice.
      await expect.poll(async () => (await bankView(page, bank)).newAccountsAt).not.toBeNull();
      await page.reload();
      await expect(row.getByRole('link', { name: `Add accounts from ${bank.name}`, exact: true })).toBeVisible();
      const platinum = { name: `Platinum ${stamp}`, mask: newMask(new Set([gold.mask])) };
      // Account Select lists every account it shares: Gold as Plaid knows it (its id), and the new one.
      const goldAtPlaid = (await fakeItem(page, bank)).accounts.find((a) => a.mask === gold.mask)!;
      await fake(page, 'link/next', { outcome: 'success', accounts: [{ account_id: goldAtPlaid.account_id, ...gold }, platinum] });
      await row.getByRole('link', { name: `Add accounts from ${bank.name}`, exact: true }).click();
      const form = pickForm(page, bank);
      await expect(form.locator('legend')).toBeFocused();
      await expect(form.getByRole('combobox')).toHaveCount(1);
      // A new account pauses the bank's syncing until it's decided (spec §12.2), so there's nothing to refresh until then (review G4-M4).
      const refresh = row.getByRole('button', { name: `Refresh ${bank.name}`, exact: true });
      await expect(refresh).toHaveCount(0);
      const latest = (await fake<{ itemId: string | null; linkTokenRequest: Record<string, unknown> }[]>(page, 'link/sessions')).filter((s) => s.itemId === plaidItemId).at(-1)!;
      expect(latest.linkTokenRequest).toMatchObject({ update: { account_selection_enabled: true } });
      await saveCards(page, { ...bank, accounts: [platinum] }, ['Skip this account'], '1 skipped');
      await expect(refresh).toBeVisible();
      await expect(row.getByRole('link', { name: `Add accounts from ${bank.name}`, exact: true })).toHaveCount(0);
      await expect(row.getByRole('list', { name: `Accounts at ${bank.name}` }).getByRole('listitem')).toHaveText([
        `${accountLabel(gold)}: on ${visa.nickname} ·${visa.mask}`,
        `${accountLabel(platinum)}: Skipped, not tracked`,
      ]);
      expect(bankId).toBe((await bankView(page, bank)).id);
    });

    test('an admin removes a bank: it is revoked at Plaid, its own transactions can go, and the CSV rows they replaced come back', async ({ page }, info) => {
      const stamp = newStamp(info);
      await signInAsNewAdmin(page, stamp);
      const bank = testBank(stamp, ['Gold']);
      const gold = bank.accounts[0]!;
      const visa = await createCard(page, `Visa ${stamp}`, gold.mask);
      const csv = await importCsv(page, visa, stamp);
      const { plaidItemId } = await connectBank(page, bank);
      // The bank's coffee replaces the CSV's; its sandwich is new.
      await bankTransaction(page, plaidItemId, gold, { merchant_name: `Blue Bottle ${stamp}`, name: csv.coffee, amount: 12.74, date: isoDay(localDay(-5)) });
      await bankTransaction(page, plaidItemId, gold, { merchant_name: `Sandwich Spot ${stamp}`, name: `SANDWICH SPOT ${stamp}`, amount: 11, date: isoDay(localDay(-2)) });
      await saveCards(page, bank, [`${visa.nickname} ·${visa.mask}`], '1 attached');
      const synced = await cardRows(page, visa.id);
      expect(synced.filter((r) => r.source === 'plaid')).toHaveLength(2);
      expect(synced.some((r) => r.merchant === csv.coffee)).toBe(false);

      // A category and a note set by hand on the bank's coffee, the row that replaced the CSV's.
      const categories = (await (await page.request.get('/api/panels/spend/categories')).json()) as { id: number; name: string }[];
      const groceries = categories.find((c) => c.name === 'Groceries')!;
      const bankCoffee = synced.find((r) => r.merchant === `Blue Bottle ${stamp}`)!;
      const patched = await page.request.patch(`/api/panels/spend/transactions/${bankCoffee.id}`, {
        data: { categoryId: groceries.id, note: `Beans ${stamp}` },
        headers: MUTATION_HEADERS,
      });
      expect(patched.ok()).toBe(true);

      // Remove, and delete its transactions too.
      const row = bankRow(page, bank);
      await row.getByRole('button', { name: `Remove ${bank.name}`, exact: true }).click();
      const dialog = page.getByRole('dialog', { name: `Remove ${bank.name}?` });
      await expect(dialog).toContainText(`The dashboard stops syncing ${visa.nickname} ·${visa.mask}`);
      await noSidewaysScroll(page);
      await noSidewaysScrollAt320(page, dialog);
      // Cancel changes nothing, and focus goes back to Remove.
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(row.getByRole('button', { name: `Remove ${bank.name}`, exact: true })).toBeFocused();
      await row.getByRole('button', { name: `Remove ${bank.name}`, exact: true }).click();
      const deleteToo = dialog.getByRole('checkbox', { name: 'Also delete its transactions' });
      await expect(deleteToo).toHaveAccessibleDescription(
        `Only the transactions that came from ${bank.name} are deleted. Rows they had replaced, from CSV files or an earlier connection to the bank, come back, with any category, person or note set by hand. Rows from a CSV import that was undone don't come back.`,
      );
      await deleteToo.check();
      await dialog.getByRole('button', { name: 'Remove bank' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(banksRegion(page).getByRole('status')).toHaveText(
        `Removed ${bank.name}. Its transactions from the bank were deleted, and any rows they had replaced are back.`,
      );
      await expect(row).toHaveCount(0);
      // Listed as removed with its transactions, never as keeping a history it deleted.
      const removedRow = page.getByRole('list', { name: 'Removed banks' }).getByRole('listitem').filter({ hasText: bank.name });
      await expect(removedRow).toContainText(/Removed [A-Z][a-z]{2} \d{1,2}, \d{4}, with its transactions/);
      await expect(removedRow).toContainText(`Its cards stay, without the bank's transactions: ${visa.nickname} ·${visa.mask}.`);
      await expect(removedRow).not.toContainText('keep their history');

      // Revoked at Plaid first.
      const { removals, items } = await fake<{ removals: string[]; items: FakeItemView[] }>(page, 'items');
      expect(removals).toContain(plaidItemId);
      expect(items.find((i) => i.itemId === plaidItemId)!.removed).toBe(true);

      // The bank's rows are gone, and the CSV coffee they had replaced is back, with the category and note set by hand.
      const rows = await cardRows(page, visa.id);
      expect(rows.map((r) => `${r.source} ${r.merchant}`).sort()).toEqual(
        [csv.coffee, csv.groceries, csv.netflix, csv.payment, csv.refund].map((m) => `csv ${m}`).sort(),
      );
      expect(rows.find((r) => r.merchant === csv.coffee)).toEqual(
        expect.objectContaining({ source: 'csv', amountCents: 1274, category: expect.objectContaining({ name: 'Groceries' }), note: `Beans ${stamp}` }),
      );
      const cards = page.getByRole('region', { name: 'Cards', exact: true });
      await expect(cards.getByRole('listitem').filter({ hasText: `${visa.nickname} ·${visa.mask}` })).toContainText('Bank connection removed');
      await page.goto(`/spend?card=${visa.id}`);
      const coffeeRow = page.getByRole('combobox', { name: new RegExp(`^Category for ${csv.coffee}`) });
      await expect(coffeeRow.locator('option:checked')).toHaveText('Groceries');
      await expect(coffeeRow).toHaveAccessibleDescription('Set by hand');
      await expect(page.getByText(`Beans ${stamp}`)).toBeVisible();
      // The CSV's $1,237.79 again, the coffee included.
      await expect(page.getByRole('region', { name: /to .*\d{4}$/ }).getByText('$1,237.79')).toBeVisible();
      await noSidewaysScroll(page);

      // Admin Integrations doesn't list it any more.
      await page.goto('/admin');
      await expect(page.getByRole('link', { name: 'Manage banks in Spend settings' })).toBeVisible();
      await expect(page.getByRole('list', { name: 'Bank connections' }).getByRole('listitem').filter({ hasText: bank.name })).toHaveCount(0);

      // A webhook for it starts no sync. The control: a second bank's webhook, sent after it, lands; webhooks are
      // handled in the order they came, so by then the first one has been handled too.
      const spare = testBank(`${stamp}-2`, ['Spare']);
      const spareCard = await createCard(page, `Spare card ${stamp}`, spare.accounts[0]!.mask);
      const { plaidItemId: spareItemId } = await connectBank(page, spare);
      await saveCards(page, spare, [`${spareCard.nickname} ·${spareCard.mask}`], '1 attached');
      const removedSyncs = await syncCalls(page, plaidItemId);
      await webhook(page, plaidItemId, SYNC_UPDATES);
      const tea = `Tea House ${stamp}`;
      await bankTransaction(page, spareItemId, spare.accounts[0]!, { merchant_name: tea, name: tea.toUpperCase(), amount: 4, date: isoDay(localDay(-1)) });
      await webhook(page, spareItemId, SYNC_UPDATES);
      await expect.poll(async () => (await cardRows(page, spareCard.id)).map((r) => r.merchant)).toEqual([tea]);
      expect(await syncCalls(page, plaidItemId)).toBe(removedSyncs);
      expect(await cardRows(page, visa.id)).toHaveLength(5);
    });

    test("an OAuth bank sends the browser to the bank and back: Link finishes on the return page, and the pick opens", async ({ page }, info) => {
      const stamp = newStamp(info);
      await signInAsNewAdmin(page, stamp);
      const bank = testBank(stamp, ['Gold']);
      const sessionsBefore = (await fake<unknown[]>(page, 'link/sessions')).length;
      // Link goes to the bank's own pages, and the bank sends the browser back with an oauth_state_id; Link then finishes.
      await fake(page, 'link/next', { outcome: 'oauth' });
      await fake(page, 'link/next', {
        outcome: 'success',
        institution: { institution_id: bank.institutionId, name: bank.name },
        accounts: bank.accounts.map((a) => ({ name: a.name, mask: a.mask })),
      });
      await page.goto('/spend?tab=settings');
      const returned = page.waitForRequest((r) => new URL(r.url()).pathname === '/connect/plaid/oauth-return' && r.isNavigationRequest());
      await banksRegion(page).getByRole('link', { name: 'Connect bank', exact: true }).click();
      const back = (await returned).url();
      expect(back).toMatch(/^http:\/\/localhost:3100\/connect\/plaid\/oauth-return\?oauth_state_id=[0-9a-f-]{36}$/);

      // Back in Spend settings with the pick open and focused.
      await expect(pickForm(page, bank).locator('legend')).toBeFocused();
      await expect(page).toHaveURL(/\/spend\?tab=settings$/);
      // Link ran twice: to the bank, then again on the return page with exactly the URL the bank sent.
      const sessions = (await fake<{ outcome: string; receivedRedirectUri: string | null }[]>(page, 'link/sessions')).slice(sessionsBefore);
      expect(sessions.map((s) => [s.outcome, s.receivedRedirectUri])).toEqual([['oauth', null], ['success', back]]);
      expect((await fakeItem(page, bank)).institution).toEqual({ institution_id: bank.institutionId, name: bank.name });
      await noSidewaysScroll(page);
    });

    test("Remove can't be stopped once it's sent: Cancel and Escape do nothing, the dialog says why, and focus lands on Banks; posted rows stay, pending ones go", async ({ page }, info) => {
      const { bank, visa, stamp, plaidItemId } = await linkedBank(page, info, async (itemId, account, stamp) => {
        await bankTransaction(page, itemId, account, { merchant_name: `Corner Bakery ${stamp}`, name: `CORNER BAKERY ${stamp}`, amount: 8.5, date: isoDay(localDay(-2)) });
        await bankTransaction(page, itemId, account, { merchant_name: `Corner Gas ${stamp}`, name: `CORNER GAS ${stamp}`, amount: 30, date: isoDay(localDay(-1)), pending: true });
      });
      expect((await cardRows(page, visa.id)).map((r) => `${r.merchant}${r.pending ? ' pending' : ''}`).sort()).toEqual([`Corner Bakery ${stamp}`, `Corner Gas ${stamp} pending`]);

      // Plaid is slow to confirm this bank's removal.
      await fake(page, 'delay', { path: '/item/remove', ms: 3_000, itemId: plaidItemId });
      const row = bankRow(page, bank);
      await row.getByRole('button', { name: `Remove ${bank.name}`, exact: true }).click();
      const dialog = page.getByRole('dialog', { name: `Remove ${bank.name}?` });
      // Pending transactions go either way (review G4-M6).
      await expect(dialog).toContainText("Its pending transactions are deleted either way, since the bank won't post them now.");
      await dialog.getByRole('button', { name: 'Remove bank' }).click();
      await expect(dialog.getByRole('status')).toHaveText(`Removing ${bank.name}. This can take up to a minute while Plaid confirms.`);
      const cancel = dialog.getByRole('button', { name: 'Cancel' });
      await expect(cancel).toHaveAttribute('aria-disabled', 'true');
      await expect(dialog.getByRole('button', { name: 'Remove bank' })).toHaveAttribute('aria-disabled', 'true');
      // What was sent is what happens: the box can't be ticked now (review C-M3).
      const deleteToo = dialog.getByRole('checkbox', { name: 'Also delete its transactions' });
      await expect(deleteToo).toHaveAttribute('aria-disabled', 'true');
      await deleteToo.focus();
      await page.keyboard.press('Space');
      await expect(deleteToo).not.toBeChecked();
      // A browser lets a page refuse only the first Escape: the second closes the dialog, and the page opens it again.
      await page.keyboard.press('Escape');
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeVisible();
      // Cancel is unavailable (aria-disabled, so it keeps its place in the tab order): pressing it does nothing.
      await cancel.focus();
      await page.keyboard.press('Enter');
      await expect(dialog).toBeVisible();
      await noSidewaysScroll(page);

      // Once Plaid answers, the bank is gone, the status line says so, and focus is on the section's heading.
      await expect(dialog).toHaveCount(0, { timeout: 10_000 });
      await expect(banksRegion(page).getByRole('status')).toHaveText(`Removed ${bank.name}. Its cards keep their transactions.`);
      await expect(banksHeading(page)).toBeFocused();
      await expect(row).toHaveCount(0);
      // Its card keeps the posted transaction; the pending one went, since the bank will never post it now.
      expect((await cardRows(page, visa.id)).map((r) => `${r.source} ${r.merchant}${r.pending ? ' pending' : ''}`)).toEqual([`plaid Corner Bakery ${stamp}`]);
      const removedRow = page.getByRole('list', { name: 'Removed banks' }).getByRole('listitem').filter({ hasText: bank.name });
      await expect(removedRow).toContainText(`Its cards keep their history: ${visa.nickname} ·${visa.mask}.`);
    });

    test('Refresh says what it is doing while it runs, then what it did, and focus stays on it', async ({ page }, info) => {
      const { bank, visa, plaidItemId, gold, stamp } = await linkedBank(page, info);
      await bankTransaction(page, plaidItemId, gold, { merchant_name: `Corner Deli ${stamp}`, name: `CORNER DELI ${stamp}`, amount: 9.25, date: isoDay(localDay(-1)) });
      await fake(page, 'delay', { path: '/transactions/sync', ms: 1_500, itemId: plaidItemId });
      const refresh = bankRow(page, bank).getByRole('button', { name: `Refresh ${bank.name}`, exact: true });
      await refresh.click();
      const status = banksRegion(page).getByRole('status');
      await expect(status).toHaveText(`Refreshing ${bank.name}…`);
      await expect(refresh).toHaveAttribute('aria-disabled', 'true');
      await expect(status).toHaveText(`Refreshed ${bank.name}.`);
      await expect(refresh).toHaveAttribute('aria-disabled', 'false');
      await expect(refresh).toBeFocused();
      expect((await cardRows(page, visa.id)).map((r) => r.merchant)).toEqual([`Corner Deli ${stamp}`]);
      await noSidewaysScroll(page);
    });

    test("an answer that never comes back is checked against the bank list: a pick that didn't arrive can be tried again, and a Remove that did is reported done", async ({ page }, info) => {
      const stamp = newStamp(info);
      await signInAsNewAdmin(page, stamp);
      const bank = testBank(stamp, ['Gold']);
      const gold = bank.accounts[0]!;
      const visa = await createCard(page, `Visa ${stamp}`, gold.mask);
      const visaName = `${visa.nickname} ·${visa.mask}`;
      const { plaidItemId } = await connectBank(page, bank);

      // The pick never reaches the server (the connection drops): the list still shows it waiting, so it's offered again.
      await page.route('**/api/panels/spend/banks/*/accounts', (route) => route.abort('failed'));
      const form = pickForm(page, bank);
      await form.getByRole('combobox', { name: `Card for ${accountLabel(gold)}` }).selectOption({ label: visaName });
      const save = form.getByRole('button', { name: 'Save cards' });
      await save.click();
      await expect(form.getByRole('alert')).toHaveText(`The server didn't answer in time. The cards for ${bank.name} don't show as saved yet. Check again in a minute before trying again.`);
      await expect(save).toBeFocused();
      await page.unroute('**/api/panels/spend/banks/*/accounts');
      await save.click();
      await expect(banksRegion(page).getByRole('status')).toHaveText(`Saved the cards for ${bank.name}: 1 attached.`);

      // Remove gets through, but the gateway's 504 is all that comes back: the list shows it removed, so that's what's said.
      await page.route('**/api/panels/spend/banks/*/remove', async (route) => {
        await route.fetch();
        await route.fulfill({ status: 504, contentType: 'text/html', body: '<html><body><h1>504 Gateway Time-out</h1></body></html>' });
      });
      const row = bankRow(page, bank);
      await row.getByRole('button', { name: `Remove ${bank.name}`, exact: true }).click();
      const dialog = page.getByRole('dialog', { name: `Remove ${bank.name}?` });
      await dialog.getByRole('button', { name: 'Remove bank' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(banksRegion(page).getByRole('status')).toHaveText(`The server didn't answer in time. ${bank.name} now shows as removed.`);
      await expect(banksHeading(page)).toBeFocused();
      await expect(row).toHaveCount(0);
      expect((await fake<{ removals: string[] }>(page, 'items')).removals).toContain(plaidItemId);
      await page.unroute('**/api/panels/spend/banks/*/remove');
    });

    test("a Remove Plaid didn't confirm says so, with the bank's name, and that it's tried again", async ({ page }, info) => {
      const { bank, plaidItemId } = await linkedBank(page, info);
      await fake(page, 'fail', { path: '/item/remove', error: 'INTERNAL_SERVER_ERROR', itemId: plaidItemId });
      await bankRow(page, bank).getByRole('button', { name: `Remove ${bank.name}`, exact: true }).click();
      const dialog = page.getByRole('dialog', { name: `Remove ${bank.name}?` });
      await dialog.getByRole('button', { name: 'Remove bank' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(banksRegion(page).getByRole('status')).toHaveText(
        `Removed ${bank.name} here. Its cards keep their transactions. Plaid didn't confirm it removed its access yet. The dashboard will keep trying every hour.`,
      );
      await expect(banksHeading(page)).toBeFocused();
      // The removed bank keeps saying so until Plaid confirms, after a reload too (review C-W-I2).
      const removedRow = page.getByRole('list', { name: 'Removed banks' }).getByRole('listitem').filter({ hasText: bank.name });
      await page.reload();
      await expect(removedRow).toContainText("Plaid hasn't confirmed it ended access yet. The dashboard retries every hour.");
      await noSidewaysScroll(page);
    });

    test('the bank categories save in one go: drafts, Discard, leaving asks first, a refusal beside its row, someone else changing one, Delete and Apply', async ({ page }, info) => {
      // This test's own detailed codes under Food and drink, on its own transactions: mappings are the family's.
      let codes: [string, string] = ['', ''];
      const { stamp, visa } = await linkedBank(page, info, async (itemId, account, stamp) => {
        const tag = `E2E${stamp.toUpperCase().replace(/[^A-Z0-9]/g, '')}`;
        codes = [`FOOD_AND_DRINK_${tag}_A`, `FOOD_AND_DRINK_${tag}_B`];
        for (const [i, code] of codes.entries()) {
          await bankTransaction(page, itemId, account, {
            merchant_name: `Code ${'AB'[i]} ${stamp}`, name: `CODE ${'AB'[i]} ${stamp}`, amount: 5 + i, date: isoDay(localDay(-2)),
            personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: code, confidence_level: 'HIGH', version: 'v2' },
          });
        }
      });
      const words = (code: string) => `Food and drink: ${code.slice('FOOD_AND_DRINK_'.length).toLowerCase().split('_').join(' ')}`;
      const [a, b] = codes.map(words) as [string, string];
      const categories = (await (await page.request.get('/api/panels/spend/categories')).json()) as { id: number; name: string }[];
      const id = (name: string) => categories.find((c) => c.name === name)!.id;
      // A category of this test's own, archived later, so the server refuses it.
      const doomed = (await (await page.request.post('/api/panels/spend/categories', { data: { name: `Doomed ${stamp}` }, headers: MUTATION_HEADERS })).json()) as { id: number };
      await page.reload();

      const mapping = page.getByRole('region', { name: 'Bank categories', exact: true });
      const unmapped = mapping.getByRole('list', { name: 'Bank categories not mapped yet' });
      const all = mapping.getByRole('list', { name: 'Bank category mappings' });
      const bar = mapping.getByRole('region', { name: 'Unsaved bank category changes' });
      const status = mapping.getByRole('status');
      const heading = mapping.getByRole('heading', { name: 'Bank categories', exact: true });
      const selectA = unmapped.getByRole('combobox', { name: `Category for ${a}`, exact: true });
      const selectB = unmapped.getByRole('combobox', { name: `Category for ${b}`, exact: true });
      // Each row says what kind of code it is and its taxonomy version (review G4-M8).
      await expect(unmapped.getByRole('listitem').filter({ hasText: codes[0] })).toContainText(`${codes[0]} · detailed category · taxonomy v2 · 1 transaction · uses Dining now`);

      // Two drafts: the bar counts them, each row says it's changed, and nothing is saved yet.
      await selectA.selectOption({ label: 'Groceries' });
      await selectB.selectOption({ label: 'Home' });
      await expect(bar.getByRole('button', { name: 'Save 2 changes', exact: true })).toBeVisible();
      await expect(selectA).toHaveAccessibleDescription('Changed, not saved');
      await noSidewaysScroll(page);
      await noSidewaysScrollAt320(page, bar);

      // Leaving asks first, and staying keeps them: a link in the app, and Connect bank's full page load,
      // each with the page's own question, not the browser's leave prompt (review C-M10).
      const inApp = nextDialog(page, 'dismiss');
      await page.getByRole('navigation', { name: 'Spend views' }).getByRole('link', { name: 'Overview' }).click();
      await expect(page).toHaveURL(/\/spend\?tab=settings$/);
      expect(inApp).toEqual({ type: 'confirm', message: 'Discard 2 unsaved changes?' });
      const toLink = nextDialog(page, 'dismiss');
      await banksRegion(page).getByRole('link', { name: 'Connect bank', exact: true }).click();
      await expect(page).toHaveURL(/\/spend\?tab=settings$/);
      expect(toLink).toEqual({ type: 'confirm', message: 'Discard 2 unsaved changes?' });
      await expect(bar.getByRole('button', { name: 'Save 2 changes', exact: true })).toBeVisible();

      // Discard asks for more than one, then drops them, and focus goes to the heading.
      page.once('dialog', (d) => void d.accept());
      await bar.getByRole('button', { name: 'Discard changes' }).click();
      await expect(status).toHaveText('Discarded 2 changes.');
      await expect(heading).toBeFocused();
      await expect(bar).toHaveCount(0);
      await expect(selectA.locator('option:checked')).toHaveText('Choose a category');

      // A category archived meanwhile: nothing is saved, the reason is beside its row, and focus goes to its select.
      await selectA.selectOption({ label: `Doomed ${stamp}` });
      await selectB.selectOption({ label: 'Home' });
      expect((await page.request.post(`/api/panels/spend/categories/${doomed.id}/archive`, { headers: MUTATION_HEADERS })).ok()).toBe(true);
      await bar.getByRole('button', { name: 'Save 2 changes', exact: true }).click();
      await expect(bar.getByRole('alert')).toHaveText(`Nothing was saved. ${a}: That category is archived. Pick another one.`);
      await expect(selectA).toBeFocused();
      await expect(selectA).toHaveAccessibleDescription('That category is archived. Pick another one.');

      // Picked again, both save in one go, though the gateway's 504 is all that comes back: the mapping
      // fetched again shows both saved, so that's what's said (review C-M5). They move to the list of
      // every code, and focus goes to the heading.
      await selectA.selectOption({ label: 'Groceries' });
      const { landed } = await answerWith504(page, '**/api/panels/spend/mappings', { afterServer: true });
      await bar.getByRole('button', { name: 'Save 2 changes', exact: true }).click();
      expect(await landed).toBe(200);
      await expect(status).toHaveText("The server didn't answer in time. Your changes now show as saved.");
      await expect(heading).toBeFocused();
      await expect(bar).toHaveCount(0);
      await expect(unmapped.getByRole('combobox', { name: `Category for ${a}`, exact: true })).toHaveCount(0);
      await mapping.locator('summary').click();
      const savedA = all.getByRole('combobox', { name: `Category for ${a}`, exact: true });
      const savedB = all.getByRole('combobox', { name: `Category for ${b}`, exact: true });
      await expect(savedA.locator('option:checked')).toHaveText('Groceries');
      await expect(savedB.locator('option:checked')).toHaveText('Home');

      // Someone else maps B meanwhile: the Save is refused, B is flagged with what it holds now, and saving again uses the pick.
      // Saved with the list of every code folded away: the refusal opens it and focuses B (review C-M6).
      await savedB.selectOption({ label: 'Kids' });
      expect((await page.request.put(`/api/panels/spend/mappings/${codes[1]}`, { data: { categoryId: id('Other') }, headers: MUTATION_HEADERS })).ok()).toBe(true);
      await mapping.locator('summary').click();
      await expect(savedB).toBeHidden();
      await bar.getByRole('button', { name: 'Save 1 change (1 not shown)', exact: true }).click();
      await expect(bar.getByRole('alert')).toHaveText('Nothing was saved. Someone else changed one of these categories while you were editing. Check it, then save again.');
      await expect(savedB).toBeVisible();
      await expect(savedB).toBeFocused();
      await expect(savedB).toHaveAccessibleDescription("Someone else changed this to Other. Your pick isn't saved yet.");
      await bar.getByRole('button', { name: 'Save 1 change', exact: true }).click();
      await expect(status).toHaveText('Saved 1 change. It applies to new transactions.');
      await expect(savedB.locator('option:checked')).toHaveText('Kids');

      // Delete: A goes back to its main category's, and back to the list of codes not mapped yet.
      await savedA.selectOption({ label: "Use Food and drink's category (Dining)" });
      await bar.getByRole('button', { name: 'Save 1 change', exact: true }).click();
      await expect(status).toHaveText('Saved 1 change. It applies to new transactions.');
      await expect(unmapped.getByRole('listitem').filter({ hasText: codes[0] })).toContainText('uses Dining now');
      await expect(all.getByRole('combobox', { name: `Category for ${a}`, exact: true })).toHaveCount(0);

      // Apply decides the past transactions again: B's is Kids now, A's still Dining.
      page.once('dialog', (d) => void d.accept());
      await mapping.getByRole('button', { name: 'Apply to past transactions' }).click();
      await expect(status).toHaveText(/^Applied the mapping and rules to past transactions\. \d+ transactions? changed\.$/);
      await expect(heading).toBeFocused();
      const rows = await cardRows(page, visa.id);
      expect(rows.find((r) => r.merchant === `Code B ${stamp}`)!.category.name).toBe('Kids');
      expect(rows.find((r) => r.merchant === `Code A ${stamp}`)!.category.name).toBe('Dining');
      await noSidewaysScroll(page);
      // B's own row stays: only this test's transactions carry its code, and they already hold what it maps to, so a
      // later test's "apply to past transactions" changes nothing of this one's.
    });

    test("a bank whose first sync failed shows its sync when it comes, without a reload", async ({ page }, info) => {
      const stamp = newStamp(info);
      await signInAsNewAdmin(page, stamp);
      const bank = testBank(stamp, ['Gold']);
      const gold = bank.accounts[0]!;
      const visa = await createCard(page, `Visa ${stamp}`, gold.mask);
      const { bankId, plaidItemId } = await connectBank(page, bank);
      // The first sync fails, its retries too: the pick is saved, the bank hasn't synced, and the status line says it'll be tried again (review C-M8).
      for (let i = 0; i < 3; i++) await fake(page, 'fail', { path: '/transactions/sync', error: 'INTERNAL_SERVER_ERROR', itemId: plaidItemId });
      await saveCards(page, bank, [`${visa.nickname} ·${visa.mask}`], '1 attached', { then: "The bank's sync didn't finish, so the dashboard will try it again." });
      const row = bankRow(page, bank);
      await expect(row).toContainText('Not synced yet');
      // Somewhere else (another tab, say), the bank syncs. The page sees it within seconds (review G4-M5).
      expect((await page.request.post(`/api/panels/spend/banks/${bankId}/refresh`, { headers: MUTATION_HEADERS })).status()).toBe(200);
      await expect(row).toContainText(/Synced (just now|\d+ (second|minute)s? ago)/, { timeout: 15_000 });
    });

    test("an unanswered pick that attaches a skipped account isn't taken as saved while it still shows as skipped", async ({ page }, info) => {
      const stamp = newStamp(info);
      await signInAsNewAdmin(page, stamp);
      const bank = testBank(stamp, ['Gold', 'Cash']);
      const [gold, cash] = bank.accounts as [TestAccount, TestAccount];
      const visa = await createCard(page, `Visa ${stamp}`, gold.mask);
      await connectBank(page, bank);
      await saveCards(page, bank, [`${visa.nickname} ·${visa.mask}`, 'Skip this account'], '1 attached, 1 skipped');

      // Cash goes on a new card now, but the request never reaches the server (the review's C-W-I1):
      // nothing waits, so only judging each choice sent tells that it wasn't saved.
      const row = bankRow(page, bank);
      await row.getByRole('button', { name: `Choose cards for ${bank.name}`, exact: true }).click();
      const form = pickForm(page, bank);
      await expect(form.locator('legend')).toBeFocused();
      await noSidewaysScrollAt320(page, form);
      await page.route('**/api/panels/spend/banks/*/accounts', (route) => route.abort('failed'));
      await form.getByRole('combobox', { name: `Card for ${accountLabel(cash)}` }).selectOption({ label: 'New card' });
      const save = form.getByRole('button', { name: 'Save cards' });
      await save.click();
      await expect(form.getByRole('alert')).toHaveText(`The server didn't answer in time. The cards for ${bank.name} don't show as saved yet. Check again in a minute before trying again.`);
      await expect(save).toBeFocused();
      await expect(row.getByRole('list', { name: `Accounts at ${bank.name}` })).toContainText(`${accountLabel(cash)}: Skipped, not tracked`);
      await page.unroute('**/api/panels/spend/banks/*/accounts');
      await save.click();
      await expect(banksRegion(page).getByRole('status')).toHaveText(`Saved the cards for ${bank.name}: 1 new card.`);
      await expect(row.getByRole('list', { name: `Accounts at ${bank.name}` })).toContainText(`${accountLabel(cash)}: on ${accountLabel(cash)}`);
    });

    test('an unanswered Remove that lands later is checked again after a while, and then reported done', async ({ page }, info) => {
      const { bank, plaidItemId } = await linkedBank(page, info);
      // The page's own timers run on a clock the test moves; the server's work is real.
      await page.clock.install();
      await page.reload();
      // Plaid is slow to confirm, and the gateway gives up first: a 504, while the removal goes on.
      await fake(page, 'delay', { path: '/item/remove', ms: 2_500, itemId: plaidItemId });
      const { landed } = await answerWith504(page, '**/api/panels/spend/banks/*/remove');
      const row = bankRow(page, bank);
      await row.getByRole('button', { name: `Remove ${bank.name}`, exact: true }).click();
      const dialog = page.getByRole('dialog', { name: `Remove ${bank.name}?` });
      await dialog.getByRole('button', { name: 'Remove bank' }).click();
      // The list still shows it: maybe still finishing, so check again before trying again (review C-M1).
      await expect(dialog.getByRole('alert')).toHaveText(`The server didn't answer in time. ${bank.name} doesn't show as removed yet. Check again in a minute before trying again.`);
      expect(await landed).toBe(200);
      // About 45 seconds on, the page looks again by itself: removed now.
      await page.clock.fastForward(46_000);
      await expect(banksRegion(page).getByRole('status')).toHaveText(`The server didn't answer in time. ${bank.name} now shows as removed.`);
      await expect(dialog).toHaveCount(0);
      await expect(row).toHaveCount(0);
      await expect(banksHeading(page)).toBeFocused();
    });

    test("the Link page says when Plaid finished but the dashboard refused to save the connection, with the server's reason", async ({ page }, info) => {
      const stamp = newStamp(info);
      await signInAsNewAdmin(page, stamp);
      const bank = testBank(stamp, ['Gold']);
      const trialBefore = ((await (await page.request.get('/api/panels/spend/banks')).json()) as { trial: { used: number } }).trial.used;
      await fake(page, 'link/next', { outcome: 'success', institution: { institution_id: bank.institutionId, name: bank.name }, accounts: bank.accounts });
      // The app's own refusal, with no next to follow (review C-M2). Synthetic text.
      await page.route('**/connect/plaid/exchange', (route) =>
        route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { code: 'validation', message: 'Synthetic refusal for this test.' } }) }));
      await page.goto('/spend?tab=settings');
      await banksRegion(page).getByRole('link', { name: 'Connect bank', exact: true }).click();
      await expect(page.locator('#link-status')).toHaveText("Plaid finished, but the dashboard couldn't save the connection: Synthetic refusal for this test.");
      await expect(page.getByRole('link', { name: 'Back to Spend settings' })).toBeFocused();
      await noSidewaysScroll(page);
      // Nothing was exchanged, so no Trial connection was used.
      expect(((await (await page.request.get('/api/panels/spend/banks')).json()) as { trial: { used: number } }).trial.used).toBe(trialBefore);
      await page.unroute('**/connect/plaid/exchange');
    });

    test('mapping drafts survive a reload; leaving or signing out asks first, and agreeing clears them; a new tab asks nothing', async ({ page }, info) => {
      const stamp = newStamp(info);
      const email = await signInAsNewAdmin(page, stamp);
      await page.goto('/spend?tab=settings');
      const mapping = page.getByRole('region', { name: 'Bank categories', exact: true });
      const bar = mapping.getByRole('region', { name: 'Unsaved bank category changes' });
      // A draft on a code every family has: only ever a draft here, never saved, so no other test sees it.
      await mapping.locator('summary').click();
      const select = mapping.getByRole('list', { name: 'Bank category mappings' }).getByRole('combobox', { name: 'Category for Food and drink', exact: true });
      const current = await select.locator('option:checked').textContent();
      const other = (await select.locator('option').allTextContents()).find((o) => o !== current && !o.includes('(archived)'))!;
      await select.selectOption({ label: other });
      await expect(bar.getByRole('button', { name: 'Save 1 change', exact: true })).toBeVisible();
      const stored = () => page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('drafts:spend-mappings:')));
      expect(await stored()).toHaveLength(1);

      // A reload keeps it (review C-M7). The browser's own leave prompt may come first: stay on course.
      const leavePrompt = (d: import('@playwright/test').Dialog) => void (d.type() === 'beforeunload' ? d.accept() : d.dismiss());
      page.on('dialog', leavePrompt);
      await page.reload();
      page.off('dialog', leavePrompt);
      await expect(bar.getByRole('button', { name: 'Save 1 change (1 not shown)', exact: true })).toBeVisible();
      await mapping.locator('summary').click();
      await expect(select.locator('option:checked')).toHaveText(other);

      // A click that opens Connect bank in a new tab leaves this page as it is: nothing to ask (review C-M4).
      if (sized.name === 'desktop') {
        let asked = 0;
        const count = () => asked++;
        page.on('dialog', count);
        // The new tab mustn't really start a link.
        await page.context().route('**/connect/plaid/link', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Not here.</p>' }));
        const opened = page.context().waitForEvent('page');
        await banksRegion(page).getByRole('link', { name: 'Connect bank', exact: true }).click({ modifiers: ['ControlOrMeta'] });
        await (await opened).close();
        await page.context().unroute('**/connect/plaid/link');
        page.off('dialog', count);
        expect(asked).toBe(0);
        await expect(page).toHaveURL(/\/spend\?tab=settings$/);
        await expect(bar).toBeVisible();
      }

      // Signing out asks first; staying keeps the draft.
      const signOut = page.getByRole('navigation', { name: 'Account' }).getByRole('button', { name: 'Sign out' });
      const stay = nextDialog(page, 'dismiss');
      await signOut.click();
      await expect(bar).toBeVisible();
      expect(stay).toEqual({ type: 'confirm', message: 'Discard 1 unsaved change?' });

      // Leaving for another page and agreeing drops it, here and in storage.
      const leave = nextDialog(page, 'accept');
      await page.getByRole('navigation', { name: 'Spend views' }).getByRole('link', { name: 'Overview' }).click();
      await expect(page).not.toHaveURL(/tab=settings/);
      expect(leave).toEqual({ type: 'confirm', message: 'Discard 1 unsaved change?' });
      expect(await stored()).toEqual([]);
      await page.goto('/spend?tab=settings');
      await expect(bar).toHaveCount(0);

      // A new draft, then signing out and agreeing: signed out, and nothing kept for the next person.
      await mapping.locator('summary').click();
      await select.selectOption({ label: other });
      await expect(bar).toBeVisible();
      const agree = nextDialog(page, 'accept');
      await signOut.click();
      await expect(signOut).toHaveCount(0);
      expect(agree).toEqual({ type: 'confirm', message: 'Discard 1 unsaved change?' });
      expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('drafts:')))).toEqual([]);
      await signIn(page, email);
      await page.goto('/spend?tab=settings');
      await expect(mapping.getByRole('heading', { name: 'Bank categories', exact: true })).toBeVisible();
      await expect(bar).toHaveCount(0);
    });
  });
}
