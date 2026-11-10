import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createSqliteAdapter } from '../src/database/index.js';
import { createPolicy, renderPolicyText, DEFAULT_TEXTS } from '../src/policy/index.js';
import { createAdmin } from '../src/admin/index.js';
import { errorResponder } from '../src/http/error-pages.js';
import { requireAuth, requirePermission } from '../src/http/session-middleware.js';
import { query } from '../src/audit/index.js';

function fakeRes() {
  const res = { code: 200, body: '', headers: {}, locals: {}, cookies: [] };
  res.status = (c) => { res.code = c; return res; };
  res.type = () => res;
  res.set = (k, v) => { res.headers[k] = v; return res; };
  res.setHeader = res.set;
  res.append = (k, v) => { if (k === 'Set-Cookie') res.cookies.push(v); return res; };
  res.json = (b) => { res.body = b; res.json_ = true; return res; };
  res.send = (b) => { res.body = b; return res; };
  res.redirect = (c, loc) => { res.code = c; res.location = loc; return res; };
  res.end = () => res;
  return res;
}
function fakeApp() {
  const routes = {};
  return { routes, get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; } };
}
async function call(chain, req, res = fakeRes()) {
  for (const h of chain) {
    let nexted = false;
    await h(req, res, () => { nexted = true; });
    if (!nexted) break;
  }
  return res;
}
const mk = (opts = {}) => {
  const db = createSqliteAdapter({ file: ':memory:' });
  const policy = createPolicy({ db, appName: 'Demo', ...opts });
  const app = fakeApp();
  policy.mount(app);
  return { db, policy, app };
};

describe('the licence page has two parts', () => {
  it('shows the platform MIT notice first (fixed), then the owner\'s own text, which replacing never removes', async () => {
    const { policy, app } = mk({ platformCopyright: 'Acme <Ltd>' });
    const page = async (lang) => (await call(app.routes['GET /policy/license'], { query: { lang }, headers: {} })).body;
    let en = await page('en');
    expect(en).toContain('Permission is hereby granted, free of charge');
    expect(en).toContain('Copyright (c) 2026 Acme &lt;Ltd&gt;'); // the holder is escaped
    expect(en).toContain('placeholder'); // the owner's part is still the default stub
    expect(en.indexOf('Permission is hereby granted') < en.indexOf('placeholder')).toBe(true);
    policy.setText('en', 'license', 'Our own agreement', 'root');
    en = await page('en');
    expect(en).toContain('Our own agreement');
    expect(en).toContain('Permission is hereby granted'); // cannot be edited away
    const ru = await page('ru');
    expect(ru).toContain('Лицензия платформы DAS-Forge');
    expect(ru).toContain('Permission is hereby granted'); // the original English MIT text in both languages
    // the other policy pages carry no platform part
    expect((await call(app.routes['GET /policy'], { query: { lang: 'en' }, headers: {} })).body).not.toContain('Permission is hereby granted');
  });
});

describe('policy mini-markup renderer', () => {
  it('never lets raw HTML or unsafe links through', () => {
    const html = renderPolicyText('# T <script>x</script>\n\n[ok](https://a.example/x?a=1&b=2) [bad](javascript:alert(1)) [rel](/policy) **b**\n- one\n- <img onerror=1>', {});
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('<a href="https://a.example/x?a=1&amp;b=2" rel="noopener noreferrer" target="_blank">ok</a>');
    expect(html).toContain('<a href="/policy">rel</a>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<strong>b</strong>');
  });
  it('substitutes {{app}} and leaves unknown placeholders', () => {
    expect(renderPolicyText('Hi {{app}} {{other}}', { app: 'X' })).toContain('Hi X {{other}}');
  });
});

describe('default policy texts', () => {
  it('exist in ru and en, mention components, licences and GPL', () => {
    for (const loc of ['ru', 'en']) {
      expect(DEFAULT_TEXTS[loc].usage).toContain('/policy/components');
      expect(DEFAULT_TEXTS[loc].usage).toContain('gpl-3.0');
      expect(DEFAULT_TEXTS[loc].cookies).toContain('das_consent');
    }
  });
});

describe('policy pages and consent', () => {
  it('serves default text per language, the app name, and links', async () => {
    const { app } = mk();
    const ru = await call(app.routes['GET /policy'], { query: {}, headers: {} });
    expect(ru.body).toContain('Политика использования Demo');
    const en = await call(app.routes['GET /policy'], { query: { lang: 'en' }, headers: {} });
    expect(en.body).toContain('Demo usage policy');
    expect(en.body).toContain('/policy/components');
  });

  it('custom text overrides the template, can be reset, is size-limited', async () => {
    const { app, policy } = mk();
    policy.setText('ru', 'usage', '# Наш текст\n\nабзац', 'ann');
    expect((await call(app.routes['GET /policy'], { query: { lang: 'ru' }, headers: {} })).body).toContain('Наш текст');
    expect(policy.getText('ru', 'usage').custom).toBe(true);
    expect(policy.resetText('ru', 'usage')).toBe(1);
    expect(policy.getText('ru', 'usage').custom).toBe(false);
    expect(() => policy.setText('ru', 'usage', '   ')).toThrow(/empty/);
    expect(() => policy.setText('ru', 'usage', 'x'.repeat(100_001))).toThrow(/longer/);
    expect(() => policy.setText('de', 'usage', 'x')).toThrow(/bad locale/);
  });

  it('banner shows until a choice is made; POST /consent stores it and redirects safely', async () => {
    const { app, policy } = mk();
    const req = { headers: {}, originalUrl: '/ui?x=1', query: {} };
    const b = policy.bannerHtml(req, fakeRes(), 'en');
    expect(b).toContain('Accept');
    expect(b).toContain('Decline');
    expect(b).toContain('value="/ui?x=1"');
    const res = await call(app.routes['POST /consent'], { headers: {}, body: { choice: 'accepted', back: '/ui?x=1' }, secure: true });
    expect(res.location).toBe('/ui?x=1');
    expect(res.cookies[0]).toMatch(/^das_consent=accepted; Path=\/; Max-Age=\d+; SameSite=Lax; Secure/);
    expect(policy.consentOf({ headers: { cookie: 'a=b; das_consent=declined' } })).toBe('declined');
    expect(policy.bannerHtml({ headers: { cookie: 'das_consent=accepted' } }, fakeRes(), 'en')).toBe('');
    for (const evil of ['//evil.example', 'https://evil.example', '/\\evil', 'javascript:1']) {
      const r = await call(app.routes['POST /consent'], { headers: {}, body: { choice: 'declined', back: evil } });
      expect(r.location).toBe('/');
    }
    const none = await call(app.routes['POST /consent'], { headers: {}, body: { choice: 'bogus', back: '/x' } });
    expect(none.cookies.length).toBe(0);
  });

  it('components page lists dependencies with licences and marks copyleft', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pol-'));
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { alpha: '^1.0.0', beta: '^2.0.0' } }));
    for (const [n, lic] of [['alpha', 'MIT'], ['beta', 'LGPL-3.0-or-later']]) {
      mkdirSync(path.join(dir, 'node_modules', n), { recursive: true });
      writeFileSync(path.join(dir, 'node_modules', n, 'package.json'), JSON.stringify({ version: '1.0.0', license: lic }));
    }
    const { app } = mk({ dependencySources: [{ packageJsonPath: path.join(dir, 'package.json') }] });
    const r = await call(app.routes['GET /policy/components'], { query: { lang: 'en' }, headers: {} });
    expect(r.body).toContain('alpha');
    expect(r.body).toContain('spdx.org/licenses/MIT.html');
    expect(r.body).toContain('copyleft');
    expect(r.body).toContain('gpl-3.0.html');
  });
});

describe('admin: policy editor', () => {
  it('saves and resets texts behind admin.access, audits both', async () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    const policy = createPolicy({ db });
    const app = fakeApp();
    const rA = () => (req, res, next) => (req.user ? next() : res.status(401).end());
    const rP = (perm) => (req, res, next) => ((req.user.permissions ?? []).includes(perm) ? next() : res.status(403).end());
    createAdmin({ db, policy, users: false }).mount(app, { requireAuth: rA, requirePermission: rP });
    const admin = { username: 'root', permissions: ['admin.access'] };
    expect((await call(app.routes['POST /admin/policy/save'], { user: { permissions: [] }, body: {} })).code).toBe(403);
    let r = await call(app.routes['POST /admin/policy/save'], { user: admin, body: { locale: 'en', kind: 'cookies', body: 'Custom cookies' } });
    expect(r.location).toBe('/admin/policy?textlang=en&msg=ok');
    expect(policy.getText('en', 'cookies').body).toBe('Custom cookies');
    r = await call(app.routes['POST /admin/policy/save'], { user: admin, body: { locale: 'xx', kind: 'cookies', body: 'x' } });
    expect(r.location).toBe('/admin/policy?textlang=ru&msg=bad');
    r = await call(app.routes['POST /admin/policy/reset'], { user: admin, body: { locale: 'en', kind: 'cookies' } });
    expect(policy.getText('en', 'cookies').custom).toBe(false);
    expect(query(db, { action: 'admin.policy.save' }).length).toBe(1);
    expect(query(db, { action: 'admin.policy.reset' }).length).toBe(1);
    const page = await call(app.routes['GET /admin/policy'], { user: admin, query: { lang: 'en' }, headers: {} });
    expect(page.body).toContain('Usage policy');
    expect(page.body).toContain('Policies');
    expect(page.body).toContain('aria-current="page"');
    expect(page.body).not.toContain('t-ru-usage'); // one language at a time
    expect(page.body).toContain('Accept'); // banner at the end of admin pages too
    // the text-language switch picks which text is edited; it does not change the interface language
    const other = await call(app.routes['GET /admin/policy'], { user: admin, query: { lang: 'en', textlang: 'ru' }, headers: {} });
    expect(other.body).toContain('Policies');
    expect(other.body).toContain('href="/admin/policy?textlang=en"');
    expect(other.body).not.toContain('href="/admin/policy?lang=');
  });
});

describe('errorResponder: guards answer browsers with a page, APIs with JSON', () => {
  const vendor = { getLogo: () => null, readLogo: () => null, name: 'V' };
  async function guarded(headers, path_ = '/x') {
    const res = fakeRes();
    const req = { headers, path: path_, id: 'rid-1' };
    errorResponder(vendor, { bodyEnd: () => '<!--END-->' })(req, res, () => {});
    requireAuth()(req, res, () => {});
    return res;
  }
  it('browser gets HTML with the footer slot; json client / api path keep JSON', async () => {
    let r = await guarded({ accept: 'text/html' });
    expect(r.code).toBe(401);
    expect(String(r.body)).toContain('<!DOCTYPE html>');
    expect(String(r.body)).toContain('<!--END-->');
    r = await guarded({ accept: 'application/json' });
    expect(r.body.error).toBe('UNAUTHENTICATED');
    r = await guarded({ accept: 'text/html' }, '/api/things');
    expect(r.body.error).toBe('UNAUTHENTICATED');
  });
  it('a client with no Accept header (curl, scripts) gets JSON, not a page', async () => {
    const r = await guarded({});
    expect(r.code).toBe(401);
    expect(r.body.error).toBe('UNAUTHENTICATED');
  });
  it('without the responder the guards still send the plain JSON', () => {
    const res = fakeRes();
    requirePermission('x')({ user: { permissions: [] }, headers: {} }, res, () => {});
    expect(res.code).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });
  it('429 keeps Retry-After', () => {
    const res = fakeRes();
    errorResponder(vendor)({ headers: { accept: 'application/json' }, path: '/' }, res, () => {});
    res.locals.sendError(429, { error: 'RATE_LIMITED', fields: [], retryAfterSec: 7 });
    expect(res.headers['Retry-After']).toBe('7');
  });
});

describe('licence agreement text', () => {
  it('has a placeholder in both languages and survives the old two-kind table', async () => {
    const { createPolicy, ensurePolicyTable, KINDS, renderPolicyText } = await import('../src/policy/index.js');
    expect(KINDS).toContain('license');
    const db = createSqliteAdapter({ file: ':memory:' });
    db.exec(`CREATE TABLE policy_texts (locale TEXT NOT NULL CHECK (locale IN ('ru','en')), kind TEXT NOT NULL CHECK (kind IN ('usage','cookies')), body TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT, PRIMARY KEY (locale, kind))`);
    db.run(`INSERT INTO policy_texts VALUES ('en', 'cookies', 'Old cookies', '2026-10-01T00:00:00Z', 'root')`);
    ensurePolicyTable(db);
    expect(db.get(`SELECT body FROM policy_texts WHERE kind = 'cookies'`).body).toBe('Old cookies');
    const policy = createPolicy({ db, appName: 'Workshop', localeOf: () => 'en' });
    expect(policy.getText('en', 'license').body).toContain('placeholder');
    expect(policy.getText('ru', 'license').body).toContain('заглушка');
    policy.setText('en', 'license', 'Our terms', 'root');
    expect(policy.getText('en', 'license')).toMatchObject({ body: 'Our terms', custom: true });
    expect(typeof renderPolicyText).toBe('function');
  });
});
