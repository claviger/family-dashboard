import { devices, expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { addPastFlow, addPastSnapshot } from './savingsHistory.js';

/**
 * The Savings panel end to end (docs/specs/2026-11-19-savings-panel-design.md, "Testing"; main spec
 * §21), against the fake Plaid that playwright.config.ts starts on port 3103. The browser runs the
 * real Link page (`/connect/plaid/link?for=savings`) with the fake's Link script; the tests act "at
 * the bank" through `/__fake/*`.
 *
 * The fake's Items are shared with plaid.spec.ts, so this runs in the `spend` project, one test at
 * a time, at both sizes. Every test is its own admin with its own institution, masks, and
 * nicknames (so the duplicate-link check never matches another test's login), and finds its own
 * Item by its institution. Savings accounts are the family's, so the home card, the table, and the
 * graph also show other tests' accounts: assertions pick this test's rows by their labels, and the
 * graph's total is compared before and after, never as a fixed number.
 *
 * Plaid gives no past balances, so the history the graph, a past month, and a mid-line join need
 * is written into the e2e database by savingsHistory.ts. Everything is synthetic.
 */

const MUTATION_HEADERS = { 'x-requested-with': 'dashboard', origin: 'http://localhost:3100' };
const FAKE_PLAID = 'http://127.0.0.1:3103';

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

// --- Dates, as the server's family time zone (the test machine's) sees them. ---

const pad = (n: number) => String(n).padStart(2, '0');
/** A local date `days` from today, `YYYY-MM-DD`. */
function isoDay(days = 0): string {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function addMonths(month: string, n: number): string {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + n;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
}
/** The home card graph's first day: the same day a month before `date`, clamped to that month's length. */
function oneMonthBack(date: string): Date {
  const month = addMonths(date.slice(0, 7), -1);
  const day = Math.min(Number(date.slice(8, 10)), Number(lastDayOf(month).slice(8, 10)));
  return new Date(`${month}-${pad(day)}T00:00:00`);
}
function lastDayOf(month: string): string {
  return `${month}-${pad(new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate())}`;
}
/** As the app writes them (src/web/panels/savings/format.ts): "Nov 19", "November 2026". */
const dayLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const monthLabel = (month: string) => new Date(`${month}-01T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

// --- The fake Plaid. ---

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
}

interface TestAccount {
  /** Plaid's name for it. */
  name: string;
  mask: string;
  /** What the pick names it. */
  nickname: string;
  /** Plaid's account id at the fake, once linked. */
  plaidId?: string;
}
interface Fidelity {
  name: string;
  institutionId: string;
  cash: TestAccount;
  brokerage: TestAccount;
  /** The fake's Item id, once linked. */
  itemId?: string;
}

/** A Fidelity-like login of this test's own: its institution, two masks no other account here has, and short stamped nicknames. */
function testFidelity(stamp: string): Fidelity {
  const tag = Math.random().toString(36).slice(2, 7);
  const first = 1000 + Math.floor(Math.random() * 8999);
  return {
    name: `Brokerage ${stamp}`,
    institutionId: `ins_e2e_savings_${stamp}`,
    cash: { name: `Cash Management ${stamp}`, mask: String(first), nickname: `Cash ${tag}` },
    brokerage: { name: `Individual ${stamp}`, mask: String(first + 1), nickname: `Brokerage ${tag}` },
  };
}

/** "Cash ab12c ·4321", as the home card and the table name a shown account. */
const shownLabel = (a: TestAccount) => (a.mask ? `${a.nickname} ·${a.mask}` : a.nickname);
/** "Cash Management … ·4321", as Settings names Plaid's account. */
const plaidLabel = (a: TestAccount) => `${a.name} ·${a.mask}`;

/** A new user with the given panels, signed in. Link and settings routes are limited per admin, and `--repeat-each` runs these back to back. */
async function signInAsNew(page: Page, stamp: string, role: 'admin' | 'member', panels: string[]): Promise<string> {
  await signIn(page, 'admin@example.com');
  const email = `savings-${role}-${stamp}@example.com`;
  const res = await page.request.post('/api/admin/users', {
    data: { email, displayName: `Savings ${role} ${stamp}`, color: '#378ADD', role, panels },
    headers: MUTATION_HEADERS,
  });
  expect(res.status(), await res.text()).toBe(201);
  await signIn(page, email);
  return email;
}

const settingsRegion = (page: Page) => page.getByRole('region', { name: 'Connections' });
/** Savings settings' status line (the Remove dialog and each account's tools have their own). */
const settingsStatus = (page: Page) => settingsRegion(page).locator(':scope > p.todo-status[role="status"]');
const monthPicker = (page: Page) => page.getByRole('combobox', { name: /^Month/ });
const homeCard = (page: Page) => page.getByRole('region', { name: 'Savings' });
const cardRow = (page: Page, a: TestAccount) => homeCard(page).getByRole('list', { name: 'Accounts' }).getByRole('listitem').filter({ hasText: shownLabel(a) });
const breakdownRow = (page: Page, a: TestAccount) => page.locator('table.savings-breakdown').getByRole('row').filter({ hasText: shownLabel(a) });
const cell = (row: Locator, label: string) => row.locator(`td[data-label="${label}"]`);

// --- Hand-added accounts and CSV import (main spec §21.8). Every file here is SYNTHETIC. ---

const handRegion = (page: Page) => page.getByRole('region', { name: 'Accounts added by hand' });
const handStatus = (page: Page) => handRegion(page).locator(':scope > p.todo-status[role="status"]');
const handRow = (page: Page, nickname: string) =>
  handRegion(page).getByRole('list', { name: 'Accounts added by hand' }).getByRole('listitem').filter({ has: page.getByRole('heading', { name: nickname, exact: true }) });
const toolsStatus = (page: Page, nickname: string) => handRow(page, nickname).locator('.savings-tools p.todo-status[role="status"]');
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const mdy = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
/** A hand-added account's row in the breakdown: it has no mask. */
const handAccount = (nickname: string): TestAccount => ({ name: nickname, mask: '', nickname });
/** "Undo the import of <file>, <Mon D>[, <time>], into <nickname>", as each import's Undo is named. */
const undoName = (file: string, nickname: string, suffix = '') =>
  new RegExp(`^Undo the import of ${file.replace(/[.()]/g, '\\$&')}, [A-Z][a-z]{2} \\d{1,2}(, \\d{1,2}:\\d{2} [AP]M)?, into ${nickname}${suffix}$`);

/**
 * A day in `month` on or before `max` whose D/M/YYYY also reads as an M/D/YYYY date no later than
 * today: every date in the bank file then fits both, so the admin has to choose (main spec §21.8).
 */
function ambiguousDay(month: string, wanted: number): string {
  const today = isoDay();
  const [y, m] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))];
  for (let d = Math.min(wanted, 12); d >= 1; d--) {
    // Read as M/D: month d, day m, same year.
    const flipped = `${y}-${pad(d)}-${pad(m)}`;
    if (flipped <= today) return `${month}-${pad(d)}`;
  }
  throw new Error(`No ambiguous day in ${month}`);
}

/** A SYNTHETIC generic bank export: a preamble, D/M/YYYY dates, Debit and Credit, oldest first, a footer. */
function bankFile(rows: { date: string; description: string; debit?: string; credit?: string; balance: string }[]): Buffer {
  const q = (v = '') => (v.includes(',') ? `"${v}"` : v);
  const lines = rows.map((r) => `${dmy(r.date)},${r.description},${q(r.debit)},${q(r.credit)},${q(r.balance)}`);
  return Buffer.from(['Example Bank export', 'Account,XXXX-0001', '', 'Date,Description,Debit,Credit,Balance', ...lines, 'End of statement', ''].join('\r\n'), 'utf8');
}

const FIDELITY_BROKERAGE_HEADER = 'Run Date,Action,Symbol,Description,Type,Exchange Quantity,Exchange Currency,Currency,Price,Quantity,Exchange Rate,Commission,Fees,Accrued Interest,Amount,Cash Balance,Settlement Date';
/** A SYNTHETIC file in Fidelity's brokerage layout (made-up amounts and account numbers), newest row first. */
function fidelityBrokerageFile(rows: { date: string; action: string; amount: string; balance: string }[]): Buffer {
  const q = (v: string) => (v.startsWith('-') ? `"${v}"` : v);
  const lines = rows.map((r) => `${mdy(r.date)},${r.action},"",No Description,Cash,0,"",USD,"","0",0,"","","",${q(r.amount)},${q(r.balance)},""`);
  return Buffer.from(['', '', FIDELITY_BROKERAGE_HEADER, ...lines, '', '"Example disclaimer, synthetic."', '', 'Date downloaded 01/01/2026 06:54 pm', ''].join('\n'), 'utf8');
}

async function addHand(page: Page, nickname: string, kind: 'Cash' | 'Investment') {
  await page.goto('/savings?tab=settings');
  const form = handRegion(page).getByRole('form', { name: 'Add an account by hand' });
  await form.getByLabel('Nickname').fill(nickname);
  await form.getByLabel('Kind').selectOption({ label: kind });
  await form.getByRole('button', { name: 'Add account' }).click();
  await expect(handStatus(page)).toHaveText(`Added ${nickname}.`);
  await expect(handRow(page, nickname)).toContainText('No balance yet');
}

async function uploadInto(page: Page, nickname: string, name: string, buffer: Buffer) {
  const row = handRow(page, nickname);
  await row.getByRole('button', { name: `Import a CSV into ${nickname}` }).click();
  const form = row.getByRole('form', { name: `Import a CSV into ${nickname}` });
  await form.getByLabel(`CSV file for ${nickname}`).setInputFiles({ name, mimeType: 'text/csv', buffer });
  await form.getByRole('button', { name: 'Next' }).click();
}

async function removeHandWithData(page: Page, nickname: string) {
  await page.goto('/savings?tab=settings');
  await handRow(page, nickname).getByRole('button', { name: `Remove ${nickname}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Remove ${nickname}?` });
  await dialog.getByLabel('Also delete its data').check();
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(handStatus(page)).toHaveText(`Removed ${nickname}. Its balances, deposits and withdrawals were deleted.`);
  await expect(handRow(page, nickname)).toHaveCount(0);
}

/**
 * Connect an account through the Link page and the fake Link, as the signed-in admin: comes back to
 * Savings settings with this login's pick open and focused. Then Show both accounts with their
 * nicknames and Save accounts, which runs the first sync. Fills in the fake's ids.
 */
async function connectAndPick(page: Page, f: Fidelity, balances = { cash: 1500, brokerage: 25000 }) {
  await fake(page, 'link/next', {
    outcome: 'success',
    institution: { institution_id: f.institutionId, name: f.name },
    accounts: [
      { name: f.cash.name, mask: f.cash.mask, type: 'depository', subtype: 'cash management', current: balances.cash },
      { name: f.brokerage.name, mask: f.brokerage.mask, type: 'investment', subtype: 'brokerage', current: balances.brokerage },
    ],
  });
  await page.goto('/savings?tab=settings');
  await settingsRegion(page).getByRole('link', { name: 'Connect an account', exact: true }).click();
  const pick = page.getByRole('form', { name: `Choose accounts for ${f.name}` });
  await expect(pick.locator('legend')).toBeFocused();
  await expect(page).toHaveURL(/\/savings\?tab=settings$/);
  // Both are shown by default, named from Plaid's names (cut to the 40-character nickname limit).
  await expect(pick.getByLabel(`Nickname for ${plaidLabel(f.cash)}`)).toHaveValue(f.cash.name.slice(0, 40));
  await pick.getByLabel(`Nickname for ${plaidLabel(f.cash)}`).fill(f.cash.nickname);
  await pick.getByLabel(`Nickname for ${plaidLabel(f.brokerage)}`).fill(f.brokerage.nickname);
  await pick.getByRole('button', { name: 'Save accounts' }).click();
  await expect(settingsStatus(page)).toHaveText(`Saved the accounts for ${f.name}: 2 shown.`);
  await expect(pick).toHaveCount(0);

  const { items } = await fake<{ items: FakeItemView[] }>(page, 'items');
  const mine = items.filter((i) => i.institution?.institution_id === f.institutionId && !i.removed);
  expect(mine).toHaveLength(1);
  f.itemId = mine[0]!.itemId;
  f.cash.plaidId = mine[0]!.accounts.find((a) => a.mask === f.cash.mask)!.account_id;
  f.brokerage.plaidId = mine[0]!.accounts.find((a) => a.mask === f.brokerage.mask)!.account_id;
}

async function refresh(page: Page, f: Fidelity) {
  await page.goto('/savings?tab=settings');
  await settingsRegion(page).getByRole('button', { name: `Refresh ${f.name}`, exact: true }).click();
  await expect(settingsStatus(page)).toHaveText(`Refreshed ${f.name}.`);
}

/** The graph's latest total in cents, as "Total now" says it; 0 when there's no graph yet. Loads Overview. */
async function graphTotalCents(page: Page): Promise<number> {
  await page.goto('/savings');
  const now = page.locator('.savings-chart p strong.savings-amount');
  const none = page.getByText("The graph starts once the accounts' first balances are in.");
  await expect(now.or(none)).toBeVisible();
  if (await none.isVisible()) return 0;
  return Math.round(Number((await now.innerText()).replace(/[$,]/g, '')) * 100);
}

async function noSidewaysScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

// A test that failed before using what it queued (a Link result, a failure) mustn't leave it for the next one.
test.beforeEach(async ({ request }) => {
  const res = await request.post(`${FAKE_PLAID}/__fake/reset-queues`, { data: {} });
  expect(res.ok(), await res.text()).toBe(true);
});

for (const s of SIZES) {
  test.describe(s.name, () => {
    test.use(s.use);
    // Long flows, one at a time beside the other projects' tests.
    test.describe.configure({ timeout: 90_000 });

    test('links a Fidelity-like login, picks with nicknames, and shows the home card and the breakdown with deposits, withdrawals and market change', async ({ page }, info) => {
      const stamp = newStamp(info);
      await signInAsNew(page, stamp, 'admin', ['savings']);
      const f = testFidelity(stamp);
      await connectAndPick(page, f);

      // The first sync read the balances: the home card has both, by nickname and last 4.
      await page.goto('/');
      await expect(cardRow(page, f.cash)).toContainText('$1,500.00');
      await expect(cardRow(page, f.brokerage)).toContainText('$25,000.00');

      // Last month's closing balances (the fake has no past ones), so this month starts from them.
      const lastMonthEnd = lastDayOf(addMonths(isoDay().slice(0, 7), -1));
      addPastSnapshot(f.cash.plaidId!, lastMonthEnd, 1400);
      addPastSnapshot(f.brokerage.plaidId!, lastMonthEnd, 24000);

      // At the bank: money in and out today, a dividend (not a flow), new balances; then Refresh.
      await fake(page, 'transactions/add', { itemId: f.itemId, mask: f.cash.mask, date: isoDay(), amount: -200, name: `PAYROLL ${stamp}` });
      await fake(page, 'transactions/add', { itemId: f.itemId, mask: f.cash.mask, date: isoDay(), amount: 50, name: `ATM ${stamp}` });
      await fake(page, 'investments/add', { itemId: f.itemId, mask: f.brokerage.mask, date: isoDay(), amount: -1000, type: 'cash', subtype: 'deposit' });
      await fake(page, 'investments/add', { itemId: f.itemId, mask: f.brokerage.mask, date: isoDay(), amount: -12.34, type: 'cash', subtype: 'dividend' });
      await fake(page, 'balances', { itemId: f.itemId, mask: f.cash.mask, current: 1650 });
      await fake(page, 'balances', { itemId: f.itemId, mask: f.brokerage.mask, current: 26100 });
      await refresh(page, f);

      // The home card: each balance and this month's change; never a transaction's name.
      await page.goto('/');
      await expect(cardRow(page, f.cash)).toContainText('$1,650.00');
      await expect(cardRow(page, f.cash)).toContainText('+$250.00 this month');
      await expect(cardRow(page, f.brokerage)).toContainText('$26,100.00');
      await expect(cardRow(page, f.brokerage)).toContainText('+$2,100.00 this month');
      await expect(homeCard(page)).toContainText(/Updated /);
      await expect(homeCard(page)).not.toContainText(`PAYROLL ${stamp}`);

      // The drill-down, from the card's title.
      await homeCard(page).getByRole('link', { name: 'Savings' }).click();
      await expect(page).toHaveURL(/\/savings$/);
      const cash = breakdownRow(page, f.cash);
      await expect(cell(cash, 'Start')).toHaveText('$1,400.00');
      await expect(cell(cash, 'Deposits')).toHaveText('$200.00');
      await expect(cell(cash, 'Withdrawals')).toHaveText('$50.00');
      // 1650 − 1400 − 200 + 50
      await expect(cell(cash, 'Other change')).toContainText('+$100.00');
      await expect(cell(cash, 'Now')).toContainText('$1,650.00');
      await expect(cell(cash, 'Now')).toContainText(/As of /);
      const brokerage = breakdownRow(page, f.brokerage);
      await expect(cell(brokerage, 'Start')).toHaveText('$24,000.00');
      await expect(cell(brokerage, 'Deposits')).toHaveText('$1,000.00');
      await expect(cell(brokerage, 'Withdrawals')).toHaveText('$0.00');
      // 26100 − 24000 − 1000: the dividend is market change, not a deposit.
      await expect(cell(brokerage, 'Market change')).toContainText('+$1,100.00');
      await expect(cell(brokerage, 'Now')).toContainText('$26,100.00');
      await expect(page.locator('table.savings-breakdown')).not.toContainText(`PAYROLL ${stamp}`);

      // The graph: one line, its frame, and the month-end table for screen readers.
      await expect(page.getByRole('group', { name: 'Graph of the total' })).toBeVisible();
      expect(await page.locator('.savings-chart svg path.savings-chart-line').count()).toBe(1);
      await page.getByText('Show as a table').click();
      const ends = page.getByRole('table', { name: 'Month-end totals' });
      await expect(ends.getByRole('row').filter({ hasText: `${monthLabel(isoDay().slice(0, 7))} (so far)` })).toBeVisible();
      await expect(ends.getByRole('row').filter({ hasText: monthLabel(lastMonthEnd.slice(0, 7)) })).toBeVisible();
      await noSidewaysScroll(page);
    });

    test("shows the brokerage's total change only, with the reason in Settings, when Investments isn't there", async ({ page }, info) => {
      const stamp = newStamp(info);
      await signInAsNew(page, stamp, 'admin', ['savings']);
      const f = testFidelity(stamp);
      await connectAndPick(page, f);
      // Last month's closing balances, so this month's change is more than one snapshot's.
      const lastMonthEnd = lastDayOf(addMonths(isoDay().slice(0, 7), -1));
      addPastSnapshot(f.cash.plaidId!, lastMonthEnd, 1500);
      addPastSnapshot(f.brokerage.plaidId!, lastMonthEnd, 25000);

      // Fidelity stops sharing investment activity: the next sync records it, and Settings says why.
      await fake(page, 'items/investments', { itemId: f.itemId, supported: false });
      await fake(page, 'balances', { itemId: f.itemId, mask: f.brokerage.mask, current: 25500 });
      await refresh(page, f);
      const conn = settingsRegion(page).getByRole('listitem').filter({ has: page.getByRole('heading', { name: f.name, exact: true }) });
      await expect(conn).toContainText("The institution didn't share investment activity, so the brokerage shows its total change only.");
      await expect(conn).toContainText(/Synced /);

      await page.goto('/savings');
      const brokerage = breakdownRow(page, f.brokerage);
      await expect(brokerage).toContainText("Deposits and withdrawals aren't available for this account, so this is the month's total change.");
      await expect(cell(brokerage, 'Deposits')).toHaveText('Not available');
      await expect(cell(brokerage, 'Withdrawals')).toHaveText('Not available');
      await expect(cell(brokerage, 'Total change')).toContainText('+$500.00');
      // The cash account is unaffected, and the total can't add up deposits for every account.
      await expect(cell(breakdownRow(page, f.cash), 'Deposits')).toHaveText('$0.00');
      await expect(page.locator('table.savings-breakdown tfoot')).toContainText("Deposits and withdrawals aren't available for every account");
    });

    test('renames, hides and shows an account again, and removes the connection with its data from the card and the graph', async ({ page }, info) => {
      const stamp = newStamp(info);
      await signInAsNew(page, stamp, 'admin', ['savings']);
      const f = testFidelity(stamp);
      await connectAndPick(page, f, { cash: 1500, brokerage: 25000 });

      // Rename: Settings names the account by Plaid's name, and the panel by the new nickname.
      const before = shownLabel(f.cash);
      const renamed = `Rainy ${f.cash.nickname.slice(5)}`;
      await settingsRegion(page).getByLabel(`Nickname for ${plaidLabel(f.cash)}`).fill(renamed);
      await settingsRegion(page).getByRole('button', { name: `Rename ${plaidLabel(f.cash)}` }).click();
      await expect(settingsStatus(page)).toHaveText(`Renamed ${before} to ${renamed}.`);
      f.cash.nickname = renamed;
      await page.goto('/');
      await expect(cardRow(page, f.cash)).toContainText('$1,500.00');
      await expect(homeCard(page)).not.toContainText(before);

      // Hide: off the card, the table, and the graph's total; still synced.
      const shownTotal = await graphTotalCents(page);
      await page.goto('/savings?tab=settings');
      await settingsRegion(page).getByRole('button', { name: `Hide ${shownLabel(f.cash)}` }).click();
      await expect(settingsStatus(page)).toHaveText(`Hid ${shownLabel(f.cash)}. It's still synced.`);
      await page.goto('/');
      await expect(cardRow(page, f.brokerage)).toBeVisible();
      await expect(cardRow(page, f.cash)).toHaveCount(0);
      expect(await graphTotalCents(page)).toBe(shownTotal - 150_000);
      await expect(breakdownRow(page, f.cash)).toHaveCount(0);

      // Show it again: back on the card.
      await page.goto('/savings?tab=settings');
      await settingsRegion(page).getByRole('button', { name: `Show ${shownLabel(f.cash)} again` }).click();
      await expect(settingsStatus(page)).toHaveText(`${shownLabel(f.cash)} is shown again.`);
      await page.goto('/');
      await expect(cardRow(page, f.cash)).toBeVisible();

      // Remove with its data: gone from the card and the graph, and listed as removed with its data.
      expect(await graphTotalCents(page)).toBe(shownTotal);
      await page.goto('/savings?tab=settings');
      await settingsRegion(page).getByRole('button', { name: `Remove ${f.name}`, exact: true }).click();
      const dialog = page.getByRole('dialog', { name: `Remove ${f.name}?` });
      await dialog.getByLabel('Also delete its data').check();
      await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
      await expect(settingsStatus(page)).toHaveText(`Removed ${f.name}. Its balances, deposits and withdrawals were deleted.`);
      const removed = page.getByRole('list', { name: 'Removed savings connections' }).getByRole('listitem').filter({ hasText: f.name });
      await expect(removed).toContainText('with its data');
      await expect(removed).not.toContainText('keep their history');
      expect(await graphTotalCents(page)).toBe(shownTotal - 150_000 - 2_500_000);
      await page.goto('/');
      await expect(homeCard(page)).toBeVisible();
      await expect(cardRow(page, f.cash)).toHaveCount(0);
      await expect(cardRow(page, f.brokerage)).toHaveCount(0);
    });

    test('shows history: the graph with a mid-line join, a past month, refused months, and a removal that keeps its data', async ({ page }, info) => {
      const stamp = newStamp(info);
      await signInAsNew(page, stamp, 'admin', ['savings']);
      const f = testFidelity(stamp);
      await connectAndPick(page, f, { cash: 1500, brokerage: 25000 });
      const today = isoDay();
      const month = today.slice(0, 7);
      const lastMonth = addMonths(month, -1);

      // The cash account has history from two months back; the brokerage only from today, so it
      // joins the line part way through.
      addPastSnapshot(f.cash.plaidId!, `${addMonths(month, -2)}-15`, 1000);
      addPastSnapshot(f.cash.plaidId!, lastDayOf(lastMonth), 1400);
      addPastFlow(f.cash.plaidId!, `${lastMonth}-10`, 'deposit', 300);
      addPastFlow(f.cash.plaidId!, `${lastMonth}-12`, 'withdrawal', 100);

      await page.goto('/savings');
      // This month: the cash account from last month's end, the brokerage since today, and the total says so.
      await expect(cell(breakdownRow(page, f.cash), 'Start')).toHaveText('$1,400.00');
      await expect(cell(breakdownRow(page, f.cash), 'Other change')).toContainText('+$100.00');
      await expect(cell(breakdownRow(page, f.brokerage), 'Start')).toContainText('$25,000.00');
      await expect(cell(breakdownRow(page, f.brokerage), 'Start')).toContainText(`Since ${dayLabel(today)}`);
      const totalStart = page.locator('table.savings-breakdown tfoot td[data-label="Start"]');
      await expect(totalStart).toContainText(new RegExp(`Mixed: .*${f.brokerage.nickname} since ${dayLabel(today)}.*, the rest from the end of last month`));

      // The graph: filling in, a ringed marker where the brokerage joined, and the sentence naming it.
      await expect(page.getByText(/^The graph starts on .+, the first day with a balance, and fills in over six months\.$/)).toBeVisible();
      expect(await page.locator('.savings-chart svg circle.savings-chart-join').count()).toBeGreaterThan(0);
      await expect(page.locator('.savings-chart p.muted').filter({ hasText: 'so the total steps up' })).toContainText(new RegExp(`${f.brokerage.nickname} (was added )?on ${dayLabel(today)}`));
      // Deposit and withdrawal lines behind the balance: a green ▲ line and a red ▼ line on their days,
      // the legend, the hidden totals line, and the day's flows in the keys' readout.
      const chart = page.locator('.savings-chart');
      await expect(chart.locator(`svg g.savings-flow.deposit[data-date="${lastMonth}-10"]`)).toHaveCount(1);
      await expect(chart.locator(`svg g.savings-flow.withdrawal[data-date="${lastMonth}-12"]`)).toHaveCount(1);
      await expect(chart.locator('p.savings-flow-legend')).toHaveText("Green ▲ deposits, red ▼ withdrawals; transfers between your accounts aren't shown.");
      await expect(chart.locator('.savings-chart-frame .visually-hidden').filter({ hasText: /^Flow lines: deposits \$[\d,.]+ on \d+ days?, withdrawals \$[\d,.]+ on \d+ days?, not counting transfers between your accounts\.$/ })).toHaveCount(1);
      const frame = page.getByRole('group', { name: 'Graph of the total' });
      await frame.focus();
      await page.keyboard.press('End');
      const back = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${lastMonth}-10T12:00:00Z`)) / 86_400_000);
      for (let i = 0; i < back; i++) await page.keyboard.press('ArrowLeft');
      await expect(frame.locator('[aria-live="polite"]')).toHaveText(new RegExp(`^${dayLabel(`${lastMonth}-10`)}: \\$[\\d,.]+\\. Deposits \\$[\\d,.]+`));
      await page.getByText('Show as a table').click();
      const ends = page.getByRole('table', { name: 'Month-end totals' });
      for (const m of [addMonths(month, -2), lastMonth]) await expect(ends.getByRole('row').filter({ hasText: monthLabel(m) })).toBeVisible();

      // The home card's last month: a compact graph with the same lines, and its caption as its text.
      await page.goto('/');
      const cardGraph = homeCard(page).getByRole('figure', { name: /^Last month: from \$[\d,.]+ to \$[\d,.]+/ });
      await expect(cardGraph).toBeVisible();
      expect(await cardGraph.locator('svg path.savings-chart-line').count()).toBe(1);
      await expect(cardGraph.locator(`svg g.savings-flow.withdrawal[data-date="${lastMonth}-12"]`)).toHaveCount(new Date(`${lastMonth}-12T12:00:00`) >= oneMonthBack(today) ? 1 : 0);
      await noSidewaysScroll(page);
      await page.goto('/savings');

      // Last month: only the accounts with a balance in it, End instead of Now, and no graph.
      await monthPicker(page).selectOption({ label: monthLabel(lastMonth) });
      await expect(page).toHaveURL(new RegExp(`/savings\\?month=${lastMonth}$`));
      await expect(page.getByRole('heading', { name: monthLabel(lastMonth), exact: true })).toBeVisible();
      // On a phone the header row is hidden and each cell carries its label, so this checks it's there, not shown.
      await expect(page.getByRole('columnheader', { name: 'End', includeHidden: true })).toHaveCount(1);
      const past = breakdownRow(page, f.cash);
      await expect(cell(past, 'Start')).toHaveText('$1,000.00');
      await expect(cell(past, 'Deposits')).toHaveText('$300.00');
      await expect(cell(past, 'Withdrawals')).toHaveText('$100.00');
      // 1400 − 1000 − 300 + 100
      await expect(cell(past, 'Other change')).toContainText('+$200.00');
      await expect(cell(past, 'End')).toContainText('$1,400.00');
      await expect(breakdownRow(page, f.brokerage)).toHaveCount(0);
      await expect(page.getByRole('group', { name: 'Graph of the total' })).toHaveCount(0);

      // A month before any data, or one that hasn't started: refused, with the way back.
      await page.goto('/savings?month=2000-01');
      await expect(page.getByRole('alert')).toHaveText('There are no savings numbers for that month. Pick a later one.');
      await page.getByRole('link', { name: 'Show this month' }).click();
      await expect(page).toHaveURL(/\/savings$/);
      await expect(breakdownRow(page, f.cash)).toBeVisible();
      await page.goto(`/savings?month=${addMonths(month, 1)}`);
      await expect(page.getByRole('alert')).toHaveText("That month hasn't started yet.");

      // Remove, keeping the data: off the card and this month, still in last month, marked.
      await page.goto('/savings?tab=settings');
      await settingsRegion(page).getByRole('button', { name: `Remove ${f.name}`, exact: true }).click();
      const dialog = page.getByRole('dialog', { name: `Remove ${f.name}?` });
      await expect(dialog.getByLabel('Also delete its data')).not.toBeChecked();
      await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
      await expect(settingsStatus(page)).toHaveText(`Removed ${f.name}. Its history is kept.`);
      await expect(page.getByRole('list', { name: 'Removed savings connections' }).getByRole('listitem').filter({ hasText: f.name }))
        .toContainText(`Its accounts keep their history in past months: ${f.cash.nickname}, ${f.brokerage.nickname}.`);
      await page.goto('/');
      await expect(homeCard(page)).toBeVisible();
      await expect(cardRow(page, f.cash)).toHaveCount(0);
      await page.goto('/savings');
      await expect(monthPicker(page)).toBeVisible();
      await expect(breakdownRow(page, f.cash)).toHaveCount(0);
      await page.goto(`/savings?month=${lastMonth}`);
      await expect(breakdownRow(page, f.cash)).toContainText('Connection removed');
      await expect(cell(breakdownRow(page, f.cash), 'End')).toContainText('$1,400.00');
    });

    test('is invisible to a member without the grant, and read-only for one with it', async ({ page }, info) => {
      const stamp = newStamp(info);
      await signInAsNew(page, stamp, 'member', ['spend']);
      await page.goto('/');
      await expect(page.getByRole('region', { name: 'Spend' })).toBeVisible();
      await expect(homeCard(page)).toHaveCount(0);
      await page.goto('/savings');
      await expect(page.getByText("You don't have access to this panel.")).toBeVisible();
      expect((await page.request.get('/api/panels/savings/summary')).status()).toBe(403);
      expect((await page.request.get('/api/panels/savings/overview')).status()).toBe(403);

      await signInAsNew(page, `${stamp}-b`, 'member', ['savings']);
      await page.goto('/');
      await expect(homeCard(page)).toBeVisible();
      await page.goto('/savings?tab=settings');
      // Overview, not Settings: no tabs, no connections, and the settings routes refuse.
      await expect(monthPicker(page)).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Savings views' })).toHaveCount(0);
      await expect(settingsRegion(page)).toHaveCount(0);
      expect((await page.request.get('/api/panels/savings/summary')).status()).toBe(200);
      expect((await page.request.get('/api/panels/savings/settings')).status()).toBe(403);
      expect((await page.request.patch('/api/panels/savings/accounts/1', { data: { hidden: true }, headers: MUTATION_HEADERS })).status()).toBe(403);
      expect((await page.request.post('/api/panels/savings/connections/1/refresh', { headers: MUTATION_HEADERS })).status()).toBe(403);
      // No hand-added accounts, Set balance, or Import a CSV, and their routes refuse too.
      await expect(handRegion(page)).toHaveCount(0);
      await expect(page.getByRole('button', { name: /^(Import a CSV|Set balance) / })).toHaveCount(0);
      expect((await page.request.post('/api/panels/savings/accounts', { data: { nickname: 'Nope', kind: 'cash' }, headers: MUTATION_HEADERS })).status()).toBe(403);
      expect((await page.request.post('/api/panels/savings/accounts/1/balance', { data: { amount: '1' }, headers: MUTATION_HEADERS })).status()).toBe(403);
      const upload = await page.request.post('/api/panels/savings/accounts/1/imports', {
        headers: MUTATION_HEADERS, multipart: { file: { name: 'statement.csv', mimeType: 'text/csv', buffer: bankFile([{ date: isoDay(-1), description: 'X', credit: '1.00', balance: '1.00' }]) } },
      });
      expect(upload.status()).toBe(403);
      expect((await page.request.delete('/api/panels/savings/accounts/1/imports/1', { headers: MUTATION_HEADERS })).status()).toBe(403);
    });

    test("adds a cash account by hand, imports a bank's CSV through every step, and fills in a past month and the graph", async ({ page }, info) => {
      const stamp = newStamp(info);
      await signInAsNew(page, stamp, 'admin', ['savings']);
      const nickname = `Hand cash ${Math.random().toString(36).slice(2, 7)}`;
      const month = isoDay().slice(0, 7);
      const lastMonth = addMonths(month, -1);
      const twoAgo = addMonths(month, -2);
      await addHand(page, nickname, 'Cash');

      const rows = [
        { date: ambiguousDay(twoAgo, 9), description: 'OPENING TRANSFER FROM SAVINGS', credit: '1,000.00', balance: '1,000.00' },
        { date: ambiguousDay(lastMonth, 2), description: 'SALARY EXAMPLE EMPLOYER', credit: '500.00', balance: '1,500.00' },
        { date: ambiguousDay(lastMonth, 4), description: 'CARD PURCHASE EXAMPLE SHOP 1234', debit: '40.00', balance: '1,460.00' },
        { date: ambiguousDay(lastMonth, 6), description: 'INTEREST PAID', credit: '0.50', balance: '1,460.50' },
        { date: ambiguousDay(lastMonth, 8), description: 'CHEQUE 1001', debit: '60.00', balance: '1,400.50' },
      ];
      const days = new Set(rows.map((r) => r.date)).size;
      const lastDay = rows.at(-1)!.date;
      await uploadInto(page, nickname, 'statement.csv', bankFile(rows));
      const row = handRow(page, nickname);
      const steps = row.getByRole('region', { name: `Import into ${nickname}`, exact: true });

      // The columns: the file's rows, the guess filled in, and the date format left for the admin.
      const columns = steps.getByRole('form', { name: 'Columns of the file' });
      await expect(steps.getByRole('region', { name: "The file's first 5 rows" }).getByRole('row')).toHaveCount(6);
      await expect(steps).toContainText('The columns are a guess from their names. Check each one.');
      await expect(columns.getByLabel('Date column')).toHaveValue('0');
      await expect(columns.getByLabel('Date format')).toHaveValue('');
      await expect(columns).toContainText('could be month first or day first');
      await expect(columns.getByLabel('Debit column (money out)')).toHaveValue('2');
      await expect(columns.getByLabel('Credit column (money in)')).toHaveValue('3');
      await expect(columns.getByLabel('Balance column')).toHaveValue('4');
      await columns.getByRole('button', { name: 'Next' }).click();
      await expect(columns.getByRole('alert')).toHaveText('Choose the date column and how its dates are written.');
      await columns.getByLabel('Date format').selectOption({ label: 'D/M/YYYY' });
      await columns.getByRole('button', { name: 'Next' }).click();

      // What rows mean: every group new, with the cash defaults picked; INTEREST PAID not counted.
      const groups = steps.getByRole('form', { name: `What rows mean for ${nickname}` });
      await expect(groups).toContainText('5 groups are new');
      await expect(groups.getByRole('combobox', { name: 'What INTEREST PAID … rows count as, new' })).toHaveValue('not_counted');
      await expect(groups.getByRole('combobox', { name: 'What CARD PURCHASE … rows count as, new' })).toHaveValue('by_sign');
      // Back to the columns and on again: the groups always show after the columns.
      await groups.getByRole('button', { name: 'Back to the columns' }).click();
      await expect(columns.getByLabel('Date format')).toHaveValue('dmy');
      await columns.getByRole('button', { name: 'Next' }).click();
      await groups.getByRole('button', { name: 'Next' }).click();

      const results = steps.getByRole('region', { name: `Results of the import into ${nickname}` });
      await expect(results).toContainText(`Adds 2 deposits, 2 withdrawals, and ${days} daily balances.`);
      await expect(results.getByRole('list', { name: 'What each group counts as' })).toContainText('INTEREST PAID … (1): not counted');
      await results.getByRole('button', { name: 'Import', exact: true }).click();
      await expect(toolsStatus(page, nickname)).toHaveText(`Imported statement.csv: 2 deposits, 2 withdrawals, and ${days} daily balances added.`);
      await expect(row).toContainText('Saved import settings: your own columns, 5 groups');
      await expect(row).toContainText(`Imported balance for ${dayLabel(lastDay)}`);

      // Last month, from the import: 1400.50 − 1000 − 500 + 100.
      await page.goto(`/savings?month=${lastMonth}`);
      const past = breakdownRow(page, handAccount(nickname));
      await expect(cell(past, 'Start')).toHaveText('$1,000.00');
      await expect(cell(past, 'Deposits')).toHaveText('$500.00');
      await expect(cell(past, 'Withdrawals')).toHaveText('$100.00');
      await expect(cell(past, 'Other change')).toContainText('+$0.50');
      await expect(cell(past, 'End')).toContainText('$1,400.50');
      await expect(cell(past, 'End')).toContainText(`Imported balance for ${dayLabel(lastDay)}`);

      // The graph's month-end totals come from the imported balances.
      await page.goto('/savings');
      await page.getByText('Show as a table').click();
      const ends = page.getByRole('table', { name: 'Month-end totals' });
      for (const m of [twoAgo, lastMonth]) await expect(ends.getByRole('row').filter({ hasText: monthLabel(m) })).toBeVisible();
      // This month has no import, so only its total change.
      await expect(breakdownRow(page, handAccount(nickname))).toContainText("No import covers this month, so this is the month's total change.");

      await removeHandWithData(page, nickname);
    });

    test('imports a Fidelity brokerage file straight to the results, adds only new rows from an overlapping file, and undoes them', async ({ page }, info) => {
      const stamp = newStamp(info);
      await signInAsNew(page, stamp, 'admin', ['savings']);
      const nickname = `Hand brokerage ${Math.random().toString(36).slice(2, 7)}`;
      const today = isoDay();
      const lastMonth = addMonths(today.slice(0, 7), -1);
      await addHand(page, nickname, 'Investment');

      // Last month's end, by hand, so this month's flows count against it.
      const row = handRow(page, nickname);
      await row.getByRole('button', { name: `Set balance for ${nickname}` }).click();
      const balance = row.getByRole('form', { name: `Set the balance of ${nickname}` });
      await balance.getByLabel('Balance').fill('25,000.00');
      await balance.getByLabel('For the day').fill(lastDayOf(lastMonth));
      await balance.getByRole('button', { name: 'Save balance' }).click();
      await expect(toolsStatus(page, nickname)).toHaveText(`Saved the balance for ${nickname}.`);
      await expect(row).toContainText(`Set by hand for ${dayLabel(lastDayOf(lastMonth))}`);
      await expect(row.getByRole('button', { name: `Set balance for ${nickname}` })).toBeFocused();

      const first = [
        { date: today, action: 'YOU SOLD EXAMPLE CORP (EXMP) (Margin)', amount: '500.00', balance: 'Processing' },
        { date: today, action: 'TRANSFERRED TO VS X00-000000-1 (Cash)', amount: '-200.00', balance: '-120.50' },
        { date: today, action: 'TRANSFERRED FROM VS X00-000000-1 (Cash)', amount: '1000.00', balance: '79.50' },
      ];
      await uploadInto(page, nickname, 'brokerage-1.csv', fidelityBrokerageFile(first));
      const steps = row.getByRole('region', { name: `Import into ${nickname}`, exact: true });
      const results = steps.getByRole('region', { name: `Results of the import into ${nickname}` });
      await expect(steps).toContainText('This looks like a Fidelity brokerage file');
      await expect(results).toContainText('Adds 1 deposit and 1 withdrawal.');
      await expect(results.getByRole('list', { name: 'What each group counts as' }).getByRole('listitem')).toHaveText([
        'TRANSFERRED FROM … (1): by sign', 'TRANSFERRED TO … (1): by sign', 'YOU SOLD … (1): not counted',
      ]);
      await results.getByRole('button', { name: 'Import', exact: true }).click();
      await expect(toolsStatus(page, nickname)).toHaveText('Imported brokerage-1.csv: 1 deposit and 1 withdrawal added.');
      await expect(row).toContainText('Saved import settings: Fidelity brokerage, 3 groups');

      // This month holds at last month's end: 0 − 1000 + 200 is Market change.
      await page.goto('/savings');
      const current = breakdownRow(page, handAccount(nickname));
      await expect(cell(current, 'Deposits')).toHaveText('$1,000.00');
      await expect(cell(current, 'Withdrawals')).toHaveText('$200.00');
      await expect(cell(current, 'Market change')).toContainText('−$800.00');

      // The same rows and one more: the saved settings fill everything in, and only the new row is added.
      await page.goto('/savings?tab=settings');
      await uploadInto(page, nickname, 'brokerage-2.csv', fidelityBrokerageFile([
        { date: today, action: 'DIRECT DEPOSIT EXAMPLE PAYROLL (Cash)', amount: '300.00', balance: '379.50' }, ...first,
      ]));
      await expect(steps).toContainText("Filled in from this account's saved import settings.");
      // The new kind of row waits for the admin, with the built-in rule picked.
      const groups = steps.getByRole('form', { name: `What rows mean for ${nickname}` });
      await expect(groups).toContainText('1 group is new');
      await expect(groups.getByRole('combobox', { name: 'What DIRECT DEPOSIT … rows count as, new' })).toHaveValue('by_sign');
      await expect(groups.getByRole('combobox', { name: 'What YOU SOLD … rows count as' })).toHaveValue('not_counted');
      await groups.getByRole('button', { name: 'Next' }).click();
      await expect(results).toContainText('Adds 1 deposit.');
      await expect(results).toContainText("Skipped, since they're already here or Plaid has them: 1 deposit and 1 withdrawal.");
      await results.getByRole('button', { name: 'Import', exact: true }).click();
      await expect(toolsStatus(page, nickname)).toHaveText('Imported brokerage-2.csv: 1 deposit added, 2 already here.');
      await page.goto('/savings');
      await expect(cell(breakdownRow(page, handAccount(nickname)), 'Deposits')).toHaveText('$1,300.00');

      // Undo the first: a later import skipped its rows, so it asks first. Keep it, then Undo anyway.
      await page.goto('/savings?tab=settings');
      await row.getByRole('button', { name: undoName('brokerage-1.csv', nickname) }).click();
      const confirm = row.getByRole('group', { name: undoName('brokerage-1.csv', nickname, '\\?') });
      await expect(confirm).toContainText('Undoing this also removes days a later import relied on; import that file again afterwards.');
      await confirm.getByRole('button', { name: /^Keep the import of brokerage-1\.csv/ }).click();
      await expect(confirm).toHaveCount(0);
      await row.getByRole('button', { name: undoName('brokerage-1.csv', nickname) }).click();
      await confirm.getByRole('button', { name: undoName('brokerage-1.csv', nickname, ' anyway') }).click();
      await expect(toolsStatus(page, nickname)).toHaveText(
        'Undid the import of brokerage-1.csv: removed 2 deposits and withdrawals. Undoing this also removes days a later import relied on; import that file again afterwards.',
      );
      // The later one has nothing after it: no question.
      await row.getByRole('button', { name: undoName('brokerage-2.csv', nickname) }).click();
      await expect(toolsStatus(page, nickname)).toHaveText('Undid the import of brokerage-2.csv: removed 1 deposit or withdrawal.');
      await expect(row.getByRole('list', { name: `Imports into ${nickname}` })).toHaveCount(0);

      // No import covers this month any more: the total change only.
      await page.goto('/savings');
      await expect(cell(breakdownRow(page, handAccount(nickname)), 'Deposits')).toHaveText('Not available');

      await removeHandWithData(page, nickname);
    });
  });
}
