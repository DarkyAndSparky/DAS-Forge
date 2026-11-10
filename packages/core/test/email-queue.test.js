import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { createEmailQueue, createEmailService, EmailError } from '../src/email/index.js';

const mail = (to = 'alice@example.com') => ({ from: 'app@example.com', to: [to], subject: 'S', text: 'link https://x/#token=SECRET', html: '<p>x</p>', headers: {} });

function setup(sendImpl, opts = {}) {
  const db = createSqliteAdapter({ file: ':memory:' });
  const clock = { t: Date.parse('2026-01-01T00:00:00Z') };
  const sent = [];
  const send = async (m) => {
    sent.push(m);
    return sendImpl ? sendImpl(m, sent.length) : { sent: true };
  };
  const queue = createEmailQueue({ db, send, baseDelayMs: 1000, maxAttempts: 3, now: () => clock.t, random: () => 1, ...opts });
  return { db, clock, sent, queue };
}

describe('email queue', () => {
  it('stores first, sends on processDue, and wipes the body afterwards', async () => {
    const { db, queue, sent } = setup();
    queue.enqueue(mail(), { scenario: 'passwordReset' });
    expect(db.get('SELECT payload FROM email_queue').payload).toContain('SECRET');
    expect(queue.stats()).toEqual({ pending: 1, sending: 0, sent: 0, failed: 0 });
    expect(await queue.processDue()).toEqual({ sent: 1, retried: 0, failed: 0 });
    expect(sent.length).toBe(1);
    const row = db.get('SELECT * FROM email_queue');
    expect(row.status).toBe('sent');
    expect(row.payload).toBe(null);
    expect(row.recipients).toBe('["a***@example.com"]');
  });

  it('retries a failure with doubling pauses and succeeds later', async () => {
    const { queue, clock, sent } = setup((m, n) => {
      if (n < 3) throw new EmailError('EMAIL_UNREACHABLE', 'down');
      return { sent: true };
    });
    queue.enqueue(mail());
    expect((await queue.processDue()).retried).toBe(1);
    expect((await queue.processDue()).sent).toBe(0); // not due yet
    clock.t += 1000;
    expect((await queue.processDue()).retried).toBe(1); // second failure, next pause 2000
    clock.t += 1999;
    expect((await queue.processDue()).sent).toBe(0);
    clock.t += 1;
    expect((await queue.processDue()).sent).toBe(1);
    expect(sent.length).toBe(3);
    expect(queue.stats().sent).toBe(1);
  });

  it('fails for good after maxAttempts and keeps no body', async () => {
    const { db, queue, clock } = setup(() => {
      throw new EmailError('EMAIL_UNREACHABLE', 'down');
    });
    queue.enqueue(mail());
    for (let i = 0; i < 3; i++) {
      await queue.processDue();
      clock.t += 10_000;
    }
    const row = db.get('SELECT * FROM email_queue');
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(3);
    expect(row.last_error).toBe('EMAIL_UNREACHABLE');
    expect(row.payload).toBe(null);
  });

  it('a refusal that cannot succeed later fails immediately', async () => {
    const { db, queue } = setup(() => {
      throw new EmailError('EMAIL_REJECTED', 'no');
    });
    queue.enqueue(mail());
    expect((await queue.processDue()).failed).toBe(1);
    expect(db.get('SELECT attempts FROM email_queue').attempts).toBe(1);
    const perm = setup(() => {
      throw new EmailError('EMAIL_SEND_FAILED', 'x', { cause: Object.assign(new Error('x'), { responseCode: 550 }) });
    });
    perm.queue.enqueue(mail());
    expect((await perm.queue.processDue()).failed).toBe(1);
  });

  it('a mail survives a restart: a second queue on the same database sends it', async () => {
    const { db, queue } = setup();
    queue.enqueue(mail());
    const sent2 = [];
    const again = createEmailQueue({ db, send: async (m) => sent2.push(m), now: () => Date.parse('2026-01-01T00:00:01Z') });
    expect((await again.processDue()).sent).toBe(1);
    expect(sent2.length).toBe(1);
  });

  it('a row claimed by a crashed process is picked up again after lockMs', async () => {
    const { db, queue, clock, sent } = setup(null, { lockMs: 5000 });
    queue.enqueue(mail());
    db.run(`UPDATE email_queue SET status = 'sending', locked_at = ?`, [new Date(clock.t).toISOString()]);
    expect((await queue.processDue()).sent).toBe(0);
    clock.t += 5001;
    expect((await queue.processDue()).sent).toBe(1);
    expect(sent.length).toBe(1);
  });

  it('refuses to grow without bound and purges finished rows', async () => {
    const { db, queue, clock } = setup(null, { maxPending: 2 });
    queue.enqueue(mail());
    queue.enqueue(mail());
    expect(() => queue.enqueue(mail())).toThrow(/full/);
    await queue.processDue();
    expect(queue.purgeFinished({ olderThanDays: 7 })).toBe(0);
    clock.t += 8 * 86_400_000;
    expect(queue.purgeFinished({ olderThanDays: 7 })).toBe(2);
    expect(db.get('SELECT COUNT(*) AS n FROM email_queue').n).toBe(0);
  });
});

describe('email service with a queue', () => {
  it('stores instead of sending inside the call; the queue delivers through sendRaw', async () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    const calls = [];
    const transport = { sendMail: async (m) => (calls.push(m), { messageId: 'id1' }) };
    let service;
    const queue = createEmailQueue({ db, send: (m) => service.sendRaw(m) });
    service = createEmailService({ config: { enabled: true, from: 'app@example.com' }, transport, queue });
    const r = await service.sendPasswordReset({ to: 'a@example.com', resetUrl: 'https://app.example.com/reset-password#token=T', expiresInMinutes: 30 });
    expect(r).toMatchObject({ sent: false, queued: true });
    expect(calls.length).toBe(0);
    expect((await queue.processDue()).sent).toBe(1);
    expect(calls.length).toBe(1);
    expect(calls[0].to).toEqual(['a@example.com']);
  });
});
