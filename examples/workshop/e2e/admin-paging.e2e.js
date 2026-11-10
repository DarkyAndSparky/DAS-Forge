import { test, expect } from '@playwright/test';

const ADMIN = { username: 'e2eadmin', password: 'e2e-admin-password-1' };

test.describe.configure({ mode: 'serial' });

async function signIn(page) {
  await page.goto('/login');
  await page.fill('#username', ADMIN.username);
  await page.fill('#password', ADMIN.password);
  await page.locator('#step1 button[type=submit], #step1 button').first().click();
  await page.waitForURL('**/ui');
}

test('a long list is paged, and "Expand" loads the rest while staying on the page', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  // 27 incidents: more than one page of 25.
  for (let i = 1; i <= 27; i += 1) {
    await page.goto('/admin/incidents');
    await page.fill('form[action$="/declare"] input[name=title]', `e2e incident ${i}`);
    await page.locator('form[action$="/declare"] button[type=submit]').click();
    await page.waitForURL('**/admin/incidents**');
  }
  await page.goto('/admin/incidents');
  const rows = page.locator('tbody[data-paged] tr');
  await expect(rows).toHaveCount(25);
  await expect(page.locator('[data-pager] a[rel=next]')).toBeVisible();

  await page.locator('[data-expand]').click();
  await expect(rows).toHaveCount(27);
  await expect(page.locator('[data-pager]')).toContainText('27');
  expect(page.url()).toMatch(/\/admin\/incidents$/);

  // Without the script the forward link still works.
  await page.goto('/admin/incidents?page=2');
  await expect(rows).toHaveCount(2);
});

test('the processing register opens and downloads as CSV', async ({ page }) => {
  await signIn(page);
  const res = await page.goto('/admin/registry');
  expect(res.status()).toBe(200);
  await expect(page.locator('tbody tr').first()).toBeVisible();
  const csv = await page.request.get('/admin/registry.csv');
  expect(csv.status()).toBe(200);
  expect(csv.headers()['content-type']).toContain('text/csv');
  expect(await csv.text()).toContain('core.');
});
