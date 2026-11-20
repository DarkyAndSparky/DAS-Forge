import { describe, it, expect, afterAll } from 'vitest';
import { openTestDb, pgConfigured } from './support/pg-test-db.js';
import { mapError, connectionEnv } from '../src/index.js';

describe('pure helpers', () => {
  it('gives constraint errors the SQLite wording the core looks for', () => {
    const e = mapError(Object.assign(new Error('duplicate key'), { code: '23505', table: 'users', detail: 'Key (username)=(ann) already exists.' }));
    expect(e.message).toBe('UNIQUE constraint failed: users.username');
    expect(e.code).toBe('23505');
    expect(mapError(Object.assign(new Error('x'), { code: '23503' })).message).toMatch(/^FOREIGN KEY constraint failed/);
    const plain = new Error('syntax');
    expect(mapError(plain)).toBe(plain);
  });
  it('turns a connection URL into the PG* variables of the client tools', () => {
    expect(connectionEnv('postgres://app:p%40ss@db.example:6543/forge?sslmode=require')).toEqual({
      PGHOST: 'db.example', PGPORT: '6543', PGUSER: 'app', PGPASSWORD: 'p@ss', PGDATABASE: 'forge', PGSSLMODE: 'require',
    });
  });
});

describe.skipIf(!pgConfigured)('driver against a PostgreSQL server', () => {
  let db;
  const ready = async () => { db ??= await openTestDb(); return db; };
  afterAll(async () => { await db?.close(); });

  it('runs translated SQL: placeholders, identity, timestamp default, lastInsertRowid, bigint as number', async () => {
    const d = await ready();
    await d.exec("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, at TEXT DEFAULT (datetime('now')))");
    const r = await d.run('INSERT INTO t (name) VALUES (?)', ['a']);
    expect(r).toEqual({ changes: 1, lastInsertRowid: 1 });
    expect((await d.run('INSERT INTO t (name) VALUES (?)', ['b'])).lastInsertRowid).toBe(2);
    expect((await d.run('INSERT OR IGNORE INTO t (name) VALUES (?)', ['b'])).changes).toBe(0);
    expect(await d.get('SELECT COUNT(*) AS n FROM t')).toEqual({ n: 2 });
    expect((await d.get('SELECT at FROM t WHERE id = ?', [1])).at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    expect(await d.get('SELECT * FROM t WHERE id = ?', [99])).toBeUndefined();
    expect((await d.run('UPDATE t SET name = ? WHERE id = ?', ['a2', 1])).changes).toBe(1);
    await expect(d.run('INSERT INTO t (name) VALUES (?)', ['a2'])).rejects.toThrow(/UNIQUE constraint failed: t\.name/);
  });
  it('rolls back a transaction, keeps the work of a savepoint that succeeded, drops the one that failed', async () => {
    const d = await ready();
    await d.exec('CREATE TABLE tx (v TEXT)');
    await d.transaction(async (tx) => {
      await tx.run('INSERT INTO tx VALUES (?)', ['one']);
      await tx.transaction((t2) => t2.run('INSERT INTO tx VALUES (?)', ['two']));
      await tx.transaction(async (t3) => { await t3.run('INSERT INTO tx VALUES (?)', ['three']); throw new Error('no'); }).catch(() => {});
    });
    await d.transaction(async (tx) => { await tx.run('INSERT INTO tx VALUES (?)', ['four']); throw new Error('boom'); }).catch(() => {});
    expect((await d.all('SELECT v FROM tx ORDER BY v')).map((r) => r.v)).toEqual(['one', 'two']);
    await expect(d.transaction(() => 1, { mode: 'weird' })).rejects.toThrow(/unknown mode/);
  });
  it('immediate transactions run one after another (read, decide, write stays safe)', async () => {
    const d = await ready();
    await d.exec('CREATE TABLE counter (n INTEGER NOT NULL)');
    await d.run('INSERT INTO counter VALUES (?)', [0]);
    const bump = () => d.transaction(async (tx) => {
      const { n } = await tx.get('SELECT n FROM counter');
      await new Promise((resolve) => setTimeout(resolve, 5));
      await tx.run('UPDATE counter SET n = ?', [n + 1]);
    }, { mode: 'immediate' });
    await Promise.all(Array.from({ length: 8 }, bump));
    expect((await d.get('SELECT n FROM counter')).n).toBe(8);
  });
  it('answers ping and refuses a snapshot without a connection string', async () => {
    const d = await ready();
    expect(await d.ping()).toBe(true);
    await expect(d.snapshotToAsync('/tmp/x.dump')).rejects.toThrow(/connectionString/);
  });
});
