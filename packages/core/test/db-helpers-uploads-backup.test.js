import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSqliteAdapter, upsert, addColumnIfMissing } from '../src/database/index.js';
import { crc32 } from 'node:zlib';
import { createBackupJob } from '../src/scheduler/backup-job.js';
import { restoreBackup, verifyBackupFile } from '../src/scheduler/backup-ops.js';
import { openBackupArchive } from '../src/scheduler/backup-archive.js';

describe('database helpers (B17)', () => {
  it('upsert inserts then updates; DO NOTHING when no update columns; rejects bad identifiers', () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    db.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT, n INTEGER)');
    upsert(db, 'kv', { k: 'a', v: '1', n: 1 }, ['k']);
    upsert(db, 'kv', { k: 'a', v: '2', n: 2 }, ['k']);
    expect(db.get('SELECT v, n FROM kv WHERE k = ?', ['a'])).toEqual({ v: '2', n: 2 });
    upsert(db, 'kv', { k: 'a', v: '3' }, ['k'], { updateColumns: ['n'] });
    expect(db.get('SELECT v FROM kv WHERE k = ?', ['a']).v).toBe('2');
    upsert(db, 'kv', { k: 'a' }, ['k']);
    expect(() => upsert(db, 'kv; DROP TABLE kv', { k: 'x' }, ['k'])).toThrow();
  });
  it('addColumnIfMissing is idempotent', () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    db.exec('CREATE TABLE t (id INTEGER)');
    expect(addColumnIfMissing(db, 't', 'note', "TEXT NOT NULL DEFAULT ''")).toBe(true);
    expect(addColumnIfMissing(db, 't', 'note', 'TEXT')).toBe(false);
  });
});

describe('uploads travel inside the single backup zip (B17)', () => {
  it('packs uploads into the zip, restores them, keeps the old ones aside', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
    const dbf = path.join(root, 'app.db');
    const up = path.join(root, 'uploads');
    const dest = path.join(root, 'bk');
    fs.mkdirSync(path.join(up, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(up, 'sub', 'a.txt'), 'v1');
    let db = createSqliteAdapter({ file: dbf });
    db.exec('CREATE TABLE t (x)');
    db.run('INSERT INTO t VALUES (1)');
    const job = createBackupJob({ db, destinations: [{ id: 'l', type: 'local', path: dest }], retentionDays: 1, minKeep: 1, uploadsDir: up });
    const [r] = await job();
    expect(r.uploadsIncluded).toBe(true);
    // one file per backup: no sidecar uploads-<ts> directory, no staging leftovers
    expect(fs.readdirSync(dest)).toEqual([path.basename(r.backupPath)]);
    expect(r.backupPath.endsWith('.zip')).toBe(true);
    const opened = await openBackupArchive(r.backupPath);
    expect(opened.manifest).toMatchObject({ format: 1, uploads: true });
    expect(opened.entries.map((e) => e.fileName)).toEqual(expect.arrayContaining(['database.db', 'manifest.json', 'uploads/sub/a.txt']));
    await opened.close();

    fs.writeFileSync(path.join(up, 'sub', 'a.txt'), 'v2');
    fs.writeFileSync(path.join(up, 'new.txt'), 'n');
    db.close();
    const res = await restoreBackup({ dbFilePath: dbf, backupFilePath: r.backupPath, createAdapterFn: createSqliteAdapter, uploadsDir: up });
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(path.join(up, 'sub', 'a.txt'), 'utf8')).toBe('v1');
    expect(fs.existsSync(path.join(up, 'new.txt'))).toBe(false);
    expect(fs.readdirSync(root).some((e) => e.startsWith('uploads.pre-restore-'))).toBe(true);
    res.db.close();

    db = createSqliteAdapter({ file: dbf });
    const [none] = await createBackupJob({ db, destinations: [{ id: 'l', type: 'local', path: dest }], retentionDays: 1, minKeep: 1, uploadsDir: path.join(root, 'nope') })();
    expect(none.uploadsIncluded).toBe(false);
    const noneOpened = await openBackupArchive(none.backupPath);
    expect(noneOpened.manifest.uploads).toBe(false);
    await noneOpened.close();
    db.close();
  });

  it('restoring a backup made without uploads leaves the live uploads alone', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
    const dbf = path.join(root, 'app.db');
    const up = path.join(root, 'uploads');
    const db = createSqliteAdapter({ file: dbf });
    db.exec('CREATE TABLE t (x)');
    const [r] = await createBackupJob({ db, destinations: [{ id: 'l', type: 'local', path: path.join(root, 'bk') }], retentionDays: 1 })();
    db.close();
    fs.mkdirSync(up);
    fs.writeFileSync(path.join(up, 'keep.txt'), 'k');
    const res = await restoreBackup({ dbFilePath: dbf, backupFilePath: r.backupPath, createAdapterFn: createSqliteAdapter, uploadsDir: up });
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(path.join(up, 'keep.txt'), 'utf8')).toBe('k');
    res.db.close();
  });
});

/** Minimal STORED-only zip writer, so a test can craft archives AdmZip would refuse to write. */
function craftZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(content);
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

describe('backup archive hardening', () => {
  const manifest = JSON.stringify({ format: 1, createdAt: new Date().toISOString(), uploads: true });
  let root;
  let dbPath;
  const make = (files) => {
    const f = path.join(root, `crafted-${Math.random().toString(16).slice(2)}.zip`);
    fs.writeFileSync(f, craftZip(files));
    return f;
  };

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bkh-'));
    dbPath = path.join(root, 'app.db');
    const db = createSqliteAdapter({ file: dbPath });
    db.exec('CREATE TABLE t (x)');
    db.close();
  });

  it('verify rejects an archive with a path-traversal entry, and restore never writes outside the uploads dir', async () => {
    const evil = make({ 'manifest.json': manifest, 'database.db': 'x', 'uploads/../../evil.txt': 'pwn' });
    const v = await verifyBackupFile(createSqliteAdapter, evil);
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/unsafe entry name|unexpected entry|invalid relative path/);
    const res = await restoreBackup({ dbFilePath: dbPath, backupFilePath: evil, createAdapterFn: createSqliteAdapter, uploadsDir: path.join(root, 'uploads') });
    expect(res.ok).toBe(false);
    expect(fs.existsSync(path.join(root, 'evil.txt'))).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(root), 'evil.txt'))).toBe(false);
  });

  it('rejects archives that are not backups: missing manifest, missing database, unknown entries, wrong format', async () => {
    expect((await verifyBackupFile(createSqliteAdapter, make({ 'database.db': 'x' }))).message).toMatch(/manifest\.json is missing/);
    expect((await verifyBackupFile(createSqliteAdapter, make({ 'manifest.json': manifest }))).message).toMatch(/database\.db is missing/);
    expect((await verifyBackupFile(createSqliteAdapter, make({ 'manifest.json': manifest, 'database.db': 'x', 'other.txt': 'y' }))).message).toMatch(/unexpected entry/);
    expect((await verifyBackupFile(createSqliteAdapter, make({ 'manifest.json': JSON.stringify({ format: 99 }), 'database.db': 'x' }))).message).toMatch(/unsupported backup format/);
    expect((await verifyBackupFile(createSqliteAdapter, path.join(root, 'missing.zip'))).message).toMatch(/does not exist/);
  });

  it('a damaged backup fails verification (CRC / inflate), and a healthy one passes', async () => {
    const db = createSqliteAdapter({ file: dbPath });
    const [r] = await createBackupJob({ db, destinations: [{ id: 'l', type: 'local', path: path.join(root, 'bk') }], retentionDays: 1 })();
    db.close();
    const ok = await verifyBackupFile(createSqliteAdapter, r.backupPath);
    expect(ok.ok).toBe(true);
    expect(ok.message).toMatch(/CRC verified/);
    const bytes = fs.readFileSync(r.backupPath);
    bytes[Math.floor(bytes.length * 0.3)] ^= 0xff;
    const damaged = path.join(root, 'damaged.zip');
    fs.writeFileSync(damaged, bytes);
    expect((await verifyBackupFile(createSqliteAdapter, damaged)).ok).toBe(false);
  });

  it('a backup of a database with a corrupt payload is refused by the integrity check', async () => {
    const f = make({ 'manifest.json': manifest, 'database.db': 'not a sqlite database, only padding text ........................' });
    const v = await verifyBackupFile(createSqliteAdapter, f);
    expect(v.ok).toBe(false);
  });
});
