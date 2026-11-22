import { describe, it, expect, beforeEach } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { createTenancy } from '../src/tenancy/index.js';
import { defineEntity, field, createEntityStore, mountEntityApi } from '../src/entities/index.js';

// Audit S-17: the person is in two organizations with different rights. Counts, pages and searches must not
// reveal anything about the organization where the person has no read right.
function fakeApp() {
  const routes = [];
  const none = () => {};
  const app = { get: (p, h) => routes.push({ p, h }), post: none, patch: none, delete: none };
  const get = async (url, { query = {}, user } = {}) => {
    const r = routes.find((x) => x.p === url); // the list route only
    const out = { status: 200, body: undefined };
    const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; }, end() { return this; } };
    await r.h({ params: {}, body: undefined, headers: {}, query, user }, res);
    return out;
  };
  return { app, get };
}

describe('entity lists: organizations without the read right do not leak through counts (S-17)', () => {
  let get; let ids; let store; let ten;
  beforeEach(async () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    let n = 0; ten = createTenancy(db, { newId: () => `t${++n}` });
    const a = await ten.createTenant({ name: 'A' }); const b = await ten.createTenant({ name: 'B' });
    await ten.createGroup({ name: 'multi-a', role: 'reader', tenantIds: [a], userIds: ['multi'] });
    await ten.createGroup({ name: 'multi-b', role: 'guest', tenantIds: [b], userIds: ['multi'] });
    await ten.createGroup({ name: 'boss', role: 'sysadmin', tenantIds: [a, b], userIds: ['boss'] });
    ids = { a, b };
    const entity = defineEntity({ name: 'asset', table: 'assets', idType: 'text', label: { ru: ['Актив', 'Активы'], en: ['Asset', 'Assets'] },
      permissions: { read: 'asset.read', create: 'asset.write', update: 'asset.write', delete: 'asset.delete' },
      fields: { title: field.text({ required: true, max: 40, searchable: true }), serial: field.text({ nullable: true, filterable: true }) } });
    let k = 0; store = createEntityStore(db, entity, { newId: () => `r${++k}` }); await store.ensureTable();
    const perms = { reader: ['asset.read'], guest: [], sysadmin: ['asset.read', 'asset.write'] };
    const f = fakeApp(); get = f.get;
    mountEntityApi(f.app, { entity, store, getScope: (req) => (req.user ? ten.resolveScope({ userId: req.user.id, platformAdmin: false, activeTenantId: req.user.tenant ?? null, permissionsOfRole: (r) => perms[r] ?? [] }) : null) });
    const boss = await ten.resolveScope({ userId: 'boss', platformAdmin: false, activeTenantId: a, permissionsOfRole: (r) => perms[r] ?? [] });
    const bossB = await ten.resolveScope({ userId: 'boss', platformAdmin: false, activeTenantId: b, permissionsOfRole: (r) => perms[r] ?? [] });
    await store.create(boss, { title: 'visible laptop', serial: 'SN-A-1' });
    await store.create(bossB, { title: 'SECRET server', serial: 'SN-SECRET-77' });
    await store.create(bossB, { title: 'SECRET router', serial: 'SN-SECRET-78' });
  });

  it('the total counts only organizations where the person may read', async () => {
    const r = await get('/api/assets', { user: { id: 'multi' } });
    expect(r.body.total).toBe(1);
    expect(r.body.items.map((x) => x.title)).toEqual(['visible laptop']);
  });
  it('a search or a filter that matches only the other organization gives total 0, same as no match at all', async () => {
    const hit = await get('/api/assets', { user: { id: 'multi' }, query: { q: 'SECRET' } });
    const miss = await get('/api/assets', { user: { id: 'multi' }, query: { q: 'zzzzzz' } });
    expect(hit.body.total).toBe(0);
    expect(hit.body).toEqual(miss.body);
    const f1 = await get('/api/assets', { user: { id: 'multi' }, query: { filter: { serial: 'SN-SECRET-77' } } });
    const f2 = await get('/api/assets', { user: { id: 'multi' }, query: { filter: { serial: 'SN-NOPE' } } });
    expect(f1.body.total).toBe(0);
    expect(f1.body).toEqual(f2.body);
  });
  it('a person who may read in both organizations still sees both', async () => {
    const r = await get('/api/assets', { user: { id: 'boss' } });
    expect(r.body.total).toBe(3);
  });
  it('the store option only narrows: an organization the person does not belong to is not added', async () => {
    const scope = await ten.resolveScope({ userId: 'multi', platformAdmin: false, activeTenantId: null, permissionsOfRole: () => ['asset.read'] });
    const out = await store.list(scope, { onlyTenants: [ids.a, 'not-mine'] });
    expect(out.total).toBe(1);
    expect((await store.list(scope, { onlyTenants: [] })).total).toBe(0);
  });
});
