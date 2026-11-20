import { devices, expect, test, type Page, type Route, type TestInfo } from '@playwright/test';

const MUTATION_HEADERS = { 'x-requested-with': 'dashboard', origin: 'http://localhost:3100' };

async function signIn(page: Page, email: string) {
  await page.context().clearCookies();
  const res = await page.request.post('/auth/test-login', { data: { email }, headers: MUTATION_HEADERS });
  expect(res.status()).toBe(204);
}

function newStamp(info: TestInfo): string {
  return `${info.titlePath[1]}-${info.repeatEachIndex}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Categories and rules are the family's, shared by every test, so the Spend tests run one at a
 * time in their own project (like the calendar's), at both sizes. A describe group can't set
 * `defaultBrowserType`; both devices are Chromium, which the project already uses.
 */
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
const mmddyyyy = (d: Date) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
const longDay = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/**
 * Long names (a big family, many cards) mustn't make the page scroll sideways on a phone. Against
 * the layout width, not `innerWidth`, which includes a vertical scrollbar.
 */
async function noSidewaysScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

/** The visually hidden line a screen reader hears the count from. */
const countLine = (page: Page, text: string | RegExp) => page.locator('[aria-live="polite"]').filter({ hasText: text });

/** Closes the tab as a person would (running beforeunload) and checks the page didn't ask first. */
async function closesWithoutAsking(page: Page) {
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.type());
    void d.accept();
  });
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => page.isClosed()).toBe(true);
  expect(dialogs).toEqual([]);
}

/** Reloads, accepting the browser's leave prompt if it asks. */
async function reloadAnyway(page: Page) {
  const accept = (d: import('@playwright/test').Dialog) => void d.accept();
  page.on('dialog', accept);
  await page.reload();
  page.off('dialog', accept);
}

/**
 * Holds requests to `url` with `method` until `release()`, then sends them on, or answers them
 * with `answer`. `held()` counts the requests caught so far. `stop()` lets the held ones go and
 * removes the route once they're handled.
 */
async function holdRequests(page: Page, url: string | RegExp, method: string, answer?: { status: number; json: unknown }) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const handled: Promise<void>[] = [];
  const handler = async (route: Route) => {
    if (route.request().method() !== method) return route.fallback();
    const done = (async () => {
      await gate;
      if (answer) await route.fulfill(answer);
      else await route.continue();
    })();
    handled.push(done);
    await done;
  };
  await page.route(url, handler);
  return {
    release: () => release(),
    held: () => handled.length,
    async stop() {
      release();
      await Promise.all(handled);
      await page.unroute(url, handler);
    },
  };
}

/**
 * A closing day 10 days from now, so the current cycle began about 20 days ago: the last 5 days are
 * in it, and 36 days ago is in the cycle before.
 */
function closingDay(): number {
  return localDay(10).getDate();
}

/**
 * A SYNTHETIC Bank of America credit-card activity CSV. Not a real export: its shape is what
 * docs/research/spend-plaid-csv.md §1 documents (the header, MM/DD/YYYY, purchases negative, a
 * 23-digit reference number, quoted and padded Payee and Address, a padded Amount, a quoted amount
 * with a thousands separator, and a TEMPRET temporary credit). Merchants carry the test's stamp, so
 * rules made here touch only this test's rows.
 */
function syntheticCsv(stamp: string) {
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
    `,TEMPRET,"${m.refund.padEnd(22)}","               ",     10.00`,
    line(-36, 6, m.coffee, 'OAKLAND CA', '-20.00'),
  ].join('\r\n');
  return { name: 'currentTransaction_1234.csv', buffer: Buffer.from(`${text}\r\n`, 'utf8'), merchants: m };
}

/** As the signed-in admin: a card through the API, and the synthetic CSV imported into it. */
async function cardWithTransactions(page: Page, stamp: string) {
  const created = await page.request.post('/api/panels/spend/cards', {
    data: { nickname: `Visa ${stamp}`, mask: '1234', included: true, usualClosingDay: closingDay() },
    headers: MUTATION_HEADERS,
  });
  expect(created.status()).toBe(201);
  const card = (await created.json()) as { id: number; nickname: string };
  const csv = syntheticCsv(stamp);
  const preview = await page.request.post('/api/panels/spend/imports', {
    multipart: { cardId: String(card.id), file: { name: csv.name, mimeType: 'text/csv', buffer: csv.buffer } },
    headers: MUTATION_HEADERS,
  });
  expect(preview.status()).toBe(201);
  const { id } = (await preview.json()) as { id: string };
  const commit = await page.request.post(`/api/panels/spend/imports/${id}/commit`, { data: { include: [2, 3, 4, 5, 6, 8] }, headers: MUTATION_HEADERS });
  expect(await commit.json()).toEqual({ imported: 6, skipped: 1 });
  return { card, merchants: csv.merchants, csv };
}

/**
 * A new admin with the Spend panel, signed in. Uploads are limited per admin (20 a minute), and
 * `--repeat-each` runs these tests back to back, so each test is its own admin.
 */
async function signInAsNewAdmin(page: Page, stamp: string): Promise<string> {
  await signIn(page, 'admin@example.com');
  const email = `spend-admin-${stamp}@example.com`;
  const res = await page.request.post('/api/admin/users', {
    data: { email, displayName: `Spend admin ${stamp}`, color: '#378ADD', role: 'admin', panels: ['spend'] },
    headers: MUTATION_HEADERS,
  });
  expect(res.status()).toBe(201);
  await signIn(page, email);
  return email;
}

async function createMember(page: Page, stamp: string, panels: string[]) {
  const member = { name: `Spender ${stamp}`, email: `spender-${stamp}@example.com` };
  const res = await page.request.post('/api/admin/users', {
    data: { email: member.email, displayName: member.name, color: '#1D9E75', role: 'member', panels },
    headers: MUTATION_HEADERS,
  });
  expect(res.status()).toBe(201);
  return member;
}

for (const sized of SIZES) {
  test.describe(sized.name, () => {
    test.use(sized.use);
    // Long flows, one at a time beside the other projects' tests: more than the default 30 seconds.
    test.describe.configure({ timeout: 90_000 });

    test('an admin adds a card and its closing day, imports a CSV after a preview, and importing it again skips every row', async ({ page }, info) => {
      const stamp = newStamp(info);
      const nickname = `Visa ${stamp}`;
      const csv = syntheticCsv(stamp);
      const admin = await signInAsNewAdmin(page, stamp);

      await page.goto('/spend?tab=settings');
      await expect(page.getByRole('navigation', { name: 'Spend views' }).getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
      const cards = page.getByRole('region', { name: 'Cards' });
      await cards.getByRole('button', { name: 'New card' }).click();
      const form = cards.getByRole('form', { name: 'New card' });
      await expect(form.getByLabel('Nickname')).toBeFocused();
      await form.getByLabel('Nickname').fill(nickname);
      await form.getByLabel('Last 4 (optional)').fill('1234');
      await form.getByLabel('Usual closing day').selectOption(String(closingDay()));
      await form.getByRole('button', { name: 'Add card' }).click();
      await expect(cards.getByRole('status')).toHaveText(`Saved ${nickname}.`);
      await expect(cards.getByRole('button', { name: 'New card' })).toBeFocused();
      await expect(cards.getByRole('listitem').filter({ hasText: nickname })).toContainText(`Closes on day ${closingDay()} · 0 transactions`);

      // Preview: 7 rows, 5 days of dates, and the temporary credit that can't be imported yet.
      const importer = page.getByRole('region', { name: 'Import a CSV' });
      await importer.getByLabel('Card').selectOption({ label: `${nickname} ·1234` });
      await importer.getByLabel('Bank of America CSV').setInputFiles({ name: csv.name, mimeType: 'text/csv', buffer: csv.buffer });
      await importer.getByRole('button', { name: 'Preview' }).click();
      await expect(importer.getByRole('heading', { name: `${csv.name} for ${nickname} ·1234` })).toBeFocused();
      await expect(importer.getByText(`7 rows, ${longDay(localDay(-36))} to ${longDay(localDay(-1))}. 1 can't be imported.`)).toBeVisible();
      const rows = importer.getByRole('group', { name: 'Rows to import' });
      await expect(rows.getByRole('checkbox')).toHaveCount(6);
      await expect(rows.getByRole('checkbox', { checked: true })).toHaveCount(6);
      await expect(importer.getByRole('region', { name: "Rows that can't be imported" })).toContainText('Line 7');
      await expect(importer.getByRole('region', { name: "Rows that can't be imported" })).toContainText("A temporary credit that hasn't posted yet.");
      await importer.getByRole('button', { name: 'Import 6 rows' }).click();
      await expect(importer.getByRole('status')).toHaveText('Imported 6 rows. 1 skipped.');

      // The totals: the payment isn't counted (the seeded rule), and the refund subtracts.
      const list = (await (await page.request.get('/api/panels/spend/cards')).json()) as { id: number; nickname: string }[];
      const card = list.find((c) => c.nickname === nickname)!;
      await page.goto(`/spend?card=${card.id}`);
      const totals = page.getByRole('region', { name: /to .*\d{4}$/ });
      await expect(totals.getByText('$1,237.79')).toBeVisible();
      await expect(totals.getByText('Up $1,217.79 from last cycle ($20.00)')).toBeVisible();
      const payment = page.getByRole('combobox', { name: `Category for ${csv.merchants.payment}, ${longDay(localDay(-2))}, -$500.00` });
      await expect(payment.locator('option:checked')).toHaveText('Payments and transfers');
      const byCategory = page.getByRole('region', { name: 'By category' });
      await expect(byCategory.getByRole('row', { name: /Uncategorized/ })).toContainText('$1,237.79');
      await expect(byCategory.getByRole('row', { name: /Uncategorized/ })).toContainText('$20.00');

      // The home card shows the card's cycle total.
      await page.goto('/');
      const home = page.getByRole('region', { name: 'Spend' });
      await expect(home.getByRole('listitem').filter({ hasText: nickname })).toContainText('$1,237.79');
      await expect(home.getByRole('listitem').filter({ hasText: nickname })).toContainText('Updated just now');

      // The same file again: every row is already imported, so nothing can be.
      await page.goto('/spend?tab=settings');
      await importer.getByLabel('Card').selectOption({ label: `${nickname} ·1234` });
      await importer.getByLabel('Bank of America CSV').setInputFiles({ name: csv.name, mimeType: 'text/csv', buffer: csv.buffer });
      await importer.getByRole('button', { name: 'Preview' }).click();
      await expect(importer.getByText("7 rows. 7 can't be imported.")).toBeVisible();
      await expect(importer.getByRole('region', { name: "Rows that can't be imported" }).getByText(/Already imported/)).toHaveCount(6);
      await expect(importer.getByRole('button', { name: 'Import 0 rows' })).toBeDisabled();
      await noSidewaysScroll(page);
      await importer.getByRole('button', { name: 'Cancel' }).click();
      await expect(importer.getByRole('status')).toHaveText('Import cancelled. Nothing was saved.');

      // Nothing scrolls sideways on the narrowest phones either.
      await page.setViewportSize({ width: 320, height: 800 });
      await noSidewaysScroll(page);
      await page.goto(`/spend?card=${card.id}`);
      await expect(totals.getByText('$1,237.79')).toBeVisible();
      await noSidewaysScroll(page);
    });

    test('anyone with Spend edits a category and person in place; an admin makes a rule from a transaction and applies it to past ones', async ({ page }, info) => {
      const stamp = newStamp(info);
      const admin = await signInAsNewAdmin(page, stamp);
      const { card, merchants } = await cardWithTransactions(page, stamp);
      const member = await createMember(page, stamp, ['spend']);
      const day = (n: number) => longDay(localDay(n));

      await signIn(page, member.email);
      await page.goto(`/spend?card=${card.id}`);
      await expect(page.getByRole('navigation', { name: 'Spend views' })).toHaveCount(0);
      // Each row's controls are named by merchant, date, and amount.
      const g = `${merchants.groceries}, ${day(-4)}, $1,234.56`;
      const c = `${merchants.coffee}, ${day(-5)}, $12.74`;
      const groceries = page.getByRole('combobox', { name: `Category for ${g}` });
      const person = page.getByRole('combobox', { name: `Person for ${g}` });
      const coffee = page.getByRole('combobox', { name: `Category for ${c}` });
      const bar = page.getByRole('region', { name: 'Unsaved changes' });
      // Arrowing through the options saves nothing, and neither does picking one: only the one Save sends anything.
      const patches: string[] = [];
      page.on('request', (r) => {
        if (r.method() === 'PATCH' && r.url().includes('/api/panels/spend/transactions')) patches.push(r.url());
      });
      const before = await groceries.inputValue();
      const atEnd = await groceries.evaluate((s: HTMLSelectElement) => s.selectedIndex === s.options.length - 1);
      await groceries.focus();
      await page.keyboard.press(atEnd ? 'ArrowUp' : 'ArrowDown');
      await expect(groceries).not.toHaveValue(before);
      await page.keyboard.press(atEnd ? 'ArrowDown' : 'ArrowUp');
      await expect(groceries).toHaveValue(before);
      // Back on the saved value, there's nothing to save.
      await expect(bar).toHaveCount(0);
      await groceries.selectOption({ label: 'Groceries' });
      await expect(groceries).toHaveAccessibleDescription('Changed, not saved');
      await expect(bar.getByRole('button', { name: 'Save 1 change' })).toBeVisible();
      // Three fields across two rows: N counts fields, not rows.
      await person.selectOption({ label: member.name });
      await coffee.selectOption({ label: 'Dining' });
      await expect(bar.getByRole('button', { name: 'Save 3 changes' })).toBeVisible();
      await expect(countLine(page, /^3 unsaved changes\.$/)).toHaveCount(1);
      await expect(page.getByRole('region', { name: 'By category' }).getByRole('row', { name: /Groceries/ })).toHaveCount(0);
      expect(patches).toHaveLength(0);
      await bar.getByRole('button', { name: 'Save 3 changes' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toHaveText('Saved 3 changes.');
      expect(patches).toEqual([expect.stringMatching(/\/api\/panels\/spend\/transactions$/)]);
      // The bar goes, and focus goes to the heading, not the page.
      await expect(bar).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Transactions' })).toBeFocused();
      await expect(groceries.locator('option:checked')).toHaveText('Groceries');
      await expect(groceries).toHaveAccessibleDescription('Set by hand');
      await expect(person.locator('option:checked')).toHaveText(member.name);
      await expect(coffee).toHaveAccessibleDescription('Set by hand');
      await expect(page.getByRole('region', { name: 'By category' }).getByRole('row', { name: /Groceries/ })).toContainText('$1,234.56');
      await expect(page.getByRole('region', { name: 'By category' }).getByRole('row', { name: /Dining/ })).toContainText('$12.74');
      await expect(page.getByRole('region', { name: 'By person' }).getByRole('row', { name: new RegExp(member.name) })).toContainText('$1,234.56');

      // A note.
      await page.getByRole('button', { name: `Add a note to ${g}` }).click();
      const noteDialog = page.getByRole('dialog', { name: 'Note' });
      await noteDialog.getByLabel('Note').fill('Thanksgiving');
      await noteDialog.getByRole('button', { name: 'Save note' }).click();
      await expect(noteDialog).toHaveCount(0);
      await expect(page.getByRole('button', { name: `Edit the note on ${g}` })).toBeFocused();
      await expect(page.getByText('Thanksgiving')).toBeVisible();

      // Remove rule acts at once: the category and the person are decided again (Uncategorized,
      // Household), and the row's unsaved pick goes too.
      await person.selectOption({ label: 'Household' });
      await expect(bar.getByRole('button', { name: 'Save 1 change' })).toBeVisible();
      await page.getByRole('button', { name: `Remove rule from ${g}` }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Rule removed' })).toHaveText(`Rule removed: ${merchants.groceries}.`);
      await expect(groceries.locator('option:checked')).toHaveText('Uncategorized');
      await expect(person.locator('option:checked')).toHaveText('Household');
      await expect(bar).toHaveCount(0);
      await expect(groceries).toBeFocused();
      expect(patches).toHaveLength(2);

      // An admin: Add rule, applied to past transactions, including last cycle's.
      await signIn(page, admin);
      await page.goto(`/spend?card=${card.id}`);
      await noSidewaysScroll(page);
      // The rule starts from what the row shows: its saved category and the person picked but not saved.
      const coffeePerson = page.getByRole('combobox', { name: `Person for ${c}` });
      await coffeePerson.selectOption({ label: member.name });
      await expect(bar.getByRole('button', { name: 'Save 1 change' })).toBeVisible();
      await page.getByRole('button', { name: `Add rule for ${c}` }).click();
      const dialog = page.getByRole('dialog', { name: 'Add rule' });
      await expect(dialog.getByLabel('Text to match')).toHaveValue(merchants.coffee);
      await expect(dialog.getByLabel('Set the category').locator('option:checked')).toHaveText('Dining');
      await expect(dialog.getByLabel('Set the person').locator('option:checked')).toHaveText(member.name);
      await expect(dialog.getByRole('checkbox', { name: /Apply to past transactions too/ })).toBeChecked();
      await dialog.getByRole('button', { name: 'Save rule' }).click();
      await expect(dialog).toHaveCount(0);
      // Both coffees change; the one set by hand keeps its category, and gets the rule's person.
      await expect(page.getByRole('status').filter({ hasText: 'Rule added' })).toHaveText('Rule added. 2 transactions changed.');
      await expect(page.getByRole('button', { name: `Add rule for ${c}` })).toBeFocused();
      await expect(coffee).toHaveAccessibleDescription('Set by hand');
      await expect(coffeePerson.locator('option:checked')).toHaveText(member.name);
      // The rule saved what the unsaved pick held, so there's nothing left to save, and the page says why it went.
      await expect(coffeePerson).toHaveAccessibleDescription('By a rule');
      await expect(bar).toHaveCount(0);
      await expect(page.getByText("1 unsaved change now matches what's saved, so it was cleared.")).toBeVisible();

      await page.getByRole('combobox', { name: 'Cycle' }).selectOption({ index: 1 });
      const lastCycle = page.getByRole('combobox', { name: `Category for ${merchants.coffee}, ${day(-36)}, $20.00` });
      await expect(lastCycle.locator('option:checked')).toHaveText('Dining');
      await expect(lastCycle).toHaveAccessibleDescription('By a rule');
      await expect(page).toHaveURL(/cycle=\d{4}-\d{2}-\d{2}/);
      // A past cycle's breakdown is headed with its dates, not "This cycle".
      const pastCycle = page.getByRole('region', { name: 'By category' });
      await expect(pastCycle.getByRole('columnheader').nth(1)).toHaveText(/^\w{3} \d{1,2}(, \d{4})? to \w{3} \d{1,2}, \d{4}$/);
      await expect(pastCycle.getByRole('columnheader', { name: 'This cycle' })).toHaveCount(0);

      // A bar filters the table.
      await page.getByRole('combobox', { name: 'Cycle' }).selectOption({ index: 0 });
      await expect(page).not.toHaveURL(/cycle=/);
      await page.getByRole('region', { name: 'By category' }).getByRole('button', { name: 'Dining' }).click();
      await expect(page.getByRole('region', { name: 'By category' }).getByRole('button', { name: 'Dining' })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByText(/^Showing 1 of 5 transactions\.$/)).toBeVisible();
      await expect(page.getByRole('combobox', { name: /^Category for / })).toHaveCount(1);

      // A pick doesn't move the row out of the filter (it isn't saved); a save that does says so, and focus goes to the heading.
      await coffee.selectOption({ label: 'Groceries' });
      await expect(page.getByText(/^Showing 1 of 5 transactions\.$/)).toBeVisible();
      await bar.getByRole('button', { name: 'Save 1 change' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toHaveText("Saved 1 change. 1 transaction no longer matches the filter, so it's hidden.");
      await expect(page.getByRole('heading', { name: 'Transactions' })).toBeFocused();
      await expect(page.getByText(/^Showing 0 of 5 transactions\.$/)).toBeVisible();
      // Saved: closing the tab doesn't ask.
      await closesWithoutAsking(page);
    });

    test('the breakdowns draw a donut with its table, folding the smallest into Other; a slice filters; the current cycle says where it is headed', async ({ page }, info) => {
      const stamp = newStamp(info);
      await signInAsNewAdmin(page, stamp);
      const { card, merchants } = await cardWithTransactions(page, stamp);
      type Overview = { cycle: { start: string; end: string }; transactions: { id: number; merchant: string }[] };
      const overview = (await (await page.request.get(`/api/panels/spend/overview?card=${card.id}`)).json()) as Overview;
      const idOf = (merchant: string) => overview.transactions.find((t) => t.merchant === merchant)!.id;
      const category = async (name: string) =>
        ((await (await page.request.post('/api/panels/spend/categories', { data: { name: `${name} ${stamp}` }, headers: MUTATION_HEADERS })).json()) as { id: number }).id;
      // Food $1,234.56 is 98% of the $1,262.79 drawn; Streaming $15.49 and Coffee $12.74 are 2.2% together, so they're Other.
      // Gear is the -$25.00 refund: in the table, not the donut. The payment stays in Payments and transfers, left out.
      const ids = { food: await category('Food'), streaming: await category('Streaming'), coffee: await category('Coffee'), gear: await category('Gear') };
      const saved = await page.request.patch('/api/panels/spend/transactions', {
        data: {
          changes: [
            { id: idOf(merchants.groceries), categoryId: ids.food },
            { id: idOf(merchants.netflix), categoryId: ids.streaming },
            { id: idOf(merchants.coffee), categoryId: ids.coffee },
            { id: idOf(merchants.refund), categoryId: ids.gear },
          ],
        },
        headers: MUTATION_HEADERS,
      });
      expect(saved.ok()).toBe(true);

      await page.goto(`/spend?card=${card.id}`);
      const byCategory = page.getByRole('region', { name: 'By category' });
      await expect(byCategory.getByRole('img', { name: `Spending by category, this cycle: Food ${stamp} 98%, Other 2%.` })).toBeVisible();
      await expect(byCategory.locator('path[data-slice]')).toHaveCount(2);
      const table = byCategory.getByRole('table');
      await expect(table.getByRole('columnheader')).toHaveText(['Name', 'This cycle', 'Share', 'Last cycle']);
      await expect(table.getByRole('row', { name: new RegExp(`^Food ${stamp}`) })).toContainText('$1,234.56');
      await expect(table.getByRole('row', { name: new RegExp(`^Food ${stamp}`) })).toContainText('98%');
      const other = table.getByRole('row', { name: /^Other/ });
      await expect(other).toContainText('(2 smaller)');
      await expect(other).toContainText('$28.23');
      await expect(other).toContainText('2%');
      // Other's members are still listed, each its own filter, largest first.
      await expect(table.getByRole('button', { name: `Streaming ${stamp}` })).toBeVisible();
      await expect(table.getByRole('button', { name: `Coffee ${stamp}` })).toBeVisible();
      await expect(table.getByRole('row', { name: new RegExp(`^Gear ${stamp}`) })).toContainText('Not in the chart');
      // By person: everything is Household, so one whole ring.
      const byPerson = page.getByRole('region', { name: 'By person' });
      await expect(byPerson.getByRole('img', { name: 'Spending by person, this cycle: Household 100%.' })).toBeVisible();

      // A slice filters the table like its name does, and again turns it off.
      const food = byCategory.locator(`path[data-slice="Food ${stamp}"]`);
      const box = (await food.boundingBox())!;
      // At 9 o'clock on the ring: the box's middle is the donut's hole.
      await food.click({ position: { x: 6, y: box.height / 2 } });
      await expect(table.getByRole('button', { name: `Food ${stamp}` })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByText(/^Showing 1 of 5 transactions\.$/)).toBeVisible();
      await food.click({ position: { x: 6, y: box.height / 2 } });
      await expect(table.getByRole('button', { name: `Food ${stamp}` })).toHaveAttribute('aria-pressed', 'false');
      await expect(page.getByText(/^5 transactions\.$/)).toBeVisible();
      // A name inside Other filters too.
      await table.getByRole('button', { name: `Coffee ${stamp}` }).click();
      await expect(table.getByRole('button', { name: `Coffee ${stamp}` })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByText(/^Showing 1 of 5 transactions\.$/)).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`category=${ids.coffee}`));
      await noSidewaysScroll(page);

      // On track: $1,237.79 so far, over the days elapsed (today counts), times the cycle's days.
      const day = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;
      const today = localDay(0);
      const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      const { start, end } = overview.cycle;
      const elapsed = day(todayIso) - day(start) + 1;
      expect(elapsed).toBeGreaterThan(1);
      const projected = Math.round((123_779 / elapsed) * (day(end) - day(start) + 1)) / 100;
      const endDay = new Date(`${end}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
      const onTrack = `On track for ${projected.toLocaleString('en-US', { style: 'currency', currency: 'USD' })} by ${endDay}`;
      const totals = page.getByRole('region', { name: /to .*\d{4}$/ });
      await expect(totals.getByText(onTrack, { exact: true })).toBeVisible();
      // Not for a past cycle.
      await page.getByRole('combobox', { name: 'Cycle' }).selectOption({ index: 1 });
      await expect(page).toHaveURL(/cycle=\d{4}-\d{2}-\d{2}/);
      await expect(page.getByText(/^On track for/)).toHaveCount(0);
      // The home card says it too, for the current cycle.
      await page.goto('/');
      await expect(page.getByRole('region', { name: 'Spend' }).getByRole('listitem').filter({ hasText: `Visa ${stamp}` })).toContainText(onTrack);
    });

    test("members don't get Spend settings; the checking export is refused; categories move from the keyboard", async ({ page }, info) => {
      const stamp = newStamp(info);
      const admin = await signInAsNewAdmin(page, stamp);
      const member = await createMember(page, stamp, ['spend']);

      await signIn(page, member.email);
      await page.goto('/spend?tab=settings');
      await expect(page.getByRole('navigation', { name: 'Spend views' })).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'Import a CSV' })).toHaveCount(0);
      const refused = await page.request.post('/api/panels/spend/cards', { data: { nickname: 'X', mask: '', included: true, usualClosingDay: null }, headers: MUTATION_HEADERS });
      expect(refused.status()).toBe(403);

      await signIn(page, admin);
      const created = await page.request.post('/api/panels/spend/cards', {
        data: { nickname: `Amex ${stamp}`, mask: '', included: true, usualClosingDay: null },
        headers: MUTATION_HEADERS,
      });
      expect(created.status()).toBe(201);
      await page.goto('/spend?tab=settings');
      const importer = page.getByRole('region', { name: 'Import a CSV' });
      await importer.getByLabel('Card').selectOption({ label: `Amex ${stamp}` });
      const checking = 'Description,,Summary Amt.\r\nBeginning balance as of 10/01/2026,,"1,000.00"\r\n\r\nDate,Description,Amount,Running Bal.\r\n';
      await importer.getByLabel('Bank of America CSV').setInputFiles({ name: 'stmt.csv', mimeType: 'text/csv', buffer: Buffer.from(checking) });
      await importer.getByRole('button', { name: 'Preview' }).click();
      await expect(importer.getByRole('alert')).toHaveText('This is a Bank of America checking or savings export. Only credit-card activity can be imported.');

      // A new category goes last; Move up moves it, and focus stays on the button.
      const categories = page.getByRole('region', { name: 'Categories', exact: true });
      const name = `Pets ${stamp}`;
      const newName = categories.getByRole('textbox', { name: 'New category' });
      await newName.fill(name);
      await categories.getByRole('button', { name: 'Add category' }).click();
      await expect(categories.getByRole('status')).toHaveText(`Saved ${name}.`);
      // Ready for the next one.
      await expect(newName).toBeFocused();
      await expect(newName).toHaveValue('');
      const items = categories.getByRole('listitem');
      await expect(items.last()).toContainText(name);
      const count = await items.count();
      const up = categories.getByRole('button', { name: `Move ${name} up` });
      await up.focus();
      await page.keyboard.press('Enter');
      await expect(categories.getByRole('status')).toHaveText(`Moved ${name} up. It's now ${count - 1} of ${count}.`);
      await expect(items.nth(count - 2)).toContainText(name);
      await expect(up).toBeFocused();
      // Back down to the end, where Move down is disabled: focus goes to Move up.
      const down = categories.getByRole('button', { name: `Move ${name} down` });
      await down.focus();
      await page.keyboard.press('Enter');
      await expect(categories.getByRole('status')).toHaveText(`Moved ${name} down. It's now ${count} of ${count}.`);
      await expect(items.last()).toContainText(name);
      await expect(down).toBeDisabled();
      await expect(up).toBeFocused();

      // A failed add leaves focus on the button, and says why.
      await newName.fill(name.toUpperCase());
      const add = categories.getByRole('button', { name: 'Add category' });
      await add.click();
      await expect(categories.getByRole('alert')).toHaveText(`Couldn't add ${name.toUpperCase()}. There is already a category with that name.`);
      await expect(add).toBeFocused();
      await newName.fill('');

      // Archive and unarchive say so, and the badge is its own word.
      await categories.getByRole('button', { name: `Archive ${name}` }).click();
      await expect(categories.getByRole('status')).toHaveText(`Archived ${name}.`);
      await expect(categories.getByRole('button', { name: `Unarchive ${name}` })).toBeFocused();
      await expect(items.filter({ hasText: name })).toContainText(`${name} Archived`);
      await categories.getByRole('button', { name: `Unarchive ${name}` }).click();
      await expect(categories.getByRole('status')).toHaveText(`Unarchived ${name}.`);
      page.once('dialog', (d) => void d.accept());
      await categories.getByRole('button', { name: `Delete ${name}` }).click();
      await expect(categories.getByRole('status')).toHaveText(`Deleted ${name}.`);
      await expect(items.filter({ hasText: name })).toHaveCount(0);
      await expect(categories.getByRole('heading', { name: 'Categories' })).toBeFocused();
    });

    test('a rule made with a filter on hides the rows it moves out, says so, and focus goes on to the next row; the card and cycle pickers add no history', async ({ page }, info) => {
      const stamp = newStamp(info);
      await signInAsNewAdmin(page, stamp);
      const { card, merchants } = await cardWithTransactions(page, stamp);
      const day = (n: number) => longDay(localDay(n));

      await page.goto('/');
      await page.goto(`/spend?card=${card.id}`);
      // Arrowing through cycles replaces the address, so Back leaves the page.
      await page.getByRole('combobox', { name: 'Cycle' }).selectOption({ index: 1 });
      await expect(page).toHaveURL(/cycle=/);
      await page.getByRole('combobox', { name: 'Cycle' }).selectOption({ index: 0 });
      await expect(page).not.toHaveURL(/cycle=/);
      await page.goBack();
      await expect(page).toHaveURL(/\/$/);
      await page.goForward();
      await expect(page).toHaveURL(new RegExp(`/spend\\?card=${card.id}$`));

      // Uncategorized, newest first: the refund, Netflix, the groceries, the coffee.
      await page.getByRole('combobox', { name: 'Category', exact: true }).selectOption({ label: 'Uncategorized' });
      await expect(page.getByText(/^Showing 4 of 5 transactions\.$/)).toBeVisible();
      const n = `${merchants.netflix}, ${day(-3)}, $15.49`;
      await page.getByRole('button', { name: `Add rule for ${n}` }).click();
      const dialog = page.getByRole('dialog', { name: 'Add rule' });
      await dialog.getByLabel('Set the category').selectOption({ label: 'Dining' });
      await dialog.getByRole('button', { name: 'Save rule' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole('status').filter({ hasText: 'Rule added' })).toHaveText('Rule added. 1 transaction changed. It no longer matches the filter, so it is hidden.');
      await expect(page.getByText(/^Showing 3 of 5 transactions\.$/)).toBeVisible();
      await expect(page.getByRole('combobox', { name: `Category for ${merchants.groceries}, ${day(-4)}, $1,234.56` })).toBeFocused();
    });

    test("a slow save keeps a newer pick and doesn't pull focus back; a note that fails after its dialog closed still says so", async ({ page }, info) => {
      const stamp = newStamp(info);
      await signInAsNewAdmin(page, stamp);
      const { card, merchants } = await cardWithTransactions(page, stamp);
      const member = await createMember(page, stamp, ['spend']);
      const day = (n: number) => longDay(localDay(n));
      const people = (await (await page.request.get('/api/panels/spend/people')).json()) as { id: number; displayName: string }[];
      const memberId = people.find((p) => p.displayName === member.name)!.id;
      const overview = (await (await page.request.get(`/api/panels/spend/overview?card=${card.id}`)).json()) as { transactions: { id: number; merchant: string }[] };
      const groceriesId = overview.transactions.find((t) => t.merchant === merchants.groceries)!.id;
      const set = await page.request.patch(`/api/panels/spend/transactions/${groceriesId}`, { data: { personUserId: memberId }, headers: MUTATION_HEADERS });
      expect(set.status()).toBe(200);

      // Before the people list loads, a row's person still shows.
      const peopleLoad = await holdRequests(page, '**/api/panels/spend/people', 'GET');
      await page.goto(`/spend?card=${card.id}`);
      const g = `${merchants.groceries}, ${day(-4)}, $1,234.56`;
      await expect.poll(peopleLoad.held).toBeGreaterThan(0);
      await expect(page.getByRole('combobox', { name: `Person for ${g}` }).locator('option:checked')).toHaveText(member.name);
      await peopleLoad.stop();

      // Only the person was set by hand, so Reset resets only the person: the category's pick stays.
      const groceries = page.getByRole('combobox', { name: `Category for ${g}` });
      const bar = page.getByRole('region', { name: 'Unsaved changes' });
      await groceries.selectOption({ label: 'Dining' });
      await page.getByRole('button', { name: `Remove rule from ${g}` }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Rule removed' })).toHaveText(`Rule removed: ${merchants.groceries}.`);
      await expect(page.getByRole('combobox', { name: `Person for ${g}` }).locator('option:checked')).toHaveText('Household');
      await expect(groceries.locator('option:checked')).toHaveText('Dining');
      await expect(groceries).toHaveAccessibleDescription('Changed, not saved');
      await expect(bar.getByRole('button', { name: 'Save 1 change' })).toBeVisible();
      await groceries.selectOption({ label: 'Uncategorized' });
      await expect(bar).toHaveCount(0);

      // A pick made while a save is out stays, for the next Save; focus moved elsewhere meanwhile stays there.
      const save = await holdRequests(page, '**/api/panels/spend/transactions', 'PATCH');
      await groceries.selectOption({ label: 'Groceries' });
      await bar.getByRole('button', { name: 'Save 1 change' }).click();
      await expect.poll(save.held).toBe(1);
      await expect(bar.getByRole('button', { name: 'Save 1 change' })).toHaveAttribute('aria-disabled', 'true');
      await expect(bar.getByText('Saving…')).toBeVisible();
      await expect(countLine(page, /^Saving 1 change…$/)).toHaveCount(1);
      // The picker stays usable while the save is out.
      await groceries.selectOption({ label: 'Dining' });
      const search = page.getByRole('searchbox', { name: 'Merchant' });
      await search.focus();
      save.release();
      await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toHaveText('Saved 1 change.');
      await expect(groceries).toHaveAccessibleDescription('Changed, not saved');
      await expect(groceries.locator('option:checked')).toHaveText('Dining');
      await expect(bar.getByRole('button', { name: 'Save 1 change' })).toHaveAttribute('aria-disabled', 'false');
      await expect(search).toBeFocused();
      await save.stop();
      // What was saved is Groceries, set by hand.
      const saved = (await (await page.request.get(`/api/panels/spend/overview?card=${card.id}`)).json()) as { transactions: { id: number; category: { name: string }; categorySource: string }[] };
      expect(saved.transactions.find((t) => t.id === groceriesId)).toMatchObject({ category: { name: 'Groceries' }, categorySource: 'manual' });
      await bar.getByRole('button', { name: 'Discard changes' }).click();
      await expect(groceries.locator('option:checked')).toHaveText('Groceries');
      await expect(groceries).toHaveAccessibleDescription('Set by hand');

      // A note save that fails after its dialog was closed shows above the table.
      const broken = await holdRequests(page, '**/api/panels/spend/transactions/*', 'PATCH', {
        status: 500,
        json: { error: { code: 'internal', message: 'Something went wrong. Try again.' } },
      });
      const n = `${merchants.netflix}, ${day(-3)}, $15.49`;
      await page.getByRole('button', { name: `Add a note to ${n}` }).click();
      const noteDialog = page.getByRole('dialog', { name: 'Note' });
      await noteDialog.getByLabel('Note').fill('Family plan');
      await noteDialog.getByRole('button', { name: 'Save note' }).click();
      await expect.poll(broken.held).toBe(1);
      page.once('dialog', (d) => void d.accept());
      await noteDialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(noteDialog).toHaveCount(0);
      broken.release();
      await expect(page.getByRole('region', { name: 'Transactions' }).getByRole('alert')).toHaveText(
        `Couldn't save the change to ${merchants.netflix}. Something went wrong. Try again.`,
      );
      await broken.stop();
      // Discarded earlier and nothing picked since: closing the tab doesn't ask.
      await closesWithoutAsking(page);
    });

    test('unsaved picks outlive a search, a cycle, and a reload, and are still saved; a failed save keeps them; Discard drops them; leaving asks first', async ({ page }, info) => {
      const stamp = newStamp(info);
      await signInAsNewAdmin(page, stamp);
      const { card, merchants } = await cardWithTransactions(page, stamp);
      const other = await page.request.post('/api/panels/spend/cards', {
        data: { nickname: `Amex ${stamp}`, mask: '', included: true, usualClosingDay: null },
        headers: MUTATION_HEADERS,
      });
      expect(other.status()).toBe(201);
      const amex = (await other.json()) as { id: number; nickname: string };
      const day = (n: number) => longDay(localDay(n));
      const categoryOf = async (merchant: string) => {
        const o = (await (await page.request.get(`/api/panels/spend/overview?card=${card.id}`)).json()) as { transactions: { merchant: string; category: { name: string } }[] };
        return o.transactions.find((t) => t.merchant === merchant)!.category.name;
      };
      const patches: string[] = [];
      page.on('request', (r) => {
        if (r.method() === 'PATCH' && r.url().includes('/api/panels/spend/transactions')) patches.push(r.url());
      });

      await page.goto(`/spend?card=${card.id}`);
      const bar = page.getByRole('region', { name: 'Unsaved changes' });
      const save = (n: number) => bar.getByRole('button', { name: new RegExp(`^Save ${n} change${n === 1 ? '' : 's'}( \\(\\d+ not shown\\))?$`) });
      const netflix = page.getByRole('combobox', { name: `Category for ${merchants.netflix}, ${day(-3)}, $15.49` });
      const coffee = page.getByRole('combobox', { name: `Category for ${merchants.coffee}, ${day(-5)}, $12.74` });
      await netflix.selectOption({ label: 'Subscriptions' });
      await expect(save(1)).toHaveText('Save 1 change');
      await expect(countLine(page, /^1 unsaved change\.$/)).toHaveCount(1);

      // A search hides the edited row; its pick still counts, and the bar says it isn't shown.
      await page.getByRole('searchbox', { name: 'Merchant' }).fill('blue bottle');
      await expect(page.getByText(/^Showing 1 of 5 transactions\.$/)).toBeVisible();
      await expect(netflix).toHaveCount(0);
      await expect(save(1)).toHaveText('Save 1 change (1 not shown)');
      await coffee.selectOption({ label: 'Dining' });
      await expect(save(2)).toHaveText('Save 2 changes (1 not shown)');
      // Another cycle of the same card keeps them too.
      await page.getByRole('combobox', { name: 'Cycle' }).selectOption({ index: 1 });
      await expect(page.getByRole('combobox', { name: `Category for ${merchants.coffee}, ${day(-36)}, $20.00` })).toBeVisible();
      await expect(save(2)).toHaveText('Save 2 changes (2 not shown)');
      await page.getByRole('combobox', { name: 'Cycle' }).selectOption({ index: 0 });
      await expect(coffee.locator('option:checked')).toHaveText('Dining');
      await expect(coffee).toHaveAccessibleDescription('Changed, not saved');

      // So does a reload: they're kept for this tab. (The search reaches the address a moment after typing.)
      await expect(page).toHaveURL(/q=blue/);
      await reloadAnyway(page);
      await expect(save(2)).toHaveText('Save 2 changes (1 not shown)');
      await expect(coffee.locator('option:checked')).toHaveText('Dining');
      await expect(coffee).toHaveAccessibleDescription('Changed, not saved');

      // Nothing scrolls sideways at 320 px with the bar showing, and the bar never covers the last row.
      await page.getByRole('searchbox', { name: 'Merchant' }).fill('');
      await expect(page.getByText(/^5 transactions\.$/)).toBeVisible();
      await page.setViewportSize({ width: 320, height: 800 });
      await expect(page.getByRole('list', { name: 'Transactions' })).toBeVisible();
      await noSidewaysScroll(page);
      // Held to the bottom of the screen while the list scrolls under it.
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect(bar).toBeInViewport();
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const lastRow = page.locator('.spend-list-item, .spend-table tbody tr').last();
      await expect(lastRow).toBeInViewport();
      const [rowBox, barBox] = [await lastRow.boundingBox(), await bar.boundingBox()];
      expect(rowBox!.y + rowBox!.height).toBeLessThanOrEqual(barBox!.y + 1);
      await page.setViewportSize(sized.use.viewport);

      // A failed save saves nothing, keeps every pick, and focus goes to the message (focused, not also an alert).
      const broken = await holdRequests(page, '**/api/panels/spend/transactions', 'PATCH', {
        status: 500,
        json: { error: { code: 'internal', message: 'Something went wrong. Try again.' } },
      });
      broken.release();
      await save(2).click();
      const failed = bar.locator('p.error');
      await expect(failed).toHaveText('Nothing was saved. Something went wrong. Try again.');
      await expect(failed).toBeFocused();
      await expect(bar.getByRole('alert')).toHaveCount(0);
      await expect(save(2)).toBeVisible();
      await expect(netflix.locator('option:checked')).toHaveText('Subscriptions');
      await broken.stop();
      expect(await categoryOf(merchants.netflix)).toBe('Uncategorized');

      // Another card, Spend settings, another page, or signing out asks first; staying keeps the picks.
      const asked: string[] = [];
      const stay = (d: import('@playwright/test').Dialog) => {
        asked.push(d.message());
        void d.dismiss();
      };
      page.on('dialog', stay);
      await page.getByRole('combobox', { name: 'Card', exact: true }).selectOption({ label: `Amex ${stamp}` });
      await expect.poll(() => asked.length).toBe(1);
      await expect(page).toHaveURL(new RegExp(`card=${card.id}`));
      await expect(page.getByRole('combobox', { name: 'Card', exact: true }).locator('option:checked')).toHaveText(`Visa ${stamp} ·1234`);
      await page.getByRole('navigation', { name: 'Spend views' }).getByRole('link', { name: 'Settings' }).click();
      await expect.poll(() => asked.length).toBe(2);
      await page.locator('a.brand').click();
      await expect.poll(() => asked.length).toBe(3);
      await page.getByRole('button', { name: 'Sign out' }).click();
      await expect.poll(() => asked.length).toBe(4);
      expect(asked).toEqual(Array(4).fill('Discard 2 unsaved changes?'));
      await expect(page).toHaveURL(new RegExp(`/spend\\?card=${card.id}$`));
      await expect(save(2)).toBeVisible();
      page.off('dialog', stay);

      // Saved once, hidden rows' picks too. The search hid Netflix before the save, so only rows
      // that were showing and now don't are counted as leaving the filter.
      await page.getByRole('searchbox', { name: 'Merchant' }).fill('blue bottle');
      await expect(page.getByText(/^Showing 1 of 5 transactions\.$/)).toBeVisible();
      const before = patches.length;
      await save(2).click();
      await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toHaveText('Saved 2 changes.');
      await expect(page.getByRole('heading', { name: 'Transactions' })).toBeFocused();
      expect(patches.length - before).toBe(1);
      expect(await categoryOf(merchants.netflix)).toBe('Subscriptions');
      await expect(page.getByRole('region', { name: 'By category' }).getByRole('row', { name: /Subscriptions/ })).toContainText('$15.49');
      await page.getByRole('searchbox', { name: 'Merchant' }).fill('');
      await expect(netflix).toHaveAccessibleDescription('Set by hand');

      // Discard asks first when it would drop more than one, then drops every pick without sending anything.
      const refund = page.getByRole('combobox', { name: `Category for ${merchants.refund}, ${day(-1)}, -$25.00` });
      await refund.selectOption({ label: 'Shopping' });
      await netflix.selectOption({ label: 'Dining' });
      const discarding = new Promise<string>((resolve) => page.once('dialog', (d) => {
        resolve(d.message());
        void d.accept();
      }));
      await bar.getByRole('button', { name: 'Discard changes' }).click();
      expect(await discarding).toBe('Discard 2 changes?');
      await expect(bar).toHaveCount(0);
      await expect(page.getByRole('status').filter({ hasText: 'Discarded' })).toHaveText('Discarded 2 changes.');
      await expect(page.getByRole('heading', { name: 'Transactions' })).toBeFocused();
      await expect(refund.locator('option:checked')).toHaveText('Uncategorized');
      await expect(netflix.locator('option:checked')).toHaveText('Subscriptions');
      // One goes without asking.
      await refund.selectOption({ label: 'Shopping' });
      await bar.getByRole('button', { name: 'Discard changes' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Discarded' })).toHaveText('Discarded 1 change.');
      await expect(bar).toHaveCount(0);
      expect(patches.length - before).toBe(1);

      // Agreeing to switch card drops the picks at once, before the other card has loaded.
      await refund.selectOption({ label: 'Shopping' });
      const amexLoad = await holdRequests(page, new RegExp(`/api/panels/spend/overview\\?card=${amex.id}$`), 'GET');
      page.once('dialog', (d) => void d.accept());
      await page.getByRole('combobox', { name: 'Card', exact: true }).selectOption({ label: `Amex ${stamp}` });
      await expect.poll(amexLoad.held).toBeGreaterThan(0);
      await expect(bar).toHaveCount(0);
      await amexLoad.stop();
      await expect(page).toHaveURL(new RegExp(`card=${amex.id}`));
      await page.getByRole('combobox', { name: 'Card', exact: true }).selectOption({ label: `Visa ${stamp} ·1234` });
      await expect(refund.locator('option:checked')).toHaveText('Uncategorized');
      await expect(bar).toHaveCount(0);
      expect(await categoryOf(merchants.refund)).toBe('Uncategorized');

      // Closing the tab with picks unsaved asks too (the browser's own prompt).
      await refund.selectOption({ label: 'Shopping' });
      await expect(save(1)).toBeVisible();
      const closing = new Promise<string>((resolve) => page.once('dialog', (d) => {
        resolve(d.type());
        void d.accept();
      }));
      await page.close({ runBeforeUnload: true });
      expect(await closing).toBe('beforeunload');
    });

    test('a refused save names its row: an archived pick, a row that is gone, a change made meanwhile; focus never lands under the bar', async ({ page }, info) => {
      const stamp = newStamp(info);
      await signInAsNewAdmin(page, stamp);
      const { card, merchants } = await cardWithTransactions(page, stamp);
      const day = (n: number) => longDay(localDay(n));
      const overview = (await (await page.request.get(`/api/panels/spend/overview?card=${card.id}`)).json()) as { transactions: { id: number; merchant: string }[] };
      const idOf = (merchant: string) => overview.transactions.find((t) => t.merchant === merchant)!.id;
      const categories = (await (await page.request.get('/api/panels/spend/categories')).json()) as { id: number; name: string }[];
      const groceriesId = categories.find((x) => x.name === 'Groceries')!.id;
      const pets = (await (await page.request.post('/api/panels/spend/categories', { data: { name: `Pets ${stamp}` }, headers: MUTATION_HEADERS })).json()) as { id: number };

      await page.goto(`/spend?card=${card.id}`);
      const bar = page.getByRole('region', { name: 'Unsaved changes' });
      const save = (n: number) => bar.getByRole('button', { name: `Save ${n} ${n === 1 ? 'change' : 'changes'}` });
      const c = `${merchants.coffee}, ${day(-5)}, $12.74`;
      const n = `${merchants.netflix}, ${day(-3)}, $15.49`;
      const coffee = page.getByRole('combobox', { name: `Category for ${c}` });
      const netflix = page.getByRole('combobox', { name: `Category for ${n}` });

      // A pick archived since it was made stays shown, marked, and flagged; Save names the row and focuses its picker.
      await coffee.selectOption({ label: `Pets ${stamp}` });
      expect((await page.request.post(`/api/panels/spend/categories/${pets.id}/archive`, { headers: MUTATION_HEADERS })).status()).toBe(200);
      await reloadAnyway(page);
      await expect(coffee.locator('option:checked')).toHaveText(`Pets ${stamp} (archived)`);
      await expect(coffee).toHaveAccessibleDescription(`Pets ${stamp} is archived now. Pick another category.`);
      await save(1).click();
      await expect(bar.getByRole('alert')).toHaveText(`Nothing was saved. ${c}: That category is archived. Pick another one.`);
      await expect(coffee).toBeFocused();

      // A row that's gone (answered by a stand-in, as if Netflix's import had been undone meanwhile):
      // its pick is dropped, and Save stays for the rest.
      await coffee.selectOption({ label: 'Dining' });
      await netflix.selectOption({ label: 'Subscriptions' });
      const gone = await holdRequests(page, '**/api/panels/spend/transactions', 'PATCH', {
        status: 404,
        json: { error: { code: 'not_found', message: 'That transaction no longer exists.', details: { missingIds: [idOf(merchants.netflix)] } } },
      });
      gone.release();
      await save(2).click();
      const message = bar.locator('p.error');
      await expect(message).toHaveText('Nothing was saved. 1 change was for a transaction that no longer exists and was removed. Save again to save the rest.');
      await expect(message).toBeFocused();
      await expect(save(1)).toBeVisible();
      await expect(netflix.locator('option:checked')).toHaveText('Uncategorized');
      await gone.stop();

      // Someone else changes Coffee meanwhile: Save is refused, and the picker says what it is now.
      const meanwhile = await page.request.patch(`/api/panels/spend/transactions/${idOf(merchants.coffee)}`, { data: { categoryId: groceriesId }, headers: MUTATION_HEADERS });
      expect(meanwhile.status()).toBe(200);
      await save(1).click();
      await expect(bar.getByRole('alert')).toHaveText(`Nothing was saved. Someone else changed ${c} while you were editing. Check it, then save again.`);
      await expect(coffee).toBeFocused();
      await expect(coffee).toHaveAccessibleDescription("Someone else changed this to Groceries. Your pick isn't saved yet.");
      await expect(coffee.locator('option:checked')).toHaveText('Dining');
      // Saving again, having seen it, keeps the pick.
      await save(1).click();
      await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toHaveText('Saved 1 change.');
      await expect(coffee.locator('option:checked')).toHaveText('Dining');
      await expect(coffee).toHaveAccessibleDescription('Set by hand');

      // On a small phone, tabbing to a picker further down scrolls it clear of the bar.
      await page.setViewportSize({ width: 320, height: 568 });
      await expect(page.getByRole('list', { name: 'Transactions' })).toBeVisible();
      await page.getByRole('combobox', { name: `Category for ${merchants.refund}, ${day(-1)}, -$25.00` }).selectOption({ label: 'Shopping' });
      await expect(save(1)).toBeVisible();
      const barHeight = (await bar.boundingBox())!.height;
      // The control before Groceries' category picker, scrolled to sit just above the bar.
      await page.getByRole('button', { name: `Add rule for ${n}` }).evaluate((el, h) => {
        window.scrollBy(0, el.getBoundingClientRect().bottom - (window.innerHeight - h - 4));
        (el as HTMLElement).focus({ preventScroll: true });
      }, barHeight);
      await page.keyboard.press('Tab');
      const groceries = page.getByRole('combobox', { name: `Category for ${merchants.groceries}, ${day(-4)}, $1,234.56` });
      await expect(groceries).toBeFocused();
      const [pickerBox, barBox] = [await groceries.boundingBox(), await bar.boundingBox()];
      expect(pickerBox!.y + pickerBox!.height).toBeLessThanOrEqual(barBox!.y);
      expect(pickerBox!.y).toBeGreaterThanOrEqual(0);
      await noSidewaysScroll(page);

      // "Go to Save", by the Transactions heading, gets to Save in one step.
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.getByRole('button', { name: 'Go to Save (1 change)' }).click();
      await expect(save(1)).toBeFocused();
      await bar.getByRole('button', { name: 'Discard changes' }).click();
      await expect(page.getByRole('button', { name: /^Go to Save/ })).toHaveCount(0);
      expect((await page.request.delete(`/api/panels/spend/categories/${pets.id}`, { headers: MUTATION_HEADERS })).status()).toBe(204);
    });

    test('cards archive, rename, and closing dates keep focus on the control that was used', async ({ page }, info) => {
      const stamp = newStamp(info);
      await signInAsNewAdmin(page, stamp);
      const nickname = `Visa ${stamp}`;
      const created = await page.request.post('/api/panels/spend/cards', {
        data: { nickname, mask: '1234', included: true, usualClosingDay: closingDay() },
        headers: MUTATION_HEADERS,
      });
      expect(created.status()).toBe(201);
      await page.goto('/spend?tab=settings');
      const cards = page.getByRole('region', { name: 'Cards' });

      // Archived cards sort last; focus follows the button there, and the badge is its own word.
      await cards.getByRole('button', { name: `Archive ${nickname}` }).click();
      await expect(cards.getByRole('status')).toHaveText(`Archived ${nickname}.`);
      await expect(cards.getByRole('button', { name: `Unarchive ${nickname}` })).toBeFocused();
      await expect(cards.getByRole('listitem').filter({ hasText: nickname })).toContainText(`${nickname} ·1234 Archived`);
      await cards.getByRole('button', { name: `Unarchive ${nickname}` }).click();
      await expect(cards.getByRole('status')).toHaveText(`Unarchived ${nickname}.`);
      await expect(cards.getByRole('button', { name: `Archive ${nickname}` })).toBeFocused();

      // A new nickname moves the card to the top; focus goes to its Edit button there.
      const renamed = `AAA ${stamp}`;
      await cards.getByRole('button', { name: `Edit ${nickname}` }).click();
      const form = cards.getByRole('form', { name: `Edit ${nickname}` });
      await form.getByLabel('Nickname').fill(renamed);
      await form.getByRole('button', { name: 'Save card' }).click();
      await expect(cards.getByRole('status')).toHaveText(`Saved ${renamed}.`);
      await expect(cards.getByRole('button', { name: `Edit ${renamed}` })).toBeFocused();

      // Closing dates: add, change (focus on its Change button), cancel, and delete.
      await cards.getByRole('button', { name: `Closing dates for ${renamed}` }).click();
      const dates = cards.getByRole('region', { name: `Closing dates for ${renamed}` });
      const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const first = localDay(-50);
      const moved = localDay(-47);
      const addField = dates.getByLabel('Add a closing date', { exact: true });
      await addField.fill(iso(first));
      await dates.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(cards.getByRole('status')).toHaveText(`Saved the closing date ${longDay(first)}.`);
      await expect(addField).toBeFocused();
      await dates.getByRole('button', { name: `Change the closing date ${longDay(first)}` }).click();
      const change = dates.getByRole('form', { name: `Change the closing date ${longDay(first)}` });
      await change.getByLabel('Closing date').fill(iso(moved));
      await change.getByRole('button', { name: 'Save' }).click();
      await expect(cards.getByRole('status')).toHaveText(`Saved the closing date ${longDay(first)}.`);
      const changed = dates.getByRole('button', { name: `Change the closing date ${longDay(moved)}` });
      await expect(changed).toBeFocused();
      await changed.click();
      await dates.getByRole('form', { name: `Change the closing date ${longDay(moved)}` }).getByRole('button', { name: 'Cancel' }).click();
      await expect(changed).toBeFocused();
      await dates.getByRole('button', { name: `Delete the closing date ${longDay(moved)}` }).click();
      await expect(cards.getByRole('status')).toHaveText(`Deleted the closing date ${longDay(moved)}.`);
      await expect(addField).toBeFocused();
      await expect(dates.getByRole('button', { name: `Change the closing date ${longDay(moved)}` })).toHaveCount(0);
    });

    test('rules move, edit, show a rule that needs attention, and apply to past transactions', async ({ page }, info) => {
      const stamp = newStamp(info);
      await signInAsNewAdmin(page, stamp);
      const category = await page.request.post('/api/panels/spend/categories', { data: { name: `Flag ${stamp}` }, headers: MUTATION_HEADERS });
      expect(category.status()).toBe(201);
      const flag = (await category.json()) as { id: number; name: string };
      for (const text of [`A ${stamp}`, `B ${stamp}`]) {
        const res = await page.request.post('/api/panels/spend/rules', {
          data: { matchText: text, matchType: 'contains', cardId: null, minCents: null, maxCents: null, setCategoryId: flag.id, setPerson: null, applyToPast: false, placeFirst: false },
          headers: MUTATION_HEADERS,
        });
        expect(res.status()).toBe(201);
      }
      await page.goto('/spend?tab=settings');
      const rules = page.getByRole('region', { name: 'Rules' });
      const items = rules.getByRole('listitem');
      await expect(items.last()).toContainText(`Text contains "B ${stamp}"`);
      const count = await items.count();

      // Move up, then down to the end, where Move down is disabled and focus goes to Move up.
      const up = rules.getByRole('button', { name: `Move the rule for B ${stamp} up` });
      const down = rules.getByRole('button', { name: `Move the rule for B ${stamp} down` });
      await up.click();
      await expect(rules.getByRole('status')).toHaveText(`Moved the rule for "B ${stamp}" up. It's now ${count - 1} of ${count}.`);
      await expect(items.nth(count - 2)).toContainText(`B ${stamp}`);
      await expect(up).toBeFocused();
      await down.click();
      await expect(rules.getByRole('status')).toHaveText(`Moved the rule for "B ${stamp}" down. It's now ${count} of ${count}.`);
      await expect(down).toBeDisabled();
      await expect(up).toBeFocused();

      // Edit: focus goes back to the rule's Edit button.
      await rules.getByRole('button', { name: `Edit the rule for A ${stamp}` }).click();
      const form = rules.getByRole('form', { name: `Edit the rule for A ${stamp}` });
      await expect(form.getByLabel('Text to match')).toBeFocused();
      await form.getByLabel('Text to match').fill(`A2 ${stamp}`);
      await form.getByLabel('Largest amount').fill('20000000');
      await form.getByRole('button', { name: 'Save rule' }).click();
      await expect(form.getByRole('alert')).toHaveText('Enter an amount of at most $10,000,000.');
      await expect(form.getByLabel('Largest amount')).toBeFocused();
      await form.getByLabel('Largest amount').fill('');
      await form.getByRole('button', { name: 'Save rule' }).click();
      await expect(rules.getByRole('status')).toHaveText(`Saved the rule for "A2 ${stamp}".`);
      await expect(rules.getByRole('button', { name: `Edit the rule for A2 ${stamp}` })).toBeFocused();

      // Archiving its category flags the rule.
      const categories = page.getByRole('region', { name: 'Categories', exact: true });
      await categories.getByRole('button', { name: `Archive ${flag.name}` }).click();
      await expect(categories.getByRole('status')).toHaveText(`Archived ${flag.name}.`);
      await expect(items.filter({ hasText: `A2 ${stamp}` })).toContainText("Needs attention: Its category is archived, so it doesn't set the category until it's edited.");

      // Apply: focus goes back to the button, which was locked while it ran.
      const apply = rules.getByRole('button', { name: 'Apply rules to past transactions' });
      page.once('dialog', (d) => void d.accept());
      await apply.click();
      await expect(rules.getByRole('status')).toHaveText(/^Rules applied to past transactions\. \d+ transactions? changed\.$/);
      await expect(apply).toBeFocused();
    });

    test('the browser refuses a file over 5 MB without sending it, and an expired preview starts again with no file', async ({ page }, info) => {
      const stamp = newStamp(info);
      await signInAsNewAdmin(page, stamp);
      const nickname = `Visa ${stamp}`;
      const created = await page.request.post('/api/panels/spend/cards', {
        data: { nickname, mask: '1234', included: true, usualClosingDay: closingDay() },
        headers: MUTATION_HEADERS,
      });
      expect(created.status()).toBe(201);
      const uploads: string[] = [];
      page.on('request', (r) => {
        if (r.method() === 'POST' && r.url().endsWith('/api/panels/spend/imports')) uploads.push(r.url());
      });
      await page.goto('/spend?tab=settings');
      const importer = page.getByRole('region', { name: 'Import a CSV' });
      await importer.getByLabel('Card').selectOption({ label: `${nickname} ·1234` });
      await importer.getByLabel('Bank of America CSV').setInputFiles({ name: 'big.csv', mimeType: 'text/csv', buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 'a') });
      await importer.getByRole('button', { name: 'Preview' }).click();
      await expect(importer.getByRole('alert')).toHaveText('That file is too big. The limit is 5 MB.');
      expect(uploads).toHaveLength(0);

      // The preview has expired by the time Import is pressed.
      const csv = syntheticCsv(stamp);
      await importer.getByLabel('Bank of America CSV').setInputFiles({ name: csv.name, mimeType: 'text/csv', buffer: csv.buffer });
      await importer.getByRole('button', { name: 'Preview' }).click();
      await expect(importer.getByRole('heading', { name: `${csv.name} for ${nickname} ·1234` })).toBeFocused();
      await page.route('**/api/panels/spend/imports/*/commit', (route) =>
        route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'That preview has expired. Upload the file again.' } } }),
      );
      await importer.getByRole('button', { name: 'Import 6 rows' }).click();
      await expect(importer.getByRole('alert')).toHaveText('That preview has expired. Upload the file again.');
      await expect(importer.getByRole('heading', { name: 'Import a CSV' })).toBeFocused();
      // The file field is empty again, and nothing is uploaded from it.
      await expect(importer.getByLabel('Bank of America CSV')).toHaveValue('');
      await importer.getByRole('button', { name: 'Preview' }).click();
      await expect(importer.getByRole('alert')).toHaveText('Pick a card and a file first.');
      expect(uploads).toHaveLength(1);
      await page.unroute('**/api/panels/spend/imports/*/commit');
    });

    test('an admin undoes an import once nothing in it was changed by hand, and imports the same file again', async ({ page }, info) => {
      const stamp = newStamp(info);
      await signInAsNewAdmin(page, stamp);
      const { card, csv } = await cardWithTransactions(page, stamp);
      // A note on one of its transactions keeps the import from being undone.
      const overview = (await (await page.request.get(`/api/panels/spend/overview?card=${card.id}`)).json()) as { transactions: { id: number; merchant: string }[] };
      const netflix = overview.transactions.find((t) => t.merchant === csv.merchants.netflix)!;
      const noted = await page.request.patch(`/api/panels/spend/transactions/${netflix.id}`, { data: { note: 'Shared account' }, headers: MUTATION_HEADERS });
      expect(noted.status()).toBe(200);

      await page.goto('/spend?tab=settings');
      const cards = page.getByRole('region', { name: 'Cards' });
      const row = cards.getByRole('listitem').filter({ hasText: card.nickname }).first();
      await expect(row).toContainText('6 transactions');
      const toggle = cards.getByRole('button', { name: `Imports for ${card.nickname}` });
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      const imports = cards.getByRole('region', { name: `Imports for ${card.nickname}` });
      await expect(imports.getByRole('listitem')).toHaveCount(1);
      await expect(imports.getByRole('listitem')).toContainText(csv.name);
      await expect(imports.getByRole('listitem')).toContainText('6 transactions');
      const undo = imports.getByRole('button', { name: new RegExp(`^Undo the import of ${csv.name.replace('.', '\\.')}`) });

      // It asks first; saying no sends nothing.
      const deletes: string[] = [];
      page.on('request', (r) => {
        if (r.method() === 'DELETE' && /\/cards\/\d+\/imports\/\d+$/.test(r.url())) deletes.push(r.url());
      });
      let asked = '';
      page.once('dialog', (d) => {
        asked = d.message();
        void d.dismiss();
      });
      await undo.click();
      expect(asked).toBe(`Undo the import of ${csv.name}? Its 6 transactions are deleted, and the file can be imported again.`);
      expect(deletes).toHaveLength(0);

      // Refused while the note is there, with how many were changed by hand.
      page.once('dialog', (d) => void d.accept());
      await undo.click();
      await expect(cards.getByRole('alert')).toHaveText(
        `Couldn't undo the import of ${csv.name}. This import can't be undone because 1 of its 6 transactions has a category, person, or note set by hand. Undo those changes first.`,
      );
      await expect(row).toContainText('6 transactions');

      // Without it, the undo goes through: the transactions go, and focus goes to the Imports button.
      const cleared = await page.request.patch(`/api/panels/spend/transactions/${netflix.id}`, { data: { note: null }, headers: MUTATION_HEADERS });
      expect(cleared.status()).toBe(200);
      page.once('dialog', (d) => void d.accept());
      await undo.click();
      await expect(cards.getByRole('status')).toHaveText(`Undid the import of ${csv.name}. Its 6 transactions were deleted.`);
      await expect(cards.getByRole('alert')).toHaveCount(0);
      await expect(imports.getByText('No imports yet.')).toBeVisible();
      await expect(row).toContainText('0 transactions');
      await expect(toggle).toBeFocused();

      // The same file imports again: none of it is "already imported".
      const importer = page.getByRole('region', { name: 'Import a CSV' });
      await importer.getByLabel('Card').selectOption({ label: `${card.nickname} ·1234` });
      await importer.getByLabel('Bank of America CSV').setInputFiles({ name: csv.name, mimeType: 'text/csv', buffer: csv.buffer });
      await importer.getByRole('button', { name: 'Preview' }).click();
      await expect(importer.getByText(/^7 rows, .* 1 can't be imported\.$/)).toBeVisible();
      await expect(importer.getByRole('group', { name: 'Rows to import' }).getByRole('checkbox', { checked: true })).toHaveCount(6);
      await importer.getByRole('button', { name: 'Import 6 rows' }).click();
      await expect(importer.getByRole('status')).toHaveText('Imported 6 rows. 1 skipped.');
      await expect(row).toContainText('6 transactions');
      await expect(imports.getByRole('listitem')).toHaveCount(1);
      await noSidewaysScroll(page);
    });

    test('Delete is shown as unavailable, with the reason, while rules use a card', async ({ page }, info) => {
      const stamp = newStamp(info);
      await signInAsNewAdmin(page, stamp);
      const nickname = `Visa ${stamp}`;
      const created = await page.request.post('/api/panels/spend/cards', {
        data: { nickname, mask: '1234', included: true, usualClosingDay: closingDay() },
        headers: MUTATION_HEADERS,
      });
      expect(created.status()).toBe(201);
      const card = (await created.json()) as { id: number };
      const rule = await page.request.post('/api/panels/spend/rules', {
        data: { matchText: `R ${stamp}`, matchType: 'contains', cardId: card.id, minCents: null, maxCents: null, setCategoryId: null, setPerson: 'household', applyToPast: false, placeFirst: false },
        headers: MUTATION_HEADERS,
      });
      expect(rule.status()).toBe(201);
      await page.goto('/spend?tab=settings');
      const cards = page.getByRole('region', { name: 'Cards' });

      // Delete is there but unavailable, and says why; pressing it asks nothing and sends nothing.
      const del = cards.getByRole('button', { name: `Delete ${nickname}` });
      await expect(del).toHaveAttribute('aria-disabled', 'true');
      await expect(del).toHaveAccessibleDescription('Rules use this card');
      let dialogs = 0;
      page.on('dialog', (d) => {
        dialogs++;
        void d.dismiss();
      });
      // Playwright won't click an aria-disabled button, so press it from the keyboard, as a person can.
      await del.focus();
      await page.keyboard.press('Enter');
      await expect(del).toBeFocused();
      expect(dialogs).toBe(0);
    });

    test("a slow card save or preview doesn't pull focus back from where it went meanwhile", async ({ page }, info) => {
      const stamp = newStamp(info);
      await signInAsNewAdmin(page, stamp);
      const nickname = `Visa ${stamp}`;
      const created = await page.request.post('/api/panels/spend/cards', {
        data: { nickname, mask: '1234', included: true, usualClosingDay: closingDay() },
        headers: MUTATION_HEADERS,
      });
      expect(created.status()).toBe(201);
      const card = (await created.json()) as { id: number };
      await page.goto('/spend?tab=settings');
      const cards = page.getByRole('region', { name: 'Cards' });
      const importer = page.getByRole('region', { name: 'Import a CSV' });

      // A slow card save: focus moved on meanwhile stays where it went.
      await cards.getByRole('button', { name: `Edit ${nickname}` }).click();
      const form = cards.getByRole('form', { name: `Edit ${nickname}` });
      await form.getByLabel('Last 4 (optional)').fill('4321');
      const save = await holdRequests(page, `**/api/panels/spend/cards/${card.id}`, 'PUT');
      await form.getByRole('button', { name: 'Save card' }).click();
      await expect.poll(() => save.held()).toBe(1);
      await importer.getByLabel('Card').focus();
      await save.stop();
      await expect(cards.getByRole('status')).toHaveText(`Saved ${nickname}.`);
      await expect(cards.getByRole('button', { name: `Edit ${nickname}` })).toBeVisible();
      await expect(importer.getByLabel('Card')).toBeFocused();

      // A slow preview: the same.
      const csv = syntheticCsv(stamp);
      await importer.getByLabel('Card').selectOption({ label: `${nickname} ·4321` });
      await importer.getByLabel('Bank of America CSV').setInputFiles({ name: csv.name, mimeType: 'text/csv', buffer: csv.buffer });
      const upload = await holdRequests(page, '**/api/panels/spend/imports', 'POST');
      await importer.getByRole('button', { name: 'Preview' }).click();
      await expect.poll(() => upload.held()).toBe(1);
      await cards.getByRole('button', { name: 'New card' }).focus();
      await upload.stop();
      await expect(importer.getByRole('heading', { name: `${csv.name} for ${nickname} ·4321` })).toBeVisible();
      await expect(cards.getByRole('button', { name: 'New card' })).toBeFocused();
      await importer.getByRole('button', { name: 'Cancel' }).click();
      await expect(importer.getByRole('status')).toHaveText('Import cancelled. Nothing was saved.');
    });

    test('a closing date the server refuses stays in its field until one is accepted', async ({ page }, info) => {
      const stamp = newStamp(info);
      await signInAsNewAdmin(page, stamp);
      const nickname = `Visa ${stamp}`;
      const created = await page.request.post('/api/panels/spend/cards', {
        data: { nickname, mask: '1234', included: true, usualClosingDay: closingDay() },
        headers: MUTATION_HEADERS,
      });
      expect(created.status()).toBe(201);
      const card = (await created.json()) as { id: number };
      await page.goto('/spend?tab=settings');
      const cards = page.getByRole('region', { name: 'Cards' });

      // A closing date the server refuses stays in the field; one it accepts is cleared.
      await cards.getByRole('button', { name: `Closing dates for ${nickname}` }).click();
      const dates = cards.getByRole('region', { name: `Closing dates for ${nickname}` });
      const day = localDay(-50);
      const iso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
      const addField = dates.getByLabel('Add a closing date', { exact: true });
      const refuse = await holdRequests(page, `**/api/panels/spend/cards/${card.id}/statements`, 'POST', {
        status: 409,
        json: { error: { code: 'conflict', message: 'That card already has that closing date.' } },
      });
      await addField.fill(iso);
      await dates.getByRole('button', { name: 'Add', exact: true }).click();
      await expect.poll(() => refuse.held()).toBe(1);
      await expect(addField).toHaveValue(iso);
      await refuse.stop();
      await expect(cards.getByRole('alert')).toHaveText(`Couldn't add the closing date ${longDay(day)}. That card already has that closing date.`);
      await expect(addField).toHaveValue(iso);
      await expect(addField).toBeFocused();
      await dates.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(cards.getByRole('status')).toHaveText(`Saved the closing date ${longDay(day)}.`);
      await expect(addField).toHaveValue('');
    });

    test('sorting by amount puts twins together; an admin removes one as a duplicate, the totals drop, and Undo brings it back', async ({ page }, info) => {
      const stamp = newStamp(info);
      await signInAsNewAdmin(page, stamp);
      const created = await page.request.post('/api/panels/spend/cards', {
        data: { nickname: `Twins ${stamp}`, mask: '4321', included: true, usualClosingDay: closingDay() },
        headers: MUTATION_HEADERS,
      });
      const card = (await created.json()) as { id: number };
      // SYNTHETIC: two rows the bank lists twice under other names (same day, same amount), one more of that amount another day, and one other.
      const m = { alpha: `ALPHA CAFE ${stamp}`, omega: `OMEGA COFFEE ${stamp}`, later: `LATER CAFE ${stamp}`, big: `BIG STORE ${stamp}` };
      const ref = (n: number) => `${Date.now()}${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}${String(n).padStart(6, '0')}`;
      const text = [
        'Posted Date,Reference Number,Payee,Address,Amount',
        `${mmddyyyy(localDay(-4))},${ref(1)},"${m.alpha}","",-9.99`,
        `${mmddyyyy(localDay(-1))},${ref(2)},"${m.big}","",-30.00`,
        `${mmddyyyy(localDay(-2))},${ref(3)},"${m.later}","",-9.99`,
        `${mmddyyyy(localDay(-4))},${ref(4)},"${m.omega}","",-9.99`,
      ].join('\r\n');
      const preview = await page.request.post('/api/panels/spend/imports', {
        multipart: { cardId: String(card.id), file: { name: 'twins.csv', mimeType: 'text/csv', buffer: Buffer.from(`${text}\r\n`) } },
        headers: MUTATION_HEADERS,
      });
      const { id } = (await preview.json()) as { id: string };
      await page.request.post(`/api/panels/spend/imports/${id}/commit`, { data: { include: [2, 3, 4, 5] }, headers: MUTATION_HEADERS });
      const label = (merchant: string, days: number, amount: string) => `${merchant}, ${longDay(localDay(days))}, ${amount}`;
      const alpha = label(m.alpha, -4, '$9.99');
      const omega = label(m.omega, -4, '$9.99');
      const phone = sized.name === 'phone';

      await page.goto(`/spend?card=${card.id}`);
      const totals = page.getByRole('region', { name: /to .*\d{4}$/ });
      await expect(totals.getByText('$59.97')).toBeVisible();
      const merchants = () => page.locator(phone ? '.spend-list-item .todo-title' : '.spend-table tbody .todo-title').allInnerTexts();
      // Newest first by default.
      await expect.poll(merchants).toEqual([m.big, m.later, m.omega, m.alpha]);
      if (phone) {
        await page.getByLabel('Sort by').selectOption({ label: 'Amount, smallest first' });
      } else {
        const header = page.getByRole('columnheader', { name: 'Amount' });
        await header.getByRole('button', { name: 'Amount' }).click();
        await expect(header).toHaveAttribute('aria-sort', 'descending');
        await expect(page.getByRole('columnheader', { name: 'Date' })).not.toHaveAttribute('aria-sort');
        await header.getByRole('button', { name: 'Amount' }).click();
        await expect(header).toHaveAttribute('aria-sort', 'ascending');
      }
      await expect(page).toHaveURL(/sort=amount&dir=asc/);
      // Within one amount, newest first: the twins sit together.
      await expect.poll(merchants).toEqual([m.later, m.omega, m.alpha, m.big]);
      // The sort is kept in the URL.
      await page.reload();
      await expect.poll(merchants).toEqual([m.later, m.omega, m.alpha, m.big]);

      // Only rows with a twin offer Remove duplicate.
      await expect(page.getByRole('button', { name: /^Remove duplicate / })).toHaveCount(2);
      // Not while the row has unsaved picks: they'd go with it.
      const removeOmega = page.getByRole('button', { name: `Remove duplicate ${omega}` });
      await page.getByRole('combobox', { name: `Category for ${omega}` }).selectOption({ label: 'Dining' });
      await expect(removeOmega).toHaveAttribute('aria-disabled', 'true');
      await expect(removeOmega).toHaveAccessibleDescription('Save or discard its changes to remove it.');
      // Playwright waits for an aria-disabled button to be enabled, so this click is forced: it does nothing.
      await removeOmega.click({ force: true });
      await expect.poll(merchants).toEqual([m.later, m.omega, m.alpha, m.big]);
      await page.getByRole('region', { name: 'Unsaved changes' }).getByRole('button', { name: 'Discard changes' }).click();
      await expect(removeOmega).toHaveAttribute('aria-disabled', 'false');
      await removeOmega.click();
      const status = page.getByRole('status').filter({ hasText: 'duplicate' });
      await expect(status).toHaveText(`Removed duplicate: ${omega}.`);
      await expect(page.getByRole('button', { name: /^Remove duplicate / })).toHaveCount(0);
      await expect.poll(merchants).toEqual([m.later, m.alpha, m.big]);
      // Focus moves on to the next row.
      await expect(page.getByRole('combobox', { name: `Category for ${alpha}` })).toBeFocused();
      await expect(totals.getByText('$49.98')).toBeVisible();

      // While Undo is out it stays where it is, waiting, with focus on it.
      const restore = await holdRequests(page, /restore-duplicate$/, 'POST');
      const undo = page.getByRole('button', { name: `Undo removing duplicate ${omega}` });
      await undo.click();
      await expect.poll(() => restore.held()).toBe(1);
      await expect(undo).toHaveAttribute('aria-disabled', 'true');
      await expect(undo).toBeFocused();
      await restore.stop();
      await expect(page.getByRole('status').filter({ hasText: 'Brought back' })).toHaveText(`Brought back: ${omega}.`);
      await expect.poll(merchants).toEqual([m.later, m.omega, m.alpha, m.big]);
      await expect(page.getByRole('button', { name: `Remove duplicate ${omega}` })).toBeFocused();
      await expect(page.getByRole('button', { name: /^Remove duplicate / })).toHaveCount(2);
      await expect(totals.getByText('$59.97')).toBeVisible();
      await expect(page.getByRole('button', { name: /^Undo/ })).toHaveCount(0);
      await noSidewaysScroll(page);

      // A member sees the twins, but not the button.
      const member = await createMember(page, stamp, ['spend']);
      await signIn(page, member.email);
      await page.goto(`/spend?card=${card.id}&sort=amount`);
      await expect(page.getByRole('combobox', { name: `Category for ${alpha}` })).toBeVisible();
      await expect(page.getByRole('button', { name: /^Remove duplicate / })).toHaveCount(0);
      expect((await page.request.post(`/api/panels/spend/transactions/1/remove-duplicate`, { headers: MUTATION_HEADERS })).status()).toBe(403);
    });
  });
}
