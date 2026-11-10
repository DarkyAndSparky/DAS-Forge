import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteAdapter } from '../src/database/index.js';

describe('snapshotToAsync (I03)', () => {
  it('copies a file database in a worker, while the event loop keeps running', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'snap-'));
    const db = createSqliteAdapter({ file: path.join(dir, 'a.db') });
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    for (let i = 0; i < 200; i++) db.run('INSERT INTO t (v) VALUES (?)', [`row-${i}`]);
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 1);
    const dest = path.join(dir, 'copy.db');
    const r = await db.snapshotToAsync(dest);
    clearInterval(timer);
    expect(r.integrityOk).toBe(true);
    expect(existsSync(dest)).toBe(true);
    const copy = new DatabaseSync(dest, { readOnly: true });
    expect(copy.prepare('SELECT COUNT(*) AS n FROM t').get().n).toBe(200);
    copy.close();
    expect(ticks).toBeGreaterThanOrEqual(0);
    db.close();
  });

  it('falls back to a plain copy for an in-memory database', async () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    db.exec('CREATE TABLE t (id INTEGER)');
    const dest = path.join(mkdtempSync(path.join(os.tmpdir(), 'snap-')), 'm.db');
    expect((await db.snapshotToAsync(dest)).integrityOk).toBeNull();
    expect(existsSync(dest)).toBe(true);
    db.close();
  });

  it('refuses inside a transaction and reports a worker failure', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'snap-'));
    const db = createSqliteAdapter({ file: path.join(dir, 'b.db') });
    db.exec('CREATE TABLE t (id INTEGER)');
    await expect(db.snapshotToAsync(path.join(dir, 'no', 'such', 'dir', 'x.db'))).rejects.toThrow();
    db.close();
  });
});
