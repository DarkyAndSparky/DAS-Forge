import { describe, it, expect } from 'vitest';
import { database, auth } from '../src/index.js';

const KEY = 'unit-test-encryption-key-0123456789';

function setup() {
  const db = database.createSqliteAdapter({ file: ':memory:' });
  auth.ensureAuthTables?.(db);
  const userId = auth.createUser(db, { username: 'u', passwordHash: 'x', role: 'operator' }).id ?? 1;
  return { db, userId };
}

// Changes the first character of the ciphertext part. (Not the last one: the last base64 character carries unused bits, so some changes of it leave the bytes the same.)
const tamper = (sealed) => { const [a, b, c, ...rest] = sealed.split(':'); return [a, b, (c[0] === 'A' ? 'B' : 'A') + c.slice(1), ...rest].join(':'); };

describe('TOTP secrets encrypted at rest (A10)', () => {
  it('seal/open round-trips and rejects wrong key / tampering', () => {
    const sealed = auth.sealSecret('JBSWY3DPEHPK3PXP', KEY);
    expect(auth.isSealed(sealed)).toBe(true);
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP');
    expect(auth.openSecret(sealed, KEY)).toBe('JBSWY3DPEHPK3PXP');
    expect(() => auth.openSecret(sealed, KEY + 'x')).toThrow(/decrypt/);
    expect(() => auth.openSecret(tamper(sealed), KEY)).toThrow();
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

describe('TOTP secret bound to its row (audit R-03)', () => {
  it('v2 opens only for the row it was sealed for', () => {
    const sealed = auth.sealSecret('JBSWY3DPEHPK3PXP', KEY, { id: 7 });
    expect(sealed.startsWith('enc:v2:')).toBe(true);
    expect(auth.isBoundSecret(sealed)).toBe(true);
    expect(auth.openSecret(sealed, KEY, { id: 7 })).toBe('JBSWY3DPEHPK3PXP');
    expect(auth.openSecret(sealed, KEY, { id: '7' })).toBe('JBSWY3DPEHPK3PXP');
    expect(() => auth.openSecret(sealed, KEY, { id: 8 })).toThrow(/decrypt/);
    expect(() => auth.openSecret(sealed, KEY)).toThrow(/row it belongs to/);
  });

  it('a secret copied to another user\'s authenticator no longer logs that user in', () => {
    const { db, userId } = setup();
    const other = auth.createUser(db, { username: 'v', passwordHash: 'x', role: 'operator' }).id;
    const a = auth.startTotpEnrollment(db, userId, { accountName: 'u', encryptionKey: KEY });
    const b = auth.startTotpEnrollment(db, other, { accountName: 'v', encryptionKey: KEY });
    const code = auth.generateTotp(a.secret);
    expect(auth.verifyTotpEnrollment(db, a.authenticatorId, code, { userId, encryptionKey: KEY })).toBe(true);
    // the database writer copies user u's ciphertext onto user v's row
    const stolen = db.get('SELECT secret FROM totp_credentials WHERE authenticator_id = ?', [a.authenticatorId]).secret;
    db.run('UPDATE totp_credentials SET secret = ? WHERE authenticator_id = ?', [stolen, b.authenticatorId]);
    db.run("UPDATE authenticators SET status = 'active' WHERE id = ?", [b.authenticatorId]);
    expect(auth.verifyTotpLogin(db, other, code, { encryptionKey: KEY })).toBeFalsy();
  });

  it('sealExistingTotpSecrets brings v1 and plaintext rows to v2 and then changes nothing', () => {
    const { db, userId } = setup();
    const r = auth.startTotpEnrollment(db, userId, { accountName: 'u' }); // plaintext
    const r2 = auth.startTotpEnrollment(db, userId, { accountName: 'u2' });
    db.run('UPDATE totp_credentials SET secret = ? WHERE authenticator_id = ?', [auth.sealSecret(r2.secret, KEY), r2.authenticatorId]); // v1
    expect(auth.sealExistingTotpSecrets(db, KEY)).toBe(2);
    for (const id of [r.authenticatorId, r2.authenticatorId]) expect(db.get('SELECT secret FROM totp_credentials WHERE authenticator_id = ?', [id]).secret.startsWith('enc:v2:')).toBe(true);
    expect(auth.sealExistingTotpSecrets(db, KEY)).toBe(0);
    const code = auth.generateTotp(r.secret);
    expect(auth.verifyTotpEnrollment(db, r.authenticatorId, code, { userId, encryptionKey: KEY })).toBe(true);
  });
});
