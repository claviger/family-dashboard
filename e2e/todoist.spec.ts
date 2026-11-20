import { expect, test, type Page, type TestInfo } from '@playwright/test';

/**
 * Todoist end to end, against the fake Todoist that playwright.config.ts starts on port 3101.
 * Its consent page approves at once, and each link gets a fresh fake account, so tests running
 * side by side never share tasks.
 */
const MUTATION_HEADERS = { 'x-requested-with': 'dashboard', origin: 'http://localhost:3100' };
const FAKE = 'http://127.0.0.1:3101';

async function signIn(page: Page, email: string) {
  await page.context().clearCookies();
  const res = await page.request.post('/auth/test-login', { data: { email }, headers: MUTATION_HEADERS });
  expect(res.status()).toBe(204);
}

/** A member with the To-do and Chores panels. Leaves the page signed in as the admin. */
async function createMember(page: Page, info: TestInfo, label: string) {
  const stamp = `${info.project.name}-${info.repeatEachIndex}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const member = { name: `${label} ${stamp}`, email: `${label.toLowerCase().replace(/\W+/g, '-')}-${stamp}@example.com`, stamp };
  await signIn(page, 'admin@example.com');
  const created = await page.request.post('/api/admin/users', {
    data: { email: member.email, displayName: member.name, color: '#1D9E75', role: 'member', panels: ['todo', 'chores'] },
    headers: MUTATION_HEADERS,
  });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: number };
  return { ...member, id };
}

/** Connects Todoist from /settings and waits until any existing to-dos have moved. */
async function connectTodoist(page: Page) {
  await page.goto('/settings');
  // A POST (behind the CSRF check), then the browser visits Todoist's consent page.
  await page.getByRole('button', { name: 'Connect Todoist' }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByText('Todoist is connected.')).toBeVisible();
  await expect(page.getByText(/Moving \d+ to-dos? into Todoist/)).toHaveCount(0, { timeout: 15_000 });
}

/** The task in the fake Todoist with this exact content. */
async function fakeTask(page: Page, content: string) {
  const res = await page.request.get(`${FAKE}/__fake/tasks?content=${encodeURIComponent(content)}`);
  expect(res.status()).toBe(200);
  return (await res.json()) as { id: string; checked: boolean; is_deleted: boolean; project_name: string; account_id: string };
}

/** Accepts the next confirmation dialog and returns its message, to assert on after the click. */
function acceptNextDialog(page: Page): { message: string | null } {
  const seen: { message: string | null } = { message: null };
  page.once('dialog', (d) => {
    seen.message = d.message();
    void d.accept();
  });
  return seen;
}

test('linking moves existing to-dos into Todoist, and the list shows the mirror', async ({ page }, info) => {
  const member = await createMember(page, info, 'Todoist link');
  const title = `Before linking ${member.stamp}`;
  await signIn(page, member.email);
  const added = await page.request.post('/api/panels/todo/items', { data: { title }, headers: MUTATION_HEADERS });
  expect(added.status()).toBe(201);

  await connectTodoist(page);
  expect(await fakeTask(page, title)).toMatchObject({ checked: false, project_name: 'Inbox' });
  await expect(page.getByText('Admins can see and edit your to-do list.')).toBeVisible();
  await expect(page.getByText(/^Connected as todoist-.+@example\.com\./)).toBeVisible();
  await expect(page.getByLabel('Chore to-dos go to')).toHaveValue(/.+/);

  await page.goto('/');
  const card = page.getByRole('region', { name: 'To-do' });
  await expect(card.getByText(title, { exact: true })).toBeVisible();
  await expect(card.getByText(/Todoist · updated just now/)).toBeVisible();

  await page.goto('/todo');
  const noDate = page.getByRole('region', { name: 'No date' });
  await expect(noDate.getByRole('listitem').filter({ hasText: title })).toContainText('Inbox');
  // Everything is in the Inbox, so there's nothing to group by project.
  await expect(page.getByRole('button', { name: 'Group by project' })).toHaveCount(0);

  // A to-do added on the dashboard goes to Todoist first, into the Inbox.
  const second = `Added after ${member.stamp}`;
  const form = page.getByRole('form', { name: 'Add a to-do' });
  await form.getByLabel('Title').fill(second);
  await form.getByRole('button', { name: 'Add' }).click();
  await expect(noDate.getByRole('checkbox', { name: `Complete ${second}` })).toBeVisible();
  expect(await fakeTask(page, second)).toMatchObject({ checked: false, project_name: 'Inbox' });
});

test('only the Inbox syncs, plus chore to-dos wherever they are', async ({ page }, info) => {
  const member = await createMember(page, info, 'Todoist inbox only');
  const marker = `Marker ${member.stamp}`;
  await signIn(page, member.email);
  expect((await page.request.post('/api/panels/todo/items', { data: { title: marker }, headers: MUTATION_HEADERS })).status()).toBe(201);
  await connectTodoist(page);
  await expect(page.getByText(/Only your Todoist Inbox syncs with this list/)).toBeVisible();
  const { account_id: account } = await fakeTask(page, marker);

  // Added in Todoist itself: one task in another project, then one in the Inbox. Each delivers a webhook.
  const elsewhere = `In Work ${member.stamp}`;
  const inInbox = `In the Inbox ${member.stamp}`;
  const work = await page.request.post(`${FAKE}/__fake/tasks/add`, { data: { account, content: elsewhere, project: 'Work' } });
  expect(work.status()).toBe(200);
  const { project_id: workId } = (await work.json()) as { project_id: string };
  expect((await page.request.post(`${FAKE}/__fake/tasks/add`, { data: { account, content: inInbox } })).status()).toBe(200);

  // Once the Inbox task shows, the sync that brought it has seen the other one too.
  await page.goto('/todo');
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole('checkbox', { name: `Complete ${inInbox}` })).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await expect(page.getByText(elsewhere)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Group by project' })).toHaveCount(0);

  // Chore to-dos go to the Work project from now on, and they do sync from there.
  const chosen = await page.request.put('/api/todoist/chores-project', { data: { projectId: workId }, headers: MUTATION_HEADERS });
  expect(chosen.status()).toBe(204);
  const chore = `Sweep the porch ${member.stamp}`;
  await signIn(page, 'admin@example.com');
  const { today } = (await (await page.request.get('/api/panels/chores/chores')).json()) as { today: string };
  const created = await page.request.post('/api/panels/chores/chores', {
    data: { title: chore, notes: null, assigneeUserId: member.id, schedule: { kind: 'daily' }, startDate: today },
    headers: MUTATION_HEADERS,
  });
  expect(created.status()).toBe(201);
  expect(await fakeTask(page, chore)).toMatchObject({ checked: false, project_name: 'Work' });

  await signIn(page, member.email);
  await page.goto('/todo');
  await expect(page.getByRole('checkbox', { name: `Complete ${chore}` })).toBeVisible();
  await expect(page.getByText(elsewhere)).toHaveCount(0);
  // Now the list spans two projects, so it can be grouped by them.
  await page.getByRole('button', { name: 'Group by project' }).click();
  await expect(page.getByRole('button', { name: 'Group by project' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/group=project/);
  await expect(page.getByRole('region', { name: 'Inbox' }).getByRole('checkbox', { name: `Complete ${inInbox}` })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Work' }).getByRole('checkbox', { name: `Complete ${chore}` })).toBeVisible();
});

test('a chore to-do completed in Todoist completes the chore, through the webhook', async ({ page }, info) => {
  const member = await createMember(page, info, 'Todoist chore');
  const title = `Water the plants ${member.stamp}`;
  await signIn(page, member.email);
  await connectTodoist(page);

  await signIn(page, 'admin@example.com');
  const { today } = (await (await page.request.get('/api/panels/chores/chores')).json()) as { today: string };
  const chore = await page.request.post('/api/panels/chores/chores', {
    data: { title, notes: null, assigneeUserId: member.id, schedule: { kind: 'daily' }, startDate: today },
    headers: MUTATION_HEADERS,
  });
  expect(chore.status()).toBe(201);
  expect(await fakeTask(page, title)).toMatchObject({ checked: false, project_name: 'Inbox' });

  // Checked off in Todoist; the fake delivers a signed item:completed webhook to the app.
  const done = await page.request.post(`${FAKE}/__fake/tasks/complete`, { data: { content: title } });
  expect(done.status()).toBe(200);

  await signIn(page, member.email);
  await expect
    .poll(async () => {
      const history = (await (await page.request.get('/api/panels/chores/history')).json()) as { entries: { title: string; state: string }[] };
      return history.entries.find((e) => e.title === title)?.state ?? null;
    }, { timeout: 10_000 })
    .toBe('done');
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Chores' }).getByRole('checkbox', { name: `Complete ${title}` })).toHaveCount(0);
});

test('unlinking keeps the to-dos on the dashboard list', async ({ page }, info) => {
  const member = await createMember(page, info, 'Todoist unlink');
  const title = `Keep me ${member.stamp}`;
  await signIn(page, member.email);
  await connectTodoist(page);
  expect((await page.request.post('/api/panels/todo/items', { data: { title }, headers: MUTATION_HEADERS })).status()).toBe(201);

  const { account_id: account } = await fakeTask(page, title);

  await page.goto('/settings');
  const dialog = acceptNextDialog(page);
  await page.getByRole('button', { name: 'Disconnect Todoist' }).click();
  await expect(page.getByRole('button', { name: 'Connect Todoist' })).toBeFocused();
  expect(dialog.message).toContain('Nothing is deleted from Todoist');
  expect(dialog.message).toContain('The open tasks in your Todoist Inbox and your chore to-dos');

  await page.goto('/');
  const card = page.getByRole('region', { name: 'To-do' });
  await expect(card.getByText(title, { exact: true })).toBeVisible();
  await expect(card.getByText(/Todoist ·/)).toHaveCount(0);
  // Still in Todoist, and both of the link's tokens were revoked.
  expect(await fakeTask(page, title)).toMatchObject({ is_deleted: false, checked: false });
  const revoked = (await (await page.request.get(`${FAKE}/__fake/revocations?account=${account}`)).json()) as string[];
  expect([...revoked].sort()).toEqual(['access', 'refresh']);
});

test('linking a different Todoist account after unlinking moves the to-dos there, deleting nothing', async ({ page }, info) => {
  const member = await createMember(page, info, 'Todoist other account');
  const title = `Moves along ${member.stamp}`;
  await signIn(page, member.email);
  expect((await page.request.post('/api/panels/todo/items', { data: { title }, headers: MUTATION_HEADERS })).status()).toBe(201);
  await connectTodoist(page);
  const { account_id: first } = await fakeTask(page, title);

  await page.goto('/settings');
  acceptNextDialog(page);
  await page.getByRole('button', { name: 'Disconnect Todoist' }).click();
  await expect(page.getByRole('button', { name: 'Connect Todoist' })).toBeFocused();
  // The fake's consent page signs in to a new account unless a cookie names one.
  await connectTodoist(page);

  const copies = (await (await page.request.get(`${FAKE}/__fake/tasks?content=${encodeURIComponent(title)}&all=1`)).json()) as { account_id: string; checked: boolean }[];
  expect(copies).toHaveLength(2);
  expect(copies.find((c) => c.account_id === first)).toMatchObject({ checked: false });
  expect(copies.find((c) => c.account_id !== first)).toMatchObject({ checked: false });
  await page.goto('/');
  const card = page.getByRole('region', { name: 'To-do' });
  await expect(card.getByText(title, { exact: true })).toBeVisible();
  await expect(card.getByText(/Todoist · updated/)).toBeVisible();
});

test('someone whose To-do panel was turned off can still disconnect their Todoist', async ({ page }, info) => {
  const member = await createMember(page, info, 'Todoist no panel');
  await signIn(page, member.email);
  await connectTodoist(page);
  await signIn(page, 'admin@example.com');
  const off = await page.request.put(`/api/admin/users/${member.id}/panels/todo`, { data: { enabled: false }, headers: MUTATION_HEADERS });
  expect(off.status()).toBe(204);

  await signIn(page, member.email);
  await page.goto('/settings');
  await expect(page.getByText(/still linked to Todoist/)).toBeVisible();
  const dialog = acceptNextDialog(page);
  await page.getByRole('button', { name: 'Disconnect Todoist' }).click();
  await expect(page.getByText('Todoist is disconnected.')).toBeFocused();
  expect(dialog.message).toContain('Disconnect Todoist?');
  await expect(page.getByRole('button', { name: 'Disconnect Todoist' })).toHaveCount(0);
});

test('a revoked Todoist link shows a Reconnect prompt', async ({ page }, info) => {
  const member = await createMember(page, info, 'Todoist revoked');
  const title = `Marker ${member.stamp}`;
  await signIn(page, member.email);
  await connectTodoist(page);
  expect((await page.request.post('/api/panels/todo/items', { data: { title }, headers: MUTATION_HEADERS })).status()).toBe(201);
  expect((await page.request.post(`${FAKE}/__fake/accounts/revoke`, { data: { content: title } })).status()).toBe(200);

  // The next change goes to Todoist first, which refuses the token, and the refresh too.
  const refused = await page.request.post('/api/panels/todo/items', { data: { title: 'Not saved' }, headers: MUTATION_HEADERS });
  expect(refused.status()).toBe(503);
  expect(((await refused.json()) as { error: { message: string } }).error.message).toMatch(/reconnect/i);
  await page.goto('/');
  const card = page.getByRole('region', { name: 'To-do' });
  await expect(card.getByText(title, { exact: true })).toBeVisible();

  // Reconnecting signs in to the same Todoist account again (the fake's consent page uses the
  // account this cookie names), and the link works again.
  const { account_id: account } = await fakeTask(page, title);
  await page.context().addCookies([{ name: 'fake_account', value: account, url: 'http://localhost:3101' }]);
  await card.getByRole('button', { name: 'Reconnect Todoist' }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByText('Todoist is connected.')).toBeFocused();
  await expect(page.getByText(/^Connected as todoist-.+@example\.com\./)).toBeVisible();
  const saved = await page.request.post('/api/panels/todo/items', { data: { title: `Saved ${member.stamp}` }, headers: MUTATION_HEADERS });
  expect(saved.status()).toBe(201);
  expect(await fakeTask(page, `Saved ${member.stamp}`)).toMatchObject({ account_id: account, checked: false });
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'To-do' }).getByRole('button', { name: 'Reconnect Todoist' })).toHaveCount(0);
});
