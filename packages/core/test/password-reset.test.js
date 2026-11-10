import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { createSqliteAdapter } from '../src/database/index.js';
import { createUser, findUserByEmail } from '../src/auth/users.js';
import { createPasswordResetToken, peekPasswordResetToken, consumePasswordResetToken, purgePasswordResetTokens } from '../src/auth/password-reset.js';
import { emailChecks, senderDomain } from '../src/email/index.js';

describe('password reset tokens', () => {
  let db;
  let alice;
  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
    alice = createUser(db, { username: 'alice', passwordHash: 'h', email: 'Alice@Example.com' });
  });
  afterEach(() => db.close());

  it('a token works once; only its hash is stored', () => {
    const { token } = createPasswordResetToken(db, alice.id);
    expect(db.all('SELECT token_hash FROM password_resets').some((r) => r.token_hash === token)).toBe(false);
    expect(peekPasswordResetToken(db, token)).toEqual({ userId: alice.id });
    expect(peekPasswordResetToken(db, token)).toEqual({ userId: alice.id }); // peeking does not use it up
    expect(consumePasswordResetToken(db, token)).toEqual({ userId: alice.id });
    expect(consumePasswordResetToken(db, token)).toBeNull();
    expect(peekPasswordResetToken(db, token)).toBeNull();
  });

  it('expired, unknown, malformed tokens are refused', () => {
    const { token } = createPasswordResetToken(db, alice.id, { ttlMinutes: 10, now: 1_000_000 });
    expect(consumePasswordResetToken(db, token, { now: 1_000_000 + 11 * 60_000 })).toBeNull();
    for (const bad of ['', 'short', 'x'.repeat(300), undefined, null, 42]) expect(consumePasswordResetToken(db, bad)).toBeNull();
    expect(consumePasswordResetToken(db, 'A'.repeat(43))).toBeNull();
  });

  it('a new token cancels the user\'s earlier ones, not other users\'', () => {
    const bob = createUser(db, { username: 'bob', passwordHash: 'h' });
    const first = createPasswordResetToken(db, alice.id).token;
    const bobs = createPasswordResetToken(db, bob.id).token;
    const second = createPasswordResetToken(db, alice.id).token;
    expect(consumePasswordResetToken(db, first)).toBeNull();
    expect(consumePasswordResetToken(db, second)).toEqual({ userId: alice.id });
    expect(consumePasswordResetToken(db, bobs)).toEqual({ userId: bob.id });
  });

  it('purge removes only tokens that expired long ago', () => {
    createPasswordResetToken(db, alice.id, { ttlMinutes: 1, now: 0 });
    createPasswordResetToken(db, alice.id, { ttlMinutes: 30, now: 10 * 3_600_000 });
    expect(purgePasswordResetTokens(db, { olderThanMs: 3_600_000, now: 10 * 3_600_000 })).toBe(1);
    expect(db.all('SELECT id FROM password_resets')).toHaveLength(1);
  });

  it('findUserByEmail: case-insensitive, and null when the address is shared or unknown', () => {
    expect(findUserByEmail(db, 'alice@example.com').id).toBe(alice.id);
    expect(findUserByEmail(db, 'nobody@example.com')).toBeNull();
    createUser(db, { username: 'twin', passwordHash: 'h', email: 'alice@example.com' });
    expect(findUserByEmail(db, 'alice@example.com')).toBeNull();
    expect(findUserByEmail(db, '')).toBeNull();
  });
});

describe('emailChecks (doctor)', () => {
  const resolver = (records) => ({
    resolveTxt: async (name) => {
      if (!(name in records)) throw Object.assign(new Error('nx'), { code: 'ENODATA' });
      return records[name].map((r) => [r]);
    },
  });
  const good = { 'example.com': ['v=spf1 -all'], '_dmarc.example.com': ['v=DMARC1; p=reject'] };
  const cfg = { enabled: true, from: 'DAS <noreply@example.com>', smtp: { host: 'smtp.example.com', port: 587 } };

  it('disabled mail is reported as fine', async () => {
    expect(await emailChecks({ enabled: false }, { verify: async () => ({ ok: false }) })).toEqual([{ name: 'E-mail', status: 'ok', message: 'disabled (email.enabled is false)' }]);
  });

  it('a healthy setup is all ok', async () => {
    const r = await emailChecks(cfg, { verify: async () => ({ ok: true }) }, { resolver: resolver(good) });
    expect(r.map((x) => x.status)).toEqual(['ok', 'ok']);
  });

  it('SMTP failure is a fail; weak TLS settings and missing DNS records are warnings', async () => {
    const r = await emailChecks(
      { ...cfg, smtp: { ...cfg.smtp, rejectUnauthorized: false, requireTLS: false } },
      { verify: async () => ({ ok: false, error: 'SMTP server refused the login' }) },
      { resolver: resolver({}) }
    );
    expect(r.find((x) => x.name === 'SMTP reachable')).toMatchObject({ status: 'fail' });
    expect(r.filter((x) => x.status === 'warn').length).toBe(4); // certificate, encryption, SPF, DMARC
  });

  it('DNS failure and an unusable sender address are warnings, never exceptions', async () => {
    const broken = { resolveTxt: async () => { throw Object.assign(new Error('x'), { code: 'ESERVFAIL' }); } };
    const r1 = await emailChecks(cfg, { verify: async () => ({ ok: true }) }, { resolver: broken });
    expect(r1[1].status).toBe('warn');
    const r2 = await emailChecks({ ...cfg, from: 'not an address' }, { verify: async () => ({ ok: true }) });
    expect(r2[1]).toMatchObject({ name: 'Sender domain', status: 'warn' });
  });

  it('senderDomain understands both forms', () => {
    expect(senderDomain('DAS <noreply@Example.com>')).toBe('example.com');
    expect(senderDomain('noreply@example.com')).toBe('example.com');
    expect(senderDomain('nonsense')).toBeNull();
  });
});
