import { describe, it, expect } from 'vitest';
import { database, auth } from '../src/index.js';

const KEY = 'unit-test-encryption-key-0123456789';

function setup() {
  const db = database.createSqliteAdapter({ file: ':memory:' });
  auth.ensureAuthTables?.(db);
  const userId = auth.createUser(db, { username: 'u', passwordHash: 'x', role: 'operator' }).id ?? 1;
  return { db, userId };
}

describe('TOTP secrets encrypted at rest (A10)', () => {
  it('seal/open round-trips and rejects wrong key / tampering', () => {
    const sealed = auth.sealSecret('JBSWY3DPEHPK3PXP', KEY);
    expect(auth.isSealed(sealed)).toBe(true);
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP');
    expect(auth.openSecret(sealed, KEY)).toBe('JBSWY3DPEHPK3PXP');
    expect(() => auth.openSecret(sealed, KEY + 'x')).toThrow(/decrypt/);
    expect(() => auth.openSecret(sealed.slice(0, -2) + 'AA', KEY)).toThrow();
    expect(() => auth.openSecret(sealed)).toThrow(/no encryptionKey/);
  });

  it('plaintext passes through when no key; sealSecret is idempotent', () => {
    expect(auth.sealSecret('abc')).toBe('abc');
    expect(auth.openSecret('abc', KEY)).toBe('abc');
    const s = auth.sealSecret('abc', KEY);
    expect(auth.sealSecret(s, KEY)).toBe(s);
  });

  it('enrollment stores ciphertext and login still works', () => {
    const { db, userId } = setup();
    const r = auth.startTotpEnrollment(db, userId, { accountName: 'u', encryptionKey: KEY });
    const stored = db.get(`SELECT secret FROM totp_credentials WHERE authenticator_id = ?`, [r.authenticatorId]).secret;
    expect(auth.isSealed(stored)).toBe(true);
    const code = auth.generateTotp(r.secret);
    expect(auth.verifyTotpEnrollment(db, r.authenticatorId, code, { userId, encryptionKey: KEY })).toBe(true);
    expect(auth.verifyTotpLogin(db, userId, code, { encryptionKey: KEY })).toBe(r.authenticatorId);
  });

  it('sealExistingTotpSecrets migrates legacy plaintext rows', () => {
    const { db, userId } = setup();
    const r = auth.startTotpEnrollment(db, userId, { accountName: 'u' });
    expect(auth.sealExistingTotpSecrets(db, KEY)).toBe(1);
    expect(auth.sealExistingTotpSecrets(db, KEY)).toBe(0);
    const code = auth.generateTotp(r.secret);
    expect(auth.verifyTotpEnrollment(db, r.authenticatorId, code, { userId, encryptionKey: KEY })).toBe(true);
  });
});

import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('bootstrap credentials file (A16)', () => {
  it('writes owner-only file, refuses to overwrite', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'boot-')), 'sub', 'first-run-admin.txt');
    auth.writeBootstrapCredentials(f, { username: 'admin', tempPassword: 'pw123' });
    expect(readFileSync(f, 'utf8')).toContain('temp password: pw123');
    if (process.platform !== 'win32') expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(() => auth.writeBootstrapCredentials(f, { username: 'a', tempPassword: 'b' })).toThrow();
  });
});
