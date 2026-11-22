import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { defineEntity, defineEntities, field, registerFieldType, EntityDefinitionError } from '../src/entities/index.js';

const perms = { read: 'asset.read', create: 'asset.write', update: 'asset.write', delete: 'asset.delete' };
const label = { ru: ['Актив', 'Активы'], en: ['Asset', 'Assets'] };
const base = (over = {}) => ({ name: 'asset', table: 'assets', label, permissions: perms, fields: { title: field.text({ required: true, max: 20 }) }, ...over });
const throwsDef = (def, re) => { let e; try { defineEntity(def); } catch (x) { e = x; } expect(e instanceof EntityDefinitionError).toBe(true); expect(String(e.message)).toMatch(re); };
const codes = (r) => r.errors.map((e) => `${e.path}:${e.code}`);

describe('defineEntity: the definition is checked at start', () => {
  it('rejects bad names, tables, labels and missing permissions with a path', () => {
    throwsDef(base({ name: 'Bad Name' }), /name/);
    throwsDef(base({ table: 'Assets' }), /table/);
    throwsDef(base({ label: { ru: ['a', 'b'] } }), /label\.en/);
    throwsDef(base({ permissions: { ...perms, delete: undefined } }), /permissions\.delete/);
    throwsDef(base({ fields: {} }), /at least one field/);
  });
  it('rejects bad fields: reserved name, unknown type, bad enum, bad ref, duplicate column', () => {
    throwsDef(base({ fields: { id: field.text() } }), /reserved/);
    throwsDef(base({ fields: { x: { type: 'nope' } } }), /unknown field type/);
    throwsDef(base({ fields: { s: field.enum([]) } }), /enum needs/);
    throwsDef(base({ fields: { r: { type: 'ref' } } }), /ref needs/);
    throwsDef(base({ fields: { a: field.text({ column: 'c' }), b: field.text({ column: 'c' }) } }), /used twice/);
    throwsDef(base({ fields: { a: field.text({ column: 'a; DROP' }) } }), /plain identifier/);
  });
  it('a secret cannot be listed, filtered or searched; json cannot be sorted', () => {
    throwsDef(base({ fields: { p: field.secret({ searchable: true }) } }), /secret field cannot be searchable/);
    throwsDef(base({ fields: { j: field.json({ sortable: true }) } }), /cannot be sortable/);
  });
  it('checks list, unique, index, features and hooks', () => {
    const f = { title: field.text({ required: true }), note: field.longText() };
    throwsDef(base({ fields: f, list: { columns: ['note'] } }), /not a listable/);
    throwsDef(base({ fields: f, list: { sort: ['-nope'] } }), /not a sortable/);
    throwsDef(base({ fields: f, list: { pageSize: 500 } }), /pageSize/);
    throwsDef(base({ fields: f, unique: [['nope']] }), /unknown field/);
    throwsDef(base({ features: { magic: true } }), /unknown feature/);
    throwsDef(base({ hooks: { onFire: () => {} } }), /unknown hook/);
    throwsDef(base({ features: { softDelete: true } }), /permissions\.restore/);
  });
  it('is frozen and gives defaults', () => {
    const e = defineEntity(base());
    expect(Object.isFrozen(e)).toBe(true);
    expect(e.tenant).toBe('tenant');
    expect(e.list.pageSize).toBe(25);
    expect(e.features.audit).toBe(true);
    expect(e.features.optimisticLock).toBe(true);
    expect(e.list.columns).toEqual(['title']);
  });
});

describe('validate: every type', () => {
  const E = defineEntity(base({ fields: {
    t: field.text({ max: 5 }), n: field.int({ min: 1, max: 10 }), d: field.decimal({ scale: 2 }), m: field.money({ currency: 'RUB' }),
    b: field.bool(), day: field.date(), at: field.datetime(), st: field.enum(['new', 'done']), r: field.ref('users'), rt: field.ref('users', { idType: 'text' }),
    j: field.json(), f: field.file(), s: field.secret(), ip: field.ip(), ip4: field.ip({ version: 4 }), mac: field.mac(),
  } }));
  const one = (k, v) => E.validate({ [k]: v });
  const good = (k, v) => { const r = one(k, v); expect(r.errors, `${k}=${JSON.stringify(v)}`).toEqual([]); return r.value[k]; };
  const badv = (k, v, code) => expect(codes(one(k, v)), `${k}=${JSON.stringify(v)}`).toEqual([`${k}:${code}`]);

  it('text trims and limits', () => { expect(good('t', '  ab ')).toBe('ab'); badv('t', 'abcdef', 'too_long'); badv('t', 5, 'type'); });
  it('int', () => { expect(good('n', 3)).toBe(3); badv('n', 0, 'too_small'); badv('n', 11, 'too_big'); badv('n', 1.5, 'type'); badv('n', '3', 'type'); });
  it('decimal is exact (scaled integer), never a float', () => {
    expect(good('d', '12.50')).toBe(1250); expect(good('d', '-0.05')).toBe(-5); expect(good('d', 7)).toBe(700);
    badv('d', '1.234', 'too_many_decimals'); badv('d', 'abc', 'type'); badv('d', 1.5, 'type');
  });
  it('money is integer minor units', () => { expect(good('m', 1999)).toBe(1999); badv('m', 19.99, 'type'); });
  it('bool, date, datetime', () => {
    expect(good('b', true)).toBe(true); badv('b', 1, 'type');
    expect(good('day', '2026-02-28')).toBe('2026-02-28'); badv('day', '2026-02-30', 'type'); badv('day', '28.02.2026', 'type');
    expect(good('at', '2026-11-20T13:00:00+05:00')).toBe('2026-11-20T08:00:00.000Z'); badv('at', '2026-11-20 13:00', 'type');
  });
  it('enum and ref', () => {
    expect(good('st', 'new')).toBe('new'); badv('st', 'other', 'not_in_list');
    expect(good('r', 5)).toBe(5); badv('r', 0, 'type'); badv('r', 'x', 'type');
    expect(good('rt', '0190-abc')).toBe('0190-abc'); badv('rt', 5, 'type');
  });
  it('json, file, secret', () => { expect(good('j', { a: [1] })).toEqual({ a: [1] }); expect(good('f', 'file-1')).toBe('file-1'); expect(good('s', 'pa$$')).toBe('pa$$'); badv('s', '', 'type'); });
  it('ip and mac are normalised', () => {
    expect(good('ip', '10.0.0.1')).toBe('10.0.0.1'); expect(good('ip', '2001:DB8::1')).toBe('2001:db8::1'); badv('ip', '999.1.1.1', 'type'); badv('ip4', '::1', 'type');
    expect(good('mac', 'AA-BB-CC-00-11-22')).toBe('aa:bb:cc:00:11:22'); badv('mac', 'aa:bb', 'type');
  });
});

describe('validate: create and update', () => {
  const E = defineEntity(base({ fields: { title: field.text({ required: true, max: 20 }), status: field.enum(['new', 'done'], { default: 'new' }), note: field.text({ nullable: true }), code: field.text({ readOnly: true }) } }));
  it('create: required, default, unknown field, null, read-only', () => {
    expect(codes(E.validate({}))).toEqual(['title:required']);
    expect(E.validate({ title: 'A' }).value).toEqual({ title: 'A', status: 'new' });
    expect(codes(E.validate({ title: 'A', zzz: 1 }))).toEqual(['zzz:unknown_field']);
    expect(E.validate({ title: 'A', note: null }).value.note).toBe(null);
    expect(codes(E.validate({ title: null }))).toEqual(['title:required']);
    expect(codes(E.validate({ title: 'A', status: null }))).toEqual(['status:null_not_allowed']);
    expect(codes(E.validate({ title: 'A', code: 'x' }))).toEqual(['code:read_only']);
    expect(codes(E.validate('nope'))).toEqual([':type']);
  });
  it('update: only the given fields, no defaults, required cannot be emptied', () => {
    expect(E.validate({ status: 'done' }, { mode: 'update' })).toEqual({ ok: true, value: { status: 'done' }, errors: [] });
    expect(codes(E.validate({ title: null }, { mode: 'update' }))).toEqual(['title:required']);
  });
});

describe('variants: fields that depend on a value (device type)', () => {
  const E = defineEntity(base({
    fields: { title: field.text({ required: true }), kind: field.enum(['laptop', 'router'], { required: true }) },
    variants: { by: 'kind', cases: {
      laptop: { fields: { hostname: field.text(), password: field.secret() } },
      router: { fields: { ip: field.ip({ required: true }), password: field.secret() } },
    } },
  }));
  it('extra fields go into attrs; the case decides which are allowed and required', () => {
    const r = E.validate({ title: 'A', kind: 'router', ip: '10.0.0.1', password: 'x' });
    expect(r.errors).toEqual([]);
    expect(r.value).toEqual({ title: 'A', kind: 'router', attrs: { ip: '10.0.0.1', password: 'x' } });
    expect(codes(E.validate({ title: 'A', kind: 'router' }))).toEqual(['ip:required']);
    expect(codes(E.validate({ title: 'A', kind: 'laptop', ip: '10.0.0.1' }))).toEqual(['ip:not_for_this_case']);
    expect(codes(E.validate({ title: 'A', kind: 'laptop', hostname: 'h', nope: 1 }))).toEqual(['nope:unknown_field']);
  });
  it('an update resolves the case from the stored record', () => {
    expect(E.validate({ ip: '10.0.0.2' }, { mode: 'update', current: { kind: 'router' } }).value).toEqual({ attrs: { ip: '10.0.0.2' } });
    expect(codes(E.validate({ ip: '10.0.0.2' }, { mode: 'update' }))).toEqual(['ip:not_for_this_case']);
  });
  it('definition: by must be an enum/text field, case keys must be enum values, no clash with base fields', () => {
    const f = { title: field.text(), kind: field.enum(['a']), n: field.int() };
    throwsDef(base({ fields: f, variants: { by: 'n', cases: { x: { fields: {} } } } }), /enum or text/);
    throwsDef(base({ fields: f, variants: { by: 'kind', cases: { zzz: { fields: {} } } } }), /not a value/);
    throwsDef(base({ fields: f, variants: { by: 'kind', cases: { a: { fields: { title: field.text() } } } } }), /duplicate field name/);
  });
  it('secrets are removed from the public shape, also inside attrs', () => {
    const rec = { title: 'A', kind: 'router', attrs: { ip: '10.0.0.1', password: 'enc' } };
    expect(E.publicShape(rec)).toEqual({ title: 'A', kind: 'router', attrs: { ip: '10.0.0.1' } });
  });
});

describe('storage and DDL', () => {
  const E = defineEntity(base({
    table: 'it_assets', idType: 'text',
    fields: { title: field.text({ required: true, unique: true }), done: field.bool(), price: field.decimal({ scale: 2 }), cfg: field.json(), owner: field.ref('users', { idType: 'text' }), serial: field.text() },
    unique: [['serial']], index: [['owner', 'done']], features: { softDelete: true }, permissions: { ...perms, restore: 'asset.restore' },
    variants: { by: 'title', cases: { x: { fields: { ip: field.ip() } } } },
  }));
  it('toStorage/fromStorage round-trip booleans, decimals and JSON', () => {
    const v = E.validate({ title: 'x', done: true, price: '9.90', cfg: { a: 1 }, ip: '10.0.0.9' }).value;
    const row = E.toStorage(v);
    expect(row).toMatchObject({ title: 'x', done: 1, price: 990, cfg: '{"a":1}', attrs: '{"ip":"10.0.0.9"}' });
    expect(E.fromStorage({ id: 'i1', ...row, created_at: 'c', tenant_id: 't' })).toMatchObject({ id: 'i1', title: 'x', done: true, price: '9.90', cfg: { a: 1 }, attrs: { ip: '10.0.0.9' }, createdAt: 'c', tenantId: 't' });
  });
  it('DDL runs on SQLite, partial unique index under soft delete, tenant in every index', () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    for (const s of E.ddl()) db.exec(s);
    const sql = E.ddl().join('\n');
    expect(sql).toContain('tenant_id TEXT NOT NULL');
    expect(sql).toContain('deleted_at TEXT');
    expect(sql).toMatch(/UNIQUE INDEX IF NOT EXISTS ux_it_assets_tenant_id_serial ON it_assets \(tenant_id, serial\) WHERE deleted_at IS NULL/);
    db.run('INSERT INTO it_assets (id, tenant_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', ['1', 'a', 'T1', 'x', 'x']);
    db.run('INSERT INTO it_assets (id, tenant_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', ['2', 'b', 'T1', 'x', 'x']); // another tenant: same title is fine
    let e; try { db.run('INSERT INTO it_assets (id, tenant_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', ['3', 'a', 'T1', 'x', 'x']); } catch (x) { e = x; }
    expect(e).toBeDefined();
    db.run('UPDATE it_assets SET deleted_at = ? WHERE id = ?', ['now', '1']);
    db.run('INSERT INTO it_assets (id, tenant_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', ['4', 'a', 'T1', 'x', 'x']); // the deleted one no longer blocks
  });
  it('a global entity has no tenant_id', () => {
    expect(defineEntity(base({ tenant: 'global' })).ddl().join('\n')).not.toContain('tenant_id');
  });
  it('too long index names are refused with a clear message', () => {
    const long = {}; for (const n of ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc', 'dddddddddddddddd']) long[n] = field.text();
    const e = defineEntity(base({ fields: long, index: [Object.keys(long)] }));
    let err; try { e.ddl(); } catch (x) { err = x; }
    expect(err instanceof EntityDefinitionError).toBe(true);
  });
});

describe('defineEntities and registerFieldType', () => {
  it('names and tables are unique, refs must resolve', () => {
    const a = defineEntity(base()); const b = defineEntity(base({ name: 'room', table: 'rooms', fields: { a: field.ref('asset') } }));
    expect(defineEntities([a, b]).get('room')).toBe(b);
    let e; try { defineEntities([a, a]); } catch (x) { e = x; }
    expect(String(e.message)).toMatch(/duplicate/);
    const c = defineEntity(base({ name: 'x', table: 'xs', fields: { a: field.ref('ghost') } }));
    try { defineEntities([c]); e = null; } catch (x) { e = x; }
    expect(String(e.message)).toMatch(/unknown entity/);
    expect(defineEntities([defineEntity(base({ fields: { u: field.ref('users') } }))]).ddl().length).toBeGreaterThan(0);
  });
  it('an application type needs the same properties as the built-ins and works like them', () => {
    let e; try { registerFieldType('broken', { column: 'TEXT' }); } catch (x) { e = x; }
    expect(String(e.message)).toMatch(/validate/);
    registerFieldType('inventoryNo', { column: 'TEXT', validate: (v) => (/^\d{6}$/.test(v) ? { ok: true, value: v } : { ok: false, code: 'pattern' }), listable: true, sortable: true, filterable: true, searchable: true });
    const E = defineEntity(base({ fields: { inv: field.inventoryNo({ required: true }) } }));
    expect(E.validate({ inv: '123456' }).ok).toBe(true);
    expect(codes(E.validate({ inv: 'x' }))).toEqual(['inv:pattern']);
    try { registerFieldType('inventoryNo', {}); e = null; } catch (x) { e = x; }
    expect(e).toBeDefined();
  });
});

describe('reserved SQL words', () => {
  it('a field whose column would be a reserved word is refused at definition', () => {
    let err;
    try { defineEntity({ name: 'x', table: 'xs', idType: 'text', label: { ru: ['а', 'аа'], en: ['a', 'as'] }, permissions: { read: 'r', create: 'w', update: 'w', delete: 'd' }, fields: { order: field.int() } }); } catch (e) { err = e; }
    expect(String(err?.message)).toContain('reserved SQL word');
  });
});
