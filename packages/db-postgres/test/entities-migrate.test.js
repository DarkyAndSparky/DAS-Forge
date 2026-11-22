import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTestDb, pgConfigured } from './support/pg-test-db.js';
import { defineEntity, field, planEntitySync, applyEntitySync } from '@das-forge/core/entities';

const mk = (fields, extra = {}) => defineEntity({ name: 'asset', table: 'assets', idType: 'text', label: { ru: ['А', 'Аа'], en: ['A', 'As'] }, permissions: { read: 'r', create: 'w', update: 'w', delete: 'd' }, tenant: 'global', fields, ...extra });

describe.skipIf(!pgConfigured)('PG: table sync from the descriptor', () => {
  let db;
  beforeEach(async () => { if (pgConfigured) db = await openTestDb(); });
  afterEach(async () => { await db?.close(); });

  it('creates a missing table, then has nothing more to do', async () => {
    const e = mk({ title: field.text({ required: true }) });
    const plan = await planEntitySync(db, [e]);
    expect(plan.created).toEqual(['asset']);
    expect(await applyEntitySync(db, plan)).toBeGreaterThan(0);
    const again = await planEntitySync(db, [e]);
    expect(again.statements).toEqual([]);
    expect(again.warnings).toEqual([]);
  });
  it('adds a new column and a new index, never drops anything', async () => {
    await applyEntitySync(db, await planEntitySync(db, [mk({ title: field.text({ required: true }), old: field.text({ nullable: true }) })]));
    const e2 = mk({ title: field.text({ required: true }), serial: field.text({ nullable: true }) }, { unique: [['serial']] });
    const plan = await planEntitySync(db, [e2]);
    expect(plan.statements.some((s) => s.startsWith('ALTER TABLE assets ADD COLUMN serial'))).toBe(true);
    expect(plan.statements.some((s) => s.includes('CREATE UNIQUE INDEX'))).toBe(true);
    expect(plan.warnings.map((w) => `${w.code}:${w.column}`)).toEqual(['column_not_in_descriptor:old']);
    await applyEntitySync(db, plan);
    const cols = (await db.all('SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?', ['assets'])).map((c) => c.name);
    expect(cols.includes('old')).toBe(true);
    expect(cols.includes('serial')).toBe(true);
    expect((await planEntitySync(db, [e2])).statements).toEqual([]);
  });
  it('a required field added to a table with rows is added nullable, with a warning', async () => {
    await applyEntitySync(db, await planEntitySync(db, [mk({ title: field.text({ required: true }) })]));
    await db.run("INSERT INTO assets (id, title, created_at, updated_at) VALUES ('1','x','t','t')");
    const plan = await planEntitySync(db, [mk({ title: field.text({ required: true }), owner: field.text({ required: true }) })]);
    expect(plan.warnings[0].code).toBe('required_added_nullable');
    await applyEntitySync(db, plan);
    expect((await db.get('SELECT COUNT(*) AS n FROM assets')).n).toBe(1);
  });
  it('warns about a column of another kind and leaves it', async () => {
    await db.exec('CREATE TABLE assets (id TEXT PRIMARY KEY, title INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1)');
    const plan = await planEntitySync(db, [mk({ title: field.text({ required: true }) })]);
    expect(plan.warnings.map((w) => w.code)).toEqual(['type_differs']);
    expect(plan.statements).toEqual([]);
  });
  it('a failing statement rolls the whole plan back', async () => {
    await applyEntitySync(db, await planEntitySync(db, [mk({ title: field.text({ required: true }) })]));
    let failed = false;
    try { await applyEntitySync(db, { statements: ['ALTER TABLE assets ADD COLUMN a1 TEXT', 'ALTER TABLE nope ADD COLUMN x TEXT'] }); } catch { failed = true; }
    expect(failed).toBe(true);
    expect((await db.all('SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?', ['assets'])).some((c) => c.name === 'a1')).toBe(false);
  });
});
