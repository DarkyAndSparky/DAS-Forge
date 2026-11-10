import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { createSqliteAdapter } from '../src/database/index.js';
import { createUser, anonymizeUser, deleteUser } from '../src/auth/users.js';
import { destroyUserSessions } from '../src/auth/sessions.js';
import { createSession, verifySession } from './helpers/session-fixtures.js';
import { startTotpEnrollment, verifyTotpEnrollment } from '../src/auth/authenticators.js';
import { generateTotp } from '../src/auth/totp.js';

describe('session revocation (audit A05)', () => {
  let db;
  let alice;
  let bob;

  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
    alice = createUser(db, { username: 'alice', passwordHash: 'h' });
    bob = createUser(db, { username: 'bob', passwordHash: 'h' });
  });

  afterEach(() => {
    db.close();
  });

  it('destroyUserSessions removes every session of that user only', () => {
    const a1 = createSession(db, { userId: alice.id, ttlMs: 60_000 });
    const a2 = createSession(db, { userId: alice.id, ttlMs: 60_000 });
    const b1 = createSession(db, { userId: bob.id, ttlMs: 60_000 });
    expect(destroyUserSessions(db, alice.id)).toBe(2);
    expect(verifySession(db, a1.id)).toBeNull();
    expect(verifySession(db, a2.id)).toBeNull();
    expect(verifySession(db, b1.id)).toBeTruthy();
  });

  it('exceptSessionId keeps the caller\'s own session', () => {
    const keep = createSession(db, { userId: alice.id, ttlMs: 60_000 });
    const other = createSession(db, { userId: alice.id, ttlMs: 60_000 });
    expect(destroyUserSessions(db, alice.id, { exceptSessionId: keep.id })).toBe(1);
    expect(verifySession(db, keep.id)).toBeTruthy();
    expect(verifySession(db, other.id)).toBeNull();
  });

  it('returns 0 when the user has no sessions', () => {
    expect(destroyUserSessions(db, alice.id)).toBe(0);
  });

  it('anonymizeUser revokes the user\'s sessions', () => {
    const s = createSession(db, { userId: bob.id, ttlMs: 60_000 });
    anonymizeUser(db, bob.id);
    expect(verifySession(db, s.id)).toBeNull();
  });

  it('deleteUser revokes the user\'s sessions', () => {
    const s = createSession(db, { userId: bob.id, ttlMs: 60_000 });
    deleteUser(db, bob.id);
    expect(verifySession(db, s.id)).toBeNull();
  });
});

describe('TOTP enrollment ownership (audit A08)', () => {
  let db;
  let dave;
  let eve;

  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
    dave = createUser(db, { username: 'dave', passwordHash: 'h' });
    eve = createUser(db, { username: 'eve', passwordHash: 'h' });
  });

  afterEach(() => {
    db.close();
  });

  it('another user cannot activate someone else\'s pending factor, even with the right code', () => {
    const enroll = startTotpEnrollment(db, dave.id, { accountName: 'dave' });
    const code = generateTotp(enroll.secret);
    expect(verifyTotpEnrollment(db, enroll.authenticatorId, code, { userId: eve.id })).toBe(false);
    expect(db.get('SELECT status FROM authenticators WHERE id = ?', [enroll.authenticatorId]).status).toBe('pending');
  });

  it('the owner can activate it', () => {
    const enroll = startTotpEnrollment(db, dave.id, { accountName: 'dave' });
    expect(verifyTotpEnrollment(db, enroll.authenticatorId, generateTotp(enroll.secret), { userId: dave.id })).toBe(true);
  });

  it('a call without userId keeps working (backward compatible)', () => {
    const enroll = startTotpEnrollment(db, dave.id, { accountName: 'dave' });
    expect(verifyTotpEnrollment(db, enroll.authenticatorId, generateTotp(enroll.secret))).toBe(true);
  });
});
