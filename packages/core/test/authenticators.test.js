import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { createSqliteAdapter } from '../src/database/index.js';
import { createUser } from '../src/auth/users.js';
import { ensureAuthTables } from '../src/auth/schema.js';
import {
  listAuthenticators,
  startTotpEnrollment,
  verifyTotpEnrollment,
  verifyTotpLogin,
  removeAuthenticator,
  purgeExpiredPendingAuthenticators,
} from '../src/auth/authenticators.js';
import { generateTotp } from '../src/auth/totp.js';
import { generateRecoveryCodes, verifyAndConsumeRecoveryCode, countRemainingRecoveryCodes } from '../src/auth/recovery-codes.js';

describe('authenticators: TOTP enrollment lifecycle', () => {
  let db;
  let alice;

  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
    alice = createUser(db, { username: 'alice', passwordHash: 'h' });
  });

  afterEach(() => {
    db.close();
  });

  it('starts pending, rejects a wrong code, activates on a correct one', () => {
    const enroll = startTotpEnrollment(db, alice.id, { accountName: 'alice' });
    expect(listAuthenticators(db, alice.id)).toEqual([
      expect.objectContaining({ id: enroll.authenticatorId, status: 'pending' }),
    ]);

    expect(verifyTotpEnrollment(db, enroll.authenticatorId, '000000')).toBe(false);
    expect(listAuthenticators(db, alice.id)[0].status).toBe('pending');

    expect(verifyTotpEnrollment(db, enroll.authenticatorId, generateTotp(enroll.secret))).toBe(true);
    const active = listAuthenticators(db, alice.id)[0];
    expect(active.status).toBe('active');
    expect(active.expiresAt).toBeNull();
  });

  it('returns a usable otpauth:// URI', () => {
    const enroll = startTotpEnrollment(db, alice.id, { accountName: 'alice', issuer: 'Test' });
    expect(enroll.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
  });

  it('an expired pending enrollment cannot be completed, and purge removes it', () => {
    const enroll = startTotpEnrollment(db, alice.id, { accountName: 'alice', ttlMinutes: -1 });
    expect(verifyTotpEnrollment(db, enroll.authenticatorId, generateTotp(enroll.secret))).toBe(false);

    purgeExpiredPendingAuthenticators(db);
    expect(listAuthenticators(db, alice.id)).toEqual([]);
  });

  it('verifyTotpEnrollment returns false for an unknown id', () => {
    expect(verifyTotpEnrollment(db, 999999, '123456')).toBe(false);
  });
});

describe('authenticators: login verification with multiple factors', () => {
  let db;
  let alice;

  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
    alice = createUser(db, { username: 'alice', passwordHash: 'h' });
  });

  afterEach(() => {
    db.close();
  });

  it('matches the correct authenticator among several, and rejects a wrong code', () => {
    const e1 = startTotpEnrollment(db, alice.id, { accountName: 'alice', name: 'Phone' });
    verifyTotpEnrollment(db, e1.authenticatorId, generateTotp(e1.secret));
    const e2 = startTotpEnrollment(db, alice.id, { accountName: 'alice', name: 'Backup' });
    verifyTotpEnrollment(db, e2.authenticatorId, generateTotp(e2.secret));

    expect(verifyTotpLogin(db, alice.id, '000000')).toBeNull();
    expect(verifyTotpLogin(db, alice.id, generateTotp(e1.secret))).toBe(e1.authenticatorId);
    expect(verifyTotpLogin(db, alice.id, generateTotp(e2.secret))).toBe(e2.authenticatorId);
  });

  it('a PENDING authenticator does not count for login', () => {
    const enroll = startTotpEnrollment(db, alice.id, { accountName: 'alice' });
    expect(verifyTotpLogin(db, alice.id, generateTotp(enroll.secret))).toBeNull();
  });
});

describe('removeAuthenticator (§18: protect the last required factor)', () => {
  let db;
  let bob;

  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
    bob = createUser(db, { username: 'bob', passwordHash: 'h' });
  });

  afterEach(() => {
    db.close();
  });

  it('allows removal when MFA is not required, regardless of count', () => {
    const e1 = startTotpEnrollment(db, bob.id, { accountName: 'bob' });
    verifyTotpEnrollment(db, e1.authenticatorId, generateTotp(e1.secret));

    expect(removeAuthenticator(db, bob.id, e1.authenticatorId, { mfaRequired: false })).toEqual({ ok: true });
    expect(listAuthenticators(db, bob.id)).toEqual([]);
  });

  it('refuses to remove the last ACTIVE authenticator when MFA is required', () => {
    const e1 = startTotpEnrollment(db, bob.id, { accountName: 'bob' });
    verifyTotpEnrollment(db, e1.authenticatorId, generateTotp(e1.secret));

    expect(removeAuthenticator(db, bob.id, e1.authenticatorId, { mfaRequired: true })).toEqual({
      ok: false,
      reason: 'last_required_factor',
    });
    expect(listAuthenticators(db, bob.id)).toHaveLength(1);
  });

  it('allows removal when a second active authenticator remains', () => {
    const e1 = startTotpEnrollment(db, bob.id, { accountName: 'bob' });
    verifyTotpEnrollment(db, e1.authenticatorId, generateTotp(e1.secret));
    const e2 = startTotpEnrollment(db, bob.id, { accountName: 'bob' });
    verifyTotpEnrollment(db, e2.authenticatorId, generateTotp(e2.secret));

    expect(removeAuthenticator(db, bob.id, e1.authenticatorId, { mfaRequired: true })).toEqual({ ok: true });
    expect(listAuthenticators(db, bob.id)).toHaveLength(1);
  });

  it('reports not_found for an unknown or mismatched-user authenticator id', () => {
    expect(removeAuthenticator(db, bob.id, 999999, {})).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('legacy users.totp_secret migration', () => {
  let db;

  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
  });

  afterEach(() => {
    db.close();
  });

  it('migrates an existing legacy secret into an authenticator row, active iff totp_enabled was set', () => {
    const carol = createUser(db, { username: 'carol', passwordHash: 'h' });
    db.run(`UPDATE users SET totp_secret = 'JBSWY3DPEHPK3PXP', totp_enabled = 1 WHERE id = ?`, [carol.id]);

    ensureAuthTables(db); // migration runs here

    const list = listAuthenticators(db, carol.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: 'active', name: 'Migrated authenticator' });
    expect(verifyTotpLogin(db, carol.id, generateTotp('JBSWY3DPEHPK3PXP'))).toBe(list[0].id);
  });

  it('migrates an un-enabled legacy secret as pending, not active', () => {
    const dave = createUser(db, { username: 'dave', passwordHash: 'h' });
    db.run(`UPDATE users SET totp_secret = 'JBSWY3DPEHPK3PXP', totp_enabled = 0 WHERE id = ?`, [dave.id]);

    ensureAuthTables(db);
    expect(listAuthenticators(db, dave.id)[0].status).toBe('pending');
  });

  it('is idempotent across repeated ensureAuthTables() calls', () => {
    const erin = createUser(db, { username: 'erin', passwordHash: 'h' });
    db.run(`UPDATE users SET totp_secret = 'JBSWY3DPEHPK3PXP', totp_enabled = 1 WHERE id = ?`, [erin.id]);

    ensureAuthTables(db);
    ensureAuthTables(db);
    ensureAuthTables(db);
    expect(listAuthenticators(db, erin.id)).toHaveLength(1);
  });
});

describe('recovery codes', () => {
  let db;
  let alice;

  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
    alice = createUser(db, { username: 'alice', passwordHash: 'h' });
  });

  afterEach(() => {
    db.close();
  });

  it('generates the requested count in XXXX-XXXX format, all initially unused', async () => {
    const codes = await generateRecoveryCodes(db, alice.id, { count: 5 });
    expect(codes).toHaveLength(5);
    for (const code of codes) expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(countRemainingRecoveryCodes(db, alice.id)).toBe(5);
  });

  it('accepts a real code once, rejects reuse, rejects a bogus code', async () => {
    const codes = await generateRecoveryCodes(db, alice.id, { count: 3 });

    expect(await verifyAndConsumeRecoveryCode(db, alice.id, 'WRONG-CODE')).toBe(false);
    expect(countRemainingRecoveryCodes(db, alice.id)).toBe(3);

    expect(await verifyAndConsumeRecoveryCode(db, alice.id, codes[0])).toBe(true);
    expect(countRemainingRecoveryCodes(db, alice.id)).toBe(2);

    expect(await verifyAndConsumeRecoveryCode(db, alice.id, codes[0])).toBe(false);
    expect(countRemainingRecoveryCodes(db, alice.id)).toBe(2);
  });

  it('regenerating invalidates the entire previous set', async () => {
    const oldCodes = await generateRecoveryCodes(db, alice.id, { count: 3 });
    const newCodes = await generateRecoveryCodes(db, alice.id, { count: 2 });

    expect(countRemainingRecoveryCodes(db, alice.id)).toBe(2);
    expect(await verifyAndConsumeRecoveryCode(db, alice.id, oldCodes[0])).toBe(false);
    expect(await verifyAndConsumeRecoveryCode(db, alice.id, newCodes[0])).toBe(true);
  });

  it('starts at zero remaining codes for a user who never generated any', () => {
    expect(countRemainingRecoveryCodes(db, alice.id)).toBe(0);
  });
});
