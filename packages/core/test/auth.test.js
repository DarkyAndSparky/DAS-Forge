import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { pbkdf2Sync, scryptSync } from 'node:crypto';

import { createSqliteAdapter } from '../src/database/index.js';
import {
  hashPassword,
  verifyPassword,
  pbkdf2Scheme,
  scryptScheme,
  createUser,
  findUserByUsername,
  updatePasswordHash,
  countUsers,
  generateTotpSecret,
  generateTotp,
  verifyTotp,
  buildTotpUri,
  firstRunBootstrap,
  createAuthProvider,
  assertAuthProvider,
} from '../src/auth/index.js';

describe('argon2id password hashing', () => {
  it('hashes and verifies a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$/);
    const result = await verifyPassword(hash, 'correct horse battery staple');
    expect(result).toEqual({ valid: true, scheme: 'argon2id', needsRehash: false });
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('right-password');
    const result = await verifyPassword(hash, 'wrong-password');
    expect(result.valid).toBe(false);
  });
});

describe('legacy scheme migration', () => {
  it('verifies a PBKDF2-legacy hash and flags needsRehash', async () => {
    // Simulate procure-it's documented format: "salt:hash" (hex), sha256, 100000 iters
    const salt = 'deadbeef';
    const plain = 'legacy-pw-1';
    const derived = pbkdf2Sync(plain, Buffer.from(salt, 'hex'), 100_000, 32, 'sha256');
    const stored = `${salt}:${derived.toString('hex')}`;

    const scheme = pbkdf2Scheme({
      iterations: 100_000,
      keylen: 32,
      digest: 'sha256',
      parseStored: (s) => {
        const [salt, hash] = s.split(':');
        return { salt, hash };
      },
    });

    const result = await verifyPassword(stored, plain, { legacySchemes: [scheme] });
    expect(result.valid).toBe(true);
    expect(result.scheme).toBe('pbkdf2-legacy');
    expect(result.needsRehash).toBe(true);
  });

  it('verifies a scrypt-legacy hash (atlas/net-monitor style)', async () => {
    const salt = 'cafebabe';
    const plain = 'legacy-pw-2';
    const derived = scryptSync(plain, Buffer.from(salt, 'hex'), 32, { N: 16384, r: 8, p: 1 });
    const stored = `${salt}$${derived.toString('hex')}`;

    const scheme = scryptScheme({
      N: 16384,
      r: 8,
      p: 1,
      keylen: 32,
      parseStored: (s) => {
        const [salt, hash] = s.split('$');
        return { salt, hash };
      },
    });

    const result = await verifyPassword(stored, plain, { legacySchemes: [scheme] });
    expect(result.valid).toBe(true);
    expect(result.scheme).toBe('scrypt-legacy');
  });

  it('rejects when plaintext is wrong against a legacy scheme', async () => {
    const salt = 'aa11bb22';
    const derived = pbkdf2Sync('right', Buffer.from(salt, 'hex'), 1000, 32, 'sha256');
    const stored = `${salt}:${derived.toString('hex')}`;
    const scheme = pbkdf2Scheme({
      iterations: 1000,
      keylen: 32,
      digest: 'sha256',
      parseStored: (s) => {
        const [salt, hash] = s.split(':');
        return { salt, hash };
      },
    });

    const result = await verifyPassword(stored, 'wrong', { legacySchemes: [scheme] });
    expect(result.valid).toBe(false);
  });

  it('falls through multiple legacy schemes trying each in order', async () => {
    const salt = '1234';
    const plain = 'multi-scheme-pw';
    const derived = scryptSync(plain, Buffer.from(salt, 'hex'), 32, { N: 1024, r: 8, p: 1 });
    const stored = `${salt}$${derived.toString('hex')}`;

    const wrongPbkdf2 = pbkdf2Scheme({
      iterations: 1000,
      keylen: 32,
      digest: 'sha256',
      parseStored: () => ({ salt: '00', hash: '00' }),
    });
    const rightScrypt = scryptScheme({
      N: 1024,
      r: 8,
      p: 1,
      keylen: 32,
      parseStored: (s) => {
        const [salt, hash] = s.split('$');
        return { salt, hash };
      },
    });

    const result = await verifyPassword(stored, plain, {
      legacySchemes: [wrongPbkdf2, rightScrypt],
    });
    expect(result.valid).toBe(true);
    expect(result.scheme).toBe('scrypt-legacy');
  });
});

describe('TOTP (RFC 6238)', () => {
  it('generates a verifiable 6-digit code', () => {
    const secret = generateTotpSecret();
    const code = generateTotp(secret, { at: 1_700_000_000 });
    expect(code).toMatch(/^\d{6}$/);
    expect(verifyTotp(secret, code, { at: 1_700_000_000 })).toBe(true);
  });

  it('rejects a wrong code', () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, '000000', { at: 1_700_000_000 })).toBe(false);
  });

  it('tolerates one time-step of drift via the window', () => {
    const secret = generateTotpSecret();
    const code = generateTotp(secret, { at: 1_700_000_000 });
    // 30s later = next step, still within window=1
    expect(verifyTotp(secret, code, { at: 1_700_000_030 })).toBe(true);
    // 90s later = 3 steps away, outside window=1
    expect(verifyTotp(secret, code, { at: 1_700_000_090 })).toBe(false);
  });

  it('builds a valid otpauth:// provisioning URI', () => {
    const secret = generateTotpSecret();
    const uri = buildTotpUri(secret, { accountName: 'alice@example.com' });
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain(`secret=${secret}`);
  });
});

describe('firstRunBootstrap', () => {
  let db;

  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
  });

  afterEach(() => db.close());

  it('creates an admin with a temp password when no users exist', async () => {
    const result = await firstRunBootstrap(db);
    expect(result.created).toBe(true);
    expect(result.username).toBe('admin');
    expect(result.tempPassword).toHaveLength(24);

    const user = findUserByUsername(db, 'admin');
    expect(user.role).toBe('admin');
    expect(user.mustChangePassword).toBe(true);

    const verify = await verifyPassword(user.passwordHash, result.tempPassword);
    expect(verify.valid).toBe(true);
  });

  it('is a no-op once any user exists', async () => {
    await firstRunBootstrap(db);
    expect(countUsers(db)).toBe(1);
    const second = await firstRunBootstrap(db);
    expect(second.created).toBe(false);
    expect(countUsers(db)).toBe(1);
  });
});

describe('createAuthProvider', () => {
  it('builds an object satisfying the AuthProvider contract', () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    const provider = createAuthProvider({ db });
    expect(() => assertAuthProvider(provider)).not.toThrow();
    db.close();
  });
});

describe('updatePasswordHash', () => {
  it('updates the hash and optionally clears mustChangePassword', async () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    const { username, tempPassword } = await firstRunBootstrap(db);
    const user = findUserByUsername(db, username);

    const newHash = await hashPassword('a-brand-new-password');
    updatePasswordHash(db, user.id, newHash, { clearMustChange: true });

    const updated = findUserByUsername(db, username);
    expect(updated.mustChangePassword).toBe(false);
    const verify = await verifyPassword(updated.passwordHash, 'a-brand-new-password');
    expect(verify.valid).toBe(true);
    // old temp password no longer works
    const oldVerify = await verifyPassword(updated.passwordHash, tempPassword);
    expect(oldVerify.valid).toBe(false);

    db.close();
  });
});
