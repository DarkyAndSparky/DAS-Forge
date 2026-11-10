import { test, expect } from '@playwright/test';

const ADMIN = { username: 'e2eadmin', password: 'e2e-admin-password-1' };

async function signIn(page, { username, password }) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.locator('#step1 button[type=submit], #step1 button').first().click();
}

const row = (page, name) => page.locator('tr', { hasText: name });
const openActions = (page, name) => row(page, name).locator('.adm-open').click();

test.describe.configure({ mode: 'serial' });

test('anonymous visitors cannot open the users section of the admin panel', async ({ page }) => {
  const res = await page.goto('/admin/users');
  expect(res.status()).toBe(401);
});

test('an admin creates, edits, resets and removes an account in the browser', async ({ page, browser }) => {
  await signIn(page, ADMIN);
  await page.waitForURL('**/ui');
  await page.goto('/admin/users');
  await expect(page.locator('tbody')).toContainText(ADMIN.username);

  // create: the temporary password is shown once, on the result page
  await page.fill('form[action$="/create"] input[name=username]', 'e2e_carol');
  await page.fill('form[action$="/create"] input[name=email]', 'carol@example.com');
  await page.locator('form[action$="/create"] button').click();
  const code = page.locator('code');
  await expect(code).toBeVisible();
  const tempPassword = (await code.textContent()).trim();
  expect(tempPassword.length).toBeGreaterThanOrEqual(12);
  await page.getByRole('link', { name: 'Back to the list' }).click();
  await expect(page.locator('tbody')).toContainText('e2e_carol');

  // the new user can sign in with it (separate context = separate session)
  const other = await browser.newContext({ ignoreHTTPSErrors: true });
  const otherPage = await other.newPage();
  await signIn(otherPage, { username: 'e2e_carol', password: tempPassword });
  await expect.poll(async () => (await other.cookies()).some((c) => c.name.includes('session') || c.name === 'das_session')).toBe(true);

  // edit the login
  await openActions(page, 'e2e_carol');
  await row(page, 'e2e_carol').locator('form[action$="/profile"] input[name=username]').fill('e2e_carolina');
  await row(page, 'e2e_carol').locator('form[action$="/profile"] button').click();
  await expect(page.locator('tbody')).toContainText('e2e_carolina');

  // temporary password reset shows a NEW password
  await openActions(page, 'e2e_carolina');
  await row(page, 'e2e_carolina').locator('form[action$="/reset"] button').click();
  await expect(code).toBeVisible();
  expect((await code.textContent()).trim()).not.toBe(tempPassword);
  await page.getByRole('link', { name: 'Back to the list' }).click();
  await other.close();

  // remove: a dialog warns the account goes for good and its confirm button unlocks after a few seconds
  await openActions(page, 'e2e_carolina');
  const form = row(page, 'e2e_carolina').locator('form[action$="/remove"]');
  await form.locator('select[name=mode]').selectOption('delete');
  await form.locator('button.adm-remove').click();
  await expect(page.locator('#admConfirm .adm-msg')).toContainText('e2e_carolina');
  await expect(page.locator('#admConfirm .adm-ok')).toBeDisabled();
  await page.locator('#admConfirm .adm-ok').click(); // waits until the button is enabled
  await expect(page.locator('tbody')).not.toContainText('e2e_carolina');
  await expect(page.locator('tbody')).not.toContainText('deleted-user');
});

test('the admin has no action buttons on their own row', async ({ page }) => {
  await signIn(page, ADMIN);
  await page.waitForURL('**/ui');
  await page.goto('/admin/users');
  const mine = row(page, ADMIN.username);
  await expect(mine.getByRole('button')).toHaveCount(0);
  await expect(mine.locator('.adm-open')).toHaveCount(0);
});

test('a double click on "Create" makes one account and no "already taken" error (G-05)', async ({ page }) => {
  await signIn(page, ADMIN);
  await page.waitForURL('**/ui');
  await page.goto('/admin/users');
  await page.fill('form[action$="/create"] input[name=username]', 'e2e_dave');
  await page.fill('form[action$="/create"] input[name=email]', 'dave@example.com');
  await page.locator('form[action$="/create"] button').dblclick();
  await expect(page.locator('code')).toBeVisible(); // the result page with the one-time password, not an error page
  await page.getByRole('link', { name: 'Back to the list' }).click();
  await expect(page.locator('tbody tr', { hasText: 'e2e_dave' })).toHaveCount(1);
});
