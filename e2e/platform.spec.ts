import { expect, test, type Page } from '@playwright/test';

async function signIn(page: Page, email: string) {
  const res = await page.request.post('/auth/test-login', {
    data: { email },
    headers: { 'x-requested-with': 'dashboard', origin: 'http://localhost:3100' },
  });
  expect(res.status()).toBe(204);
}

test('visitors without a session see the sign-in page', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Sign in with Google' })).toBeVisible();
});

test('admin adds a user, grants a panel, and the user sees only that panel', async ({ page }, info) => {
  const name = `Kid ${info.project.name} ${Math.random().toString(36).slice(2, 8)}`;
  // Unique per run: copies of this test from --repeat-each can start in the same millisecond.
  const email = `kid-${info.project.name}-${info.repeatEachIndex}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

  await signIn(page, 'admin@example.com');
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Our family' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Calendar/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Spend/ })).toBeVisible();

  await page.getByRole('link', { name: 'Admin' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Display name').fill(name);
  await page.getByRole('button', { name: 'Add user' }).click();
  await expect(page.getByRole('cell', { name: email })).toBeVisible();

  await page.getByRole('checkbox', { name: `Chores for ${name}` }).click();
  await expect(page.getByRole('checkbox', { name: `Chores for ${name}` })).toBeChecked();

  await page.context().clearCookies();
  await signIn(page, email);
  await page.goto('/');
  await expect(page.getByRole('link', { name: /Chores/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Spend/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Admin' })).toHaveCount(0);

  await page.getByRole('link', { name: /Chores/ }).click();
  await expect(page).toHaveURL(/\/chores$/);
  await expect(page.getByRole('navigation', { name: 'Chores views' })).toBeVisible();
  await page.goto('/spend');
  await expect(page.getByText("You don't have access to this panel.")).toBeVisible();
});

test("changing a user's email asks first and signs them out (scan finding F2)", async ({ page, browser }, info) => {
  const tag = `${info.project.name}-${info.repeatEachIndex}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const name = `Moved ${tag}`;
  const email = `moved-${tag}@example.com`;
  const newEmail = `moved-new-${tag}@example.com`;

  await signIn(page, 'admin@example.com');
  await page.goto('/admin');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Display name').fill(name);
  await page.getByRole('button', { name: 'Add user' }).click();
  await expect(page.getByRole('cell', { name: email })).toBeVisible();

  // The user is signed in elsewhere.
  const theirs = await browser.newContext();
  const them = await theirs.newPage();
  await signIn(them, email);
  await them.goto('/');
  await expect(them.getByRole('heading', { name: 'Our family' })).toBeVisible();

  const row = page.getByRole('row').filter({ hasText: email });
  const emailField = page.getByRole('textbox', { name: `Email for ${name}` });
  // While editing, the email is in a field, so the row is found by that field.
  const editRow = page.getByRole('row').filter({ has: emailField });
  const asked: string[] = [];
  let answer: 'dismiss' | 'accept' = 'dismiss';
  page.on('dialog', (d) => {
    asked.push(d.message());
    void (answer === 'accept' ? d.accept() : d.dismiss());
  });
  const question = `Change ${name}'s email? They'll be signed out, and they'll need to sign in with the Google account for the new address.`;

  // Only the spelling changes: no question, and they stay signed in.
  await row.getByRole('button', { name: 'Edit' }).click();
  await emailField.fill(email.toUpperCase());
  await editRow.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('cell', { name: email })).toBeVisible();
  expect(asked).toEqual([]);
  await them.reload();
  await expect(them.getByRole('heading', { name: 'Our family' })).toBeVisible();

  // A new address asks first; dismissing it saves nothing.
  await row.getByRole('button', { name: 'Edit' }).click();
  await emailField.fill(newEmail);
  await editRow.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => asked).toEqual([question]);
  await expect(emailField).toHaveValue(newEmail);

  // Accepting it saves, and their session ends.
  answer = 'accept';
  await editRow.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => asked).toEqual([question, question]);
  await expect(page.getByRole('cell', { name: newEmail })).toBeVisible();
  await them.reload();
  await expect(them.getByRole('link', { name: 'Sign in with Google' })).toBeVisible();
  await theirs.close();
});

test('an admin changing their own email stays signed in there, and their other sessions end', async ({ page, browser }, info) => {
  const tag = `${info.project.name}-${info.repeatEachIndex}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const name = `Self ${tag}`;
  const email = `self-${tag}@example.com`;
  const newEmail = `self-new-${tag}@example.com`;
  await signIn(page, 'admin@example.com');
  const made = await page.request.post('/api/admin/users', {
    data: { email, displayName: name, color: '#378ADD', role: 'admin', panels: [] },
    headers: { 'x-requested-with': 'dashboard', origin: 'http://localhost:3100' },
  });
  expect(made.status()).toBe(201);

  // The new admin, signed in here and elsewhere.
  await page.context().clearCookies();
  await signIn(page, email);
  const other = await browser.newContext();
  const elsewhere = await other.newPage();
  await signIn(elsewhere, email);
  await elsewhere.goto('/');
  await expect(elsewhere.getByRole('heading', { name: 'Our family' })).toBeVisible();

  await page.goto('/admin');
  await page.getByRole('row').filter({ hasText: email }).getByRole('button', { name: 'Edit' }).click();
  const emailField = page.getByRole('textbox', { name: `Email for ${name}` });
  await emailField.fill(newEmail);
  const asked: string[] = [];
  page.on('dialog', (d) => {
    asked.push(d.message());
    void d.accept();
  });
  await page.getByRole('row').filter({ has: emailField }).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('cell', { name: newEmail })).toBeVisible();
  expect(asked).toEqual([
    "Change your email? You'll stay signed in here, but your other sessions will end, and next time you'll need to sign in with the Google account for the new address.",
  ]);

  await page.reload();
  await expect(page.getByRole('cell', { name: newEmail })).toBeVisible();
  await elsewhere.reload();
  await expect(elsewhere.getByRole('link', { name: 'Sign in with Google' })).toBeVisible();
  await other.close();
});
