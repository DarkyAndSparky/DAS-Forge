import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { createSqliteAdapter } from '../src/database/index.js';
import { asyncDb } from '../src/database/async.js';
import { runMigrationsAsync, migrationStatusAsync } from '../src/cli/migrator.js';
import { log, archiveAndPurgeAsync, queryAsync, verifyChainAsync } from '../src/audit/index.js';

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'das-clias-'));
  const migrations = path.join(root, 'migrations');
  mkdirSync(migrations);
  const add = (n, body) => writeFileSync(path.join(migrations, `${String(n).padStart(3, '0')}_m${n}.js`), body);
  return { root, migrations, add };
}

describe('migrator over asyncDb', () => {
  it('applies pending migrations in order (sync and async up()) and reports status', async () => {
    const { migrations, add } = setup();
    const db = createSqliteAdapter({ file: ':memory:' });
    add(1, 'export function up(db) { db.exec("CREATE TABLE a (x INTEGER)"); }');
    add(2, 'export async function up(db) { await db.exec("CREATE TABLE b (x INTEGER)"); await db.run("INSERT INTO b VALUES (?)", [7]); }');
    const r = await runMigrationsAsync(db, migrations);
    expect(r.applied.map((m) => m.version)).toEqual([1, 2]);
    expect(db.get('SELECT x FROM b').x).toBe(7);
    expect((await runMigrationsAsync(db, migrations)).applied).toEqual([]);
    const st = await migrationStatusAsync(asyncDb(db), migrations);
    expect(st.map((m) => m.applied)).toEqual([true, true]);
  });
  it('a failing migration rolls back and stops; an edited applied one is refused', async () => {
    const { migrations, add } = setup();
    const db = createSqliteAdapter({ file: ':memory:' });
    add(1, 'export function up(db) { db.exec("CREATE TABLE a (x INTEGER)"); }');
    add(2, 'export async function up(db) { await db.exec("CREATE TABLE b (x INTEGER)"); throw new Error("boom"); }');
    await expect(runMigrationsAsync(db, migrations)).rejects.toThrow('boom');
    expect(db.all("SELECT name FROM sqlite_master WHERE name = 'b'")).toEqual([]);
    expect((await migrationStatusAsync(db, migrations)).map((m) => m.applied)).toEqual([true, false]);
    add(1, 'export function up(db) { db.exec("CREATE TABLE a (x INTEGER, y INTEGER)"); }');
    await expect(runMigrationsAsync(db, migrations)).rejects.toThrow(/modified after being applied/);
  });
  it('makes the copy before migrating (same file naming as the sync runner)', async () => {
    const { root, migrations, add } = setup();
    const dbFile = path.join(root, 'app.db');
    const db = createSqliteAdapter({ file: dbFile });
    add(1, 'export function up(db) { db.exec("CREATE TABLE a (x INTEGER)"); }');
    await runMigrationsAsync(db, migrations);
    add(2, 'export function up(db) { db.exec("CREATE TABLE b (x INTEGER)"); }');
    const events = [];
    const backups = path.join(root, 'pre');
    await runMigrationsAsync(db, migrations, { backupDir: backups, onBackup: (e) => events.push(e.status) });
    expect(events).toEqual(['made']);
    expect(readdirSync(backups).some((f) => /-v1\.db$/.test(f))).toBe(true);
  });
});

describe('audit archive and purge over asyncDb', () => {
  it('archives, checks, deletes and records itself; the chain stays valid', async () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    for (let i = 0; i < 5; i += 1) log(db, { actor: `u${i}`, action: 'auth.login' });
    const dir = mkdtempSync(path.join(os.tmpdir(), 'das-arch-'));
    const r = await archiveAndPurgeAsync(db, new Date(Date.now() + 60_000).toISOString(), { archiveDir: dir, actor: 'cli' });
    expect(r.removed).toBe(5);
    expect(r.archive.rows).toBe(5);
    const left = await queryAsync(db, { limit: 10 });
    expect(left.some((e) => e.action === 'audit.purge')).toBe(true);
    expect((await verifyChainAsync(db)).ok).toBe(true);
  });
});
