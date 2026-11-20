import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { createFailureTracker } from '../src/http/rate-limit.js';
import { createFailureStore } from '../src/security/failure-store.js';

const mem = () => createSqliteAdapter({ file: ':memory:' });
const opts = (db, scope, extra = {}) => ({ maxFailures: 3, baseLockMs: 60_000, maxLockMs: 600_000, resetAfterMs: 600_000, store: createFailureStore(db, { scope }), flushMs: 10_000, ...extra });
const count = (db) => db.get('SELECT COUNT(*) AS n FROM auth_failure_counters').n;

describe('persistent failure counters', () => {
  it('a lock survives re-creating the tracker (restart)', async () => {
    const db = mem(); let t = 1_000_000;
    const a = createFailureTracker({ ...opts(db, 'login-pair'), now: () => t });
    for (let i = 0; i < 3; i += 1) a.recordFailure('bob|1.2.3.4');
    expect(a.check('bob|1.2.3.4').locked).toBe(true);
    await a.close();
    const b = createFailureTracker({ ...opts(db, 'login-pair'), now: () => t + 1000 });
    expect(b.check('bob|1.2.3.4').locked).toBe(false); // nothing loaded yet
    await b.hydrate();
    const r = b.check('bob|1.2.3.4');
    expect(r.locked).toBe(true);
    expect(r.retryAfterMs).toBeGreaterThan(50_000);
    expect(b.list()).toHaveLength(1);
    await b.close();
  });
  it('two trackers on one database: a lock set by one is taken over by the other', async () => {
    const db = mem();
    const a = createFailureTracker(opts(db, 'login-ip'));
    const b = createFailureTracker(opts(db, 'login-ip'));
    for (let i = 0; i < 3; i += 1) a.recordFailure('9.9.9.9');
    await a.flush();
    expect(b.check('9.9.9.9').locked).toBe(false);
    await b.refresh();
    expect(b.check('9.9.9.9').locked).toBe(true);
    await a.close(); await b.close();
  });
  it('scopes are separate', async () => {
    const db = mem();
    const a = createFailureTracker(opts(db, 'login-ip')); const m = createFailureTracker(opts(db, 'mfa'));
    for (let i = 0; i < 3; i += 1) a.recordFailure('7');
    await a.close(); await m.hydrate();
    expect(m.check('7').locked).toBe(false);
  });
  it('reset and resetPrefix remove the stored rows', async () => {
    const db = mem();
    const a = createFailureTracker(opts(db, 'login-pair'));
    a.recordFailure('ann|1'); a.recordFailure('ann|2'); a.recordFailure('bob|1');
    await a.flush();
    expect(count(db)).toBe(3);
    a.reset('bob|1'); a.resetPrefix('ann|');
    await a.flush();
    expect(count(db)).toBe(0);
    a.recordFailure('x%_|1'); a.recordFailure('xAB|1');
    await a.flush();
    a.resetPrefix('x%_|');
    await a.flush();
    expect(count(db)).toBe(1); // the prefix is a literal, not a LIKE pattern
    await a.close();
  });
  it('expired and quiet counters are not loaded and purgeStore deletes them', async () => {
    const db = mem(); let t = 5_000_000;
    const a = createFailureTracker({ ...opts(db, 'login-user'), now: () => t });
    a.recordFailure('old');
    await a.close();
    t += 700_000; // quiet longer than resetAfterMs, never locked
    const b = createFailureTracker({ ...opts(db, 'login-user'), now: () => t });
    expect(await b.hydrate()).toBe(0);
    await b.purgeStore();
    expect(count(db)).toBe(0);
  });
  it('writes are coalesced: 5000 failures on one key are one row, many keys go in batches of maxBatch', async () => {
    const db = mem(); const calls = [];
    const real = createFailureStore(db, { scope: 'login-ip' });
    const store = { ...real, save: async (rows) => { calls.push(rows.length); return real.save(rows); } };
    const a = createFailureTracker({ ...opts(db, 'login-ip'), store, maxFailures: 100_000, maxBatch: 200 });
    for (let i = 0; i < 5000; i += 1) a.recordFailure('same');
    await a.flush();
    expect(calls).toEqual([1]);
    expect(count(db)).toBe(1);
    for (let i = 0; i < 1000; i += 1) a.recordFailure(`k${i}`);
    calls.length = 0;
    await a.flush();
    expect(calls).toEqual([200]); // one batch per flush; the rest waits for the next one
    expect(Math.max(...calls) <= 200).toBe(true);
    await a.close();
  });
  it('a failing database never breaks check/recordFailure', async () => {
    const store = { load: async () => { throw new Error('down'); }, save: async () => { throw new Error('down'); }, remove: async () => {}, removePrefix: async () => {}, purge: async () => {} };
    const a = createFailureTracker({ maxFailures: 2, store, flushMs: 5 });
    a.recordFailure('k'); const r = a.recordFailure('k');
    expect(r.locked).toBe(true);
    let e; try { await a.flush(); } catch (x) { e = x; }
    expect(e && e.message).toBe('down');
  });
  it('without a store nothing changes', async () => {
    const a = createFailureTracker({ maxFailures: 2 });
    a.recordFailure('k'); expect(a.recordFailure('k').locked).toBe(true);
    expect(await a.hydrate()).toBe(0);
    await a.close();
  });
});
