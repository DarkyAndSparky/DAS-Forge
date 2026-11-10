import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, existsSync, readFileSync } from 'node:fs';

import { createSqliteAdapter } from '../src/database/index.js';
import { createBackupJob, restoreBackup, listBackups } from '../src/scheduler/index.js';
import { parseBackupTimestamp } from '../src/scheduler/backup-job.js';
import { openBackupArchive, extractBackupDatabase } from '../src/scheduler/backup-archive.js';
import { runMigrations, migrationStatus } from '../src/cli/migrator.js';

/**
 * Audit wave 2a: B01-B07 (backup via snapshot, per-destination isolation,
 * retention floor, atomic restore with rollback, nested transactions,
 * pragmas, migration checksums/ordering).
 */

let root;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'das-durability-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('transaction() (B06)', () => {
  let db;
  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
    db.exec('CREATE TABLE t (v TEXT)');
  });
  afterEach(() => db.close());

  const count = () => db.get('SELECT COUNT(*) AS n FROM t').n;

  it('commits on success and rolls back on throw', () => {
    db.transaction((tx) => tx.run('INSERT INTO t VALUES (?)', ['a']));
    expect(count()).toBe(1);
    expect(() =>
      db.transaction((tx) => {
        tx.run('INSERT INTO t VALUES (?)', ['b']);
        throw new Error('boom');
      })
    ).toThrow(/boom/);
    expect(count()).toBe(1);
  });

  it('nested calls work, and an inner failure caught by the outer keeps the outer work', () => {
    db.transaction((tx) => {
      tx.run('INSERT INTO t VALUES (?)', ['outer']);
      expect(() =>
        tx.transaction((inner) => {
          inner.run('INSERT INTO t VALUES (?)', ['inner']);
          throw new Error('inner fail');
        })
      ).toThrow(/inner fail/);
    });
    expect(db.all('SELECT v FROM t').map((r) => r.v)).toEqual(['outer']);
  });

  it('an inner failure that propagates rolls back everything', () => {
    expect(() =>
      db.transaction((tx) => {
        tx.run('INSERT INTO t VALUES (?)', ['outer']);
        tx.transaction(() => {
          throw new Error('inner fail');
        });
      })
    ).toThrow(/inner fail/);
    expect(count()).toBe(0);
  });

  it('rejects an async fn (and rolls back) instead of committing early', () => {
    expect(() =>
      db.transaction(async (tx) => {
        tx.run('INSERT INTO t VALUES (?)', ['x']);
      })
    ).toThrow(/returned a Promise/);
    expect(count()).toBe(0);
    // connection is usable afterwards (no dangling open transaction)
    db.transaction((tx) => tx.run('INSERT INTO t VALUES (?)', ['y']));
    expect(count()).toBe(1);
  });

  it('a failing ROLLBACK does not mask the original error', () => {
    expect(() =>
      db.transaction((tx) => {
        tx.exec('ROLLBACK'); // fn itself ends the transaction -> our ROLLBACK will fail
        throw new Error('original');
      })
    ).toThrow(/original/);
  });

  it("supports mode 'immediate' and rejects unknown modes", () => {
    expect(() => db.transaction(() => {}, { mode: 'immediate' })).not.toThrow();
    expect(() => db.transaction(() => {}, { mode: 'bogus' })).toThrow(/unknown mode/);
  });
});

describe('connection pragmas (B07)', () => {
  it('sets busy_timeout, WAL and synchronous=NORMAL on a file database', () => {
    const db = createSqliteAdapter({ file: path.join(root, 'p.db') });
    expect(Object.values(db.get('PRAGMA busy_timeout'))[0]).toBe(5000);
    expect(Object.values(db.get('PRAGMA journal_mode'))[0]).toBe('wal');
    expect(Object.values(db.get('PRAGMA synchronous'))[0]).toBe(1); // NORMAL
    db.close();
  });

  it('opens read-only files without trying to change the journal mode', () => {
    const file = path.join(root, 'ro.db');
    createSqliteAdapter({ file }).close();
    const ro = createSqliteAdapter({ file, readonly: true, walMode: true });
    expect(ro.get('SELECT 1 AS x').x).toBe(1);
    ro.close();
  });
});

describe('createBackupJob (B01-B03)', () => {
  let db, dbPath, dest;
  beforeEach(() => {
    dbPath = path.join(root, 'live', 'app.db');
    dest = path.join(root, 'backups');
    db = createSqliteAdapter({ file: dbPath });
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    db.run('INSERT INTO t (v) VALUES (?)', ['committed-in-wal']);
  });
  afterEach(() => db.close());

  const job = (extra = {}) =>
    createBackupJob({ db, destinations: [{ id: 'l', type: 'local', path: dest }], retentionDays: 30, ...extra });

  it('includes data that is still only in the WAL, and leaves no .tmp behind', async () => {
    const [r] = await job()();
    expect(r.ok).toBe(true);
    expect(readdirSync(dest).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    const copyFile = path.join(root, 'extracted-copy.db');
    const opened = await openBackupArchive(r.backupPath);
    await extractBackupDatabase(opened, copyFile);
    await opened.close();
    const copy = createSqliteAdapter({ file: copyFile, readonly: true, walMode: false });
    expect(copy.get('SELECT v FROM t').v).toBe('committed-in-wal');
    copy.close();
  });

  it('one failing destination does not stop the others, and the job still reports failure', async () => {
    const run = createBackupJob({
      db,
      retentionDays: 30,
      destinations: [
        { id: 's3', type: 's3', config: {} },
        { id: 'l', type: 'local', path: dest },
      ],
    });
    const err = await run().catch((e) => e);
    expect(err.message).toMatch(/s3.*not implemented/);
    expect(err.results.map((r) => [r.destinationId, r.ok])).toEqual([['s3', false], ['l', true]]);
    expect(readdirSync(dest).filter((f) => f.endsWith('.zip'))).toHaveLength(1);
  });

  it('never leaves a backup-*.zip (or a staging file) when the snapshot itself fails', async () => {
    const broken = { ...db, snapshotTo: () => { throw new Error('disk full'); }, snapshotToAsync: () => Promise.reject(new Error('disk full')) };
    const run = createBackupJob({ db: broken, retentionDays: 30, destinations: [{ id: 'l', type: 'local', path: dest }] });
    await expect(run()).rejects.toThrow(/disk full/);
    expect(readdirSync(dest).filter((f) => f.startsWith('backup-'))).toEqual([]);
  });

  it('validates retentionDays and minKeep', () => {
    expect(() => job({ retentionDays: 0 })).toThrow(/must be an integer >= 1/);
    expect(() => job({ retentionDays: -3 })).toThrow(/must be an integer >= 1/);
    expect(() => job({ minKeep: 0 })).toThrow(/must be an integer >= 1/);
  });

  it('keeps the newest minKeep copies even when ALL are older than retention', async () => {
    const old = (daysAgo) => {
      const d = new Date(Date.now() - daysAgo * 86_400_000).toISOString().replace(/[:.]/g, '-');
      const f = path.join(dest, `backup-${d}.zip`);
      writeFileSync(f, 'x');
      return f;
    };
    mkdirSync(dest, { recursive: true });
    const files = [old(200), old(150), old(120), old(90), old(60)];
    const [r] = await job({ minKeep: 3 })(); // + the new one => 6 files
    // new + 2 newest old ones survive; 3 oldest are pruned
    expect(r.prunedCount).toBe(3);
    expect(existsSync(files[4])).toBe(true);
    expect(existsSync(files[3])).toBe(true);
    expect(existsSync(files[0])).toBe(false);
  });

  it('takes age from the file NAME, not mtime (a re-copied old backup is still old)', async () => {
    mkdirSync(dest, { recursive: true });
    const d = new Date(Date.now() - 90 * 86_400_000).toISOString().replace(/[:.]/g, '-');
    const f = path.join(dest, `backup-${d}.zip`);
    writeFileSync(f, 'x'); // mtime = now
    const [r] = await job({ minKeep: 1 })();
    expect(r.prunedCount).toBe(1);
    expect(existsSync(f)).toBe(false);
  });

  it('parseBackupTimestamp round-trips the job naming and rejects foreign names', () => {
    const iso = '2026-10-14T00:19:03.123Z';
    expect(parseBackupTimestamp(`backup-${iso.replace(/[:.]/g, '-')}.zip`)).toBe(Date.parse(iso));
    expect(parseBackupTimestamp('backup-old.zip')).toBeNull();
  });

  it('listBackups ignores .tmp leftovers', async () => {
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, 'backup-2026-01-01T00-00-00-000Z.zip.tmp'), 'partial');
    await job()();
    expect(listBackups([{ id: 'l', type: 'local', path: dest }])).toHaveLength(1);
  });
});

describe('restoreBackup (B04)', () => {
  let dbPath, backupPath;

  function seedLive(value) {
    const db = createSqliteAdapter({ file: dbPath });
    db.exec('CREATE TABLE IF NOT EXISTS t (v TEXT)');
    db.run('INSERT INTO t VALUES (?)', [value]);
    return db;
  }

  beforeEach(async () => {
    dbPath = path.join(root, 'app.db');
    const db = seedLive('from-backup');
    const [r] = await createBackupJob({
      db,
      retentionDays: 30,
      destinations: [{ id: 'l', type: 'local', path: path.join(root, 'bk') }],
    })();
    backupPath = r.backupPath;
    db.run('DELETE FROM t');
    db.run('INSERT INTO t VALUES (?)', ['live-after-backup']); // un-checkpointed WAL content
    db.close();
  });

  it('restores the backup, keeps a consistent safety copy, leaves no staging files', async () => {
    const result = await restoreBackup({ dbFilePath: dbPath, backupFilePath: backupPath, createAdapterFn: createSqliteAdapter });
    expect(result.ok).toBe(true);
    expect(result.db.get('SELECT v FROM t').v).toBe('from-backup');
    result.db.close();

    const safety = createSqliteAdapter({ file: result.preRestorePath, readonly: true, walMode: false });
    expect(safety.get('SELECT v FROM t').v).toBe('live-after-backup');
    safety.close();
    expect(readdirSync(root).filter((f) => f.endsWith('.restore-tmp') || f.endsWith('.rollback-tmp'))).toEqual([]);
  });

  it('a stale -wal next to the live file is NOT replayed onto the restored database', async () => {
    writeFileSync(dbPath + '-wal', Buffer.from('garbage that is not a real WAL'));
    writeFileSync(dbPath + '-shm', Buffer.from('garbage'));
    const result = await restoreBackup({ dbFilePath: dbPath, backupFilePath: backupPath, createAdapterFn: createSqliteAdapter });
    expect(result.ok).toBe(true);
    expect(result.db.get('SELECT v FROM t').v).toBe('from-backup');
    result.db.close();
  });

  it('refuses a corrupt backup before touching the live database', async () => {
    const bad = path.join(root, 'bad.zip');
    writeFileSync(bad, 'this is not a zip archive at all, just text padding.......................');
    const before = readFileSync(dbPath);
    const result = await restoreBackup({ dbFilePath: dbPath, backupFilePath: bad, createAdapterFn: createSqliteAdapter });
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1).name).toBe('Verify backup');
    expect(readFileSync(dbPath).equals(before)).toBe(true);
  });

  it('rolls back to the pre-restore copy when the restored database fails the health check', async () => {
    // wrap createAdapterFn so the connection to the restored file fails its first SELECT 1
    let reopened = 0;
    const flaky = (opts) => {
      const real = createSqliteAdapter(opts);
      if (opts.readonly) return real;
      reopened++;
      return { ...real, get: (sql, p) => { if (/SELECT 1 AS ok/.test(sql)) throw new Error('dead'); return real.get(sql, p); } };
    };
    const result = await restoreBackup({ dbFilePath: dbPath, backupFilePath: backupPath, createAdapterFn: flaky });
    expect(result.ok).toBe(false);
    expect(result.steps.find((s) => s.name === 'Rollback')?.ok).toBe(true);
    expect(reopened).toBe(1);
    const back = createSqliteAdapter({ file: dbPath });
    expect(back.get('SELECT v FROM t').v).toBe('live-after-backup');
    back.close();
  });
});

describe('migrator (B05)', () => {
  let dir, db;
  const write = (name, body) => writeFileSync(path.join(dir, name), body);
  const mig = (table) => `export function up(db) { db.exec('CREATE TABLE ${table} (id INTEGER)'); }\n`;

  beforeEach(() => {
    dir = path.join(root, 'migrations');
    mkdirSync(dir, { recursive: true });
    db = createSqliteAdapter({ file: ':memory:' });
  });
  afterEach(() => db.close());

  it('records a checksum and refuses to continue after an applied file is edited', async () => {
    write('001_a.js', mig('a'));
    await runMigrations(db, dir);
    expect(db.get('SELECT checksum FROM schema_migrations WHERE version = 1').checksum).toMatch(/^[0-9a-f]{64}$/);

    write('001_a.js', mig('a') + '// sneaky edit\n');
    expect(migrationStatus(db, dir)[0].modified).toBe(true);
    await expect(runMigrations(db, dir)).rejects.toThrow(/modified after being applied/);
  });

  it('CRLF vs LF checkouts produce the same checksum', async () => {
    write('001_a.js', mig('a'));
    await runMigrations(db, dir);
    write('001_a.js', mig('a').replace(/\n/g, '\r\n'));
    expect(await runMigrations(db, dir)).toEqual({ applied: [] });
  });

  it('backfills checksums for databases created before they existed', async () => {
    db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    db.exec(`CREATE TABLE a (id INTEGER)`);
    db.run('INSERT INTO schema_migrations (version, name) VALUES (1, ?)', ['001_a.js']);
    write('001_a.js', mig('a'));
    await runMigrations(db, dir);
    expect(db.get('SELECT checksum FROM schema_migrations WHERE version = 1').checksum).toBeTruthy();
  });

  it('rejects duplicate version numbers', async () => {
    write('001_a.js', mig('a'));
    write('001_b.js', mig('b'));
    await expect(runMigrations(db, dir)).rejects.toThrow(/Duplicate migration version 1/);
  });

  it('rejects a pending migration numbered below an applied one', async () => {
    write('002_b.js', mig('b'));
    await runMigrations(db, dir);
    write('001_a.js', mig('a'));
    await expect(runMigrations(db, dir)).rejects.toThrow(/pending but a later version/);
  });

  it('an async up() is rejected and nothing is recorded as applied', async () => {
    write('001_a.js', `export async function up(db) { db.exec('CREATE TABLE a (id INTEGER)'); }\n`);
    await expect(runMigrations(db, dir)).rejects.toThrow(/returned a Promise/);
    expect(db.get('SELECT COUNT(*) AS n FROM schema_migrations').n).toBe(0);
    expect(db.get(`SELECT name FROM sqlite_master WHERE name = 'a'`)).toBeUndefined();
  });

  it('a failing migration rolls back its own DDL and is not recorded', async () => {
    write('001_a.js', `export function up(db) { db.exec('CREATE TABLE a (id INTEGER)'); throw new Error('half done'); }\n`);
    await expect(runMigrations(db, dir)).rejects.toThrow(/half done/);
    expect(db.get(`SELECT name FROM sqlite_master WHERE name = 'a'`)).toBeUndefined();
  });
});
