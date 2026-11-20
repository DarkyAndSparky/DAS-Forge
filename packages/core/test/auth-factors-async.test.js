import { describe, it, expect } from 'vitest';
import { createSqliteAdapter, asyncDb } from '../src/database/index.js';
import * as auth from '../src/auth/index.js';

const fresh = () => createSqliteAdapter({ file: ':memory:', walMode: false });
async function withUser() {
  const db = fresh();
  const u = await auth.createUserAsync(db, { username: 'zed', passwordHash: 'h' });
  return { db, u };
}

describe('asynchronous second factors', () => {
  it('enrol, activate, log in with replay protection, remove (last required factor is kept)', async () => {
    const { db, u } = await withUser();
    const e = await auth.startTotpEnrollmentAsync(db, u.id, { accountName: 'zed', name: 'phone' });
    expect(e.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(await auth.verifyTotpEnrollmentAsync(db, e.authenticatorId, '000000', { userId: u.id })).toBe(false);
    expect(await auth.verifyTotpEnrollmentAsync(db, e.authenticatorId, auth.generateTotp(e.secret), { userId: u.id + 1 })).toBe(false); // not theirs
    expect(await auth.verifyTotpEnrollmentAsync(db, e.authenticatorId, auth.generateTotp(e.secret), { userId: u.id })).toBe(true);
    expect((await auth.listAuthenticatorsAsync(db, u.id))[0]).toMatchObject({ status: 'active', name: 'phone' });
    const code = auth.generateTotp(e.secret);
    expect(await auth.verifyTotpLoginAsync(db, u.id, code)).toBe(e.authenticatorId);
    expect(await auth.verifyTotpLoginAsync(db, u.id, code)).toBeNull(); // the same step cannot be used twice
    expect(await auth.removeAuthenticatorAsync(db, u.id, e.authenticatorId, { mfaRequired: true })).toEqual({ ok: false, reason: 'last_required_factor' });
    expect(await auth.removeAuthenticatorAsync(db, u.id, 999)).toEqual({ ok: false, reason: 'not_found' });
    expect(await auth.removeAuthenticatorAsync(db, u.id, e.authenticatorId)).toEqual({ ok: true });
  });

  it('the secret is sealed when a key is given, and an unreadable one just does not match', async () => {
    const { db, u } = await withUser();
    const key = 'k'.repeat(32);
    const e = await auth.startTotpEnrollmentAsync(db, u.id, { accountName: 'zed', encryptionKey: key });
    expect(db.get('SELECT secret FROM totp_credentials').secret).not.toBe(e.secret);
    expect(await auth.verifyTotpEnrollmentAsync(db, e.authenticatorId, auth.generateTotp(e.secret), { userId: u.id, encryptionKey: key })).toBe(true);
    expect(await auth.verifyTotpLoginAsync(db, u.id, auth.generateTotp(e.secret), { encryptionKey: key })).toBe(e.authenticatorId);
  });

  it('expired pending enrolments are purged', async () => {
    const { db, u } = await withUser();
    await auth.startTotpEnrollmentAsync(db, u.id, { accountName: 'zed', ttlMinutes: -1 });
    await auth.purgeExpiredPendingAuthenticatorsAsync(db);
    expect((await auth.listAuthenticatorsAsync(db, u.id)).length).toBe(0);
  });
});

describe('asynchronous recovery codes', () => {
  it('a new set replaces the old; a code works once; the count goes down', async () => {
    const { db, u } = await withUser();
    const first = await auth.generateRecoveryCodesAsync(db, u.id, { count: 3 });
    const second = await auth.generateRecoveryCodesAsync(db, u.id, { count: 3 });
    expect(await auth.countRemainingRecoveryCodesAsync(db, u.id)).toBe(3);
    expect(await auth.verifyAndConsumeRecoveryCodeAsync(db, u.id, first[0])).toBe(false);
    expect(await auth.verifyAndConsumeRecoveryCodeAsync(db, u.id, second[1])).toBe(true);
    expect(await auth.verifyAndConsumeRecoveryCodeAsync(db, u.id, second[1])).toBe(false);
    expect(await auth.countRemainingRecoveryCodesAsync(db, u.id)).toBe(2);
  });
});

describe('asynchronous password reset tokens', () => {
  it('single use, expiry, a newer token cancels the older, purge', async () => {
    const { db, u } = await withUser();
    const t1 = await auth.createPasswordResetTokenAsync(db, u.id);
    expect(await auth.peekPasswordResetTokenAsync(db, t1.token)).toEqual({ userId: u.id });
    const t2 = await auth.createPasswordResetTokenAsync(db, u.id);
    expect(await auth.consumePasswordResetTokenAsync(db, t1.token)).toBeNull();
    expect(await auth.consumePasswordResetTokenAsync(db, t2.token)).toEqual({ userId: u.id });
    expect(await auth.consumePasswordResetTokenAsync(db, t2.token)).toBeNull();
    expect(await auth.peekPasswordResetTokenAsync(db, 'short')).toBeNull();
    const t3 = await auth.createPasswordResetTokenAsync(db, u.id, { ttlMinutes: 1, now: Date.now() - 3_600_000 });
    expect(await auth.peekPasswordResetTokenAsync(db, t3.token)).toBeNull();
    expect(await auth.purgePasswordResetTokensAsync(db, { olderThanMs: 0 })).toBeGreaterThanOrEqual(1);
  });
  it('is compatible with the synchronous functions (same hash)', async () => {
    const { db, u } = await withUser();
    const t = await auth.createPasswordResetTokenAsync(db, u.id);
    expect(auth.peekPasswordResetToken(db, t.token)).toEqual({ userId: u.id });
  });
});

describe('asynchronous known devices', () => {
  it('first device is silent, an unknown one is new, a known one is recognised', async () => {
    const { db, u } = await withUser();
    const a = await auth.recognizeDeviceAsync(db, { userId: u.id, ip: '1.1.1.1', userAgent: 'x' });
    expect(a).toMatchObject({ isNew: true, firstEver: true });
    const again = await auth.recognizeDeviceAsync(db, { userId: u.id, deviceId: a.deviceId });
    expect(again).toMatchObject({ isNew: false, deviceId: a.deviceId });
    const other = await auth.recognizeDeviceAsync(db, { userId: u.id, deviceId: 'bad' });
    expect(other).toMatchObject({ isNew: true, firstEver: false });
    expect(await asyncDb(db).get('SELECT COUNT(*) AS n FROM login_devices')).toEqual({ n: 2 });
  });
});
