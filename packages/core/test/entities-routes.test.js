import { describe, it, expect, beforeEach } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { createTenancy } from '../src/tenancy/index.js';
import { defineEntity, field, createEntityStore, mountEntityApi } from '../src/entities/index.js';

// a tiny stand-in for Express: collects handlers, then calls them
function fakeApp() {
  const routes = [];
  const add = (m) => (p, h) => routes.push({ m, p, h });
  const app = { get: add('GET'), post: add('POST'), patch: add('PATCH'), delete: add('DELETE') };
  const call = async (m, url, { body, headers = {}, query = {}, user } = {}) => {
    for (const r of routes) {
      if (r.m !== m) continue;
      const names = []; const re = new RegExp(`^${r.p.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; })}$`);
      const mt = re.exec(url); if (!mt) continue;
      const params = Object.fromEntries(names.map((n, i) => [n, mt[i + 1]]));
      const out = { status: 200, body: undefined };
      const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; }, end() { return this; } };
      await r.h({ params, body, headers, query, user }, res);
      return out;
    }
    throw new Error(`no route ${m} ${url}`);
  };
  return { app, call };
}

describe('entity JSON API', () => {
  let call; let ids; let ten; let db;
  beforeEach(async () => {
    db = createSqliteAdapter({ file: ':memory:' });
    let n = 0; ten = createTenancy(db, { newId: () => `t${++n}` });
    const a = await ten.createTenant({ name: 'A' }); const b = await ten.createTenant({ name: 'B' });
    await ten.createGroup({ name: 'acc', role: 'accountant', tenantIds: [a], userIds: ['acc'] });
    await ten.createGroup({ name: 'sys', role: 'sysadmin', tenantIds: [a, b], userIds: ['sys'] });
    ids = { a, b };
    const entity = defineEntity({ name: 'asset', table: 'assets', idType: 'text', label: { ru: ['Актив', 'Активы'], en: ['Asset', 'Assets'] },
      permissions: { read: 'asset.read', create: 'asset.write', update: 'asset.write', delete: 'asset.delete', restore: 'asset.delete' },
      fields: { title: field.text({ required: true, max: 20, searchable: true }), serial: field.text({ unique: true, nullable: true }) }, features: { softDelete: true } });
    let k = 0; const store = createEntityStore(db, entity, { newId: () => `r${++k}` }); await store.ensureTable();
    const perms = { accountant: ['asset.read'], sysadmin: ['asset.read', 'asset.write', 'asset.delete'] };
    const f = fakeApp(); call = f.call;
    mountEntityApi(f.app, { entity, store, getScope: (req) => (req.user ? ten.resolveScope({ userId: req.user.id, platformAdmin: req.user.admin, activeTenantId: req.user.tenant ?? null, permissionsOfRole: (r) => perms[r] ?? [] }) : null) });
  });
  const U = (id, tenant, admin = false) => ({ id, tenant, admin });

  it('401 without a person; 400 without an organization; 403 without the right', async () => {
    expect((await call('GET', '/api/assets')).status).toBe(401);
    expect((await call('POST', '/api/assets', { user: U('sys'), body: { title: 'x' } })).body.error).toBe('tenant_required');
    expect((await call('POST', '/api/assets', { user: U('acc', ids.a), body: { title: 'x' } })).status).toBe(403);
    expect((await call('GET', '/api/assets', { user: U('nobody') })).status).toBe(403);
  });
  it('create, read, list, change with a version, conflict, delete, restore', async () => {
    const u = U('sys', ids.a);
    const c = await call('POST', '/api/assets', { user: u, body: { title: 'Laptop' } });
    expect(c.status).toBe(201);
    const id = c.body.id;
    expect((await call('GET', `/api/assets/${id}`, { user: u })).body.title).toBe('Laptop');
    expect((await call('GET', '/api/assets', { user: U('acc') })).body.total).toBe(1);
    const p = await call('PATCH', `/api/assets/${id}`, { user: u, body: { title: 'L2' }, headers: { 'if-match': '"1"' } });
    expect(p.body.version).toBe(2);
    expect((await call('PATCH', `/api/assets/${id}`, { user: u, body: { title: 'L3', _version: 1 } })).status).toBe(409);
    expect((await call('PATCH', `/api/assets/${id}`, { user: u, body: { title: 'x'.repeat(50) } })).status).toBe(422);
    expect((await call('DELETE', `/api/assets/${id}`, { user: U('acc', ids.a) })).status).toBe(403);
    expect((await call('DELETE', `/api/assets/${id}`, { user: u })).status).toBe(204);
    expect((await call('GET', `/api/assets/${id}`, { user: u })).status).toBe(404);
    expect((await call('POST', `/api/assets/${id}/restore`, { user: u })).status).toBe(200);
  });
  it('another organization looks like "not found"; a bad body is refused', async () => {
    const c = await call('POST', '/api/assets', { user: U('sys', ids.b), body: { title: 'Beta' } });
    for (const [m, extra] of [['GET', {}], ['PATCH', { body: { title: 'h' } }], ['DELETE', {}]]) expect((await call(m, `/api/assets/${c.body.id}`, { user: U('acc', ids.a), ...extra })).status).toBe(404);
    expect((await call('POST', '/api/assets', { user: U('sys', ids.a), body: [] })).status).toBe(400);
    expect((await call('POST', '/api/assets', { user: U('sys', ids.a), body: { title: 't', tenantId: ids.b } })).status).toBe(422);
  });
});
