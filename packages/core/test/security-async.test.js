import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { createBans, createBansAsync, createIpBanPolicy, createIpBanPolicyAsync, SYSTEM_BAN_AUTHOR } from '../src/security/index.js';
import * as auth from '../src/auth/index.js';
import { queryAsync, verifyChainAsync } from '../src/audit/index.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
async function setup(config = {}) {
  const db = createSqliteAdapter({ file: ':memory:', walMode: false });
  await auth.ensureAuthTablesAsync(db);
  const clock = { t: Date.parse('2026-11-01T10:00:00Z') };
  const now = () => clock.t;
  const bans = createBansAsync(db, { cacheMs: 0, now });
  const policy = createIpBanPolicyAsync({ db, bans, config, now });
  const fail = async (ip, n = 1) => { let r; for (let i = 0; i < n; i += 1) { clock.t += 1000; r = await policy.recordFailure(ip); } return r; };
  return { db, bans, policy, clock, fail };
}

describe('asynchronous bans', () => {
  it('bans a whole network (CIDR) and lifts it', async () => {
    const { bans } = await setup();
    expect((await bans.ban({ kind: 'ip', value: '10.1.2.0/24', reason: 'botnet' })).value).toBe('10.1.2.0/24');
    expect((await bans.check({ ip: '10.1.2.77' }))?.reason).toBe('botnet');
    expect(await bans.check({ ip: '10.1.3.1' })).toBe(null);
    expect(await bans.lift({ kind: 'ip', value: '10.1.2.0/24' })).toBe(1);
    expect(await bans.check({ ip: '10.1.2.77' })).toBe(null);
  });

  it('bans an address and a user (ending sessions), writes the audit line, refuses a duplicate, lifts', async () => {
    const { db, bans } = await setup();
    const u = await auth.createUserAsync(db, { username: 'eve', passwordHash: 'h' });
    db.run('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', [auth.hashSessionId('s'), u.id, new Date().toISOString(), new Date(Date.now() + 1e6).toISOString()]);
    const b = await bans.ban({ kind: 'user', value: 'eve', reason: 'abuse', by: 'root' });
    expect(b).toMatchObject({ already: false, sessionsEnded: 1 });
    expect(db.get('SELECT COUNT(*) AS c FROM sessions').c).toBe(0);
    expect((await bans.ban({ kind: 'user', value: 'eve', by: 'root' })).already).toBe(true);
    expect(await bans.check({ username: 'eve' })).toMatchObject({ kind: 'user', value: 'eve' });
    await bans.ban({ kind: 'ip', value: '::ffff:1.2.3.4', durationMs: HOUR });
    expect((await bans.check({ ip: '1.2.3.4' })).value).toBe('1.2.3.4');
    expect(await bans.count()).toBe(2);
    expect(await bans.lift({ kind: 'ip', value: '1.2.3.4' })).toBe(1);
    expect(await bans.check({ ip: '1.2.3.4' })).toBeNull();
    expect((await bans.list({ active: false })).length).toBe(2);
    const actions = (await queryAsync(db, {})).map((e) => e.action).sort();
    expect(actions).toEqual(['security.ban', 'security.ban', 'security.unban']);
    expect((await verifyChainAsync(db)).ok).toBe(true);
    await expect(bans.ban({ kind: 'ip', value: 'not-an-ip' })).rejects.toThrow(/not an IP/);
  });

  it('the cache holds a verdict for cacheMs, and a ban made by the synchronous object is seen after it expires', async () => {
    const db = createSqliteAdapter({ file: ':memory:', walMode: false });
    const clock = { t: Date.now() };
    const bans = createBansAsync(db, { cacheMs: 5000, now: () => clock.t });
    expect(await bans.check({ ip: '9.9.9.9' })).toBeNull();
    createBans(db, { now: () => clock.t }).ban({ kind: 'ip', value: '9.9.9.9' });
    expect(await bans.check({ ip: '9.9.9.9' })).toBeNull(); // still the cached "no"
    clock.t += 6000;
    expect((await bans.check({ ip: '9.9.9.9' })).value).toBe('9.9.9.9');
  });

  it('purge removes old lifted and expired bans', async () => {
    const { db, bans, clock } = await setup();
    await bans.ban({ kind: 'ip', value: '5.5.5.5', durationMs: HOUR });
    clock.t += 200 * DAY;
    expect(await bans.purge({ keepDays: 180 })).toBe(1);
    expect(db.get('SELECT COUNT(*) AS c FROM security_bans').c).toBe(0);
  });

  it('the middleware stops a banned address with 403, lets others pass, and passes a lookup error on', async () => {
    const { bans } = await setup();
    await bans.ban({ kind: 'ip', value: '7.7.7.7' });
    const run = (mw, req) => new Promise((resolve) => {
      const res = { status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); return this; } };
      mw(req, res, (err) => resolve({ next: true, err }));
    });
    const mw = bans.middleware();
    expect((await run(mw, { ip: '7.7.7.7' })).code).toBe(403);
    expect((await run(mw, { ip: '7.7.7.8' })).next).toBe(true);
    const broken = createBansAsync({ async: { dialect: 'sqlite', exec: async () => { throw new Error('db down'); }, get: async () => undefined, all: async () => [], run: async () => ({}), transaction: async () => {} } }).middleware();
    expect((await run(broken, { ip: '1.1.1.1' })).err.message).toBe('db down');
  });
});

describe('asynchronous automatic ban of an address', () => {
  it('bans at the threshold, grows the term, uses the recidive rule, and agrees with the synchronous policy', async () => {
    const { db, bans, policy, clock, fail } = await setup({ maxFailures: 3 });
    expect(await fail('203.0.113.7', 2)).toMatchObject({ banned: false, reason: 'counted', count: 2 });
    expect(await fail('203.0.113.7')).toMatchObject({ banned: true, durationMs: HOUR });
    expect((await bans.check({ ip: '203.0.113.7' })).createdBy).toBe(SYSTEM_BAN_AUTHOR);
    expect((await bans.list())[0].reason).toMatch(/^auto: 3 failed/);
    expect(await fail('203.0.113.7')).toMatchObject({ banned: false, reason: 'already' });
    clock.t += 2 * HOUR;
    expect(await fail('203.0.113.7', 3)).toMatchObject({ banned: true, durationMs: 2 * HOUR });
    clock.t += 3 * HOUR;
    expect(await fail('203.0.113.7', 3)).toMatchObject({ banned: true, durationMs: 7 * DAY }); // 3rd ban in a day: repeat offender
    const sync = createIpBanPolicy({ db, bans: createBans(db, { cacheMs: 0, now: () => clock.t }), config: { maxFailures: 3 }, now: () => clock.t });
    expect(sync.get()).toEqual(await policy.get());
  });

  it('ignores listed addresses, disabled policy and junk; counts per address', async () => {
    const { policy, fail } = await setup({ maxFailures: 2, ignore: ['10.0.0.0/8'] });
    expect(await fail('10.1.2.3', 5)).toMatchObject({ banned: false, reason: 'ignored' });
    expect(await fail('not-an-ip')).toMatchObject({ reason: 'invalid' });
    expect(await policy.isIgnored('10.9.9.9')).toBe(true);
    expect(await policy.isIgnored('11.0.0.1')).toBe(false);
    await policy.set({ enabled: false });
    expect(await fail('203.0.113.9', 5)).toMatchObject({ reason: 'disabled' });
  });

  it('saves and resets the settings with the same checks; shares the row with the synchronous policy', async () => {
    const { db, policy } = await setup();
    await policy.set({ maxFailures: '4', baseBanMs: 2 * HOUR, ignore: '192.168.0.0/16\n::1' });
    expect(await policy.get()).toMatchObject({ maxFailures: 4, baseBanMs: 2 * HOUR, ignore: ['192.168.0.0/16', '::1'] });
    expect(createIpBanPolicy({ db, bans: createBans(db) }).get().maxFailures).toBe(4);
    await expect(policy.set({ maxFailures: 0 })).rejects.toThrow(/MAX_FAILURES_INVALID/);
    await expect(policy.set({ maxBanMs: HOUR, baseBanMs: 2 * HOUR })).rejects.toThrow(/MAX_BAN_BELOW_BASE/);
    await expect(policy.set({ ignore: 'junk' })).rejects.toThrow(/IGNORE_INVALID/);
    expect((await policy.reset()).maxFailures).toBe(10);
    expect((await policy.schedule(3)).length).toBe(3);
    expect(await policy.purge()).toBe(0);
  });
});
