import { describe, it, expect, afterAll } from 'vitest';
import { openTestDb, pgConfigured } from './support/pg-test-db.js';
import * as auth from '@das-forge/core/auth';
import { logAsync } from '@das-forge/core/audit';
import { createAdmin, createMetrics, ensureMetricsTableAsync } from '@das-forge/core/admin';
import { createBansAsync } from '@das-forge/core/security';
import { createAlerts, ensureAlertsTableAsync } from '@das-forge/core/alerts';
import { createNotifications, ensureNotificationsTableAsync } from '@das-forge/core/notifications';
import { createIncidentRegister, ensureIncidentTableAsync } from '@das-forge/core/privacy';

describe.skipIf(!pgConfigured)('admin pages on PostgreSQL', () => {
  let db;
  afterAll(async () => { await db?.close(); });

  it('every page without a form opens, shows data from the database and does not fail', async () => {
    db = await openTestDb();
    await auth.ensureAuthTablesAsync(db);
    await ensureMetricsTableAsync(db);
    await ensureAlertsTableAsync(db);
    await ensureNotificationsTableAsync(db);
    await ensureIncidentTableAsync(db);
    await auth.createUserAsync(db, { username: 'ann', passwordHash: 'h', role: 'operator' });
    for (let i = 0; i < 3; i += 1) await logAsync(db, { actor: 'ann', action: 'auth.login' });

    const routes = [];
    const app = { get: (path, ...h) => routes.push({ path, h }), post() {}, use() {} };
    const pass = () => (req, res, next) => next();
    createAdmin({
      db, metrics: createMetrics(db, { flushMs: 0, synchronous: false }), bans: createBansAsync(db, { cacheMs: 0 }),
      alerts: createAlerts({ db }), incidents: createIncidentRegister(db), notifications: createNotifications({ db }),
    }).mount(app, { requireAuth: pass, requirePermission: pass });

    const open = async (route) => {
      const req = { query: {}, params: { id: '1' }, headers: {}, path: route.path, originalUrl: route.path, ip: '1.1.1.1', get: () => '', session: {}, user: { id: 1, username: 'ann', permissions: ['admin.access'], role: 'admin' } };
      const res = { code: 200, body: '', locals: {}, set() { return this; }, setHeader() { return this; }, type() { return this; }, attachment() { return this; }, status(c) { this.code = c; return this; }, end(b) { if (b) this.body += b; return this; }, send(b) { this.body = b; return this; }, json(b) { this.body = JSON.stringify(b); return this; }, redirect() { return this; }, write(b) { this.body += b; return true; }, flushHeaders() {}, on() { return this; }, once() { return this; } };
      let failure = null;
      const pending = [];
      let i = 0;
      const next = (e) => { if (e) { failure = e; return; } const h = route.h[i++]; if (h) pending.push(Promise.resolve().then(() => h(req, res, next)).catch((x) => { failure = x; })); };
      next();
      for (let k = 0; k < pending.length; k += 1) await pending[k];
      return { res, failure };
    };

    const seen = {};
    for (const route of routes) {
      const { res, failure } = await open(route);
      expect(failure, route.path).toBeNull();
      expect(res.code, route.path).toBeLessThan(500);
      seen[route.path] = String(res.body);
    }
    expect(routes.length).toBeGreaterThanOrEqual(10);
    expect(seen['/admin']).toContain('Обзор');
    expect(seen['/admin/users']).toContain('ann');
    expect(seen['/admin/audit']).toContain('auth.login');
    expect(seen['/admin/audit.csv']).toContain('auth.login');
    expect(seen['/admin/alerts']).toBeTruthy();
  });
});
