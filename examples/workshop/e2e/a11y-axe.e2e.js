import { test, expect } from '@playwright/test';

// Accessibility check with axe-core (WCAG 2.0/2.1/2.2 A and AA rules) in a real browser: it sees what the markup check of the
// core cannot (colour contrast as painted, focus, ARIA use). The package is NOT in package.json (it would change the lock
// file); install it for a run:   npm install --no-save @axe-core/playwright   then   npm run test:e2e --workspace workshop
// Without it these tests are skipped. `npm install` and `npm ci` remove it again.
let AxeBuilder = null;
try { ({ default: AxeBuilder } = await import('@axe-core/playwright')); } catch { /* not installed: the tests below skip */ }

const ADMIN = { username: 'e2eadmin', password: 'e2e-admin-password-1' };
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const PUBLIC = ['/login', '/forgot-password', '/about', '/policy', '/policy/cookies', '/policy/license', '/policy/accessibility', '/policy/components'];
const ADMIN_PAGES = ['/admin', '/admin/audit', '/admin/users', '/admin/policy', '/admin/incidents', '/admin/config', '/admin/password-policy', '/control', '/control/tasks', '/control/maintenance'];

async function scan(page, path, theme) {
  const res = await page.goto(path);
  expect(res.status(), path).toBe(200);
  if (theme) await page.evaluate((t) => { globalThis.document.documentElement.dataset.theme = t; }, theme);
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  // one readable line per finding: rule, how bad, where
  return violations.map((v) => `${path}${theme ? ` [${theme}]` : ''}: ${v.id} (${v.impact}) ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
}

test.describe.configure({ mode: 'serial' });
test.skip(!AxeBuilder, 'axe is not installed (npm install --no-save @axe-core/playwright)');

test('the public pages have no axe findings, in the light and the dark theme', async ({ page }) => {
  const found = [];
  for (const path of PUBLIC) for (const theme of ['light', 'dark']) found.push(...await scan(page, path, theme));
  expect(found).toEqual([]);
});

test('the administration pages have no axe findings', async ({ page }) => {
  await page.goto('/login');
  await page.fill('#username', ADMIN.username);
  await page.fill('#password', ADMIN.password);
  await page.locator('#step1 button[type=submit], #step1 button').first().click();
  await page.waitForURL('**/ui');
  const found = [];
  for (const path of ADMIN_PAGES) found.push(...await scan(page, path));
  expect(found).toEqual([]);
});
