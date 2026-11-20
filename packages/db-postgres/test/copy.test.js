import { describe, it, expect, afterAll } from 'vitest';
import { openTestDb, pgConfigured } from './support/pg-test-db.js';
import * as auth from '@das-forge/core/auth';
import { log, verifyChain, verifyChainAsync, ensureAuditTableAsync } from '@das-forge/core/audit';
import { createSqliteAdapter, copyDatabaseAsync } from '@das-forge/core/database';

function makeSource() {
  const src = createSqliteAdapter({ file: ':memory:' });
  auth.ensureAuthTables(src);
  const u = auth.createUser(src, { username: 'ann', passwordHash: 'h', role: 'admin' });
  auth.createUser(src, { username: 'bob', passwordHash: 'h', role: 'operator' });
  for (let i = 0; i < 5; i += 1) log(src, { actor: 'ann', action: 'auth.login', meta: { n: i } });
  src.exec('CREATE TABLE owners (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)');
  src.exec('CREATE TABLE things (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL REFERENCES owners(id), blob BLOB, title TEXT)');
  src.exec('CREATE INDEX things_owner ON things(owner_id)');
  src.run('INSERT INTO owners (name) VALUES (?)', ['Отдел ИТ']);
  for (let i = 0; i < 1200; i += 1) src.run('INSERT INTO things (owner_id, blob, title) VALUES (?, ?, ?)', [1, new Uint8Array([i % 256, 1, 2]), `вещь ${i}`]);
  return { src, u };
}

describe.skipIf(!pgConfigured)('copying SQLite into PostgreSQL', () => {
  let db;
  afterAll(async () => { await db?.close(); });

  it('copies users, the audit chain, a table with a foreign key and binary data; identities continue; counts agree', async () => {
    const { src } = makeSource();
    expect(verifyChain(src).ok).toBe(true);
    db = await openTestDb();
    await auth.ensureAuthTablesAsync(db); // the audit table and its append-only trigger come from the application
    await ensureAuditTableAsync(db);

    const dry = await copyDatabaseAsync(src, db, { dryRun: true });
    expect(dry.ok).toBe(true);
    expect(Number((await db.get('SELECT COUNT(*) AS n FROM users')).n)).toBe(0);

    const seen = [];
    const report = await copyDatabaseAsync(src, db, { batchSize: 400, onProgress: (e) => seen.push(e) });
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    const by = Object.fromEntries(report.tables.map((t) => [t.name, t]));
    expect(by.users.rows).toBe(2);
    expect(by.things.copied).toBe(1200);
    expect(by.things.created).toBe(true); // this table did not exist on the target: created from the source definition
    expect(report.tables.findIndex((t) => t.name === 'owners')).toBeLessThan(report.tables.findIndex((t) => t.name === 'things'));
    expect(seen.length).toBeGreaterThan(3);

    expect((await verifyChainAsync(db)).ok).toBe(true); // the journal's hashes survive the move
    const blob = await db.get('SELECT blob FROM things WHERE id = ?', [258]);
    expect([...blob.blob]).toEqual([(257) % 256, 1, 2]);
    expect((await db.get('SELECT title FROM things WHERE id = 1200')).title).toBe('вещь 1199');

    // identities go on after the copied ids
    const next = await db.run('INSERT INTO things (owner_id, title) VALUES (?, ?)', [1, 'новая']);
    expect(Number(next.lastInsertRowid)).toBe(1201);
    const created = await auth.createUserAsync(db, { username: 'carl', passwordHash: 'h' });
    expect(created.id).toBe(3);
    expect((await verifyChainAsync(db)).ok).toBe(true);
  });

  it('refuses a target that already has data and one that lacks a column; nothing is written then', async () => {
    const { src } = makeSource();
    const again = await copyDatabaseAsync(src, db);
    expect(again.ok).toBe(false);
    expect(again.problems.join('\n')).toMatch(/not empty/);

    const fresh = await openTestDb();
    db = fresh;
    await fresh.exec('CREATE TABLE owners (id BIGINT PRIMARY KEY)'); // no `name`
    const r = await copyDatabaseAsync(src, fresh, { tables: ['owners'] });
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/no column name/);
    expect(Number((await fresh.get('SELECT COUNT(*) AS n FROM owners')).n)).toBe(0);
  });

  it('wants the synchronous SQLite adapter as the source', async () => {
    db ??= await openTestDb();
    await expect(copyDatabaseAsync(db, db)).rejects.toThrow(/synchronous SQLite/);
  });
});
