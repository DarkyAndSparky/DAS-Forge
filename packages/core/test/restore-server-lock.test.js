import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { acquireFileLock, readLockOwner } from '../src/scheduler/file-lock.js';
import { restoreBackup } from '../src/scheduler/backup-ops.js';

let dir, lock;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'srvlock-'));
  lock = path.join(dir, '.server.lock');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const opts = (extra = {}) => ({
  dbFilePath: path.join(dir, 'app.db'),
  backupFilePath: path.join(dir, 'missing.zip'),
  migrationsDir: dir,
  createAdapterFn: () => { throw new Error('must not be reached'); },
  serverLockFile: lock,
  ...extra,
});

describe('restore vs running server (G02)', () => {
  it('refuses while another live process holds the server lock', async () => {
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, at: Date.now() - 3 * 60 * 60 * 1000 })); // old, but its owner lives
    const r = await restoreBackup(opts());
    expect(r.ok).toBe(false);
    expect(r.steps[0].name).toBe('Check server');
    expect(r.steps[0].message).toMatch(/server is running/);
    expect(existsSync(lock)).toBe(true); // the server's lock is not touched
  });

  it('a lock of a dead process does not block, and the lock is released afterwards', async () => {
    writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
    const r = await restoreBackup(opts());
    expect(r.steps[0].name).not.toBe('Check server');
    expect(existsSync(lock)).toBe(false);
  });

  it('while a restore runs, a server cannot take the lock', () => {
    const release = acquireFileLock(lock, { staleMs: Infinity });
    expect(release).not.toBe(null);
    expect(acquireFileLock(lock, { staleMs: Infinity, takeOverSelf: false })).toBe(null);
    expect(readLockOwner(lock).pid).toBe(process.pid);
    release();
    expect(existsSync(lock)).toBe(false);
  });

  it('a leftover lock naming this very pid (container restart) is taken over by the server only', () => {
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
    expect(acquireFileLock(lock, { staleMs: Infinity })).toBe(null);
    expect(typeof acquireFileLock(lock, { staleMs: Infinity, takeOverSelf: true })).toBe('function');
  });

  it('without serverLockFile behaviour is unchanged', async () => {
    const r = await restoreBackup(opts({ serverLockFile: undefined }));
    expect(r.steps[0].name).not.toBe('Check server');
  });
});
