import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { createSqliteAdapter } from '../src/database/index.js';
import { log, purgeOlderThan, verifyChain, query } from '../src/audit/index.js';
import { createEmailQueue } from '../src/email/index.js';
import { hashPassword, configurePasswordConcurrency, passwordConcurrencyStats, PasswordBusyError } from '../src/auth/password.js';
import * as auth from '../src/auth/index.js';
import { ApplicationConfigSchema } from '../src/config/schema.js';

/** Audit 0.1.79: F02/I06 (audit retention), F05 (queue), I01 (password gate), K02 (TOTP key rotation). */

describe('I06/F02: purge in batches', () => {
  it('removes everything older than the cutoff across several batches and keeps the chain valid', () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    for (let i = 0; i < 7; i++) log(db, { actor: 'a', action: `old${i}` });
    db.exec('DROP TRIGGER audit_log_no_update');
    db.run(`UPDATE audit_log SET created_at = '2020-01-01T00:00:00.000Z'`);
    db.exec(`CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;`);
    log(db, { actor: 'a', action: 'fresh' });
    const removed = purgeOlderThan(db, '2021-01-01T00:00:00.000Z', { batchSize: 3, record: true, actor: 'system' });
    expect(removed).toBe(7);
    expect(query(db, { action: 'fresh' })).toHaveLength(1);
    expect(query(db, { action: 'audit.purge' })[0].meta).toMatchObject({ removed: 7 });
    expect(verifyChain(db).ok).toBe(true);
    db.close();
  });
  it('the config has a retention default and validates it', () => {
    const cfg = ApplicationConfigSchema.parse({ appName: 'x', auth: { sessionSecret: 'a'.repeat(20) } });
    expect(cfg.audit.retentionDays).toBe(365);
    expect(cfg.email.queue.pendingTtlHours).toBe(72);
    expect(cfg.auth.argon2.maxConcurrent).toBe(2);
  });
});

describe('F05: the mail queue and erased people', () => {
  const mail = (to) => ({ from: 'a@x.org', to: [to], subject: 'S', text: 'https://x/#token=SECRET', html: '', headers: {} });
  it('cancelForAddress cancels waiting mail and wipes the body; others stay', async () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    const queue = createEmailQueue({ db, send: async () => ({}) });
    queue.enqueue(mail('Alice@Example.com'));
    queue.enqueue(mail('bob@example.com'));
    expect(queue.cancelForAddress('alice@example.com')).toBe(1);
    const rows = db.all('SELECT status, payload, last_error FROM email_queue ORDER BY id');
    expect(rows[0]).toEqual({ status: 'failed', payload: null, last_error: 'CANCELLED' });
    expect(rows[1].status).toBe('pending');
    expect(queue.cancelForAddress('nobody@example.com')).toBe(0);
    db.close();
  });
  it('a mail waiting longer than the TTL is dropped with its body', async () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    const clock = { t: Date.parse('2026-01-01T00:00:00Z') };
    const sent = [];
    const queue = createEmailQueue({ db, send: async (m) => sent.push(m), now: () => clock.t, pendingTtlMs: 1000 });
    queue.enqueue(mail('a@example.com'));
    clock.t += 5000;
    await queue.processDue();
    expect(sent).toHaveLength(0);
    expect(db.get('SELECT status, payload, last_error FROM email_queue')).toEqual({ status: 'failed', payload: null, last_error: 'EXPIRED' });
    db.close();
  });
});

describe('I01: password concurrency gate', () => {
  afterEach(() => configurePasswordConcurrency({ maxConcurrent: 2, maxQueue: 64 }));
  it('refuses work beyond the queue with PasswordBusyError (503) and recovers', async () => {
    configurePasswordConcurrency({ maxConcurrent: 1, maxQueue: 1 });
    const results = await Promise.allSettled([hashPassword('password-one-1'), hashPassword('password-two-2'), hashPassword('password-three-3')]);
    const busy = results.filter((r) => r.status === 'rejected' && r.reason instanceof PasswordBusyError);
    expect(busy).toHaveLength(1);
    expect(busy[0].reason.status).toBe(503);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(passwordConcurrencyStats().active).toBe(0);
    await hashPassword('password-four-4'); // still works afterwards
  });
});

describe('K02: TOTP key rotation', () => {
  const OLD = 'old-totp-key-0123456789abcdef';
  const NEW = 'new-totp-key-0123456789abcdef';
  let db;
  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
    auth.createUser(db, { username: 'u', passwordHash: 'x', role: 'operator' });
  });
  afterEach(() => db.close());

  it('a list opens with any key, seals with the first, and sealExisting re-encrypts old rows', () => {
    const sealedOld = auth.sealSecret('JBSWY3DPEHPK3PXP', OLD);
    expect(auth.openSecret(sealedOld, [NEW, OLD])).toBe('JBSWY3DPEHPK3PXP');
    expect(() => auth.openSecret(sealedOld, [NEW])).toThrow();
    const fresh = auth.sealSecret('JBSWY3DPEHPK3PXP', [NEW, OLD]);
    expect(auth.openSecret(fresh, NEW)).toBe('JBSWY3DPEHPK3PXP');

    const id = db.run(`INSERT INTO authenticators (user_id, type, status) VALUES (1, 'totp', 'active')`).lastInsertRowid;
    db.run(`INSERT INTO totp_credentials (authenticator_id, secret) VALUES (?, ?)`, [id, sealedOld]);
    expect(auth.sealExistingTotpSecrets(db, [NEW, OLD])).toBe(1);
    expect(auth.openSecret(db.get('SELECT secret FROM totp_credentials').secret, NEW)).toBe('JBSWY3DPEHPK3PXP');
    expect(auth.sealExistingTotpSecrets(db, [NEW, OLD])).toBe(0); // idempotent
  });

  it('an unreadable secret makes the factor fail, not the login throw', () => {
    const id = db.run(`INSERT INTO authenticators (user_id, type, status) VALUES (1, 'totp', 'active')`).lastInsertRowid;
    db.run(`INSERT INTO totp_credentials (authenticator_id, secret) VALUES (?, ?)`, [id, auth.sealSecret('JBSWY3DPEHPK3PXP', OLD)]);
    expect(auth.verifyTotpLogin(db, 1, '123456', { encryptionKey: NEW })).toBe(null);
  });
});
