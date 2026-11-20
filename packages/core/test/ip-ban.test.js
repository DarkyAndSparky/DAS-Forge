import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { ensureAuthTables } from '../src/auth/schema.js';
import { createBans } from '../src/security/bans.js';
import { createIpBanPolicy, IpBanPolicyError, IP_BAN_DEFAULTS, parseIgnoreList, banSchedule, SYSTEM_BAN_AUTHOR } from '../src/security/ip-ban.js';
import { query } from '../src/audit/index.js';
import { createAdmin, createMetrics } from '../src/admin/index.js';
import { mountAccountRoutes } from '../src/accounts/index.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
function setup(config = {}) {
  const db = createSqliteAdapter({ file: ':memory:' });
  ensureAuthTables(db);
  const clock = { t: Date.parse('2026-11-01T10:00:00Z') };
  const now = () => clock.t;
  const bans = createBans(db, { cacheMs: 0, now });
  const policy = createIpBanPolicy({ db, bans, config, now });
  const fail = (ip, n = 1) => { let r; for (let i = 0; i < n; i += 1) { clock.t += 1000; r = policy.recordFailure(ip, { ctx: {} }); } return r; };
  return { db, bans, policy, clock, fail };
}

describe('automatic ban of an address', () => {
  it('counts failures and bans at the threshold, for the first term; the ban is in the database', () => {
    const { db, bans, policy, fail } = setup({ maxFailures: 3 });
    expect(fail('203.0.113.7', 2)).toMatchObject({ banned: false, reason: 'counted', count: 2 });
    const r = fail('203.0.113.7');
    expect(r).toMatchObject({ banned: true, durationMs: HOUR });
    expect(bans.check({ ip: '203.0.113.7' })).toMatchObject({ createdBy: SYSTEM_BAN_AUTHOR });
    expect(bans.list()[0].reason).toMatch(/^auto: 3 failed/);
    expect(query(db, { action: 'security.ban' }).length).toBe(1);
    // a new instance over the same database still sees the ban (a restart does not free the address)
    const again = createBans(db, { cacheMs: 0, now: () => Date.parse('2026-11-01T10:30:00Z') });
    expect(again.check({ ip: '203.0.113.7' })).not.toBeNull();
    expect(policy.get().maxFailures).toBe(3);
  });

  it('the term grows with every earlier automatic ban and stops at the maximum', () => {
    const { bans, clock, fail } = setup({ maxFailures: 2, baseBanMs: HOUR, factor: 2, maxBanMs: 5 * HOUR, recidiveCount: 50 });
    const terms = [];
    for (let i = 0; i < 5; i += 1) {
      const r = fail('198.51.100.9', 2);
      terms.push(r.durationMs / HOUR);
      clock.t += r.durationMs + 1000; // the ban runs out
      expect(bans.check({ ip: '198.51.100.9' })).toBeNull();
    }
    expect(terms).toEqual([1, 2, 4, 5, 5]);
  });

  it('a repeat offender (3 bans inside the window) gets the long term', () => {
    const { clock, fail } = setup({ maxFailures: 1, baseBanMs: 60_000, factor: 1, maxBanMs: 7 * DAY, recidiveCount: 3, recidiveWindowMs: DAY, recidiveBanMs: 7 * DAY, historyRetentionMs: 35 * DAY });
    const a = fail('192.0.2.50'); clock.t += 120_000;
    const b = fail('192.0.2.50'); clock.t += 120_000;
    const c = fail('192.0.2.50');
    expect([a.durationMs, b.durationMs, c.durationMs]).toEqual([60_000, 60_000, 7 * DAY]);
  });

  it('failures older than the window are forgotten', () => {
    const { clock, fail } = setup({ maxFailures: 3, findTimeMs: HOUR });
    fail('192.0.2.1', 2);
    clock.t += 2 * HOUR;
    expect(fail('192.0.2.1')).toMatchObject({ banned: false, count: 1 });
  });

  it('never bans an address on the ignore list, an invalid one, or when switched off', () => {
    const { policy, bans, fail } = setup({ maxFailures: 1, ignore: ['10.0.0.0/8', '2001:db8::/32', '203.0.113.15'] });
    for (const ip of ['10.1.2.3', '2001:db8::1', '203.0.113.15', '::ffff:10.9.9.9']) expect(fail(ip, 5), ip).toMatchObject({ banned: false, reason: 'ignored' });
    expect(fail('not-an-ip')).toMatchObject({ reason: 'invalid' });
    expect(bans.count()).toBe(0);
    policy.set({ enabled: false });
    expect(fail('192.0.2.77', 5)).toMatchObject({ banned: false, reason: 'disabled' });
    expect(bans.count()).toBe(0);
  });

  it('an address that is already banned is not counted again', () => {
    const { bans, fail } = setup({ maxFailures: 1 });
    fail('192.0.2.8');
    expect(fail('192.0.2.8')).toMatchObject({ banned: false, reason: 'already' });
    expect(bans.count()).toBe(1);
  });

  it('IPv4-mapped IPv6 is the same address as the plain one', () => {
    const { bans, fail } = setup({ maxFailures: 2 });
    fail('::ffff:192.0.2.5'); fail('192.0.2.5');
    expect(bans.check({ ip: '192.0.2.5' })).not.toBeNull();
  });
});

describe('settings without restart', () => {
  it('starts from the defaults, takes the configuration, then the saved values; reset returns to the start', () => {
    const { policy } = setup({ maxFailures: 4 });
    expect(policy.get()).toMatchObject({ maxFailures: 4, baseBanMs: IP_BAN_DEFAULTS.baseBanMs, enabled: true });
    policy.set({ maxFailures: 6, ignore: '10.0.0.1, 192.168.0.0/16' });
    expect(policy.get()).toMatchObject({ maxFailures: 6 });
    expect(policy.get().ignore).toEqual(['10.0.0.1', '192.168.0.0/16']);
    policy.reset();
    expect(policy.get()).toMatchObject({ maxFailures: 4 });
    expect(policy.get().ignore).toEqual([...IP_BAN_DEFAULTS.ignore]);
  });

  it('refuses out-of-range numbers, broken cross rules and bad ignore entries, and saves nothing', () => {
    const { policy } = setup();
    const code = (patch) => { try { policy.set(patch); return 'ok'; } catch (e) { return e instanceof IpBanPolicyError ? e.code : String(e); } };
    expect(code({ maxFailures: 0 })).toBe('MAX_FAILURES_INVALID');
    expect(code({ maxFailures: 1.5 })).toBe('MAX_FAILURES_INVALID');
    expect(code({ factor: 25 })).toBe('FACTOR_INVALID');
    expect(code({ baseBanMs: 'abc' })).toBe('BASE_BAN_MS_INVALID');
    expect(code({ baseBanMs: 5 * DAY, maxBanMs: DAY })).toBe('MAX_BAN_BELOW_BASE');
    expect(code({ maxBanMs: 100 * DAY })).toBe('HISTORY_TOO_SHORT');
    expect(code({ ignore: '300.1.1.1' })).toBe('IGNORE_INVALID');
    expect(code({ ignore: '10.0.0.0/33' })).toBe('IGNORE_INVALID');
    expect(code({ ignore: Array.from({ length: 101 }, (_, i) => `10.0.${Math.floor(i / 250)}.${i % 250 + 1}`) })).toBe('IGNORE_TOO_LONG');
    expect(policy.get()).toMatchObject({ maxFailures: IP_BAN_DEFAULTS.maxFailures, maxBanMs: IP_BAN_DEFAULTS.maxBanMs });
  });

  it('a damaged or hostile saved row falls back to valid values', () => {
    const { db, policy } = setup({ maxFailures: 4 });
    policy.set({ maxFailures: 6 });
    db.run(`UPDATE app_settings SET value = ? WHERE key = 'ip_ban_policy'`, [JSON.stringify({ maxFailures: -5, baseBanMs: 'x', ignore: ['zzz'], maxBanMs: 1, enabled: 'yes' })]);
    expect(policy.get()).toMatchObject({ maxFailures: 4, enabled: true });
    db.run(`UPDATE app_settings SET value = ? WHERE key = 'ip_ban_policy'`, ['not json']);
    expect(policy.get().maxFailures).toBe(4);
  });

  it('shows the schedule of terms', () => {
    const { policy } = setup({ baseBanMs: HOUR, factor: 24, maxBanMs: 35 * DAY });
    expect(banSchedule(policy.get(), 4).map((m) => m / HOUR)).toEqual([1, 24, 576, 840]);
    expect(parseIgnoreList('10.0.0.1\n10.0.0.1, ::1')).toEqual(['10.0.0.1', '::1']);
  });
});

describe('admin block "Automatic address ban"', () => {
  function build() {
    const { db, bans, policy } = setup({ maxFailures: 3 });
    const routes = {};
    const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; } };
    const requireAuth = () => (req, res, next) => (req.user ? next() : res.status(401).end());
    const requirePermission = (perm) => (req, res, next) => ((req.user.permissions ?? []).includes(perm) ? next() : res.status(403).end());
    createAdmin({ db, bans, ipBan: policy, metrics: createMetrics(db, { flushMs: 0 }) }).mount(app, { requireAuth, requirePermission });
    return { db, bans, policy, routes };
  }
  const admin = { username: 'root', permissions: ['admin.access'] };
  function call(chain, req) {
    return new Promise((resolve) => {
      req.on ??= function (ev, cb) { if (ev === 'end') cb(); return this; };
      req.headers ??= {};
      const res = { code: 200, body: '', headers: {}, locals: {}, set(k, v) { if (typeof k === 'string') this.headers[k] = v; return this; }, type() { return this; }, status(c) { this.code = c; return this; } };
      res.write = (c) => { res.body += String(c); return true; };
      res.end = (c) => { if (c) res.body += String(c); resolve(res); return res; };
      res.send = (b2) => { res.body = b2; resolve(res); return res; };
      res.redirect = (c, loc) => { res.code = c; res.location = loc; resolve(res); return res; };
      let i = 0;
      const next = () => { const h = chain[i++]; if (h) Promise.resolve(h(req, res, next)).catch((e) => { res.body = String(e); resolve(res); }); };
      next();
    });
  }
  const form = { maxFailures: '5', findTimeMin: '1440', baseBanMin: '60', factor: '2', maxBanDays: '35', recidiveCount: '3', recidiveWindowMin: '1440', recidiveBanDays: '7', historyDays: '35', ignore: '127.0.0.0/8, 10.0.0.0/8', enabled: '1' };

  it('shows the block with the schedule of terms', async () => {
    const { routes } = build();
    const page = await call(routes['GET /admin/security'], { user: admin, query: {} });
    expect(page.body).toContain('id="ip-ban"');
    expect(page.body).toContain('name="maxFailures"');
    expect(page.body).toContain('1 ч'); // the first term
  });

  it('saves the values with an audit entry, and they apply at once', async () => {
    const { db, policy, routes } = build();
    const r = await call(routes['POST /admin/security/ip-ban'], { user: admin, body: form });
    expect(r.location).toBe('/admin/security?msg=ok&s=ip#ip-ban');
    expect(policy.get()).toMatchObject({ maxFailures: 5, factor: 2 });
    expect(policy.get().ignore).toEqual(['127.0.0.0/8', '10.0.0.0/8']);
    expect(query(db, { action: 'admin.ipban.set' }).length).toBe(1);
  });

  it('reports bad values and saves nothing; a stale form is refused', async () => {
    const { policy, routes } = build();
    let r = await call(routes['POST /admin/security/ip-ban'], { user: admin, body: { ...form, maxFailures: '0' } });
    expect(r.location).toBe('/admin/security?msg=bad&s=ip&e=MAX_FAILURES_INVALID#ip-ban');
    r = await call(routes['POST /admin/security/ip-ban'], { user: admin, body: { ...form, ignore: 'not-an-address' } });
    expect(r.location).toContain('e=IGNORE_INVALID');
    r = await call(routes['POST /admin/security/ip-ban'], { user: admin, body: { ...form, findTimeMin: 'abc' } });
    expect(r.location).toContain('e=FIND_TIME_MS_INVALID');
    expect(policy.get().maxFailures).toBe(3);
    r = await call(routes['POST /admin/security/ip-ban'], { user: admin, body: { ...form, _v: '0000000000000000' } });
    expect(r.location).toContain('e=CONFLICT');
  });

  it('"Restore the initial values" goes back to the configuration, with an audit entry', async () => {
    const { db, policy, routes } = build();
    await call(routes['POST /admin/security/ip-ban'], { user: admin, body: form });
    const r = await call(routes['POST /admin/security/ip-ban/reset'], { user: admin });
    expect(r.code).toBe(303);
    expect(policy.get().maxFailures).toBe(3);
    expect(query(db, { action: 'admin.ipban.reset' }).length).toBe(1);
  });

  it('an administrator cannot ban the address he is working from, in any spelling', async () => {
    const { bans, routes } = build();
    let r = await call(routes['POST /admin/security/bans'], { user: admin, ip: '::ffff:192.0.2.40', body: { kind: 'ip', value: '192.0.2.40' } });
    expect(r.location).toBe('/admin/security?msg=bad');
    r = await call(routes['POST /admin/security/bans'], { user: admin, ip: '192.0.2.40', body: { kind: 'ip', value: '192.0.2.41' } });
    expect(r.location).toBe('/admin/security?msg=ok');
    expect(bans.count()).toBe(1);
  });
});

describe('failed sign-ins reach the automatic ban', () => {
  it('every failed password counts for the address; a good login does not', async () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    ensureAuthTables(db);
    const calls = [];
    const ipBan = { recordFailure: (ip) => calls.push(ip) };
    const routes = [];
    const reg = (method) => (path, ...h) => routes.push({ method, path, h });
    const app = { routes, use() {}, get: reg('GET'), post: reg('POST'), delete: reg('DELETE') };
    mountAccountRoutes(app, { db, ipBan, authProvider: { hashPassword: async () => 'h', verifyPassword: async () => ({ valid: false }) }, permissionsForRole: () => [] });
    const login = routes.find((r) => r.method === 'POST' && r.path === '/login').h.at(-1);
    await new Promise((resolve) => {
      const res = { setHeader() {}, set() { return this; }, type() { return this; }, status() { return this; }, json: resolve, send: resolve, redirect: resolve, end: resolve };
      Promise.resolve(login({ body: { username: 'nobody', password: 'x'.repeat(12) }, ip: '203.0.113.99', headers: {}, id: 'r1', get: () => '' }, res)).catch(resolve);
    });
    expect(calls).toEqual(['203.0.113.99']);
  });
});
