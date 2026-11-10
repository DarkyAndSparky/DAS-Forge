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
    let i = 0;
    const next = () => { const h = chain[i++]; if (h) Promise.resolve(h(req, res, next)).catch((e) => { res.body = String(e); resolve(res); }); };
    next();
  });
}

describe('audit: event card and export', () => {
  it('the card shows every field, the details as a table, and links to the request, the object and the actor', async () => {
    const { db, routes } = build();
    log(db, { actor: 'root', action: 'admin.user.force_logout', entity: 'user', entityId: 42, meta: { sessions: 3, note: '<b>x</b>' }, requestId: 'req-1', ip: '10.0.0.1' });
    const id = query(db, { limit: 1 })[0].id;
    const res = await call(routes['GET /admin/audit/event/:id'], { user: admin, query: {}, params: { id: String(id) } });
    expect(res.code).toBe(200);
    expect(res.body).toContain('admin.user.force_logout');
    expect(res.body).toContain('sessions');
    expect(res.body).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(res.body).not.toContain('<b>x</b>');
    expect(res.body).toContain('requestId=req-1');
    expect(res.body).toContain('entity=user');
    expect(res.body).toContain('actor=root');
  });

  it('an unknown or malformed event number is a 404', async () => {
    const { routes } = build();
    for (const id of ['999', 'abc', '-1', '0']) expect((await call(routes['GET /admin/audit/event/:id'], { user: admin, query: {}, params: { id } })).code).toBe(404);
  });

  it('the list filters by request, object and actor', async () => {
    const { db, routes } = build();
    log(db, { actor: 'a', action: 'x.one', entity: 'user', entityId: 1, requestId: 'r1' });
    log(db, { actor: 'b', action: 'x.two', entity: 'asset', entityId: 2, requestId: 'r2' });
    const byReq = await call(routes['GET /admin/audit'], { user: admin, query: { requestId: 'r2' } });
    expect(byReq.body).toContain('x.two');
    expect(byReq.body).not.toContain('x.one');
    const byEntity = await call(routes['GET /admin/audit'], { user: admin, query: { entity: 'user', entityId: '1' } });
    expect(byEntity.body).toContain('x.one');
    expect(byEntity.body).not.toContain('x.two');
  });

  it('the export is not cut off: it carries every row, with details and hashes (JSON and CSV)', async () => {
    const { db, routes } = build();
    for (let i = 0; i < 2500; i += 1) log(db, { actor: 'a', action: 'bulk.row', entityId: i, meta: { n: i } });
    const json = await call(routes['GET /admin/audit.json'], { user: admin, query: { action: 'bulk.row' } });
    const rows = JSON.parse(json.body);
    expect(rows).toHaveLength(2500);
    expect(rows[0].meta.n).toBeDefined();
    expect(typeof rows[0].hash).toBe('string');
    expect(typeof rows[0].prevHash).toBe('string');
    const csv = await call(routes['GET /admin/audit.csv'], { user: admin, query: { action: 'bulk.row' } });
    const lines = csv.body.trim().split('\r\n');
    expect(lines).toHaveLength(2501);
    expect(lines[0]).toContain('prevHash');
    // the export itself is journalled, once, with the row count
    const exp = query(db, { action: 'admin.audit.export' });
    expect(exp).toHaveLength(2);
    expect(exp[0].meta.rows).toBe(2500);
  });
});
