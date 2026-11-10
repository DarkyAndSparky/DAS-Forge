import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { ensureAuthTables } from '../src/auth/schema.js';
import { createManagedUser } from '../src/auth/user-admin.js';
import { createStepUp, safeNext } from '../src/admin/step-up.js';
import { query } from '../src/audit/index.js';

const provider = { verifyPassword: async (h, p) => ({ valid: h === `hash:${p}` }) };
function setup(opts = {}) {
  const db = createSqliteAdapter({ file: ':memory:' });
  ensureAuthTables(db);
  const u = createManagedUser(db, { username: 'root1', email: null, role: 'admin', passwordHash: 'hash:right-pass-1', mustChangePassword: false });
  let t = 1_000_000;
  const su = createStepUp({ db, authProvider: provider, now: () => t, ...opts });
  const routes = {};
  su.mount({ get: (p, ...h) => { routes[`GET ${p}`] = h.at(-1); }, post: (p, ...h) => { routes[`POST ${p}`] = h.at(-1); } }, { requireAuth: () => (req, res, next) => next() });
  const session = {};
  const req = (extra = {}) => ({ user: { id: u.id }, session, headers: {}, query: {}, ip: '1.1.1.1', ...extra });
  const res = () => { const r = { code: 200, body: '', locals: {}, set() { return this; }, status(c) { r.code = c; return r; }, type() { return r; }, send(b) { r.body = b; return r; }, json(b) { r.body = b; return r; }, redirect(c, l) { r.code = c; r.location = l; return r; } }; return r; };
  return { db, su, routes, req, res, session, tick: (ms) => { t += ms; } };
}

describe('admin step-up (R-01)', () => {
  it('blocks a stale session: redirect for pages, 401 for JSON, and does not call next', () => {
    const { su, req, res } = setup();
    let called = false;
    const r = res();
    su.middleware(req({ headers: { referer: 'https://x.test/admin/users' } }), r, () => { called = true; });
    expect(called).toBe(false);
    expect(r.code).toBe(303);
    expect(r.location).toBe('/admin/confirm?next=%2Fadmin%2Fusers');
    const j = res();
    su.middleware(req({ headers: { accept: 'application/json' } }), j, () => { called = true; });
    expect(j.code).toBe(401);
    expect(j.body).toEqual({ error: 'STEP_UP_REQUIRED', confirm: '/admin/confirm' });
  });

  it('a right password confirms, records it, and later actions pass until the time runs out', async () => {
    const { db, su, routes, req, res, session, tick } = setup({ maxAgeMs: 600_000 });
    const r = res();
    await routes['POST /admin/confirm'](req({ body: { password: 'right-pass-1', next: '/admin/users' } }), r);
    expect(r.location).toBe('/admin/users');
    expect(query(db, { action: 'admin.stepup' })[0].result).toBe('success');
    let ok = 0;
    su.middleware(req(), res(), () => { ok++; });
    tick(599_000);
    su.middleware(req(), res(), () => { ok++; });
    tick(2_000);
    const late = res();
    su.middleware(req(), late, () => { ok++; });
    expect(ok).toBe(2);
    expect(late.code).toBe(303);
    expect(session.stepUpAt).toBeDefined();
  });

  it('the mark of one user does not serve another', async () => {
    const { su, routes, req, res } = setup();
    await routes['POST /admin/confirm'](req({ body: { password: 'right-pass-1' } }), res());
    const other = res();
    let called = false;
    su.middleware(req({ user: { id: 999 } }), other, () => { called = true; });
    expect(called).toBe(false);
  });

  it('a wrong password does not confirm; five failures lock the form even for the right password', async () => {
    const { db, su, routes, req, res, session } = setup();
    for (let i = 0; i < 5; i++) {
      const r = res();
      await routes['POST /admin/confirm'](req({ body: { password: 'nope-nope-1' } }), r);
      expect(r.code).toBe(200);
      expect(r.body).toContain('Неверные данные');
    }
    const locked = res();
    await routes['POST /admin/confirm'](req({ body: { password: 'right-pass-1' } }), locked);
    expect(locked.code).toBe(429);
    expect(session.stepUpAt).toBeUndefined();
    expect(su.isFresh(req())).toBe(false);
    expect(query(db, { action: 'admin.stepup' }).filter((e) => e.result === 'failure').length).toBe(5);
  });

  it('the return address is only ever a path on this site', async () => {
    expect(safeNext('/admin/users?page=2')).toBe('/admin/users?page=2');
    for (const bad of ['https://evil.test/', '//evil.test', '/\\evil.test', 'javascript:alert(1)', '', undefined]) expect(safeNext(bad)).toBe('/');
    const { routes, req, res } = setup();
    const r = res();
    await routes['POST /admin/confirm'](req({ body: { password: 'right-pass-1', next: '//evil.test' } }), r);
    expect(r.location).toBe('/');
  });

  it('refuses to be created without a database or provider', () => {
    expect(() => createStepUp({})).toThrow(/required/);
  });
});
