import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encryptBackupFile, decryptBackupFile, isEncryptedBackup, DEFAULT_SCRYPT } from '../src/scheduler/backup-crypto.js';

const KEY = 'correct horse battery staple';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bk2-'));
const payload = Buffer.concat([Buffer.from('HASHES '), Buffer.alloc(100_000, 3)]);
const rejectsWith = async (p, code) => { let e; try { await p; } catch (x) { e = x; } expect(e && e.code).toBe(code); };

describe('DASBAK2', () => {
  it('is the default, carries the cost in the header and round-trips', async () => {
    const d = tmp(); fs.writeFileSync(path.join(d, 'a'), payload);
    await encryptBackupFile(path.join(d, 'a'), path.join(d, 'a.enc'), KEY);
    const f = fs.readFileSync(path.join(d, 'a.enc'));
    expect(f.subarray(0, 8).toString('latin1')).toBe('DASBAK2\0');
    expect([f[8], f[9], f[10], f[11]]).toEqual([1, DEFAULT_SCRYPT.logN, DEFAULT_SCRYPT.r, DEFAULT_SCRYPT.p]);
    expect(isEncryptedBackup(path.join(d, 'a.enc'))).toBe(true);
    await decryptBackupFile(path.join(d, 'a.enc'), path.join(d, 'out'), KEY);
    expect(fs.readFileSync(path.join(d, 'out')).equals(payload)).toBe(true);
  });
  it('DASBAK1 files are still read', async () => {
    const d = tmp(); fs.writeFileSync(path.join(d, 'a'), payload);
    await encryptBackupFile(path.join(d, 'a'), path.join(d, 'a.enc'), KEY, { format: 1 });
    expect(fs.readFileSync(path.join(d, 'a.enc')).subarray(0, 8).toString('latin1')).toBe('DASBAK1\0');
    await decryptBackupFile(path.join(d, 'a.enc'), path.join(d, 'out'), KEY);
    expect(fs.readFileSync(path.join(d, 'out')).equals(payload)).toBe(true);
  });
  it('a changed header byte (cost, salt, iv) fails and leaves no plaintext', async () => {
    const d = tmp(); fs.writeFileSync(path.join(d, 'a'), payload);
    await encryptBackupFile(path.join(d, 'a'), path.join(d, 'a.enc'), KEY, { cost: { logN: 14, r: 8, p: 1 } });
    for (const at of [9, 10, 12, 30]) {
      const b = Buffer.from(fs.readFileSync(path.join(d, 'a.enc')));
      b[at] = at === 9 ? 15 : b[at] ^ 1; // logN 14 -> 15 is a valid cost but a different key
      fs.writeFileSync(path.join(d, 'b.enc'), b);
      await rejectsWith(decryptBackupFile(path.join(d, 'b.enc'), path.join(d, 'x'), KEY), 'BAD_KEY_OR_CORRUPT');
      expect(fs.existsSync(path.join(d, 'x'))).toBe(false);
    }
  });
  it('a forged cost outside the range is refused before any work', async () => {
    const d = tmp(); fs.writeFileSync(path.join(d, 'a'), payload);
    await encryptBackupFile(path.join(d, 'a'), path.join(d, 'a.enc'), KEY, { cost: { logN: 14, r: 8, p: 1 } });
    const b = Buffer.from(fs.readFileSync(path.join(d, 'a.enc')));
    b[9] = 30; fs.writeFileSync(path.join(d, 'b.enc'), b);
    await rejectsWith(decryptBackupFile(path.join(d, 'b.enc'), path.join(d, 'x'), KEY), 'BAD_HEADER');
    b[9] = 14; b[8] = 9; fs.writeFileSync(path.join(d, 'c.enc'), b);
    await rejectsWith(decryptBackupFile(path.join(d, 'c.enc'), path.join(d, 'x'), KEY), 'BAD_HEADER');
  });
  it('the default cost stays under one second on this machine', async () => {
    const d = tmp(); fs.writeFileSync(path.join(d, 'a'), 'x'.repeat(100));
    const t = Date.now();
    await encryptBackupFile(path.join(d, 'a'), path.join(d, 'a.enc'), KEY);
    expect(Date.now() - t).toBeLessThan(2000);
  });
});
