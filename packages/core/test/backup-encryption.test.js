import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSqliteAdapter } from '../src/database/index.js';
import { createBackupJob, listBackups, verifyBackupFile, restoreBackup } from '../src/scheduler/index.js';
import { encryptBackupFile, decryptBackupFile, isEncryptedBackup, BackupCryptoError } from '../src/scheduler/backup-crypto.js';

const KEY = 'correct horse battery staple';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bkenc-'));

describe('backup-crypto', () => {
  it('round-trips a file and the sealed file shows no plaintext', async () => {
    const dir = tmp();
    const plain = path.join(dir, 'a.bin');
    const payload = Buffer.concat([Buffer.from('SECRET-PASSWORD-HASH '), Buffer.alloc(300_000, 7)]);
    fs.writeFileSync(plain, payload);
    await encryptBackupFile(plain, path.join(dir, 'a.enc'), KEY);
    expect(isEncryptedBackup(path.join(dir, 'a.enc'))).toBe(true);
    expect(isEncryptedBackup(plain)).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'a.enc')).includes('SECRET-PASSWORD-HASH')).toBe(false);
    await decryptBackupFile(path.join(dir, 'a.enc'), path.join(dir, 'a.out'), KEY);
    expect(fs.readFileSync(path.join(dir, 'a.out')).equals(payload)).toBe(true);
  });

  it('a wrong key and a flipped byte both fail, and no plaintext is left behind', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'a.bin'), 'hello world hello world');
    await encryptBackupFile(path.join(dir, 'a.bin'), path.join(dir, 'a.enc'), KEY);
    await expect(decryptBackupFile(path.join(dir, 'a.enc'), path.join(dir, 'x'), 'another long passphrase!')).rejects.toMatchObject({ code: 'BAD_KEY_OR_CORRUPT' });
    expect(fs.existsSync(path.join(dir, 'x'))).toBe(false);
    const bytes = fs.readFileSync(path.join(dir, 'a.enc'));
    bytes[bytes.length - 20] ^= 1;
    fs.writeFileSync(path.join(dir, 'b.enc'), bytes);
    await expect(decryptBackupFile(path.join(dir, 'b.enc'), path.join(dir, 'y'), KEY)).rejects.toBeInstanceOf(BackupCryptoError);
    expect(fs.existsSync(path.join(dir, 'y'))).toBe(false);
  });

  it('refuses a short key and a file that is not an encrypted backup', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'a.bin'), 'x'.repeat(100));
    await expect(encryptBackupFile(path.join(dir, 'a.bin'), path.join(dir, 'o'), 'short')).rejects.toMatchObject({ code: 'KEY_TOO_SHORT' });
    await expect(decryptBackupFile(path.join(dir, 'a.bin'), path.join(dir, 'o'), KEY)).rejects.toMatchObject({ code: 'NOT_ENCRYPTED' });
  });
});

describe('encrypted backups end to end', () => {
  it('job writes only .zip.enc, list/verify/restore work with the key and refuse without it', async () => {
    const root = tmp();
    const dbFile = path.join(root, 'app.db');
    const dest = path.join(root, 'bk');
    let db = createSqliteAdapter({ file: dbFile });
    db.exec('CREATE TABLE t (x)');
    db.run('INSERT INTO t (x) VALUES (1)');
    const destinations = [{ id: 'l', type: 'local', path: dest }];
    const results = await createBackupJob({ db, destinations, retentionDays: 30, encryptionKey: KEY })();
    expect(results[0].encrypted).toBe(true);
    expect(fs.readdirSync(dest).every((f) => f.endsWith('.zip.enc'))).toBe(true);
    const [b] = listBackups(destinations);
    expect(b.encrypted).toBe(true);

    expect((await verifyBackupFile(createSqliteAdapter, b.path, { encryptionKey: KEY })).ok).toBe(true);
    const noKey = await verifyBackupFile(createSqliteAdapter, b.path);
    expect(noKey.ok).toBe(false);
    expect(noKey.message).toMatch(/encrypted/);
    expect((await verifyBackupFile(createSqliteAdapter, b.path, { encryptionKey: 'wrong wrong wrong wrong' })).ok).toBe(false);

    db.run('INSERT INTO t (x) VALUES (2)');
    db.close();
    const res = await restoreBackup({ dbFilePath: dbFile, backupFilePath: b.path, migrationsDir: path.join(root, 'none'), createAdapterFn: createSqliteAdapter, encryptionKey: KEY });
    res.db?.close();
    const check = createSqliteAdapter({ file: dbFile });
    expect(check.get('SELECT COUNT(*) AS n FROM t').n).toBe(1);
    check.close();
  });

  it('job refuses a short key at construction', () => {
    expect(() => createBackupJob({ db: {}, destinations: [], retentionDays: 1, encryptionKey: 'short' })).toThrow(/16/);
  });
});
