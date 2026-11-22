import { describe, it, expect, beforeEach } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { createTenancy } from '../src/tenancy/index.js';
import { defineEntity, field, createEntityStore, readFilter, EntityValidationError } from '../src/entities/index.js';

// Found by attacking the real server (0.1.372 build): inherited names, huge page numbers, NUL in search, query-parser dependence.
const def = () => defineEntity({ name: 'asset', table: 'assets', idType: 'text', tenant: 'global', label: { ru: ['А', 'Аа'], en: ['A', 'As'] },
  permissions: { read: 'r', create: 'w', update: 'w', delete: 'd' },
  fields: { title: field.text({ required: true, max: 20, searchable: true, sortable: true }), status: field.enum(['new', 'used'], { default: 'new', filterable: true }), kind: field.enum(['laptop', 'router'], { nullable: true }) },
  variants: { by: 'kind', cases: { router: { fields: { ip: field.ip({ nullable: true }) } }, laptop: { fields: { host: field.text({ nullable: true }) } } } } });

const must = async (p) => { let e; try { await p; } catch (x) { e = x; } expect(e instanceof EntityValidationError, `expected EntityValidationError, got ${e?.name}: ${e?.message}`).toBe(true); };

describe('hardening found by attack', () => {
  let store; let scope;
  beforeEach(async () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    scope = await createTenancy(db).resolveScope({ userId: 'u', platformAdmin: true, permissionsOfRole: () => [] });
    store = createEntityStore(db, def()); await store.ensureTable();
    await store.create(scope, { title: 'alpha' }); await store.create(scope, { title: 'beta' });
  });

  it('keys named like inherited properties are unknown fields, never a server error', async () => {
    for (const key of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__']) {
      await must(store.create(scope, JSON.parse(`{"title":"x","kind":"router","${key}":"z"}`)));
      await must(store.create(scope, JSON.parse(`{"title":"x","${key}":"z"}`)));
      await must(store.update(scope, (await store.list(scope)).items[0].id, JSON.parse(`{"${key}":"z"}`)));
    }
  });
  it('a kind named like an inherited property is not found', async () => {
    await must(store.create(scope, { title: 'x', kind: 'constructor' }));
    await must(store.create(scope, { title: 'x', kind: 'toString', ip: '1.1.1.1' }));
  });
  it('filter and sort by an inherited name are refused', async () => {
    await must(store.list(scope, { filter: { constructor: 'x' } }));
    await must(store.list(scope, { filter: { toString: 'x' } }));
    await must(store.list(scope, { sort: ['constructor'] }));
  });
  it('a huge page number is clamped, not an overflow', async () => {
    for (const page of [1e20, '99999999999999999999', Infinity, 2 ** 53]) { const r = await store.list(scope, { page }); expect(r.items.length).toBe(0); expect(r.page <= 1_000_000).toBe(true); }
  });
  it('control characters in the search are dropped (a NUL must not match everything)', async () => {
    expect((await store.list(scope, { q: '\u0000' })).total).toBe(2); // dropped = no search at all
    expect((await store.list(scope, { q: 'alp\u0000ha' })).total).toBe(1);
    expect((await store.list(scope, { q: 'x'.repeat(5000) })).total).toBe(0);
  });
  it('readFilter reads filter[field] from a flat query (Express default parser) and from a nested one', () => {
    expect({ ...readFilter({ 'filter[status]': 'used', other: '1' }) }).toEqual({ status: 'used' });
    expect({ ...readFilter({ filter: { status: ['used', 'new'] } }) }).toEqual({ status: ['used', 'new'] });
    for (const bad of [{ 'filter[a][$ne]': 'x' }, { filter: { a: { $ne: 'x' } } }, { 'filter[__proto__]': 'x' }, { 'filter[a b]': 'x' }, { filter: 'x' }, { filter: ['a'] }, { 'filter[a]': Array(51).fill('x') }, { 'filter[a]': 'x'.repeat(201) }]) {
      let err; try { readFilter(bad); } catch (e) { err = e; }
      expect(err instanceof EntityValidationError, JSON.stringify(bad)).toBe(true);
    }
    expect(Object.getPrototypeOf(readFilter({}))).toBe(null);
  });
});
