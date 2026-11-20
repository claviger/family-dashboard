import { expect, test, type Page, type TestInfo } from '@playwright/test';

const MUTATION_HEADERS = { 'x-requested-with': 'dashboard', origin: 'http://localhost:3100' };

async function signIn(page: Page, email: string) {
  await page.context().clearCookies();
  const res = await page.request.post('/auth/test-login', { data: { email }, headers: MUTATION_HEADERS });
  expect(res.status()).toBe(204);
}

/**
 * Creates a member with the To-do panel and leaves the page signed in as the admin. Each test
 * gets its own member, so tests don't share a list across projects or repeats.
 */
async function createMember(page: Page, info: TestInfo, label: string) {
  const stamp = `${info.project.name}-${info.repeatEachIndex}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const member = { name: `${label} ${stamp}`, email: `${label.toLowerCase().replace(/\W+/g, '-')}-${stamp}@example.com`, stamp };
  await signIn(page, 'admin@example.com');
  const created = await page.request.post('/api/admin/users', {
    data: { email: member.email, displayName: member.name, color: '#1D9E75', role: 'member', panels: ['todo'] },
    headers: MUTATION_HEADERS,
  });
  expect(created.status()).toBe(201);
  return member;
}

test('quick add and complete on the home card, then reopen in the drill-down', async ({ page }, info) => {
  const member = await createMember(page, info, 'Todo quick');
  const title = `Buy milk ${member.stamp}`;
  await signIn(page, member.email);
  await page.goto('/');

  const card = page.getByRole('region', { name: 'To-do' });
  await card.getByLabel('New to-do').fill(title);
  await card.getByRole('button', { name: 'Add' }).click();
  await expect(card.getByText(title, { exact: true })).toBeVisible();
  await expect(card.getByRole('status')).toHaveText(`Added: ${title}`);

  await card.getByRole('checkbox', { name: `Complete ${title}` }).click();
  await expect(card.getByText(title, { exact: true })).toHaveCount(0);

  await card.getByRole('link', { name: 'To-do' }).click();
  await expect(page).toHaveURL(/\/todo$/);
  await expect(page.getByText('Admins can see and edit your to-do list.')).toBeVisible();
  await page.getByText(/Completed in the last 7 days/).click();
  await page.getByRole('button', { name: `Reopen ${title}` }).click();
  await expect(page.getByRole('region', { name: 'No date' }).getByRole('checkbox', { name: `Complete ${title}` })).toBeVisible();

  // Opening the editor focuses its title; cancelling returns focus to the row's Edit button.
  await page.getByRole('button', { name: `Edit ${title}` }).click();
  await expect(page.getByRole('form', { name: `Edit ${title}` }).getByLabel('Title')).toBeFocused();
  await page.getByRole('form', { name: `Edit ${title}` }).getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('button', { name: `Edit ${title}` })).toBeFocused();

  // After an add, focus returns to the add form's title.
  const second = `Buy bread ${member.stamp}`;
  const addForm = page.getByRole('form', { name: 'Add a to-do' });
  await addForm.getByLabel('Title').fill(second);
  await addForm.getByRole('button', { name: 'Add' }).click();
  const noDate = page.getByRole('region', { name: 'No date' });
  await expect(noDate.getByRole('checkbox', { name: `Complete ${second}` })).toBeVisible();
  await expect(addForm.getByLabel('Title')).toBeFocused();

  // After a delete, focus moves to the next row, else the group heading, else the add form.
  page.on('dialog', (d) => void d.accept());
  await expect(noDate.getByRole('checkbox')).toHaveCount(2);
  await page.getByRole('button', { name: `Delete ${title}` }).click();
  await expect(noDate.getByRole('checkbox', { name: `Complete ${title}` })).toHaveCount(0);
  await expect(noDate.getByRole('checkbox', { name: `Complete ${second}` })).toBeFocused();
  await addForm.getByLabel('Title').fill(title);
  await addForm.getByRole('button', { name: 'Add' }).click();
  await expect(noDate.getByRole('checkbox')).toHaveCount(2);
  await page.getByRole('button', { name: `Delete ${title}` }).click();
  await expect(noDate.getByRole('checkbox')).toHaveCount(1);
  await expect(noDate.getByRole('heading', { name: /No date/ })).toBeFocused();
  await page.getByRole('button', { name: `Delete ${second}` }).click();
  await expect(page.getByText('Nothing to do.')).toBeVisible();
  await expect(addForm.getByLabel('Title')).toBeFocused();
});

test('a failed completion on the home card rolls back and says so', async ({ page }, info) => {
  const member = await createMember(page, info, 'Todo rollback');
  const title = `Water plants ${member.stamp}`;
  await signIn(page, member.email);
  await page.goto('/');

  const card = page.getByRole('region', { name: 'To-do' });
  await card.getByLabel('New to-do').fill(title);
  await card.getByRole('button', { name: 'Add' }).click();
  const checkbox = card.getByRole('checkbox', { name: `Complete ${title}` });
  await expect(checkbox).not.toBeChecked();

  await page.route('**/complete', (r) =>
    r.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'internal', message: 'Something went wrong. Try again.' } }),
    }),
  );
  await checkbox.click();
  await expect(card.getByRole('alert')).toHaveText("Couldn't complete that to-do. Something went wrong. Try again.");
  await expect(checkbox).not.toBeChecked();
  await expect(checkbox).toBeEnabled();
});

test("an admin views and adds to another person's list", async ({ page }, info) => {
  const member = await createMember(page, info, 'Todo kid');
  const { name, email } = member;
  const kidItem = `Homework ${member.stamp}`;
  const adminItem = `Practice piano ${member.stamp}`;

  // The member adds an item and has no person picker.
  await signIn(page, email);
  await page.goto('/');
  const card = page.getByRole('region', { name: 'To-do' });
  await card.getByLabel('New to-do').fill(kidItem);
  await card.getByRole('button', { name: 'Add' }).click();
  await expect(card.getByText(kidItem, { exact: true })).toBeVisible();
  await page.goto('/todo');
  await expect(page.getByText('Admins can see and edit your to-do list.')).toBeVisible();
  await expect(page.getByLabel('Person')).toHaveCount(0);

  // The admin picks the member, sees their item, and adds one with a due date.
  await signIn(page, 'admin@example.com');
  await page.goto('/todo');
  await page.getByLabel('Person').selectOption({ label: name });
  await expect(page).toHaveURL(/\/todo\?userId=\d+$/);
  await expect(page.getByRole('heading', { name: `${name}'s list` })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: `Complete ${kidItem}` })).toBeVisible();
  const form = page.getByRole('form', { name: 'Add a to-do' });
  await form.getByLabel('Title').fill(adminItem);
  await form.getByLabel('Due date').fill('2026-01-01');
  await form.getByRole('button', { name: `Add to ${name}'s list` }).click();
  await expect(page.getByRole('region', { name: 'Overdue' }).getByText(adminItem)).toBeVisible();
  await expect(page.getByRole('form', { name: 'Add a to-do' }).getByLabel('Title')).toBeFocused();

  // The member sees the admin's item on their home card.
  await signIn(page, email);
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'To-do' }).getByText(adminItem)).toBeVisible();
});

test('an unknown userId shows a placeholder instead of picking someone', async ({ page }) => {
  await signIn(page, 'admin@example.com');
  await page.goto('/todo?userId=999999');
  await expect(page.getByLabel('Person')).toHaveValue('');
  await expect(page.getByRole('option', { name: 'Choose a person' })).toBeAttached();
  await expect(page.getByText("That person doesn't have a to-do list.")).toBeVisible();
  await expect(page.getByRole('form', { name: 'Add a to-do' })).toHaveCount(0);
});
