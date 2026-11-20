import { describe, it, expect, afterAll } from 'vitest';
import { openTestDb, pgConfigured } from './support/pg-test-db.js';
import * as auth from '@das-forge/core/auth';
import { createBansAsync, createIpBanPolicyAsync } from '@das-forge/core/security';
import { queryAsync, verifyChainAsync, summarizeAuditAsync } from '@das-forge/core/audit';
import { inactiveUsersAsync, userCardAsync } from '@das-forge/core/admin';
import { databaseChecksAsync } from '@das-forge/core/health';

describe.skipIf(!pgConfigured)('bans, sessions, activity and health on PostgreSQL', () => {
  let db;
  const ready = async () => { db ??= await openTestDb(); return db; };
  afterAll(async () => { await db?.close(); });

  it('bans a user (ending sessions), an address, the automatic ban after repeated failures; audit chain intact', async () => {
    const d = await ready();
    await auth.ensureAuthTablesAsync(d);
    const u = await auth.createUserAsync(d, { username: 'eve', passwordHash: 'h' });
    await d.run('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', [auth.hashSessionId('s'), u.id, new Date().toISOString(), new Date(Date.now() + 3_600_000).toISOString()]);
    const clock = { t: Date.parse('2026-11-01T10:00:00Z') };
    const now = () => clock.t;
    const bans = createBansAsync(d, { cacheMs: 0, now });
    expect(await bans.ban({ kind: 'user', value: 'eve', reason: 'abuse', by: 'root' })).toMatchObject({ already: false, sessionsEnded: 1 });
    expect((await bans.ban({ kind: 'user', value: 'eve', by: 'root' })).already).toBe(true);
    expect(await bans.check({ username: 'eve' })).toMatchObject({ kind: 'user', value: 'eve' });
    await bans.ban({ kind: 'ip', value: '::ffff:1.2.3.4', durationMs: 3_600_000 });
    expect((await bans.check({ ip: '1.2.3.4' })).value).toBe('1.2.3.4');
    expect(await bans.count()).toBe(2);
    expect(await bans.lift({ kind: 'ip', value: '1.2.3.4' })).toBe(1);
    expect(await bans.check({ ip: '1.2.3.4' })).toBeNull();
    const policy = createIpBanPolicyAsync({ db: d, bans, config: {}, now });
    let r;
    for (let i = 0; i < 12; i += 1) { clock.t += 1000; r = await policy.recordFailure('5.6.7.8'); }
    expect(r).toMatchObject({ banned: false, reason: 'already' });
    expect(await bans.check({ ip: '5.6.7.8' })).toMatchObject({ kind: 'ip', value: '5.6.7.8' });
    expect((await verifyChainAsync(d)).ok).toBe(true);
    expect((await queryAsync(d, {})).some((e) => e.action === 'security.ban')).toBe(true);
  });

  it('users: session create/find/destroy, password history, the user card and the inactive list', async () => {
    const d = await ready();
    const u = await auth.createUserAsync(d, { username: 'zoe', passwordHash: 'h1' });
    const Store = class {};
    const store = auth.createSessionStoreAsync({ db: d, expressSession: { Store }, idleTimeoutMs: 0 });
    const call = (fn, ...args) => new Promise((resolve, reject) => fn.call(store, ...args, (err, v) => (err ? reject(err) : resolve(v))));
    await call(store.set, 'sid-1', { userId: u.id, cookie: { expires: new Date(Date.now() + 60_000) } });
    expect((await call(store.get, 'sid-1')).userId).toBe(u.id);
    await call(store.set, 'sid-1', { userId: u.id, extra: 1, cookie: { expires: new Date(Date.now() + 60_000) } });
    expect((await call(store.get, 'sid-1')).extra).toBe(1);
    expect(await call(store.length)).toBe(1);
    await call(store.touch, 'sid-1', { cookie: {} });
    expect(await store.destroyUserSessions(u.id)).toBeGreaterThanOrEqual(1);
    expect(await call(store.get, 'sid-1')).toBeNull();
    await call(store.set, 'sid-2', { userId: u.id, cookie: { expires: new Date(Date.now() - 1000) } });
    expect(await call(store.get, 'sid-2')).toBeNull();
    const card = await userCardAsync(d, u.id);
    expect(card.user.username).toBe('zoe');
    const idle = await inactiveUsersAsync(d, { days: 30 });
    expect(Array.isArray(idle)).toBe(true);
    expect(idle.some((x) => x.username === 'zoe')).toBe(false); // created just now
  });

  it('audit summary and the database health checks', async () => {
    const d = await ready();
    const s = await summarizeAuditAsync(d, { since: new Date(Date.now() - 86_400_000).toISOString(), until: '2999-01-01T00:00:00Z' });
    expect(Object.values(s.totals).some((n) => n > 0)).toBe(true);
    expect(s.perDay.length).toBeGreaterThan(0);
    expect(s.topActions[0].count).toBeGreaterThan(0);
    const checks = await databaseChecksAsync(d, {});
    expect(checks.map((c) => c.status)).toEqual(['ok', 'ok']);
  });
});
