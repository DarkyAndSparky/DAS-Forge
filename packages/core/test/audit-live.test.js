import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { ensureAuthTables } from '../src/auth/schema.js';
import { createAdmin } from '../src/admin/index.js';
import { log, query } from '../src/audit/index.js';

function build() {
  const db = createSqliteAdapter({ file: ':memory:' });
  ensureAuthTables(db);
  const routes = {};
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; } };
  const requireAuth = () => (req, res, next) => (req.user ? next() : res.status(401).end());
  const requirePermission = (perm) => (req, res, next) => ((req.user.permissions ?? []).includes(perm) ? next() : res.status(403).end());
  createAdmin({ db }).mount(app, { requireAuth, requirePermission });
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

describe('audit: live feed', () => {
  it('returns only the rows newer than `after`, newest on top, escaped, and respects the filter', async () => {
    const { db, routes } = build();
    log(db, { actor: 'a', action: 'admin.user.force_logout', entity: 'user', entityId: 1 });
    const first = query(db, { limit: 1 })[0].id;
    log(db, { actor: 'b', action: 'admin.task.run', entity: 'task', entityId: 2 });
    log(db, { actor: '<i>c</i>', action: 'admin.user.force_logout', entity: 'user', entityId: 3 });
    const res = await call(routes['GET /admin/audit/live'], { user: admin, query: { after: String(first) } });
    const d = JSON.parse(res.body);
    expect(d.count).toBe(2);
    expect(d.lastId > first).toBe(true);
    expect(d.rows).not.toContain('<i>c</i>');
    expect(d.rows.indexOf('&lt;i&gt;c') < d.rows.indexOf('admin.task.run')).toBe(true);
    expect(res.headers['Cache-Control']).toBe('no-store');
    const f = JSON.parse((await call(routes['GET /admin/audit/live'], { user: admin, query: { after: '0', action: 'task' } })).body);
    expect(f.count).toBe(1);
    const none = JSON.parse((await call(routes['GET /admin/audit/live'], { user: admin, query: { after: String(d.lastId) } })).body);
    expect(none).toMatchObject({ count: 0, rows: '', lastId: d.lastId });
  });

  it('the audit page has the switch on the first page only, and the live route needs the admin permission', async () => {
    const { routes } = build();
    const page = await call(routes['GET /admin/audit'], { user: admin, query: {} });
    expect(page.body).toContain('id="adm-live"');
    expect(page.body).toContain('/admin/audit/live?');
    const older = await call(routes['GET /admin/audit'], { user: admin, query: { before: '5' } });
    expect(older.body).not.toContain('id="adm-live"');
    const denied = await call(routes['GET /admin/audit/live'], { user: { id: 2, username: 'x', permissions: [] }, query: {} });
    expect(denied.code).toBe(403);
  });
});
