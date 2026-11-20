import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTestDb, pgConfigured } from './support/pg-test-db.js';
import { createTenancy, TenantAccessError } from '@das-forge/core/tenancy';
import { defineEntity, field, createEntityStore, EntityNotFoundError, EntityValidationError, EntityConflictError, TenantRequiredError } from '@das-forge/core/entities';

const rejects = async (p, cls) => { let e; try { await p; } catch (x) { e = x; } expect(e instanceof cls, `[${new Error().stack.split('\n')[2].match(/:(\d+):/)?.[1]}] expected ${cls.name}, got ${e && e.name}: ${e && e.message}`).toBe(true); return e; };

const asset = (over = {}) => defineEntity({
  name: 'asset', table: 'assets', idType: 'text',
  label: { ru: ['Актив', 'Активы'], en: ['Asset', 'Assets'] },
  permissions: { read: 'asset.read', create: 'asset.write', update: 'asset.write', delete: 'asset.delete', restore: 'asset.restore' },
  fields: { title: field.text({ required: true, max: 30, searchable: true }), status: field.enum(['new', 'used'], { default: 'new', filterable: true }), serial: field.text({ unique: true, nullable: true }), kind: field.enum(['laptop', 'router'], { nullable: true }), secretNote: field.secret({ nullable: true }) },
  variants: { by: 'kind', cases: { laptop: { fields: { host: field.text() } }, router: { fields: { ip: field.ip() } } } },
  features: { softDelete: true },
  ...over,
});

let db; let ten; let ids; let ScopeOf;
afterEach(async () => { await db?.close(); });
beforeEach(async () => {
  if (!pgConfigured) return;
  db =  await openTestDb();
  let n = 0;
  ten = createTenancy(db, { newId: () => `id${++n}` });
  const a = await ten.createTenant({ name: 'Alpha' }); const b = await ten.createTenant({ name: 'Beta' }); const c = await ten.createTenant({ name: 'Gamma' });
  // accountant of Alpha; sysadmin of Alpha and Beta; nobody in Gamma
  await ten.createGroup({ name: 'Alpha accountants', role: 'accountant', tenantIds: [a], userIds: ['u-acc'] });
  await ten.createGroup({ name: 'Sysadmins', role: 'sysadmin', tenantIds: [a, b], userIds: ['u-sys'] });
  ids = { a, b, c };
  ScopeOf = (userId, active = null, extra = {}) => ten.resolveScope({ userId, activeTenantId: active, permissionsOfRole: (r) => ({ accountant: ['asset.read'], sysadmin: ['asset.read', 'asset.write'] }[r] ?? []), ...extra });
});

describe.skipIf(!pgConfigured)('PG: tenancy: groups and scopes', () => {
  it('a user in several groups works in several organizations; the sets are the union', async () => {
    const s = await ScopeOf('u-sys');
    expect([...s.tenantIds].sort()).toEqual([ids.a, ids.b].sort());
    expect((await ScopeOf('u-acc')).tenantIds).toEqual([ids.a]);
    expect((await ScopeOf('nobody')).tenantIds).toEqual([]);
  });
  it('the active organization must be one of the person\'s', async () => {
    await rejects(ScopeOf('u-acc', ids.b), TenantAccessError);
    expect((await ScopeOf('u-sys', ids.b)).visibleTenantIds).toEqual([ids.b]);
    expect((await ScopeOf('u-sys')).visibleTenantIds.length).toBe(2);
  });
  it('the platform administrator sees every active organization', async () => {
    const s = await ScopeOf('admin1', null, { platformAdmin: true });
    expect(s.all).toBe(true);
    expect(s.tenantIds.length).toBe(3);
    expect(s.can('anything', ids.c)).toBe(true);
  });
  it('a switched-off organization leaves every scope', async () => {
    await ten.setTenantActive(ids.b, false);
    expect((await ScopeOf('u-sys')).tenantIds).toEqual([ids.a]);
    await rejects(ScopeOf('u-sys', ids.b), TenantAccessError);
    expect((await ScopeOf('admin1', null, { platformAdmin: true })).tenantIds.length).toBe(2);
  });
  it('can() follows the role of the group in that organization', async () => {
    const s = await ScopeOf('u-sys');
    expect(s.can('asset.write', ids.a)).toBe(true);
    expect(s.can('asset.write')).toBe(false); // no organization chosen
    const acc = await ScopeOf('u-acc', ids.a);
    expect(acc.can('asset.read')).toBe(true);
    expect(acc.can('asset.write')).toBe(false);
    expect(acc.can('asset.read', ids.b)).toBe(false);
  });
  it('membership changes apply at the next scope; deleting a group removes access', async () => {
    const g = (await ten.listGroups()).find((x) => x.name === 'Alpha accountants');
    await ten.setGroupTenants(g.id, [ids.a, ids.c]);
    expect([...(await ScopeOf('u-acc')).tenantIds].sort()).toEqual([ids.a, ids.c].sort());
    await ten.deleteGroup(g.id);
    expect((await ScopeOf('u-acc')).tenantIds).toEqual([]);
  });
});

describe.skipIf(!pgConfigured)('PG: entity store: the organization boundary', () => {
  let store;
  beforeEach(async () => { store = createEntityStore(db, asset(), { newId: (() => { let n = 0; return () => `a${++n}`; })() }); await store.ensureTable(); });

  it('refuses a scope that was not made by resolveScope', async () => {
    for (const fake of [{ tenantIds: [ids.a], visibleTenantIds: [ids.a], activeTenantId: ids.a, all: true }, null, undefined]) {
      await rejects(store.list(fake), TypeError);
      await rejects(store.create(fake, { title: 'x' }), TypeError);
      await rejects(store.get(fake, 'a1'), TypeError);
    }
  });
  it('create needs a chosen organization and puts the record into it; tenantId cannot be sent', async () => {
    await rejects(store.create(await ScopeOf('u-sys'), { title: 'x' }), TenantRequiredError);
    const rec = await store.create(await ScopeOf('u-sys', ids.b), { title: 'Laptop 1' });
    expect(rec.tenantId).toBe(ids.b);
    expect(rec.status).toBe('new');
    const e = await rejects(store.create(await ScopeOf('u-sys', ids.b), { title: 'x', tenantId: ids.a }), EntityValidationError);
    expect(e.errors[0]).toMatchObject({ path: 'tenantId', code: 'unknown_field' });
  });
  it('a record of another organization is not found: get, update, remove, restore', async () => {
    const mine = await store.create(await ScopeOf('u-sys', ids.b), { title: 'Beta laptop' });
    const acc = await ScopeOf('u-acc', ids.a);
    await rejects(store.get(acc, mine.id), EntityNotFoundError);
    await rejects(store.update(acc, mine.id, { title: 'hacked' }), EntityNotFoundError);
    await rejects(store.remove(acc, mine.id), EntityNotFoundError);
    await rejects(store.restore(acc, mine.id), EntityNotFoundError);
    expect((await store.get(await ScopeOf('u-sys', ids.b), mine.id)).title).toBe('Beta laptop'); // untouched
  });
  it('a person who is not in the organization cannot write into it, even choosing it', async () => {
    await rejects(ScopeOf('u-acc', ids.b), TenantAccessError);
  });
  it('lists: the chosen organization, or all of the person\'s ("all mine"), never others; the administrator sees all', async () => {
    const sysA = await ScopeOf('u-sys', ids.a); const sysB = await ScopeOf('u-sys', ids.b);
    await store.create(sysA, { title: 'A1' }); await store.create(sysA, { title: 'A2' }); await store.create(sysB, { title: 'B1' });
    await store.create(await ScopeOf('admin1', ids.c, { platformAdmin: true }), { title: 'C1' });
    expect((await store.list(sysA)).total).toBe(2);
    expect((await store.list(await ScopeOf('u-sys'))).total).toBe(3);
    expect((await store.list(await ScopeOf('u-acc'))).total).toBe(2);
    expect((await store.list(await ScopeOf('nobody'))).total).toBe(0);
    expect((await store.list(await ScopeOf('admin1', null, { platformAdmin: true }))).total).toBe(4);
    expect((await store.list(await ScopeOf('admin1', ids.c, { platformAdmin: true }))).total).toBe(1);
  });
  it('a global entity is not fenced', async () => {
    const g = createEntityStore(db, asset({ name: 'unit', table: 'units', tenant: 'global', features: {} }), { newId: () => 'g1' });
    await g.ensureTable();
    await g.create(await ScopeOf('u-sys'), { title: 'Piece' });
    expect((await g.list(await ScopeOf('nobody'))).total).toBe(1);
  });
});

describe.skipIf(!pgConfigured)('PG: entity store: writes', () => {
  let store; let scope;
  beforeEach(async () => { store = createEntityStore(db, asset(), { newId: (() => { let n = 0; return () => `a${++n}`; })() }); await store.ensureTable(); scope = await ScopeOf('u-sys', ids.a); });

  it('validation errors carry the path and code', async () => {
    const e = await rejects(store.create(scope, { status: 'bad' }), EntityValidationError);
    expect(e.errors.map((x) => `${x.path}:${x.code}`).sort()).toEqual(['status:not_in_list', 'title:required']);
  });
  it('optimistic lock: a stale version is a conflict, a right one bumps the version', async () => {
    const r = await store.create(scope, { title: 'T' });
    expect(r.version).toBe(1);
    const u = await store.update(scope, r.id, { title: 'T2' }, { expectedVersion: 1 });
    expect(u.version).toBe(2);
    await rejects(store.update(scope, r.id, { title: 'T3' }, { expectedVersion: 1 }), EntityConflictError);
    expect((await store.get(scope, r.id)).title).toBe('T2');
  });
  it('variant fields are merged on update and secrets never leave', async () => {
    const r = await store.create(scope, { title: 'R', kind: 'router', ip: '10.0.0.1', secretNote: 'pw' });
    expect(r.attrs).toEqual({ ip: '10.0.0.1' });
    expect(r.secretNote).toBeUndefined();
    const u = await store.update(scope, r.id, { ip: '10.0.0.2' });
    expect(u.attrs.ip).toBe('10.0.0.2');
    await rejects(store.update(scope, r.id, { host: 'h' }), EntityValidationError); // not a field of this case
    const row = (await db.get('SELECT secret_note FROM assets WHERE id = ?', [r.id]));
    expect(row.secret_note).toBe('pw'); // stored as given: encryption is the application's job (not done here)
  });
  it('soft delete hides, restore brings back, a unique clash blocks the restore', async () => {
    const r = await store.create(scope, { title: 'S', serial: 'SN1' });
    await store.remove(scope, r.id);
    await rejects(store.get(scope, r.id), EntityNotFoundError);
    expect((await store.list(scope)).total).toBe(0);
    expect((await store.list(scope, { includeDeleted: true })).total).toBe(1);
    const again = await store.create(scope, { title: 'S2', serial: 'SN1' }); // the deleted one no longer holds the value
    await rejects(store.restore(scope, r.id), EntityConflictError);
    await store.remove(scope, again.id);
    expect((await store.restore(scope, r.id)).id).toBe(r.id);
    expect((await store.get(scope, r.id)).title).toBe('S');
  });
  it('a hard delete when there is no soft delete', async () => {
    const hard = createEntityStore(db, asset({ name: 'part', table: 'parts', features: {}, permissions: { read: 'p.r', create: 'p.w', update: 'p.w', delete: 'p.d' } }), { newId: () => 'p1' });
    await hard.ensureTable();
    const r = await hard.create(scope, { title: 'P' });
    await hard.remove(scope, r.id);
    expect((await db.get('SELECT COUNT(*) AS n FROM parts')).n).toBe(0);
  });
  it('an exception in a hook rolls everything back', async () => {
    const s2 = createEntityStore(db, asset({ name: 'hooked', table: 'hooked', hooks: { afterCreate: () => { throw new Error('boom'); } } }), { newId: () => 'h1' });
    await s2.ensureTable();
    await rejects(s2.create(scope, { title: 'X' }), Error);
    expect((await db.get('SELECT COUNT(*) AS n FROM hooked')).n).toBe(0);
  });
  it('a hook can change the value, and the change is checked again', async () => {
    const s2 = createEntityStore(db, asset({ name: 'hk', table: 'hks', hooks: { beforeCreate: (ctx) => { ctx.value.title = ctx.value.title.toUpperCase(); } } }), { newId: () => 'h1' });
    await s2.ensureTable();
    expect((await s2.create(scope, { title: 'abc' })).title).toBe('ABC');
    const bad = createEntityStore(db, asset({ name: 'hk2', table: 'hks2', hooks: { beforeCreate: (ctx) => { ctx.value.title = 'x'.repeat(99); } } }), { newId: () => 'h2' });
    await bad.ensureTable();
    await rejects(bad.create(scope, { title: 'abc' }), EntityValidationError);
  });
});

describe.skipIf(!pgConfigured)('PG: entity store: lists', () => {
  let store; let scope;
  beforeEach(async () => {
    store = createEntityStore(db, asset(), { newId: (() => { let n = 0; return () => `a${String(++n).padStart(3, '0')}`; })() });
    await store.ensureTable(); scope = await ScopeOf('u-sys', ids.a);
    for (let i = 1; i <= 30; i += 1) await store.create(scope, { title: i % 10 === 0 ? `100% disk ${i}` : `Item ${i}`, status: i % 2 ? 'new' : 'used' });
  });
  it('pages, caps the page size at 200, and keeps a stable order', async () => {
    const p1 = await store.list(scope, { size: 10, sort: ['title'] }); const p2 = await store.list(scope, { size: 10, page: 2, sort: ['title'] });
    expect(p1.total).toBe(30); expect(p1.items.length).toBe(10);
    expect(p1.items.map((x) => x.id).some((id) => p2.items.map((x) => x.id).includes(id))).toBe(false);
    expect((await store.list(scope, { size: 99999 })).size).toBe(200);
  });
  it('filters only filterable fields, with a list of values', async () => {
    expect((await store.list(scope, { filter: { status: 'used' } })).total).toBe(15);
    expect((await store.list(scope, { filter: { status: ['used', 'new'] } })).total).toBe(30);
    await rejects(store.list(scope, { filter: { nope: 'x' } }), EntityValidationError);
    await rejects(store.list(scope, { filter: { status: 'bad' } }), EntityValidationError);
    await rejects(store.list(scope, { filter: { secretNote: 'x' } }), EntityValidationError);
  });
  it('search escapes LIKE characters and never looks into secrets', async () => {
    expect((await store.list(scope, { q: '100%' })).total).toBe(3);
    expect((await store.list(scope, { q: '%' })).total).toBe(3); // a literal percent sign, not "anything"
    expect((await store.list(scope, { q: '_' })).total).toBe(0);
    expect((await store.list(scope, { q: "x' OR '1'='1" })).total).toBe(0);
  });
  it('sorts only by sortable fields', async () => {
    await rejects(store.list(scope, { sort: ['secretNote'] }), EntityValidationError);
    await rejects(store.list(scope, { sort: ['title; DROP TABLE assets'] }), EntityValidationError);
    expect((await store.list(scope, { sort: ['-title'], size: 1 })).items[0].title).toBe('Item 9');
  });
});
