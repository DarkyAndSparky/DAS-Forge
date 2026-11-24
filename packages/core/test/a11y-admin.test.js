import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { ensureAuthTables } from '../src/auth/schema.js';
import { createUser } from '../src/auth/users.js';
import { createAdmin } from '../src/admin/index.js';
import { createMaintenance } from '../src/maintenance/index.js';
import { createAnnouncement } from '../src/announcement/index.js';
import { createIncidentRegister } from '../src/privacy/incidents.js';
import { createPolicy } from '../src/policy/index.js';
import { createAlerts } from '../src/alerts/index.js';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBans } from '../src/security/bans.js';
import { createEmailQueue } from '../src/email/queue.js';
import { a11yIssues } from './support/a11y-lint.js';

// Every parameterless GET page of the administration panel, in both languages, through the same handlers the server uses.
function build() {
  const db = createSqliteAdapter({ file: ':memory:' });
  ensureAuthTables(db);
  createUser(db, { username: 'root', passwordHash: 'h', role: 'admin' });
  const routes = {};
  const app = { get: (p, ...h) => { routes[p] = h; }, post: () => {}, use: () => {}, all: () => {} };
  const requireAuth = () => (req, res, next) => next();
  const requirePermission = () => (req, res, next) => next();
  createAdmin({ db, users: true, incidents: createIncidentRegister(db), maintenance: createMaintenance({ db }), announcement: createAnnouncement({ db }), policy: createPolicy({ db }), config: { a: 1 }, controlPath: '/control',
    bans: createBans(db, { cacheMs: 0 }),
    scheduler: { listJobs: () => [{ name: 'backup', expression: '0 3 * * *', running: false, lastRunAt: new Date('2026-10-27T03:00:00Z'), lastError: null }], runNow: async () => {} },
    mail: { queue: createEmailQueue({ db, send: async () => {} }), service: { enabled: true } },
    alerts: createAlerts({ db, email: { enabled: false } }),
    backups: { list: async () => [{ destinationId: 'd1', file: 'b.zip', sizeBytes: 2048, createdAt: '2026-11-24T00:00:00Z' }], run: async () => {}, info: { retentionDays: 14, destinations: ['local-1'] } },
    logDestination: { stats: () => [{ type: 'http', sent: 5, dropped: 1, spilled: 0, queued: 2, failures: 3, lastError: 'x' }] },
    appearance: { uploadsDir: mkdtempSync(path.join(os.tmpdir(), 'a11y-')), fallbackName: 'Product' } }).mount(app, { requireAuth, requirePermission });
  return routes;
}
function call(chain, req) {
  return new Promise((resolve) => {
    req.on ??= function (ev, cb) { if (ev === 'end') cb(); return this; };
    const res = { code: 200, body: '', headers: {}, locals: { cspNonce: 'n' }, set(k, v) { this.headers[k] = v; return this; }, setHeader(k, v) { this.headers[k] = v; return this; }, type() { return this; }, status(c) { this.code = c; return this; }, json(b) { this.body = JSON.stringify(b); resolve(this); return this; } };
    res.end = () => { resolve(res); return res; };
    res.send = (b) => { res.body = String(b); resolve(res); return res; };
    res.redirect = () => { res.code = 302; resolve(res); return res; };
    let i = 0;
    const next = () => { const h = chain[i++]; if (h) Promise.resolve(h(req, res, next)).catch((e) => { res.body = ''; res.code = 500; res.err = String(e); resolve(res); }); else resolve(res); };
    next();
  });
}

describe('the administration pages', () => {
  const routes = build();
  const pages = Object.keys(routes).filter((p) => !p.includes(':') && !p.includes('*') && !/\.(json|csv|ndjson|css|js|svg)$/.test(p));
  it('there are pages to check', () => { expect(pages.length).toBeGreaterThan(20); });
  for (const locale of ['ru', 'en']) {
    it(`have no structural accessibility problems (${locale})`, async () => {
      const found = [];
      let checked = 0;
      for (const p of pages) {
        const res = await call(routes[p], { user: { id: 1, username: 'root', permissions: ['admin.access'] }, query: {}, params: {}, locale, headers: { 'accept-language': locale }, get: () => undefined, cookies: {} });
        if (res.code !== 200 || !/<html/i.test(res.body)) continue;
        checked += 1;
        for (const issue of a11yIssues(res.body)) found.push(`${p}: ${issue}`);
      }
      expect(checked).toBeGreaterThan(5);
      expect(found).toEqual([]);
    });
  }
});
