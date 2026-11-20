import { describe, it, expect, afterAll } from 'vitest';
import { openTestDb, pgConfigured } from './support/pg-test-db.js';
import * as auth from '@das-forge/core/auth';
import { verifyChainAsync, queryAsync } from '@das-forge/core/audit';
import { createAdmin, createMetrics, ensureMetricsTableAsync } from '@das-forge/core/admin';
import { createBansAsync, createIpBanPolicyAsync } from '@das-forge/core/security';
import { createAlerts, ensureAlertsTableAsync } from '@das-forge/core/alerts';
import { createNotifications, ensureNotificationsTableAsync } from '@das-forge/core/notifications';
import { createIncidentRegister, ensureIncidentTableAsync } from '@das-forge/core/privacy';

describe.skipIf(!pgConfigured)('admin forms (POST) on PostgreSQL', () => {
  let db;
  afterAll(async () => { await db?.close(); });

  it('creates and disables a user, bans and lifts, declares an incident, mutes an alert, changes the ban policy; the audit chain stays intact', async () => {
    db = await openTestDb();
    await auth.ensureAuthTablesAsync(db);
    await ensureMetricsTableAsync(db);
    await ensureAlertsTableAsync(db);
    await ensureNotificationsTableAsync(db);
    await ensureIncidentTableAsync(db);
    const ann = await auth.createUserAsync(db, { username: 'ann', passwordHash: 'h', role: 'admin' });

    const posts = new Map();
    const app = { get() {}, post: (path, ...h) => posts.set(path, h), use() {} };
    const pass = () => (req, res, next) => next();
    const bans = createBansAsync(db, { cacheMs: 0 });
    const incidents = createIncidentRegister(db);
    const alerts = createAlerts({ db });
    createAdmin({
      db, metrics: createMetrics(db, { flushMs: 0, synchronous: false }), bans, incidents, alerts,
      notifications: createNotifications({ db }), ipBan: createIpBanPolicyAsync({ db, bans, config: {} }),
      userManagement: { authProvider: { hashPassword: async (p) => `hash:${p}` }, roles: ['admin', 'operator'], adminRole: 'admin' },
    }).mount(app, { requireAuth: pass, requirePermission: pass });

    const post = async (path, body = {}, params = {}) => {
      const chain = posts.get(path);
      expect(chain, `route ${path}`).toBeTruthy();
      const req = { body, params, query: {}, headers: {}, ip: '10.0.0.1', get: () => '', session: {}, user: { id: ann.id, username: 'ann', permissions: ['admin.access'], role: 'admin' } };
      const out = { code: 200, location: null, body: '' };
      const res = { locals: {}, set() { return this; }, setHeader() { return this; }, type() { return this; }, status(c) { out.code = c; return this; }, end() { return this; }, send(b) { out.body = String(b); return this; }, redirect(c, u) { out.code = c; out.location = u ?? c; return this; } };
      let failure = null;
      const pending = [];
      let i = 0;
      const next = (e) => { if (e) { failure = e; return; } const h = chain[i++]; if (h) pending.push(Promise.resolve().then(() => h(req, res, next)).catch((x) => { failure = x; })); };
      next();
      for (let k = 0; k < pending.length; k += 1) await pending[k];
      expect(failure, path).toBeNull();
      return out;
    };

    // users
    const created = await post('/admin/users/create', { username: 'bob', role: 'operator' });
    expect(created.code).toBeLessThan(500);
    const bob = await db.get('SELECT * FROM users WHERE username = ?', ['bob']);
    expect(bob).toBeTruthy();
    await post('/admin/users/:id/disable', {}, { id: String(bob.id) });
    expect(Boolean((await db.get('SELECT disabled FROM users WHERE id = ?', [bob.id])).disabled)).toBe(true);
    await post('/admin/users/:id/enable', {}, { id: String(bob.id) });
    expect(Boolean((await db.get('SELECT disabled FROM users WHERE id = ?', [bob.id])).disabled)).toBe(false);

    // bans
    expect((await post('/admin/security/bans', { kind: 'ip', value: '9.9.9.9', duration: '1h', reason: 'test' })).location).toContain('msg=ok');
    expect(await bans.count()).toBe(1);
    const ban = await db.get('SELECT id FROM security_bans');
    expect((await post('/admin/security/bans/:id/lift', {}, { id: String(ban.id) })).location).toContain('msg=ok');
    expect(await bans.count()).toBe(0);

    // ban policy
    const policyForm = { enabled: '1', maxFailures: '5', findTimeMin: '10', baseBanMin: '15', factor: '2', maxBanDays: '7', recidiveCount: '3', recidiveWindowMin: '1440', recidiveBanDays: '30', historyDays: '30', ignore: '' };
    expect((await post('/admin/security/ip-ban', policyForm)).location).toContain('msg=ok');
    expect((await post('/admin/security/ip-ban/reset')).location).toContain('msg=ok');

    // incidents and alerts
    const declared = await post('/admin/incidents/declare', { title: 'Утечка списка', description: 'тест', severity: 'high', personalData: '1' });
    expect(declared.code).toBeLessThan(500);
    expect(Number((await db.get('SELECT COUNT(*) AS n FROM security_incidents')).n)).toBe(1);
    expect((await post('/admin/alerts/mute', { key: 'disk', hours: '24' })).location).toContain('msg=ok');
    expect((await post('/admin/alerts/unmute', { key: 'disk' })).location).toContain('msg=ok');

    // everything above is in the audit journal, and the chain is intact
    const actions = (await queryAsync(db, { limit: 200 })).map((e) => e.action);
    for (const a of ['admin.user.create', 'admin.user.disable', 'admin.user.enable']) expect(actions).toContain(a);
    expect((await verifyChainAsync(db)).ok).toBe(true);
  });
});
