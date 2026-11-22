import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { createSqliteAdapter } from '../src/database/index.js';
import { createTenancy } from '../src/tenancy/index.js';
import { defineEntity, field, createEntityStore, zodSchemaOf, EntityValidationError } from '../src/entities/index.js';

const def = () => defineEntity({ name: 'asset', table: 'assets', idType: 'text', tenant: 'global', label: { ru: ['А', 'Аа'], en: ['A', 'As'] },
  permissions: { read: 'r', create: 'w', update: 'w', delete: 'd', restore: 'd' },
  fields: { title: field.text({ required: true, max: 20, min: 2 }), qty: field.int({ min: 0, max: 100 }), price: field.money({ nullable: true }), amount: field.decimal({ scale: 2, nullable: true }), active: field.bool({ default: true }),
    kind: field.enum(['laptop', 'router'], { nullable: true }), day: field.date({ nullable: true }), at: field.datetime({ nullable: true }), mac: field.mac({ nullable: true }), meta: field.json({ nullable: true }), pass: field.secret({ nullable: true }) },
  variants: { by: 'kind', cases: { router: { fields: { ip: field.ip({ required: true }) } }, laptop: { fields: { host: field.text() } } } } });

const reject = async (p) => { let e; try { await p; } catch (x) { e = x; } expect(e instanceof EntityValidationError, `expected EntityValidationError, got ${e?.name}: ${e?.message}`).toBe(true); return e; };

describe('validation in two places: the Zod gate and the descriptor', () => {
  let entity; let store; let scope; let calls;
  beforeEach(async () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    const ten = createTenancy(db, { newId: () => 't1' });
    await ten.ensure?.();
    scope = await ten.resolveScope({ userId: 'u', platformAdmin: true, permissionsOfRole: () => [] });
    entity = def(); calls = { validate: 0 };
    // count the descriptor's calls: the gate must reject before it is reached
    const counting = { ...entity, validate: (...a) => { calls.validate += 1; return entity.validate(...a); } };
    store = createEntityStore(db, counting, { newId: (() => { let n = 0; return () => `a${++n}`; })() }); await store.ensureTable();
  });

  it('the gate rejects crafted input before the descriptor is touched', async () => {
    const huge = 'x'.repeat(5_000_000);
    const t0 = Date.now();
    // abuse: oversized, unknown, absurd values. (An ordinary wrong type also fails the gate, but then the descriptor is asked too, to list every problem.)
    for (const bad of [{ title: huge }, { title: 'ok', zzz: 1 }, { title: 'ok', qty: 10 ** 20 }, { title: 'ok', day: 'x'.repeat(1000) }, { title: 'ok', pass: 'x'.repeat(5000) }, { title: huge, qty: '5', kind: 'plane' }]) {
      await reject(store.create(scope, bad));
    }
    expect(calls.validate).toBe(0);
    for (const bad of [{ title: 'ok', qty: '5' }, { title: 'ok', qty: 1.5 }, { title: { a: 1 } }, { title: 'ok', active: 'yes' }, { title: 'ok', kind: 'plane' }, { title: 'ok', mac: 'nope' }, { title: 'ok', pass: '' }]) await reject(store.create(scope, bad));
    expect(Date.now() - t0 < 2000, 'rejecting crafted bodies must be cheap').toBe(true);
  });
  it('10 000 unknown keys are rejected without reaching the descriptor', async () => {
    const body = { title: 'ok' }; for (let i = 0; i < 10_000; i += 1) body[`k${i}`] = 1;
    const e = await reject(store.create(scope, body));
    expect(e.errors.every((x) => x.code === 'unknown_field')).toBe(true);
    expect(calls.validate).toBe(0);
  });
  it('an ordinary mistake shows both layers\' findings together', async () => {
    const e = await reject(store.create(scope, { kind: 'router', ip: 'not an ip' }));
    const codes = e.errors.map((x) => `${x.path}:${x.code}`).sort();
    expect(codes).toEqual(['ip:type', 'title:required']);
    expect(calls.validate).toBe(1);
  });
  it('what only the descriptor knows still stops there (the second layer works on its own)', async () => {
    const e = await reject(store.create(scope, { title: 'ok', kind: 'router', ip: 'zzz' })); // the gate lets a text through, the descriptor refuses it
    expect(e.errors[0]).toMatchObject({ path: 'ip', code: 'type' });
    expect(calls.validate).toBe(1);
  });
  it('variants: a field of another kind, a missing required field of the kind, no kind on update', async () => {
    await reject(store.create(scope, { title: 'ok', kind: 'router', host: 'h', ip: '10.0.0.1' }));
    await reject(store.create(scope, { title: 'ok', kind: 'router' }));
    const r = await store.create(scope, { title: 'ok', kind: 'router', ip: '10.0.0.1' });
    expect((await store.update(scope, r.id, { ip: '10.0.0.2' })).attrs.ip).toBe('10.0.0.2'); // kind is taken from the record
    await reject(store.update(scope, r.id, { ip: 12 }));
    await reject(store.update(scope, r.id, { nothing: 1 }));
  });
  it('the gate is never stricter than the descriptor: whatever the descriptor accepts, the gate accepts (2000 random inputs)', () => {
    const schema = zodSchemaOf(z, entity, 'create');
    let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const pool = { title: ['ab', ' ab ', 'x'.repeat(20), 'x'.repeat(21), 'a', '', '  a  ', 5, null],
      qty: [0, 1, 100, 101, -1, 1.5, '3', null], price: [null, 0, 12345, -5, 1.5, '1'], amount: [null, '12.50', '12.555', 5, '-0.01', 'abc', 1.5],
      active: [true, false, 'true', 1], kind: [null, 'router', 'laptop', 'plane'], day: [null, '2026-02-28', '2026-02-30', '2026-13-01', 'x'],
      at: [null, '2026-11-20T08:00:00Z', '2026-11-20T08:00:00+05:00', '2026-11-20', 'x'], mac: [null, 'aa:bb:cc:dd:ee:ff', 'AA-BB-CC-DD-EE-FF', 'aa:bb', 'zz:bb:cc:dd:ee:ff'],
      meta: [null, { a: 1 }, [1, 2], 'text', 5], pass: [null, 'p', '', 'x'.repeat(1025)], ip: ['10.0.0.1', '::1', 'zzz', 5], host: ['h', '', 5] };
    let valid = 0;
    for (let i = 0; i < 2000; i += 1) {
      const input = {};
      for (const k of Object.keys(pool)) if (rnd() < 0.3) input[k] = rnd() < 0.7 ? pool[k][Math.floor(rnd() * 2)] : pick(pool[k]);
      const r = entity.validate(input, { mode: 'create' });
      if (r.ok) { valid += 1; const g = schema.safeParse(input); if (!g.success) throw new Error(`the gate refused what the descriptor accepts: ${JSON.stringify(input)} -> ${JSON.stringify(g.error.issues)}`); }
    }
    if (valid <= 100) throw new Error(`only ${valid} valid samples: the test is not exercising anything`);
  });
});
