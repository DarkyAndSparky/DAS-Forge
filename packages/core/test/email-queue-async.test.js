import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { createEmailQueue, ensureEmailQueueTableAsync } from '../src/email/queue.js';

const fresh = () => createSqliteAdapter({ file: ':memory:', walMode: false });

describe('e-mail queue over the asynchronous database', () => {
  it('enqueues, sends, wipes the body, retries, fails for good', async () => {
    const db = fresh();
    await ensureEmailQueueTableAsync(db);
    let t = 1_000_000;
    const sent = [];
    let mode = 'ok';
    const q = createEmailQueue({
      db, now: () => t, baseDelayMs: 1000, maxAttempts: 2, random: () => 0.5,
      send: async (m) => {
        if (mode === 'temp') throw Object.assign(new Error('x'), { code: 'ETIMEDOUT' });
        if (mode === 'reject') throw Object.assign(new Error('x'), { code: 'EMAIL_REJECTED' });
        sent.push(m.subject);
      },
    });
    const { id } = await q.enqueueAsync({ to: ['alice@example.com'], subject: 'Hi' }, { scenario: 'reset' });
    expect((await q.listAsync())[0].recipients).toEqual(['a***@example.com']);
    expect(await q.processDueAsync()).toEqual({ sent: 1, retried: 0, failed: 0 });
    expect(sent).toEqual(['Hi']);
    expect(db.get('SELECT payload FROM email_queue WHERE id = ?', [id]).payload).toBeNull();
    expect((await q.statsAsync()).sent).toBe(1);

    mode = 'temp';
    await q.enqueueAsync({ to: ['b@example.com'], subject: 'Retry' });
    expect((await q.processDueAsync()).retried).toBe(1);
    t += 10 * 60_000;
    expect((await q.processDueAsync()).failed).toBe(1);
    mode = 'reject';
    await q.enqueueAsync({ to: ['c@example.com'], subject: 'Rej' });
    expect((await q.processDueAsync()).failed).toBe(1);
    expect(q.stats().failed).toBe(2);
    t += 8 * 86_400_000;
    expect(await q.purgeFinishedAsync()).toBe(3);
  });
  it('cancels by address and by id, refuses beyond maxPending, expires stale mail', async () => {
    const db = fresh();
    await ensureEmailQueueTableAsync(db);
    let t = 5_000_000;
    const q = createEmailQueue({ db, send: async () => {}, now: () => t, maxPending: 3, pendingTtlMs: 1000 });
    await q.enqueueAsync({ to: ['x@example.com'], subject: '1' });
    const two = await q.enqueueAsync({ to: ['y@example.com'], subject: '2' });
    await q.enqueueAsync({ to: ['z@example.com'], subject: '3' });
    let err;
    try { await q.enqueueAsync({ to: ['w@example.com'], subject: '4' }); } catch (e) { err = e; }
    expect(err?.code).toBe('EMAIL_QUEUE_FULL');
    expect(await q.cancelForAddressAsync('X@example.com')).toBe(1);
    expect(await q.cancelAsync(two.id)).toBe(true);
    expect(await q.cancelAsync(two.id)).toBe(false);
    t += 5000;
    expect(await q.expireStaleAsync()).toBe(1);
    expect((await q.statsAsync()).pending).toBe(0);
  });
});
