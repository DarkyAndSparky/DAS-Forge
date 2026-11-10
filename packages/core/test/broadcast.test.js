import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { ensureAuthTables } from '../src/auth/schema.js';
import { createUser } from '../src/auth/users.js';
import { createAdmin } from '../src/admin/index.js';
import { query } from '../src/audit/index.js';

const admin = { id: 1, username: 'root', permissions: ['admin.access'] };
function call(chain, req) {
  return new Promise((resolve) => {
    req.on ??= function () { return this; };
    const res = { code: 200, body: '', locals: {}, set() { return this; }, type() { return this; }, status(c) { this.code = c; return this; } };
    res.send = (b) => { res.body = b; resolve(res); return res; };
    res.end = () => resolve(res);
    res.redirect = (c, loc) => { res.location = loc; resolve(res); return res; };
    let i = 0;
    const next = () => { const h = chain[i++]; if (h) Promise.resolve(h(req, res, next)).catch((e) => { res.body = String(e); resolve(res); }); };
    next();
  });
}

function build({ enabled = true } = {}) {
  const db = createSqliteAdapter({ file: ':memory:' });
  ensureAuthTables(db);
  createUser(db, { username: 'root', email: 'root@example.com', passwordHash: 'h', role: 'admin' });
  createUser(db, { username: 'ann', email: 'ann@example.com', passwordHash: 'h', role: 'operator' });
  createUser(db, { username: 'bob', email: 'bob@example.com', passwordHash: 'h', role: 'operator' });
  createUser(db, { username: 'noemail', passwordHash: 'h', role: 'operator' });
  createUser(db, { username: 'off', email: 'off@example.com', passwordHash: 'h', role: 'operator' });
  db.run(`UPDATE users SET disabled = 1 WHERE username = 'off'`);
  const sent = [];
  const service = { enabled, sendSystemNotice: async (m) => { sent.push(m); return { sent: false, queued: true }; } };
  const routes = {};
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; } };
  createAdmin({ db, mail: { queue: { list: () => [], stats: () => ({ pending: 0, sending: 0, sent: 0, failed: 0 }) }, service }, userManagement: { authProvider: { hashPassword: async (p) => p }, roles: ['admin', 'operator'], adminRole: 'admin' } })
    .mount(app, { requireAuth: () => (r, s, n) => n(), requirePermission: () => (r, s, n) => n() });
  return { db, routes, sent };
}
const form = (extra = {}) => ({ subject: 'Planned maintenance', message: 'Down on Friday 22:00-23:00.', locale: 'en', role: '', ...extra });

describe('broadcast section', () => {
  it('sends one separate mail to every active user with an address', async () => {
    const { db, routes, sent } = build();
    const r = await call(routes['POST /admin/broadcast/send'], { user: admin, body: form() });
    expect(r.location).toBe('/admin/broadcast?msg=ok&n=3&s=0&f=0');
    expect(sent.map((m) => m.to).sort()).toEqual(['ann@example.com', 'bob@example.com', 'root@example.com']);
    expect(sent.every((m) => typeof m.to === 'string' && m.locale === 'en' && m.subject === 'Planned maintenance')).toBe(true);
    const ev = query(db, { action: 'admin.broadcast.send' });
    expect(ev).toHaveLength(1);
    expect(JSON.stringify(ev[0])).not.toContain('Down on Friday');
  });

  it('can address one role only', async () => {
    const { routes, sent } = build();
    await call(routes['POST /admin/broadcast/send'], { user: admin, body: form({ role: 'operator' }) });
    expect(sent.map((m) => m.to).sort()).toEqual(['ann@example.com', 'bob@example.com']);
    const r = await call(routes['POST /admin/broadcast/send'], { user: admin, body: form({ role: 'hacker' }) });
    expect(r.location).toBe('/admin/broadcast?msg=bad&e=ROLE_INVALID');
  });

  it('sends the test to the signed-in administrator only', async () => {
    const { routes, sent, db } = build();
    const r = await call(routes['POST /admin/broadcast/test'], { user: admin, body: form() });
    expect(r.location).toBe('/admin/broadcast?msg=ok&t=1');
    expect(sent.map((m) => m.to)).toEqual(['root@example.com']);
    expect(query(db, { action: 'admin.broadcast.test' })).toHaveLength(1);
  });

  it('refuses bad input and a switched-off mail service, and sends nothing', async () => {
    const { routes, sent } = build();
    for (const [body, code] of [[form({ subject: '' }), 'SUBJECT_INVALID'], [form({ subject: 'a\nb' }), 'SUBJECT_INVALID'], [form({ message: '' }), 'MESSAGE_INVALID'], [form({ locale: 'xx' }), 'LOCALE_INVALID']]) {
      const r = await call(routes['POST /admin/broadcast/send'], { user: admin, body });
      expect(r.location).toBe(`/admin/broadcast?msg=bad&e=${code}`);
    }
    const off = build({ enabled: false });
    const r = await call(off.routes['POST /admin/broadcast/send'], { user: admin, body: form() });
    expect(r.location).toBe('/admin/broadcast?msg=bad&e=MAIL_OFF');
    expect(sent).toHaveLength(0);
    expect(off.sent).toHaveLength(0);
  });

  it('shows the page with the recipient counts', async () => {
    const { routes } = build();
    const r = await call(routes['GET /admin/broadcast'], { user: admin, query: {}, headers: {} });
    expect(r.body).toContain('Рассылка');
    expect(r.body).toContain('operator (2)');
  });
});
