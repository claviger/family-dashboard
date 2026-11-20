import { expect, test, type Page, type TestInfo } from '@playwright/test';

const MUTATION_HEADERS = { 'x-requested-with': 'dashboard', origin: 'http://localhost:3100' };

type Schedule =
  | { kind: 'daily' }
  | { kind: 'weekly'; interval: number; weekdays: number[] }
  | { kind: 'monthly'; day: number | 'last' }
  | { kind: 'after'; every: number; unit: 'days' | 'weeks' }
  | { kind: 'none' };

interface BoardRowJson {
  choreId: number;
  title: string;
  assignee: { id: number } | null;
  state: string;
  date: string | null;
  occurrenceId: number | null;
}

async function signIn(page: Page, email: string) {
  await page.context().clearCookies();
  const res = await page.request.post('/auth/test-login', { data: { email }, headers: MUTATION_HEADERS });
  expect(res.status()).toBe(204);
}

/**
 * Creates a member with the To-do and Chores panels and leaves the page signed in as the admin.
 * Every test gets its own member and unique chore titles, because the desktop and phone projects
 * (and repeats) share one server and database, and the board is shared by everyone.
 */
async function createMember(
  page: Page,
  info: TestInfo,
  label: string,
  opts: { stamp?: string; name?: string; panels?: string[] } = {},
) {
  const stamp = opts.stamp ?? newStamp(info);
  const member = {
    name: opts.name ?? `${label} ${stamp}`,
    email: `${label.toLowerCase().replace(/\W+/g, '-')}-${stamp}@example.com`,
    stamp,
  };
  await signIn(page, 'admin@example.com');
  const created = await page.request.post('/api/admin/users', {
    data: { email: member.email, displayName: member.name, color: '#1D9E75', role: 'member', panels: opts.panels ?? ['todo', 'chores'] },
    headers: MUTATION_HEADERS,
  });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: number };
  return { ...member, id };
}

function newStamp(info: TestInfo): string {
  return `${info.project.name}-${info.repeatEachIndex}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Creates `count` members whose names start with one fresh stamp, so they sort next to each other
 * in every person picker (names sort by their bytes, and nobody else's name starts with the stamp).
 */
async function createAdjacentMembers(page: Page, info: TestInfo, label: string, count: number) {
  const stamp = newStamp(info);
  const members = [];
  for (let i = 1; i <= count; i++) {
    members.push(await createMember(page, info, `${label} ${i}`, { stamp, name: `${stamp} ${label} ${i}` }));
  }
  return members;
}

/** The open to-dos on `email`'s list, with due dates, read through the API. Leaves the page signed in as them. */
async function openTodos(page: Page, email: string): Promise<{ title: string; dueDate: string | null }[]> {
  await signIn(page, email);
  const res = await page.request.get('/api/panels/todo/items');
  expect(res.status()).toBe(200);
  const list = (await res.json()) as { groups: Record<string, { title: string; dueDate: string | null }[]> };
  return Object.values(list.groups).flat().map((i) => ({ title: i.title, dueDate: i.dueDate }));
}

async function openTodoTitles(page: Page, email: string): Promise<string[]> {
  return (await openTodos(page, email)).map((i) => i.title);
}

/** The family's today (the e2e server runs on the real clock). */
async function familyToday(page: Page): Promise<string> {
  return ((await (await page.request.get('/api/panels/chores/chores')).json()) as { today: string }).today;
}

function addDaysTo(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** As the signed-in user, adds a chore that starts today. */
async function addChore(page: Page, title: string, assigneeUserId: number | null, schedule: Schedule = { kind: 'daily' }) {
  const res = await page.request.post('/api/panels/chores/chores', {
    data: { title, notes: null, assigneeUserId, schedule, startDate: await familyToday(page) },
    headers: MUTATION_HEADERS,
  });
  expect(res.status()).toBe(201);
}

/** A chore's row on the board, read through the API as the signed-in user. */
async function boardRowJson(page: Page, title: string): Promise<BoardRowJson> {
  const board = (await (await page.request.get('/api/panels/chores/board')).json()) as { rows: BoardRowJson[] };
  return board.rows.find((r) => r.title === title)!;
}

/** Waits until the Board tab has shown its list. */
async function boardLoaded(page: Page) {
  await expect(page.getByRole('heading', { name: /^Chores \(\d+\)$/ })).toBeVisible();
}

test('the board lists chores most often first, and a member claims one and releases it', async ({ page }, info) => {
  const member = await createMember(page, info, 'Board claim');
  const s = member.stamp;
  const today = await familyToday(page);
  await addChore(page, `As needed ${s}`, null, { kind: 'none' });
  await addChore(page, `Monthly ${s}`, null, { kind: 'monthly', day: 1 });
  await addChore(page, `Weekly ${s}`, null, { kind: 'weekly', interval: 1, weekdays: [3] });
  await addChore(page, `Daily ${s}`, null, { kind: 'daily' });
  await addChore(page, `Every 2 days ${s}`, null, { kind: 'after', every: 2, unit: 'days' });

  await signIn(page, member.email);
  await page.goto('/chores');
  await expect(page.getByRole('link', { name: 'Board', exact: true })).toHaveAttribute('aria-current', 'page');
  const rows = page.getByRole('listitem').filter({ hasText: s });
  await expect(rows.locator('.todo-title')).toHaveText([`Daily ${s}`, `Every 2 days ${s}`, `Weekly ${s}`, `Monthly ${s}`, `As needed ${s}`]);
  await expect(rows.filter({ hasText: `Weekly ${s}` })).toContainText('Wednesdays');
  await expect(rows.filter({ hasText: `As needed ${s}` })).toContainText('As needed');

  // Claim: it's theirs, due today, with a done checkbox, and on their to-do list due today.
  const daily = rows.filter({ hasText: `Daily ${s}` });
  await expect(daily).toContainText('Unassigned');
  await daily.getByRole('button', { name: `Claim Daily ${s}` }).click();
  await expect(page.getByRole('status')).toHaveText(`Claimed: Daily ${s}`);
  await expect(daily).toBeFocused();
  await expect(daily).toContainText('You');
  await expect(daily).toContainText('Due today');
  await expect(daily.getByRole('checkbox', { name: `Complete Daily ${s}` })).toBeVisible();
  expect(await openTodos(page, member.email)).toContainEqual({ title: `Daily ${s}`, dueDate: today });

  // Release: back on the board, unassigned, and off their list.
  await page.goto('/chores');
  await daily.getByRole('button', { name: `Release Daily ${s}` }).click();
  await expect(page.getByRole('status')).toHaveText(`Released: Daily ${s}`);
  await expect(daily).toContainText('Unassigned');
  await expect(daily.getByRole('button', { name: `Claim Daily ${s}` })).toBeVisible();
  expect(await openTodoTitles(page, member.email)).not.toContain(`Daily ${s}`);
});

test('a claimed chore lands on the to-do list with its next due date, and an as-needed one with none', async ({ page }, info) => {
  const member = await createMember(page, info, 'Board due');
  const s = member.stamp;
  const inTwo = addDaysTo(await familyToday(page), 2);
  await addChore(page, `Sweep ${s}`, null, { kind: 'weekly', interval: 1, weekdays: [weekdayOf(inTwo)] });
  await addChore(page, `Gutters ${s}`, null, { kind: 'none' });

  await signIn(page, member.email);
  await page.goto('/chores');
  const sweep = page.getByRole('listitem').filter({ hasText: `Sweep ${s}` });
  await sweep.getByRole('button', { name: `Claim Sweep ${s}` }).click();
  // Due in two days isn't due yet, so it reads "Next: …", not "Due …".
  await expect(sweep).toContainText(/Next: /);
  await expect(sweep).not.toContainText(/Due /);
  const gutters = page.getByRole('listitem').filter({ hasText: `Gutters ${s}` });
  await gutters.getByRole('button', { name: `Claim Gutters ${s}` }).click();
  await expect(gutters).toContainText('On your list');

  const todos = await openTodos(page, member.email);
  expect(todos).toContainEqual({ title: `Sweep ${s}`, dueDate: inTwo });
  expect(todos).toContainEqual({ title: `Gutters ${s}`, dueDate: null });
  // The home tile words it the same way: it's theirs, with a checkbox, but not due yet.
  await page.goto('/');
  const tileSweep = page.getByRole('region', { name: 'Chores' }).getByRole('region', { name: 'Yours' }).getByRole('listitem').filter({ hasText: `Sweep ${s}` });
  await expect(tileSweep).toContainText(/Next: /);
  await expect(tileSweep).not.toContainText(/Due /);
  await page.goto('/todo');
  await expect(page.getByRole('listitem').filter({ hasText: `Gutters ${s}` }).getByRole('link', { name: `Chore: Gutters ${s}` })).toBeVisible();
});

test('taking over a chore keeps its due date and moves the to-do', async ({ page }, info) => {
  const from = await createMember(page, info, 'Take from');
  const to = await createMember(page, info, 'Take to', { stamp: from.stamp });
  const title = `Water plants ${from.stamp}`;
  const inTwo = addDaysTo(await familyToday(page), 2);
  await addChore(page, title, from.id, { kind: 'weekly', interval: 1, weekdays: [weekdayOf(inTwo)] });

  await signIn(page, to.email);
  await page.goto('/chores');
  const row = page.getByRole('listitem').filter({ hasText: title });
  await expect(row).toContainText(from.name);
  await row.getByRole('button', { name: `Take over ${title}` }).click();
  await expect(page.getByRole('status')).toHaveText(`Taken over: ${title}`);
  await expect(row).toBeFocused();
  await expect(row).toContainText('You');

  expect(await openTodoTitles(page, from.email)).not.toContain(title);
  expect(await openTodos(page, to.email)).toContainEqual({ title, dueDate: inTwo });
});

test('the home tile shows yours, coming up, and up for grabs, in at most six rows unless more are due', async ({ page }, info) => {
  const member = await createMember(page, info, 'Tile');
  const s = member.stamp;
  for (const n of [1, 2, 3, 4]) await addChore(page, `Due ${n} ${s}`, member.id);
  const inThree = addDaysTo(await familyToday(page), 3);
  await addChore(page, `Later ${s}`, member.id, { kind: 'weekly', interval: 1, weekdays: [weekdayOf(inThree)] });
  await addChore(page, `Grab ${s}`, null);

  // Done early, so it's coming up instead of due.
  await signIn(page, member.email);
  const later = await boardRowJson(page, `Later ${s}`);
  const done = await page.request.post(`/api/panels/chores/occurrences/${later.occurrenceId}/complete`, { headers: MUTATION_HEADERS });
  expect(done.status()).toBe(200);

  await page.goto('/');
  const card = page.getByRole('region', { name: 'Chores' });
  const yours = card.getByRole('region', { name: 'Yours' });
  await expect(yours.getByRole('checkbox')).toHaveCount(4);
  await expect(yours.getByRole('checkbox', { name: `Complete Due 1 ${s}` })).toBeVisible();
  const coming = card.getByRole('region', { name: 'Coming up' });
  await expect(coming.getByRole('listitem')).toHaveCount(1);
  await expect(coming).toContainText(`Later ${s}`);
  await expect(coming).toContainText('Next: ');
  // One row is left for Up for grabs (the board is shared, so it may be anyone's chore).
  await expect(card.getByRole('region', { name: 'Up for grabs' }).getByRole('listitem')).toHaveCount(1);
  await expect(card.getByRole('listitem')).toHaveCount(6);

  // Seven due: every one shows, and nothing else does.
  await signIn(page, 'admin@example.com');
  for (const n of [5, 6, 7]) await addChore(page, `Due ${n} ${s}`, member.id);
  await signIn(page, member.email);
  await page.goto('/');
  await expect(yours.getByRole('checkbox')).toHaveCount(7);
  await expect(card.getByRole('region', { name: 'Coming up' })).toHaveCount(0);
  await expect(card.getByRole('region', { name: 'Up for grabs' })).toHaveCount(0);
});

test('a member adds a chore for themselves on the Board, and it lands on their list', async ({ page }, info) => {
  const member = await createMember(page, info, 'Board add');
  const title = `Make bed ${member.stamp}`;
  await signIn(page, member.email);
  await page.goto('/chores');
  await expect(page.getByRole('link', { name: 'Manage', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add chore' }).click();
  const form = page.getByRole('form', { name: 'New chore' });
  await expect(form.getByLabel('Title')).toBeFocused();
  await form.getByLabel('Title').fill(title);
  const who = form.getByLabel('Who has it');
  await expect(who.locator('option')).toHaveText(['Unassigned (up for grabs)', member.name]);
  await who.selectOption({ label: member.name });
  await form.getByLabel('Repeats').selectOption('daily');
  await expect(form.getByLabel('Starting the week of')).toHaveCount(0);
  await form.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(`Added: ${title}`);
  await expect(page.getByRole('button', { name: 'Add chore' })).toBeFocused();
  const row = page.getByRole('listitem').filter({ hasText: title });
  await expect(row).toContainText('Every day');
  await expect(row).toContainText('You');
  await expect(row).toContainText('Due today');
  expect(await openTodoTitles(page, member.email)).toContain(title);
});

test('an admin adds an every weekday chore, and editing it shows Every weekday with Monday to Friday behind it', async ({ page }, info) => {
  const title = `Pack lunches ${newStamp(info)}`;
  await signIn(page, 'admin@example.com');
  await page.goto('/chores');
  await page.getByRole('button', { name: 'Add chore' }).click();
  const form = page.getByRole('form', { name: 'New chore' });
  await form.getByLabel('Title').fill(title);
  await form.getByLabel('Repeats').selectOption({ label: 'Every weekday' });
  await expect(form.getByLabel('Every how many weeks')).toHaveCount(0);
  await expect(form.getByLabel('Starting the week of')).toHaveCount(0);
  await expect(form.locator('[aria-live="polite"]')).toHaveText('Every weekday');
  await form.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(`Added: ${title}`);
  await expect(page.getByRole('listitem').filter({ hasText: title })).toContainText('Every weekday');

  await page.goto('/chores?tab=manage');
  const row = page.getByRole('listitem').filter({ hasText: title });
  await expect(row).toContainText('Every weekday');
  await row.getByRole('button', { name: /^Edit/ }).click();
  const edit = page.getByRole('form', { name: `Edit ${title}` });
  await expect(edit.getByLabel('Repeats')).toHaveValue('weekdays');
  await edit.getByLabel('Repeats').selectOption('weekly');
  await expect(edit.getByLabel('Every how many weeks')).toHaveValue('1');
  for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']) await expect(edit.getByLabel(day, { exact: true })).toBeChecked();
  for (const day of ['Saturday', 'Sunday']) await expect(edit.getByLabel(day, { exact: true })).not.toBeChecked();
  await expect(edit.locator('[aria-live="polite"]')).toHaveText('Every weekday');
  await edit.getByRole('button', { name: 'Cancel' }).click();
});

test('an admin adds a chore for a member, who completes it on their to-do list', async ({ page }, info) => {
  const member = await createMember(page, info, 'Chore kid');
  const title = `Feed the cat ${member.stamp}`;

  await page.goto('/chores');
  await page.getByRole('button', { name: 'Add chore' }).click();
  const form = page.getByRole('form', { name: 'New chore' });
  await form.getByLabel('Title').fill(title);
  await form.getByLabel('Who has it').selectOption({ label: member.name });
  // Every N weeks is the one frequency that asks for a start date.
  await form.getByLabel('Every how many weeks').fill('2');
  await expect(form.getByLabel('Starting the week of')).toBeVisible();
  await form.getByLabel('Every how many weeks').fill('1');
  await form.getByLabel('Repeats').selectOption('daily');
  await form.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(`Added: ${title}`);
  await expect(page.getByRole('listitem').filter({ hasText: title })).toContainText(member.name);

  // The member sees it on both cards, with a Chore tag on the to-do, and completes it there.
  await signIn(page, member.email);
  await page.goto('/');
  const todoCard = page.getByRole('region', { name: 'To-do' });
  const choresCard = page.getByRole('region', { name: 'Chores' });
  await expect(todoCard.getByRole('link', { name: `Chore: ${title}` })).toBeVisible();
  await expect(choresCard.getByRole('region', { name: 'Yours' }).getByRole('checkbox', { name: `Complete ${title}` })).toBeVisible();
  await todoCard.getByRole('checkbox', { name: `Complete ${title}` }).click();
  await expect(todoCard.getByText(title, { exact: true })).toHaveCount(0);
  await expect(choresCard.getByRole('checkbox', { name: `Complete ${title}` })).toHaveCount(0);
  // Done on the day, so it's coming up tomorrow.
  await expect(choresCard.getByRole('region', { name: 'Coming up' })).toContainText(title);
  await expect(choresCard.getByText('Nothing due right now.')).toBeVisible();

  // It's in their history (which shows their own by default), credited to them.
  await page.goto('/chores?tab=history');
  await expect(page.getByRole('link', { name: 'History', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('link', { name: 'Board', exact: true })).not.toHaveAttribute('aria-current');
  await expect(page.getByLabel('Person')).toHaveValue(String(member.id));
  await expect(page.getByText('1 completed · 0 late · 0 skipped')).toBeVisible();
  const entry = page.getByRole('region', { name: 'Completed and skipped' }).getByRole('listitem').filter({ hasText: title });
  await expect(entry).toContainText(member.name);
  await expect(entry).toContainText('Assigned: By an admin');
});

test("a member can't delete a chore to-do", async ({ page }, info) => {
  const member = await createMember(page, info, 'Chore keep');
  const title = `Empty dishwasher ${member.stamp}`;
  await addChore(page, title, member.id);

  await signIn(page, member.email);
  await page.goto('/todo');
  const row = page.getByRole('listitem').filter({ hasText: title });
  await expect(row.getByRole('checkbox', { name: `Complete ${title}` })).toBeVisible();
  await expect(row.getByRole('link', { name: `Chore: ${title}` })).toBeVisible();
  await expect(row.getByRole('button', { name: `Edit ${title}` })).toBeVisible();
  await expect(row.getByRole('button', { name: `Delete ${title}` })).toHaveCount(0);

  // The server refuses too.
  const list = (await (await page.request.get('/api/panels/todo/items')).json()) as {
    groups: Record<string, { id: number; title: string }[]>;
  };
  const item = Object.values(list.groups).flat().find((i) => i.title === title)!;
  const del = await page.request.delete(`/api/panels/todo/items/${item.id}`, { headers: MUTATION_HEADERS });
  expect(del.status()).toBe(403);
  expect(await del.json()).toEqual({
    error: { code: 'forbidden', message: "Chore to-dos can't be deleted. Complete it, or ask an admin to skip the chore." },
  });

  // The Chore tag opens the Board, where it's theirs to check off.
  await row.getByRole('link', { name: `Chore: ${title}` }).click();
  await expect(page).toHaveURL(/\/chores$/);
  await expect(page.getByRole('listitem').filter({ hasText: title }).getByRole('checkbox', { name: `Complete ${title}` })).toBeVisible();
});

test('an admin assigns by keyboard, and only the person assigned with the button gets the to-do', async ({ page }, info) => {
  const [first, second, third] = await createAdjacentMembers(page, info, 'Kbd', 3);
  const title = `Fold laundry ${first!.stamp}`;
  await addChore(page, title, first!.id);

  await page.goto('/chores');
  const row = page.getByRole('listitem').filter({ hasText: title });
  const toggle = row.getByRole('button', { name: `Assign ${title}…` });
  const picker = row.getByLabel(`Who has ${title}`);
  const confirm = row.getByRole('button', { name: `Assign ${title}`, exact: true });

  // The picker is closed until Assign… opens it, under the row, with focus in it.
  await expect(picker).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toHaveAttribute('aria-controls', /^assign-panel-\d+$/);
  await expect(picker).toBeFocused();
  await expect(picker).toHaveValue(String(first!.id));
  await expect(confirm).toBeDisabled();

  // Escape closes it and gives focus back to Assign….
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  await toggle.click();
  await expect(picker).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(picker).toHaveValue(String(third!.id));

  // Moving through the options only selects: nothing has been reassigned.
  await expect(page.getByRole('status')).toHaveText('');
  expect((await boardRowJson(page, title)).assignee?.id).toBe(first!.id);

  await confirm.click();
  await expect(page.getByRole('status')).toHaveText(`Assigned: ${title}`);
  await expect(picker).toHaveCount(0);
  await expect(toggle).toBeFocused();
  await expect(row).toContainText(third!.name);

  expect(await openTodoTitles(page, first!.email)).not.toContain(title);
  expect(await openTodoTitles(page, second!.email)).not.toContain(title);
  expect(await openTodoTitles(page, third!.email)).toContain(title);

  // Unassigning works the same way: pick Unassigned, then press Unassign.
  await signIn(page, 'admin@example.com');
  await page.goto('/chores');
  await toggle.click();
  await picker.selectOption({ label: 'Unassigned' });
  await row.getByRole('button', { name: `Unassign ${title}`, exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(`Unassigned: ${title}`);
  await expect(row).toContainText('Unassigned');
  expect(await openTodoTitles(page, third!.email)).not.toContain(title);
});

test("the assign picker warns about someone who won't see the chore before Assign is pressed", async ({ page }, info) => {
  const member = await createMember(page, info, 'Chore holder');
  const unseen = await createMember(page, info, 'No panels', { stamp: member.stamp, panels: [] });
  const title = `Rake leaves ${member.stamp}`;
  await addChore(page, title, member.id);

  await page.goto('/chores');
  const row = page.getByRole('listitem').filter({ hasText: title });
  const picker = row.getByLabel(`Who has ${title}`);
  const warning = `${unseen.name} has neither the Chores nor the To-do panel, so they won't see this chore.`;
  await expect(page.getByText(warning)).toHaveCount(0);
  await row.getByRole('button', { name: `Assign ${title}…` }).click();
  await picker.selectOption({ label: unseen.name });
  await expect(row.getByText(warning)).toBeVisible();
  await expect(picker).toHaveAccessibleDescription(warning);
  await expect(page.getByRole('status')).toHaveText('');
  await expect(row).toContainText(member.name);

  // Picking whoever has it again clears it.
  await picker.selectOption({ label: member.name });
  await expect(page.getByText(warning)).toHaveCount(0);

  // So does cancelling, which leaves the chore where it was.
  await picker.selectOption({ label: unseen.name });
  await expect(row.getByText(warning)).toBeVisible();
  await row.getByRole('button', { name: `Cancel assigning ${title}` }).click();
  await expect(picker).toHaveCount(0);
  await expect(page.getByText(warning)).toHaveCount(0);
  await expect(row.getByRole('button', { name: `Assign ${title}…` })).toBeFocused();
  expect((await boardRowJson(page, title)).assignee?.id).toBe(member.id);
});

test('an admin skips a chore on the Board and reopens it from History', async ({ page }, info) => {
  const member = await createMember(page, info, 'Chore skip');
  const title = `Sweep porch ${member.stamp}`;
  await addChore(page, title, member.id);

  await page.goto('/chores');
  const row = page.getByRole('listitem').filter({ hasText: title });
  await row.getByRole('button', { name: `Skip ${title}` }).click();
  await expect(page.getByRole('status')).toHaveText(`Skipped: ${title}`);
  // Skipped on the day: nothing due until tomorrow.
  await expect(row).toContainText('Next: Tomorrow');
  expect(await openTodoTitles(page, member.email)).not.toContain(title);

  await signIn(page, 'admin@example.com');
  await page.goto('/chores?tab=history');
  await page.getByLabel('Person').selectOption('all');
  const entry = page.getByRole('region', { name: 'Completed and skipped' }).getByRole('listitem').filter({ hasText: title });
  await expect(entry).toContainText('Skipped by');
  await entry.getByRole('button', { name: `Reopen ${title}` }).click();
  await expect(page.getByRole('status')).toHaveText(`Reopened: ${title}`);
  await expect(entry).toHaveCount(0);
  await page.goto('/chores');
  await expect(row).toContainText('Due today');
  expect(await openTodoTitles(page, member.email)).toContain(title);
});

test('an admin deleting a chore to-do skips the occurrence, which History shows as skipped', async ({ page }, info) => {
  const member = await createMember(page, info, 'Chore deleted');
  const title = `Wipe counters ${member.stamp}`;
  await addChore(page, title, member.id);

  await page.goto(`/todo?userId=${member.id}`);
  const row = page.getByRole('listitem').filter({ hasText: title });
  await expect(row.getByRole('link', { name: `Chore: ${title}` })).toBeVisible();
  let question = '';
  page.once('dialog', (d) => {
    question = d.message();
    void d.accept();
  });
  await row.getByRole('button', { name: `Delete ${title}` }).click();
  await expect(row).toHaveCount(0);
  expect(question).toBe(`Delete "${title}"? This skips the chore.`);

  await page.goto('/chores');
  await boardLoaded(page);
  await expect(page.getByRole('listitem').filter({ hasText: title })).toContainText('Next: Tomorrow');

  // History, opened with its filters in the URL.
  await page.goto(`/chores?tab=history&person=${member.id}`);
  await expect(page.getByLabel('Person')).toHaveValue(String(member.id));
  await expect(page.getByText('0 completed · 0 late · 1 skipped')).toBeVisible();
  const entry = page.getByRole('region', { name: 'Completed and skipped' }).getByRole('listitem').filter({ hasText: title });
  await expect(entry).toContainText('Skipped by');
  await expect(entry.getByText('Skipped', { exact: true })).toBeVisible();

  // Hiding skips goes in the URL, survives a reload, and the back button undoes it.
  await page.getByLabel('Show skipped').uncheck();
  await expect(page).toHaveURL(/[?&]skipped=false(&|$)/);
  await expect(page).toHaveURL(new RegExp(`[?&]person=${member.id}(&|$)`));
  await expect(entry).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('Show skipped')).not.toBeChecked();
  await expect(page.getByLabel('Person')).toHaveValue(String(member.id));
  await expect(page.getByText('0 completed · 0 late · 1 skipped')).toBeVisible();
  await expect(entry).toHaveCount(0);
  await page.goBack();
  await expect(page.getByLabel('Show skipped')).toBeChecked();
  await expect(entry).toBeVisible();
});

test('pausing takes a chore off the board and the to-do list; resuming puts it back on their list', async ({ page }, info) => {
  const member = await createMember(page, info, 'Chore paused');
  const title = `Water garden ${member.stamp}`;
  await addChore(page, title, member.id);
  expect(await openTodoTitles(page, member.email)).toContain(title);

  await signIn(page, 'admin@example.com');
  await page.goto('/chores?tab=manage');
  await expect(page.getByRole('link', { name: 'Manage', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('button', { name: `Pause ${title}` }).click();
  await expect(page.getByRole('status')).toHaveText(`Paused: ${title}`);
  await expect(page.getByRole('button', { name: `Resume ${title}` })).toBeFocused();
  await expect(page.getByRole('region', { name: /^Paused/ }).getByRole('listitem').filter({ hasText: title })).toContainText(`Has it: ${member.name}`);

  await page.goto('/chores');
  await boardLoaded(page);
  await expect(page.getByRole('listitem').filter({ hasText: title })).toHaveCount(0);
  expect(await openTodoTitles(page, member.email)).not.toContain(title);

  await signIn(page, 'admin@example.com');
  await page.goto('/chores?tab=manage');
  await page.getByRole('button', { name: `Resume ${title}` }).click();
  await expect(page.getByRole('status')).toHaveText(`Resumed: ${title}`);
  expect(await openTodoTitles(page, member.email)).toContain(title);
});

test("members don't see the admin controls on the Board", async ({ page }, info) => {
  const member = await createMember(page, info, 'Chore member');
  const other = await createMember(page, info, 'Chore other', { stamp: member.stamp });
  const mine = `Make lunch ${member.stamp}`;
  const grabs = `Walk dog ${member.stamp}`;
  const theirs = `Mow lawn ${member.stamp}`;
  await addChore(page, mine, member.id);
  await addChore(page, grabs, null);
  await addChore(page, theirs, other.id);

  // The admin has them, so their absence below means something.
  await page.goto('/chores');
  const adminRow = page.getByRole('listitem').filter({ hasText: theirs });
  await expect(adminRow.getByRole('button', { name: `Skip ${theirs}` })).toBeVisible();
  await expect(adminRow.getByRole('button', { name: `Assign ${theirs}…` })).toBeVisible();

  await signIn(page, member.email);
  await page.goto('/chores');
  await boardLoaded(page);
  await expect(page.getByRole('link', { name: 'Manage', exact: true })).toHaveCount(0);
  const mineRow = page.getByRole('listitem').filter({ hasText: mine });
  const grabsRow = page.getByRole('listitem').filter({ hasText: grabs });
  const theirRow = page.getByRole('listitem').filter({ hasText: theirs });
  await expect(mineRow.getByRole('checkbox', { name: `Complete ${mine}` })).toBeVisible();
  await expect(mineRow.getByRole('button', { name: `Release ${mine}` })).toBeVisible();
  await expect(grabsRow.getByRole('button', { name: `Claim ${grabs}` })).toBeVisible();
  await expect(theirRow.getByRole('button', { name: `Take over ${theirs}` })).toBeVisible();
  await expect(theirRow.getByRole('button')).toHaveCount(1);

  // The Who has it filter is the only picker: no assign pickers.
  await expect(page.getByRole('combobox')).toHaveCount(1);
  await expect(page.getByRole('combobox', { name: 'Who has it', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^(Skip|Assign|Unassign) / })).toHaveCount(0);
  await expect(page.getByText(/won't see this chore/)).toHaveCount(0);
});

test("a slow add or edit doesn't pull focus back from where it went meanwhile", async ({ page }, info) => {
  const stamp = newStamp(info);
  await signIn(page, 'admin@example.com');
  const title = `Water plants ${stamp}`;
  await page.goto('/chores');
  const history = page.getByRole('link', { name: 'History', exact: true });

  /** Holds the next request to `url` with `method`; `release()` sends it on. */
  async function hold(url: string, method: string) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held = 0;
    await page.route(url, async (route) => {
      if (route.request().method() !== method) return route.fallback();
      held++;
      await gate;
      await route.continue();
    });
    return { held: () => held, release: () => release() };
  }

  // Adding on the Board: focus goes to a link while the save is out, and stays there once it's saved.
  await page.getByRole('button', { name: 'Add chore' }).click();
  const form = page.getByRole('form', { name: 'New chore' });
  await form.getByLabel('Title').fill(title);
  await form.getByLabel('Repeats').selectOption('daily');
  const add = await hold('**/api/panels/chores/chores', 'POST');
  await form.getByRole('button', { name: 'Add', exact: true }).click();
  await expect.poll(add.held).toBe(1);
  await history.focus();
  add.release();
  await expect(page.getByRole('status')).toHaveText(`Added: ${title}`);
  await expect(page.getByRole('button', { name: 'Add chore' })).toBeVisible();
  await expect(history).toBeFocused();
  await page.unroute('**/api/panels/chores/chores');

  // Editing on the Manage tab: the same.
  await page.goto('/chores?tab=manage');
  const row = page.getByRole('listitem').filter({ hasText: title });
  await row.getByRole('button', { name: /^Edit/ }).click();
  const edit = page.getByRole('form', { name: `Edit ${title}` });
  await expect(edit.getByLabel('Who has it')).toHaveCount(0);
  await edit.getByLabel('Title').fill(`${title} again`);
  const save = await hold('**/api/panels/chores/chores/*', 'PUT');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect.poll(save.held).toBe(1);
  await page.getByRole('link', { name: 'History', exact: true }).focus();
  save.release();
  await expect(page.getByRole('status')).toHaveText(`Saved: ${title} again`);
  await expect(page.getByRole('link', { name: 'History', exact: true })).toBeFocused();
  await page.unroute('**/api/panels/chores/chores/*');
});

test('the Who has it filter shows yours, unassigned, or one person, keeps the board order, and is in the URL', async ({ page }, info) => {
  const me = await createMember(page, info, 'Filter me');
  const other = await createMember(page, info, 'Filter other', { stamp: me.stamp });
  const s = me.stamp;
  await addChore(page, `Mine daily ${s}`, me.id);
  await addChore(page, `Mine as needed ${s}`, me.id, { kind: 'none' });
  await addChore(page, `Theirs ${s}`, other.id);
  await addChore(page, `Open ${s}`, null);

  await signIn(page, me.email);
  await page.goto('/chores');
  await boardLoaded(page);
  const rows = page.getByRole('listitem').filter({ hasText: s });
  await expect(rows).toHaveCount(4);

  // Who has it is a column on wider screens (avatar and name), and in the meta line on phones.
  const theirs = rows.filter({ hasText: `Theirs ${s}` });
  const column = theirs.locator('.chore-who');
  const metaWho = theirs.locator('.chore-who-meta');
  if (info.project.name === 'phone') {
    await expect(column).toBeHidden();
    await expect(metaWho).toBeVisible();
    await expect(metaWho).toHaveText(other.name);
  } else {
    await expect(column).toBeVisible();
    await expect(column.locator('.chore-who-name')).toHaveText(`Who has it: ${other.name}`);
    await expect(column.locator('.avatar')).toHaveText(other.name.slice(0, 1).toUpperCase());
    await expect(metaWho).toBeHidden();
    await expect(rows.filter({ hasText: `Open ${s}` }).locator('.chore-who-name')).toHaveText('Who has it: Unassigned');
    await expect(rows.filter({ hasText: `Open ${s}` }).locator('.chore-who .avatar-open')).toBeVisible();
    await expect(page.getByText('Who has it', { exact: true }).last()).toBeVisible();
  }

  const filter = page.getByRole('combobox', { name: 'Who has it', exact: true });
  await expect(filter.locator('option:checked')).toHaveText('Everyone');
  await expect(filter.locator('option', { hasText: other.name })).toHaveCount(1);
  await expect(filter.locator('option', { hasText: me.name })).toHaveCount(0);

  // Mine: only yours, in board order (most often first), and the count says of how many.
  await filter.selectOption({ label: 'Mine' });
  await expect(page).toHaveURL(/[?&]who=mine\b/);
  await expect(rows.locator('.todo-title')).toHaveText([`Mine daily ${s}`, `Mine as needed ${s}`]);
  await expect(page.getByRole('heading', { name: /^Chores \(2 of \d+\)$/ })).toBeVisible();

  // One person, and it survives a reload.
  await filter.selectOption({ label: other.name });
  await expect(page).toHaveURL(new RegExp(`[?&]who=${other.id}(&|$)`));
  await expect(rows.locator('.todo-title')).toHaveText([`Theirs ${s}`]);
  await page.reload();
  await expect(page.getByRole('heading', { name: /^Chores \(\d+ of \d+\)$/ })).toBeVisible();
  await expect(filter.locator('option:checked')).toHaveText(other.name);
  await expect(rows.locator('.todo-title')).toHaveText([`Theirs ${s}`]);

  // Unassigned.
  await filter.selectOption({ label: 'Unassigned' });
  await expect(rows.locator('.todo-title')).toHaveText([`Open ${s}`]);
  // The controls are the same as ever.
  await expect(rows.getByRole('button', { name: `Claim Open ${s}` })).toBeVisible();

  // Releasing your last chore under Mine hides it, says so, and focus goes to the heading; then the empty state.
  await filter.selectOption({ label: 'Mine' });
  await rows.getByRole('button', { name: `Release Mine daily ${s}` }).click();
  await expect(page.getByRole('status')).toHaveText(`Released: Mine daily ${s}. It no longer matches the filter, so it is hidden.`);
  await expect(page.getByRole('heading', { name: /^Chores \(1 of \d+\)$/ })).toBeFocused();
  await rows.getByRole('button', { name: `Release Mine as needed ${s}` }).click();
  await expect(page.getByText("You don't have any chores right now.")).toBeVisible();
  await expect(rows).toHaveCount(0);

  // Everyone drops it from the URL and shows the whole board again.
  await filter.selectOption({ label: 'Everyone' });
  await expect(page).not.toHaveURL(/[?&]who=/);
  await boardLoaded(page);
  await expect(rows).toHaveCount(4);
});
