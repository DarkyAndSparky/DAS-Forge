import { test, expect } from '@playwright/test';

const ADMIN = { username: 'e2eadmin', password: 'e2e-admin-password-1' };

async function signIn(page) {
  await page.goto('/login');
  await page.fill('#username', ADMIN.username);
  await page.fill('#password', ADMIN.password);
  await page.locator('#step1 button[type=submit], #step1 button').first().click();
  await page.waitForURL('**/ui');
}

test.describe.configure({ mode: 'serial' });

test('the pages of the account module are served without signing in', async ({ page }) => {
  for (const path of ['/login', '/forgot-password']) {
    const res = await page.goto(path);
    expect(res.status(), path).toBe(200);
  }
});

test('the new admin sections open and the sign-in journal lists the sign-in', async ({ page }) => {
  await signIn(page);
  // The mail and broadcast sections exist only when e-mail is switched on (the e2e server runs without it).
  for (const path of ['/control', '/control/tasks', '/admin/config', '/control/maintenance', '/admin/incidents', '/admin/password-policy', '/admin/policy']) {
    const res = await page.goto(path);
    expect(res.status(), path).toBe(200);
    await expect(page.locator('h1').first()).toBeVisible();
  }
  expect((await page.goto('/control/mail')).status()).toBe(404);
  expect((await page.goto('/admin/tasks')).status()).toBe(404); // moved to the control area
  await page.goto('/admin/audit?view=logins');
  await expect(page.locator('tbody')).toContainText('auth.login');
  const json = await page.request.get('/admin/audit.json?view=logins');
  expect(json.status()).toBe(200);
  const rows = await json.json();
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((r) => r.action.startsWith('auth.login'))).toBe(true);
});

test('maintenance mode: visitors get 503, the administrator can switch it off', async ({ page, browser }) => {
  await signIn(page);
  await page.goto('/control/maintenance');
  await page.fill('textarea[name=message]', 'e2e maintenance');
  await page.locator('form[action$="/enable"] button').click();

  const visitor = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: test.info().project.use.baseURL });
  const res = await visitor.request.get('/ui');
  expect(res.status()).toBe(503);
  expect(res.headers()['retry-after']).toBeTruthy();
  await visitor.close();

  await page.goto('/control/maintenance');
  await page.locator('form[action$="/disable"] button').click();
  const after = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: test.info().project.use.baseURL });
  expect((await after.request.get('/health')).status()).toBe(200);
  expect((await after.request.get('/ui')).status()).not.toBe(503);
  await after.close();
});
