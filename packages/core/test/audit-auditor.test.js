import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { ensureAuthTables } from '../src/auth/schema.js';
import { createAdmin } from '../src/admin/index.js';
import { log, query } from '../src/audit/index.js';

function build(opts = {}) {
  const db = createSqliteAdapter({ file: ':memory:' });
  ensureAuthTables(db);
  const routes = {};
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; } };
  const requireAuth = () => (req, res, next) => (req.user ? next() : res.status(401).end());
  const requirePermission = (perm) => (req, res, next) => ((req.user?.permissions ?? []).includes(perm) ? next() : res.status(req.user ? 403 : 401).end());
  createAdmin({ db, users: true, ...opts }).mount(app, { requireAuth, requirePermission });
  return { db, routes };
}
const admin = { id: 1, username: 'root', permissions: ['admin.access'] };
function call(chain, req) {
  return new Promise((resolve) => {
    const res = { code: 200, body: '', chunks: [], locals: {}, headers: {}, set(k, v) { this.headers[k] = v; return this; }, type() { return this; }, status(c) { this.code = c; return this; }, write(c) { this.chunks.push(String(c)); return true; } };
    res.end = (c) => { if (c) res.chunks.push(String(c)); res.body = res.body || res.chunks.join(''); resolve(res); return res; };
    res.send = (b) => { res.body = b; resolve(res); return res; };
    res.redirect = () => resolve(res);
    res.json = (o) => { res.body = JSON.stringify(o); resolve(res); return res; };
    let i = 0;
    const next = () => { const h = chain[i++]; if (h) Promise.resolve(h(req, res, next)).catch((e) => { res.body = String(e); resolve(res); }); };
    next();
  });
}

const reader = { id: 2, username: 'aud', permissions: ['audit.read'] };
const exporter = { id: 3, username: 'aud2', permissions: ['audit.read', 'audit.export'] };
const nobody = { id: 4, username: 'x', permissions: ['read:basic'] };
const ACCESS = { auditAccess: { read: 'audit.read', export: 'audit.export' } };

describe('auditor role: audit access without the administration', () => {
  it('reads the journal, the summary, the live feed and an event card, but not the rest of the admin', async () => {
    const { db, routes } = build(ACCESS);
    log(db, { actor: 'a', action: 'admin.user.force_logout', entity: 'user', entityId: 1 });
    const id = query(db, { limit: 1 })[0].id;
    for (const [p, q] of [['GET /admin/audit', {}], ['GET /admin/audit/live', { after: '0' }], ['GET /admin/audit/summary', {}], ['GET /admin/audit/event/:id', {}]]) {
      const r = await call(routes[p], { user: reader, query: q, params: { id: String(id) } });
      expect(r.code, p).toBe(200);
    }
    for (const p of ['GET /admin', 'GET /admin/users', 'GET /admin/search']) {
      expect((await call(routes[p], { user: reader, query: {} })).code, p).toBe(403);
    }
  });

  it('the export needs its own permission, and the buttons are hidden without it', async () => {
    const { routes } = build(ACCESS);
    const page = await call(routes['GET /admin/audit'], { user: reader, query: {} });
    expect(page.body).not.toContain('/admin/audit.csv');
    expect((await call(routes['GET /admin/audit.csv'], { user: reader, query: {} })).code).toBe(403);
    expect((await call(routes['GET /admin/audit.json'], { user: reader, query: {} })).code).toBe(403);
    const withExport = await call(routes['GET /admin/audit'], { user: exporter, query: {} });
    expect(withExport.body).toContain('/admin/audit.csv');
    expect((await call(routes['GET /admin/audit.csv'], { user: exporter, query: {} })).code).not.toBe(403);
    const adminPage = await call(routes['GET /admin/audit'], { user: admin, query: {} });
    expect(adminPage.body).toContain('/admin/audit.csv');
  });

  it('the menu of an auditor holds the Audit section only; an administrator keeps the full menu', async () => {
    const { routes } = build(ACCESS);
    const a = await call(routes['GET /admin/audit'], { user: reader, query: {} });
    expect(a.body).toContain('href="/admin/audit"');
    expect(a.body).not.toContain('href="/admin/users"');
    const b = await call(routes['GET /admin/audit'], { user: admin, query: {} });
    expect(b.body).toContain('href="/admin/users"');
  });

  it('others are refused, and without the option the audit stays for administrators only', async () => {
    const { routes } = build(ACCESS);
    expect((await call(routes['GET /admin/audit'], { user: nobody, query: {} })).code).toBe(403);
    expect((await call(routes['GET /admin/audit'], { user: null, query: {} })).code).toBe(401);
    const plain = build();
    expect((await call(plain.routes['GET /admin/audit'], { user: reader, query: {} })).code).toBe(403);
    expect((await call(plain.routes['GET /admin/audit'], { user: admin, query: {} })).code).toBe(200);
  });
});
