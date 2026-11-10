import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, existsSync, readdirSync, copyFileSync, statSync, renameSync, unlinkSync, createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSqliteAdapter } from '../src/database/index.js';
import { createBackupJob } from '../src/scheduler/backup-job.js';
import { listRemoteBackups, normalizeFingerprint, selectExpired } from '../src/scheduler/backup-remote.js';
import { BackupDestinationSchema } from '../src/config/schema.js';

const KEY = 'a-long-enough-backup-passphrase';
const FP = 'SHA256:' + Buffer.alloc(32, 7).toString('base64');
const FP_HEX = Buffer.alloc(32, 7).toString('hex');

/** A stand-in for the ssh2 module: "remote" paths live in a local directory. */
function fakeSsh2(root, { hostHashHex = FP_HEX, corrupt = false } = {}) {
  const real = (p) => path.join(root, p.replace(/^\/+/, ''));
  const log = { connects: 0, options: null };
  class Client extends EventEmitter {
    connect(options) {
      log.connects++;
      log.options = options;
      setImmediate(() => {
        if (!options.hostVerifier(hostHashHex)) {
          const err = new Error('Handshake failed: signature verification failed');
          err.level = 'handshake';
          this.emit('error', err);
        } else this.emit('ready');
      });
    }
    sftp(cb) {
      cb(null, {
        stat: (p, c) => {
          try {
            const st = statSync(real(p));
            c(null, { size: st.size, isDirectory: () => st.isDirectory() });
          } catch (e) { c(e); }
        },
        fastPut: (local, remote, _o, c) => {
          try { copyFileSync(local, real(remote)); if (corrupt) writeFileSync(real(remote), Buffer.alloc(statSync(local).size, 1)); c(null); } catch (e) { c(e); }
        },
        rename: (a, b, c) => { try { renameSync(real(a), real(b)); c(null); } catch (e) { c(e); } },
        unlink: (p, c) => { try { unlinkSync(real(p)); c(null); } catch (e) { c(e); } },
        readdir: (p, c) => {
          try {
            c(null, readdirSync(real(p)).map((n) => ({ filename: n, attrs: { size: statSync(path.join(real(p), n)).size, mtime: Math.floor(statSync(path.join(real(p), n)).mtimeMs / 1000) } })));
          } catch (e) { c(e); }
        },
        createReadStream: (p) => createReadStream(real(p)),
      });
    }
    end() {}
  }
  return { Client, log };
}

let dir, db, dbFile;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'bk-remote-'));
  dbFile = path.join(dir, 'data', 'app.db');
  mkdirSync(path.dirname(dbFile), { recursive: true });
  db = createSqliteAdapter({ file: dbFile });
  db.exec('CREATE TABLE t (x INTEGER)');
  db.run('INSERT INTO t VALUES (1)');
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const sftpDest = (over = {}) => ({
  id: 'off-site',
  type: 'sftp',
  config: { host: 'backup.example.com', username: 'bk', hostKeySha256: FP, remotePath: '/backups', password: 'env:BK_PASS', ...over },
});
const job = (destinations, extra = {}) =>
  createBackupJob({ db, destinations, retentionDays: 30, encryptionKey: KEY, dbFilePath: dbFile, env: { BK_PASS: 'secret' }, ...extra });

describe('mount destination', () => {
  it('s3 and webdav are refused by the schema with a clear message (nothing writes to them)', () => {
    for (const type of ['s3', 'webdav']) {
      const r = BackupDestinationSchema.safeParse({ id: 'x', type, config: {} });
      expect(r.success).toBe(false);
      expect(JSON.stringify(r.error.issues)).toContain('not supported yet');
    }
    expect(BackupDestinationSchema.safeParse({ id: 'x', type: 'local', path: 'data/b' }).success).toBe(true);
  });

  it('copies an encrypted backup to a mounted path, verified by hash, no temp file left', async () => {
    const share = path.join(dir, 'share'); mkdirSync(share);
    const [r] = await job([{ id: 'nas', type: 'mount', path: share, config: { allowSameDevice: true } }])();
    expect(r.ok).toBe(true);
    expect(r.verified).toBe('hash');
    expect(r.encrypted).toBe(true);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    const files = readdirSync(share);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^backup-.*\.zip\.enc$/);
  });

  it('refuses a path on the same device as the data directory', async () => {
    if (process.platform === 'win32') return; // the device check is skipped on Windows (documented)
    const share = path.join(dir, 'share'); mkdirSync(share);
    await expect(job([{ id: 'nas', type: 'mount', path: share }])()).rejects.toThrow(/same device/);
    expect(readdirSync(share).length).toBe(0);
  });

  it('never creates a missing mount root (an unmounted share)', async () => {
    const share = path.join(dir, 'not-mounted');
    await expect(job([{ id: 'nas', type: 'mount', path: share, config: { allowSameDevice: true } }])()).rejects.toThrow(/does not exist/);
    expect(existsSync(share)).toBe(false);
  });

  it('requires the marker file when configured', async () => {
    const share = path.join(dir, 'share'); mkdirSync(share);
    await expect(job([{ id: 'nas', type: 'mount', path: share, config: { allowSameDevice: true, markerFile: '.mounted' } }])()).rejects.toThrow(/marker file/);
    writeFileSync(path.join(share, '.mounted'), '');
    const [r] = await job([{ id: 'nas', type: 'mount', path: share, config: { allowSameDevice: true, markerFile: '.mounted' } }])();
    expect(r.ok).toBe(true);
  });

  it('refuses to send an unencrypted archive off the machine', async () => {
    const share = path.join(dir, 'share'); mkdirSync(share);
    const d = { id: 'nas', type: 'mount', path: share, config: { allowSameDevice: true } };
    await expect(createBackupJob({ db, destinations: [d], retentionDays: 30, dbFilePath: dbFile })()).rejects.toThrow(/unencrypted/);
    const ok = { ...d, config: { allowSameDevice: true, allowUnencrypted: true } };
    const [r] = await createBackupJob({ db, destinations: [ok], retentionDays: 30, dbFilePath: dbFile })();
    expect(r.encrypted).toBe(false);
    expect(readdirSync(share)[0]).toMatch(/\.zip$/);
  });

  it('retention prunes old copies on the share but keeps the newest minKeep', async () => {
    const share = path.join(dir, 'share'); mkdirSync(share);
    for (const d of ['2020-01-01', '2020-01-02', '2020-01-03', '2020-01-04', '2020-01-05']) {
      writeFileSync(path.join(share, `backup-${d}T00-00-00-000Z.zip.enc`), 'x');
    }
    const [r] = await job([{ id: 'nas', type: 'mount', path: share, config: { allowSameDevice: true } }])();
    expect(r.prunedCount).toBe(3); // 5 old + 1 new = 6; newest 3 kept
    expect(readdirSync(share).length).toBe(3);
  });
});

describe('sftp destination', () => {
  it('uploads through ssh2 with the pinned host key, verifies by hash and renames', async () => {
    const remoteRoot = path.join(dir, 'remote'); mkdirSync(path.join(remoteRoot, 'backups'), { recursive: true });
    const ssh2 = fakeSsh2(remoteRoot);
    const [r] = await job([sftpDest()], { ssh2 })();
    expect(r.ok).toBe(true);
    expect(r.backupPath).toMatch(/^sftp:\/\/backup\.example\.com\/backups\/backup-.*\.zip\.enc$/);
    expect(readdirSync(path.join(remoteRoot, 'backups')).filter((n) => n.endsWith('.tmp')).length).toBe(0);
    expect(ssh2.log.options.password).toBe('secret'); // resolved from env, not from the config
    expect(ssh2.log.options.hostHash).toBe('sha256');
  });

  it('a different host key is refused', async () => {
    const remoteRoot = path.join(dir, 'remote'); mkdirSync(path.join(remoteRoot, 'backups'), { recursive: true });
    const ssh2 = fakeSsh2(remoteRoot, { hostHashHex: 'ab'.repeat(32) });
    await expect(job([sftpDest()], { ssh2 })()).rejects.toThrow(/host key mismatch/);
    expect(readdirSync(path.join(remoteRoot, 'backups')).length).toBe(0);
  });

  it('a corrupted upload is detected, removed, and never gets the final name', async () => {
    const remoteRoot = path.join(dir, 'remote'); mkdirSync(path.join(remoteRoot, 'backups'), { recursive: true });
    const ssh2 = fakeSsh2(remoteRoot, { corrupt: true });
    await expect(job([sftpDest()], { ssh2 })()).rejects.toThrow(/checksum mismatch/);
    expect(readdirSync(path.join(remoteRoot, 'backups')).length).toBe(0);
  });

  it('a missing remote directory fails clearly and is not created', async () => {
    const remoteRoot = path.join(dir, 'remote'); mkdirSync(remoteRoot);
    await expect(job([sftpDest()], { ssh2: fakeSsh2(remoteRoot) })()).rejects.toThrow(/does not exist/);
    expect(existsSync(path.join(remoteRoot, 'backups'))).toBe(false);
  });

  it('a missing env secret fails that destination only', async () => {
    const remoteRoot = path.join(dir, 'remote'); mkdirSync(path.join(remoteRoot, 'backups'), { recursive: true });
    const share = path.join(dir, 'share'); mkdirSync(share);
    const run = createBackupJob({
      db, retentionDays: 30, encryptionKey: KEY, dbFilePath: dbFile, env: {}, ssh2: fakeSsh2(remoteRoot),
      destinations: [sftpDest(), { id: 'nas', type: 'mount', path: share, config: { allowSameDevice: true } }],
    });
    let err;
    try { await run(); } catch (e) { err = e; }
    expect(err.results.find((r) => r.destinationId === 'off-site').ok).toBe(false);
    expect(err.results.find((r) => r.destinationId === 'nas').ok).toBe(true);
    expect(readdirSync(share).length).toBe(1);
  });

  it('listRemoteBackups lists only backup files', async () => {
    const remoteRoot = path.join(dir, 'remote'); mkdirSync(path.join(remoteRoot, 'backups'), { recursive: true });
    writeFileSync(path.join(remoteRoot, 'backups', 'backup-2025-01-01T00-00-00-000Z.zip.enc'), 'x');
    writeFileSync(path.join(remoteRoot, 'backups', 'notes.txt'), 'x');
    const list = await listRemoteBackups([sftpDest()], { ssh2: fakeSsh2(remoteRoot), env: { BK_PASS: 'p' } });
    expect(list.length).toBe(1);
    expect(list[0].file).toBe('backup-2025-01-01T00-00-00-000Z.zip.enc');
    expect(list[0].encrypted).toBe(true);
  });
});

describe('config and helpers', () => {
  it('sftp config: literal secrets and a missing host key are rejected', () => {
    const base = { id: 'x', type: 'sftp' };
    expect(BackupDestinationSchema.safeParse({ ...base, config: sftpDest().config }).success).toBe(true);
    expect(BackupDestinationSchema.safeParse({ ...base, config: sftpDest({ password: 'hunter2' }).config }).success).toBe(false);
    const noKey = sftpDest().config; delete noKey.hostKeySha256;
    expect(BackupDestinationSchema.safeParse({ ...base, config: noKey }).success).toBe(false);
    const noAuth = sftpDest().config; delete noAuth.password;
    expect(BackupDestinationSchema.safeParse({ ...base, config: noAuth }).success).toBe(false);
    expect(BackupDestinationSchema.safeParse({ id: 'm', type: 'mount' }).success).toBe(false);
    expect(BackupDestinationSchema.safeParse({ id: 'm', type: 'mount', path: '/mnt/nas' }).success).toBe(true);
  });

  it('normalizeFingerprint accepts OpenSSH and hex forms', () => {
    expect(normalizeFingerprint(FP)).toBe(FP_HEX);
    expect(normalizeFingerprint(FP_HEX.toUpperCase().replace(/(..)/g, '$1:').slice(0, -1))).toBe(FP_HEX);
  });

  it('selectExpired never returns the newest minKeep', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const files = [1, 2, 3, 4].map((i) => ({ name: `f${i}`, time: now - i * 100 * 86400000 }));
    expect(selectExpired(files, 30, 3, now).map((f) => f.name)).toEqual(['f4']);
  });
});
