import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSqliteAdapter } from '../src/database/index.js';
import { createAdmin } from '../src/admin/index.js';
import { getCompanyBranding } from '../src/branding/company-branding.js';
import { readableOn, themeWithBranding, brandingHtml } from '../src/branding/appearance.js';

function makeApp() {
  const routes = {};
  const reg = (m) => (p, ...h) => { routes[`${m} ${p}`] = h; };
  return { app: { get: reg('GET'), post: reg('POST') }, routes };
}
const mk = (db, dir, extra = {}) => {
  const { app, routes } = makeApp();
  createAdmin({ db, appearance: { uploadsDir: dir, fallbackName: 'Product', ...extra } }).mount(app, { requireAuth: () => (q, s, n) => n(), requirePermission: () => (q, s, n) => n() });
  return routes;
};
async function call(handlers, req) {
  const res = { headers: {}, set(k, v) { this.headers[k] = v; return this; }, type() { return this; }, send(b) { this.body = b; }, redirect(c, u) { this.status = c; this.location = u; }, locals: {} };
  const h = handlers[handlers.length - 1];
  await h({ query: {}, body: {}, headers: {}, user: { username: 'admin', permissions: [] }, ...req }, res);
  return res;
}

describe('admin appearance section', () => {
  let db, dir, routes;
  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
    dir = mkdtempSync(path.join(os.tmpdir(), 'appr-'));
    routes = mk(db, dir);
  });

  it('shows a live preview of both themes inside the accent card that follows the name, the colors and a chosen file', async () => {
    const { setCompanyBranding } = await import('../src/branding/index.js');
    setCompanyBranding(db, { name: 'ACME', accent: '#aa2200', accentDark: '#ffcc00' });
    const res = await call(routes['GET /admin/appearance'], { query: { lang: 'en' } });
    expect(res.body).toContain('data-pv="light"');
    expect(res.body).toContain('data-pv="dark"');
    expect(res.body).toContain('--pv-accent:#aa2200');
    expect(res.body).toContain('--pv-accent:#ffcc00');
    expect(res.body).toContain('data-pv-name>ACME<');
    expect(res.body).toContain('data-pv-file="light"');
    expect(res.body).toContain('data-pv-file="dark"');
    expect(res.body).toContain('readAsDataURL'); // a chosen file is previewed locally, nothing is uploaded
  });

  it('is in the menu, renders name, both logos and both colors', async () => {
    const res = await call(routes['GET /admin/appearance'], { query: { lang: 'en' } });
    expect(res.body).toContain('Appearance');
    expect(res.body).toContain('name="accent"');
    expect(res.body).toContain('name="accentDark"');
    expect(res.body).toContain('/admin/appearance/logo/light');
    expect(res.body).toContain('/admin/appearance/logo/dark');
  });

  it('saves and resets the name; invalid names are refused', async () => {
    let r = await call(routes['POST /admin/appearance/name'], { body: { name: '  ACME Corp ' } });
    expect(r.location).toBe('/admin/appearance?msg=ok');
    expect(getCompanyBranding(db).name).toBe('ACME Corp');
    r = await call(routes['POST /admin/appearance/name'], { body: { name: 'x'.repeat(101) } });
    expect(r.location).toBe('/admin/appearance?msg=bad');
    r = await call(routes['POST /admin/appearance/name'], { body: { name: '' } });
    expect(getCompanyBranding(db).name).toBe(null);
  });

  it('colors must be #rrggbb for both themes; the theme gets them with readable text, and reset clears', async () => {
    let r = await call(routes['POST /admin/appearance/colors'], { body: { accent: 'red', accentDark: '#112233' } });
    expect(r.location).toContain('bad');
    expect(getCompanyBranding(db).accent).toBe(null);
    r = await call(routes['POST /admin/appearance/colors'], { body: { accent: '#E8445A', accentDark: '#F5D000' } });
    expect(r.location).toContain('ok');
    const theme = themeWithBranding(db, {});
    expect(theme.tokens.accent).toBe('#e8445a');
    expect(theme.darkTokens.accent).toBe('#f5d000');
    expect(theme.darkTokens['accent-text']).toBe('#0b1220'); // dark text on a bright yellow
    await call(routes['POST /admin/appearance/reset'], {});
    expect(getCompanyBranding(db).accent).toBe(null);
    expect(themeWithBranding(db, { tokens: { a: '#fff' } })).toEqual({ tokens: { a: '#fff' } });
  });

  it('admin pages carry the chosen accent and name', async () => {
    await call(routes['POST /admin/appearance/colors'], { body: { accent: '#e8445a', accentDark: '#e8445a' } });
    await call(routes['POST /admin/appearance/name'], { body: { name: 'ACME <b>' } });
    const res = await call(routes['GET /admin'], {});
    expect(res.body).toContain('--adm-accent:#e8445a');
    expect(res.body).toContain('ACME &lt;b&gt;');
  });

  it('logo upload goes through acceptUpload into branding/, replaces the old file, and can be removed', async () => {
    // a real 1x1 PNG; the image re-encode (sharp) is replaced by a pass-through so the test needs no native binary
    const svg = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    routes = mk(db, dir, { acceptOptions: { reencode: async (b) => ({ buffer: b, format: 'png' }) } });
    // run the handler chain after the multipart step by calling the last handler directly with req.upload
    const handlers = routes['POST /admin/appearance/logo/:theme'];
    const last = handlers[handlers.length - 1];
    const res1 = await call([last], { params: { theme: 'light' }, upload: { buffer: svg } });
    expect(res1.location).toBe('/admin/appearance?msg=ok');
    const first = getCompanyBranding(db).logoFile;
    expect(first).toMatch(/\.png$/);
    expect(existsSync(path.join(dir, 'branding', first))).toBe(true);
    await call([last], { params: { theme: 'light' }, upload: { buffer: svg } });
    const second = getCompanyBranding(db).logoFile;
    expect(second).not.toBe(first);
    expect(readdirSync(path.join(dir, 'branding'))).toEqual([second]);
    expect(brandingHtml(db, { fallbackName: 'P' })).toContain('adm-logo-single');
    await call([last], { params: { theme: 'dark' }, upload: { buffer: svg } });
    expect(brandingHtml(db, {})).toContain('adm-logo-dark');
    const rm = routes['POST /admin/appearance/logo/:theme/remove'];
    await call(rm, { params: { theme: 'light' } });
    expect(getCompanyBranding(db).logoFile).toBe(null);
    expect(readdirSync(path.join(dir, 'branding')).length).toBe(1);
    const bad = await call([last], { params: { theme: 'sepia' }, upload: { buffer: svg } });
    expect(bad.location).toContain('bad');
  });

  it('a file that is not a real image is refused and nothing is stored', async () => {
    const handlers = routes['POST /admin/appearance/logo/:theme'];
    const last = handlers[handlers.length - 1];
    const res = await call([last], { params: { theme: 'light' }, upload: { buffer: Buffer.from('<?php echo 1; ?>') } });
    expect(res.location).toContain('bad');
    expect(readdirSync(path.join(dir, 'branding')).length).toBe(0);
  });
});

describe('readableOn', () => {
  it('picks dark text on light colors and white on dark ones', () => {
    expect(readableOn('#ffffff')).toBe('#0b1220');
    expect(readableOn('#000000')).toBe('#ffffff');
    expect(readableOn('#2f6fdd')).toBe('#ffffff');
  });
});

describe('admin appearance section: two administrators (G-03)', () => {
  it('a stale name form or colour form is refused with msg=conflict; the other form is not affected', async () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    const routes = mk(db, mkdtempSync(path.join(os.tmpdir(), 'adm-appearance-')));
    const page = await call(routes['GET /admin/appearance'], { query: { lang: 'en' } });
    const [nameV, colorV] = [...page.body.matchAll(/name="_v" value="([0-9a-f]+)"/g)].map((m) => m[1]);
    let r = await call(routes['POST /admin/appearance/name'], { body: { name: 'First', _v: nameV } });
    expect(r.location).toBe('/admin/appearance?msg=ok');
    r = await call(routes['POST /admin/appearance/name'], { body: { name: 'Second', _v: nameV } });
    expect(r.location).toBe('/admin/appearance?msg=conflict');
    expect(getCompanyBranding(db).name).toBe('First');
    r = await call(routes['POST /admin/appearance/colors'], { body: { accent: '#E8445A', accentDark: '#F5D000', _v: colorV } });
    expect(r.location).toBe('/admin/appearance?msg=ok'); // the name changed, the colours did not
    r = await call(routes['POST /admin/appearance/colors'], { body: { accent: '#111111', accentDark: '#222222', _v: colorV } });
    expect(r.location).toBe('/admin/appearance?msg=conflict');
  });
});
