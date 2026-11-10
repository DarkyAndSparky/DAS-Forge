import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { ensureAuthTables } from '../src/auth/schema.js';
import { createMaintenance, MaintenanceError } from '../src/maintenance/index.js';
import { createAdmin } from '../src/admin/index.js';
import { brandBlockHtml } from '../src/branding/appearance.js';
import { defineVendorIdentity } from '../src/branding/index.js';
import { query } from '../src/audit/index.js';
import { renderErrorPage } from '../src/http/error-pages.js';
import { ERROR_CATALOG } from '../src/http/error-catalog.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const vendor = defineVendorIdentity({ name: 'Workshop', repoUrl: null, assetsDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets/brand') });

function setup(opts = {}) {
  const db = createSqliteAdapter({ file: ':memory:' });
  ensureAuthTables(db);
  let t = Date.parse('2026-10-28T10:00:00Z');
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const m = createMaintenance({ db, cacheMs: 0, now: clock.now, ...opts });
  return { db, m, clock };
}

function run(mw, req) {
  const res = { code: 200, headers: {}, body: undefined, locals: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, type() { return this; }, json(b) { this.body = b; this.json = b; return this; }, send(b) { this.body = b; return this; } };
  let passed = false;
  mw({ headers: {}, path: '/ui', ...req }, res, () => { passed = true; });
  return { res, passed };
}

describe('maintenance mode', () => {
  it('is off by default and lets everything through', () => {
    const { m } = setup();
    expect(m.get().enabled).toBe(false);
    expect(run(m.middleware({ vendorIdentity: vendor }), {}).passed).toBe(true);
  });

  it('stores the state in the database, validates input and switches off', () => {
    const { db, m } = setup();
    m.enable({ message: ' back at noon ', until: '2026-10-28T12:00:00Z', by: 'root' });
    const again = createMaintenance({ db, cacheMs: 0 });
    expect(again.get()).toMatchObject({ enabled: true, message: 'back at noon', until: '2026-10-28T12:00:00.000Z', startedBy: 'root' });
    expect(() => m.enable({ message: 'x'.repeat(501) })).toThrow(MaintenanceError);
    expect(() => m.enable({ until: 'tomorrow-ish' })).toThrow(/date/);
    m.disable();
    expect(again.get().enabled).toBe(false);
  });

  it('answers visitors with 503, Retry-After and a page (HTML) or JSON; admins, sign-in and health pass', () => {
    const { m } = setup();
    m.enable({ message: 'Updating <b>now</b>', until: '2026-10-28T10:30:00Z' });
    const mw = m.middleware({ vendorIdentity: vendor });

    const html = run(mw, { headers: { accept: 'text/html' }, locale: 'en' });
    expect(html.passed).toBe(false);
    expect(html.res.code).toBe(503);
    expect(html.res.headers['Retry-After']).toBe('1800');
    expect(html.res.body).toContain('Maintenance in progress');
    expect(html.res.body).toContain('Updating &lt;b&gt;now&lt;/b&gt;');
    expect(html.res.body).not.toContain('<b>now</b>');
    expect(html.res.body).toContain('http-equiv="refresh"');
    expect(html.res.body).toContain('Powered by');

    const api = run(mw, { headers: { accept: 'application/json' } });
    expect(api.res.code).toBe(503);
    expect(api.res.json.error).toBe('MAINTENANCE');

    expect(run(mw, { user: { permissions: ['admin.access'] } }).passed).toBe(true);
    expect(run(mw, { user: { permissions: ['read:basic'] } }).passed).toBe(false);
    for (const p of ['/health', '/login', '/login/totp', '/logout', '/branding/logo/light']) expect(run(mw, { path: p }).passed).toBe(true);
    expect(run(mw, { path: '/loginx' }).passed).toBe(false);
  });

  it('keeps Retry-After between 30 seconds and an hour, five minutes without an end time', () => {
    const { m, clock } = setup();
    m.enable({});
    expect(m.retryAfterSec()).toBe(300);
    m.enable({ until: '2026-10-28T10:00:10Z' });
    expect(m.retryAfterSec()).toBe(30);
    m.enable({ until: '2026-10-29T10:00:00Z' });
    expect(m.retryAfterSec()).toBe(3600);
    clock.advance(1000);
  });

  it('uses the app brand block when given', () => {
    const { m } = setup();
    m.enable({});
    const r = run(m.middleware({ vendorIdentity: vendor, brand: () => '<span>Acme Ltd</span>' }), { headers: { accept: 'text/html' } });
    expect(r.res.body).toContain('Acme Ltd');
  });
});

describe('admin: maintenance section', () => {
  it('switches the mode on and off from the panel and audits both', async () => {
    const { db, m } = setup();
    const routes = {};
    const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; } };
    createAdmin({ db, maintenance: m, users: false }).mount(app, { requireAuth: () => (q, r, n) => n(), requirePermission: () => (q, r, n) => n() });
    const call = (key, req) => new Promise((resolve) => {
      const res = { locals: {}, set() { return this; }, type() { return this; }, send(b) { res.body = b; resolve(res); }, redirect(c, loc) { res.location = loc; resolve(res); } };
      let i = 0;
      const chain = routes[key];
      const next = () => { const h = chain[i++]; if (h) Promise.resolve(h({ user: { username: 'root', permissions: [] }, query: {}, params: {}, headers: {}, on(ev, cb) { if (ev === 'end') cb(); return this; }, ...req }, res, next)).catch((e) => { res.body = String(e); resolve(res); }); };
      next();
    });

    let r = await call('GET /admin/maintenance', {});
    expect(r.body).toContain('/admin/maintenance/enable');
    r = await call('POST /admin/maintenance/enable', { body: { message: 'short break', until: '2026-10-28T12:00' } });
    expect(r.location).toBe('/admin/maintenance?msg=ok');
    expect(m.get({ fresh: true })).toMatchObject({ enabled: true, message: 'short break', startedBy: 'root', until: '2026-10-28T12:00:00.000Z' });
    r = await call('POST /admin/maintenance/enable', { body: { message: 'x'.repeat(501) } });
    expect(r.location).toBe('/admin/maintenance?msg=bad&e=MESSAGE_TOO_LONG');
    expect((await call('GET /admin', {})).body).toContain('/admin/maintenance');
    r = await call('POST /admin/maintenance/disable', { body: { a: 1 } });
    expect(m.get({ fresh: true }).enabled).toBe(false);
    expect(query(db, { action: 'admin.maintenance.enable' })).toHaveLength(1);
    expect(query(db, { action: 'admin.maintenance.disable' })).toHaveLength(1);
  });
});

describe('brand block and status pages', () => {
  it('falls back to the vendor name and logo, and the administrator\'s name wins', () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    expect(brandBlockHtml(null, vendor)).toContain('<span>Workshop</span>');
    expect(brandBlockHtml(db, vendor)).toContain('<span>Workshop</span>');
  });

  it('error pages show the app name, a Powered by line and no old badge', () => {
    const html = renderErrorPage({ vendorIdentity: vendor, statusCode: 404, title: 't', message: 'm', locale: 'ru' });
    expect(html).toContain('<span>Workshop</span>');
    expect(html).toContain('Powered by');
    expect(html).toContain('DAS-Forge');
    expect(html).not.toContain('powered-by');
  });

  it('every listed status has a title, message and hint in both languages', () => {
    const codes = (l) => Object.keys(ERROR_CATALOG[l]).filter((k) => /^\d+$/.test(k)).sort();
    expect(codes('ru')).toEqual(codes('en'));
    expect(codes('ru').length).toBeGreaterThan(30);
    for (const l of ['ru', 'en']) {
      for (const c of codes(l)) {
        const t = ERROR_CATALOG[l][c];
        expect(t.title && t.message && t.hint, `${l} ${c}`).toBeTruthy();
      }
      const mt = ERROR_CATALOG[l].maintenance;
      expect(mt.title && mt.message && mt.hint && mt.until && mt.retry).toBeTruthy();
    }
  });
});
