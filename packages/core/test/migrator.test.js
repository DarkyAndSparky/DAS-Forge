import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { createSqliteAdapter } from '../src/database/index.js';
import { runMigrations } from '../src/cli/migrator.js';

let root;
let dbFile;
let migrations;
let backups;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'das-premig-'));
  dbFile = path.join(root, 'app.db');
  migrations = path.join(root, 'migrations');
  backups = path.join(root, 'pre-migrate');
  mkdirSync(migrations);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const addMigration = (n, sql) => writeFileSync(path.join(migrations, `${String(n).padStart(3, '0')}_m${n}.js`), `export function up(db) { db.exec(${JSON.stringify(sql)}); }\n`);
const copies = () => readdirSync(backups).filter((f) => f.startsWith('pre-migrate-'));

describe('copy of the database before migrating (R-05)', () => {
  it('makes a copy holding the OLD schema before the first pending migration runs', async () => {
    const db = createSqliteAdapter({ file: dbFile });
    addMigration(1, 'CREATE TABLE a (x INTEGER)');
    await runMigrations(db, migrations); // first one, nothing to copy yet is fine either way
    addMigration(2, 'CREATE TABLE b (x INTEGER)');
    const events = [];
    const r = await runMigrations(db, migrations, { backupDir: backups, onBackup: (e) => events.push(e.status) });
    expect(r.applied.length).toBe(1);
    expect(events).toEqual(['made']);
    const file = copies().at(-1);
    expect(file).toMatch(/-v1\.db$/);
    const copy = createSqliteAdapter({ file: path.join(backups, file) });
    expect(copy.all("SELECT name FROM sqlite_master WHERE name IN ('a','b')").map((x) => x.name)).toEqual(['a']);
    copy.close?.();
    db.close?.();
  });

  it('makes no copy when nothing is pending', async () => {
    const db = createSqliteAdapter({ file: dbFile });
    addMigration(1, 'CREATE TABLE a (x INTEGER)');
    await runMigrations(db, migrations, { backupDir: backups });
    const before = readdirSync(root).includes('pre-migrate') ? copies().length : 0;
    const r = await runMigrations(db, migrations, { backupDir: backups });
    expect(r.backup).toBe(undefined);
    expect((readdirSync(root).includes('pre-migrate') ? copies().length : 0)).toBe(before);
    db.close?.();
  });

  it('a failing copy stops the migration: nothing is applied', async () => {
    const db = createSqliteAdapter({ file: dbFile });
    addMigration(1, 'CREATE TABLE a (x INTEGER)');
    writeFileSync(path.join(root, 'blocker'), 'a file where the directory should be');
    const events = [];
    await expect(runMigrations(db, migrations, { backupDir: path.join(root, 'blocker', 'x'), onBackup: (e) => events.push(e.status) })).rejects.toThrow(/Pre-migration backup failed/);
    expect(events).toEqual(['failed']);
    expect(db.all("SELECT name FROM sqlite_master WHERE name = 'a'").length).toBe(0);
    db.close?.();
  });

  it('skipBackup is explicit, reported, and migrates', async () => {
    const db = createSqliteAdapter({ file: dbFile });
    addMigration(1, 'CREATE TABLE a (x INTEGER)');
    const events = [];
    const r = await runMigrations(db, migrations, { backupDir: backups, skipBackup: true, onBackup: (e) => events.push(e.status) });
    expect(events).toEqual(['skipped']);
    expect(r.applied.length).toBe(1);
    expect(readdirSync(root).includes('pre-migrate')).toBe(false);
    db.close?.();
  });

  it('keeps only the newest `keep` copies', async () => {
    const db = createSqliteAdapter({ file: dbFile });
    for (let n = 1; n <= 4; n++) {
      addMigration(n, `CREATE TABLE t${n} (x INTEGER)`);
      await runMigrations(db, migrations, { backupDir: backups, keep: 2 });
      await new Promise((res) => setTimeout(res, 15));
    }
    expect(copies().length).toBe(2);
    db.close?.();
  });
});
