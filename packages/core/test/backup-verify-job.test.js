import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSqliteAdapter } from '../src/database/index.js';
import { createBackupJob, createBackupVerifyJob } from '../src/scheduler/index.js';

const KEY = 'correct horse battery staple';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bkv-'));
const failure = async (p) => { try { await p; } catch (e) { return e; } return null; };

async function setup(encryptionKey) {
  const root = tmp(); const dest = path.join(root, 'bk');
  const db = createSqliteAdapter({ file: path.join(root, 'app.db') });
  db.exec('CREATE TABLE t (x)'); db.run('INSERT INTO t (x) VALUES (1)');
  const destinations = [{ id: 'l', type: 'local', path: dest }];
  return { root, dest, db, destinations, backup: createBackupJob({ db, destinations, retentionDays: 30, encryptionKey }) };
}

describe('createBackupVerifyJob', () => {
  it('verifies the newest copy (plain and encrypted) and reports each result', async () => {
    for (const key of [null, KEY]) {
      const s = await setup(key); await s.backup();
      const seen = [];
      const res = await createBackupVerifyJob({ destinations: s.destinations, createAdapterFn: createSqliteAdapter, encryptionKey: key, onResult: (r) => seen.push(r) })();
      expect(res[0].ok).toBe(true);
      expect(seen).toHaveLength(1);
      expect(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('das-forge-decrypt-'))).toHaveLength(0);
    }
  });
  it('raises an alarm for a damaged copy, a wrong key and an empty destination', async () => {
    const s = await setup(KEY); await s.backup();
    const file = path.join(s.dest, fs.readdirSync(s.dest)[0]);
    const verify = (key) => createBackupVerifyJob({ destinations: s.destinations, createAdapterFn: createSqliteAdapter, encryptionKey: key });
    const wrong = await failure(verify('another long passphrase!')());
    expect(wrong && wrong.results[0].ok).toBe(false);
    const b = fs.readFileSync(file); b[b.length - 30] ^= 1; fs.writeFileSync(file, b);
    const bad = await failure(verify(KEY)());
    expect(bad && /verification failed/.test(bad.message)).toBe(true);
    const empty = await failure(createBackupVerifyJob({ destinations: [{ id: 'e', type: 'local', path: path.join(s.root, 'none') }], createAdapterFn: createSqliteAdapter })());
    expect(empty && /no backup found/.test(empty.message)).toBe(true);
  });
  it('checks only the newest copy: an older damaged one is not the subject', async () => {
    const s = await setup(null);
    await s.backup();
    const first = path.join(s.dest, fs.readdirSync(s.dest)[0]);
    fs.writeFileSync(first, 'garbage'); fs.utimesSync(first, new Date(Date.now() - 86_400_000), new Date(Date.now() - 86_400_000));
    await new Promise((r) => setTimeout(r, 1100));
    await s.backup();
    const res = await createBackupVerifyJob({ destinations: s.destinations, createAdapterFn: createSqliteAdapter })();
    expect(res[0].ok).toBe(true);
    expect(res[0].file).not.toBe(path.basename(first));
  });
});

describe('createBackupVerifyJob (logic, with a stand-in verifier)', () => {
  const mkdest = (names) => {
    const d = tmp();
    names.forEach(([n, age]) => { const f = path.join(d, n); fs.writeFileSync(f, 'x'); const t = new Date(Date.now() - age * 1000); fs.utimesSync(f, t, t); });
    return [{ id: 'l', type: 'local', path: d }];
  };
  it('picks the newest file per destination and reports ok', async () => {
    const destinations = mkdest([['backup-old.zip', 500], ['backup-new.zip', 10]]);
    const asked = [];
    const res = await createBackupVerifyJob({ destinations, createAdapterFn: () => null, verifyFn: async (_a, file) => { asked.push(path.basename(file)); return { ok: true, message: 'fine' }; } })();
    expect(asked).toEqual(['backup-new.zip']);
    expect(res[0]).toEqual({ destinationId: 'l', ok: true, file: 'backup-new.zip', message: 'fine' });
  });
  it('throws with results when the verifier says no, and when there is no copy; onResult errors do not hide it', async () => {
    const destinations = mkdest([['backup-a.zip', 5]]);
    const e1 = await failure(createBackupVerifyJob({ destinations, createAdapterFn: () => null, onResult: () => { throw new Error('boom'); }, verifyFn: async () => ({ ok: false, message: 'integrity_check failed' }) })());
    expect(e1 && e1.results[0].ok === false && /integrity_check failed/.test(e1.message)).toBe(true);
    const e2 = await failure(createBackupVerifyJob({ destinations: mkdest([]), createAdapterFn: () => null, verifyFn: async () => ({ ok: true, message: '' }) })());
    expect(e2 && /no backup found/.test(e2.message)).toBe(true);
  });
  it('sftp destinations are not checked by this job', async () => {
    const res = await createBackupVerifyJob({ destinations: [{ id: 's', type: 'sftp' }], createAdapterFn: () => null, verifyFn: async () => ({ ok: true, message: '' }) })();
    expect(res).toEqual([]);
  });
});
