import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { createIncidentRegister, IncidentError } from '../src/privacy/incidents.js';
import { query } from '../src/audit/index.js';
import { ensureAuthTables } from '../src/auth/schema.js';
import { createAdmin } from '../src/admin/index.js';

const HOUR = 3600 * 1000;
const setup = (opts) => { const db = createSqliteAdapter({ file: ':memory:' }); return { db, reg: createIncidentRegister(db, opts) }; };

describe('incident register', () => {
  it('declares an incident and audits it', () => {
    const { db, reg } = setup();
    const i = reg.declare({ title: 'Lost laptop', severity: 'high', actor: 'root' });
    expect(i).toMatchObject({ id: 1, title: 'Lost laptop', severity: 'high', status: 'open', personalData: false, firstNoticeDue: null });
    expect(query(db, { action: 'privacy.incident.declare' })).toHaveLength(1);
  });

  it('counts the notice deadlines from detection only when personal data is involved', () => {
    const t0 = Date.parse('2026-11-01T00:00:00Z');
    let now = t0 + HOUR;
    const { reg } = setup({ now: () => now });
    const i = reg.declare({ title: 'Leak', personalData: true, detectedAt: '2026-11-01T00:00:00Z' });
    expect(i.firstNoticeDue.at).toBe('2026-11-02T00:00:00.000Z');
    expect(i.detailsDue.at).toBe('2026-11-04T00:00:00.000Z');
    expect(reg.overdue()).toHaveLength(0);
    now = t0 + 25 * HOUR;
    expect(reg.get(1).firstNoticeDue.overdue).toBe(true);
    expect(reg.get(1).detailsDue.overdue).toBe(false);
    reg.update(1, { firstNoticeAt: '2026-11-01T20:00:00Z' });
    expect(reg.overdue()).toHaveLength(0);
    now = t0 + 80 * HOUR;
    expect(reg.overdue()).toHaveLength(1);
    reg.update(1, { status: 'closed' });
    expect(reg.overdue()).toHaveLength(0);
    expect(reg.get(1).closedAt).not.toBeNull();
  });

  it('refuses bad input with stable codes', () => {
    const { reg } = setup();
    expect(() => reg.declare({ title: '  ' })).toThrow(IncidentError);
    expect(() => reg.declare({ title: 'x', severity: 'dire' })).toThrow(/SEVERITY_INVALID/);
    expect(() => reg.declare({ title: 'x', detectedAt: 'yesterday-ish' })).toThrow(/DATE_INVALID/);
    reg.declare({ title: 'x' });
    expect(() => reg.update(1, { status: 'weird' })).toThrow(/STATUS_INVALID/);
    expect(() => reg.update(99, { status: 'closed' })).toThrow(/NOT_FOUND/);
  });

  it('lists by status', () => {
    const { reg } = setup();
    reg.declare({ title: 'a' }); reg.declare({ title: 'b' });
    reg.update(2, { status: 'closed' });
    expect(reg.list({ status: 'open' }).map((i) => i.id)).toEqual([1]);
    expect(reg.list()).toHaveLength(2);
  });
});

describe('incidents admin section', () => {
  const admin = { id: 1, username: 'root', permissions: ['admin.access'] };
  function call(chain, req) {
    return new Promise((resolve) => {
      req.on ??= function (ev, cb) { if (ev === 'end') cb(); return this; };
      const res = { code: 200, body: '', locals: {}, set() { return this; }, type() { return this; }, status(c) { this.code = c; return this; } };
      res.end = () => { resolve(res); return res; };
      res.send = (b) => { res.body = b; resolve(res); return res; };
      res.redirect = (c, loc) => { res.code = c; res.location = loc; resolve(res); return res; };
      let i = 0;
      const next = () => { const h = chain[i++]; if (h) Promise.resolve(h(req, res, next)).catch((e) => { res.body = String(e); resolve(res); }); };
      next();
    });
  }
  function build() {
    const { db, reg } = setup();
    ensureAuthTables(db);
    const routes = {};
    const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; } };
    createAdmin({ db, incidents: reg }).mount(app, { requireAuth: () => (req, res, next) => next(), requirePermission: () => (req, res, next) => next() });
    return { db, reg, routes };
  }

  it('declares, shows and updates an incident, and refuses bad input', async () => {
    const { reg, routes } = build();
    let r = await call(routes['POST /admin/incidents/declare'], { user: admin, body: { title: 'Phish', severity: 'high', personalData: '1' } });
    expect(r.location).toBe('/admin/incidents/1?msg=ok');
    expect(reg.get(1).personalData).toBe(true);
    r = await call(routes['GET /admin/incidents'], { user: admin, query: {}, headers: {} });
    expect(r.body).toContain('Phish');
    r = await call(routes['POST /admin/incidents/:id'], { user: admin, params: { id: '1' }, body: { status: 'notified', firstNoticeAt: '2026-11-01T10:00', measures: 'Passwords reset' } });
    expect(r.location).toBe('/admin/incidents/1?msg=ok');
    expect(reg.get(1)).toMatchObject({ status: 'notified', measures: 'Passwords reset', firstNoticeAt: '2026-11-01T10:00:00.000Z' });
    r = await call(routes['POST /admin/incidents/declare'], { user: admin, body: { title: '' } });
    expect(r.location).toBe('/admin/incidents?msg=bad&e=TITLE_INVALID');
  });
});
