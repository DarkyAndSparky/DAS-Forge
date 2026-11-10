import { describe, it, expect } from 'vitest';
import { checkPasswordPolicy, PASSWORD_ABSOLUTE_MAX, hashPassword, verifyPassword } from '../src/auth/index.js';

describe('checkPasswordPolicy (audit A15)', () => {
  it('accepts a normal passphrase, including non-ASCII', () => {
    expect(checkPasswordPolicy('correct horse battery staple')).toEqual({ ok: true, problems: [] });
    expect(checkPasswordPolicy('длинный-пароль-2026')).toEqual({ ok: true, problems: [] });
  });

  it('length is counted in characters, not UTF-16 units', () => {
    expect(checkPasswordPolicy('😀'.repeat(8)).ok).toBe(true);
    expect(checkPasswordPolicy('😀'.repeat(7)).problems).toEqual(['TOO_SHORT']);
  });

  it('min/max are configurable; max is clamped to the absolute ceiling', () => {
    expect(checkPasswordPolicy('abcdefghij', { minLength: 12 }).problems).toEqual(['TOO_SHORT']);
    expect(checkPasswordPolicy('a'.repeat(30), { maxLength: 20 }).problems).toEqual(['TOO_LONG']);
    expect(checkPasswordPolicy('a'.repeat(PASSWORD_ABSOLUTE_MAX + 1), { maxLength: 100000 }).problems).toContain('TOO_LONG');
  });

  it('refuses username, current password, deny-list and extra forbidden values (case-insensitive where it matters)', () => {
    expect(checkPasswordPolicy('Administrator', { username: 'administrator' }).problems).toContain('SAME_AS_USERNAME');
    expect(checkPasswordPolicy('same-as-before', { currentPassword: 'same-as-before' }).problems).toEqual(['SAME_AS_CURRENT']);
    expect(checkPasswordPolicy('QWERTY123').problems).toEqual(['COMMON']);
    expect(checkPasswordPolicy('Acme-Corp-2026', { forbidden: ['acme-corp-2026'] }).problems).toEqual(['COMMON']);
  });

  it('reports several problems at once; non-strings are refused', () => {
    expect(checkPasswordPolicy('12345').problems).toEqual(['TOO_SHORT']);
    expect(checkPasswordPolicy('password', { username: 'password' }).problems).toEqual(['SAME_AS_USERNAME', 'COMMON']);
    expect(checkPasswordPolicy(undefined)).toEqual({ ok: false, problems: ['NOT_A_STRING'] });
  });
});

describe('hash/verify length guard', () => {
  it('hashPassword refuses an oversize or non-string password', async () => {
    await expect(hashPassword('x'.repeat(PASSWORD_ABSOLUTE_MAX + 1))).rejects.toThrow(/at most/);
    await expect(hashPassword(123)).rejects.toThrow(/string/);
  });

  it('verifyPassword says "invalid" for an oversize password without touching argon2', async () => {
    expect(await verifyPassword('$argon2id$bogus', 'x'.repeat(PASSWORD_ABSOLUTE_MAX + 1))).toEqual({ valid: false, scheme: null, needsRehash: false });
  });
});

describe('scryptSaltColumnScheme (D07: atlas / net-monitor format)', () => {
  it('verifies the exact format of those apps (salt string in its own column, 128 hex), migrates to argon2id', async () => {
    const { scryptSaltColumnScheme, verifyPassword } = await import('../src/auth/password.js');
    const { scryptSync } = await import('node:crypto');
    const salt = '0123456789abcdef0123456789abcdef'; // atlas: randomBytes(16).toString('hex'), used as a STRING
    const hash = scryptSync('Correct-Horse-9', salt, 64).toString('hex'); // what atlas/net-monitor stored
    const opts = { legacySchemes: [scryptSaltColumnScheme()], legacyContext: { salt } };
    expect(await verifyPassword(hash, 'Correct-Horse-9', opts)).toEqual({ valid: true, scheme: 'scrypt-salt-column', needsRehash: true });
    expect((await verifyPassword(hash, 'wrong', opts)).valid).toBe(false);
    expect((await verifyPassword(hash, 'Correct-Horse-9', { legacySchemes: [scryptSaltColumnScheme()], legacyContext: { salt: 'other' } })).valid).toBe(false);
    expect((await verifyPassword(hash, 'Correct-Horse-9', { legacySchemes: [scryptSaltColumnScheme()] })).valid).toBe(false); // no salt given
    expect((await verifyPassword('not-hex-and-short', 'x', opts)).valid).toBe(false);
  });
});
