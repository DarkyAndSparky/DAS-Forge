import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { ensureAuthTables } from '../src/auth/schema.js';
import { mountAccountRoutes } from '../src/accounts/index.js';

function fakeApp() {
  const routes = [];
  const middleware = [];
  const reg = (method) => (path, ...h) => routes.push({ method, path, h });
  return { routes, middleware, use: (fn) => middleware.push(fn), get: reg('GET'), post: reg('POST'), delete: reg('DELETE') };
}
const provider = { hashPassword: async () => 'h', verifyPassword: async () => ({ valid: false }) };
const base = (extra = {}) => {
  const db = createSqliteAdapter({ file: ':memory:' });
  ensureAuthTables(db);
  const app = fakeApp();
  const api = mountAccountRoutes(app, { db, authProvider: provider, permissionsForRole: (r) => (r === 'admin' ? ['admin.access'] : ['read:basic']), ...extra });
  return { app, api, db };
};
const has = (app, method, path) => app.routes.some((r) => r.method === method && r.path === path);
const run = (fn, req) => new Promise((resolve) => {
  const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); }, redirect(c, loc) { resolve({ code: c, location: loc }); } };
  fn(req, res, () => resolve({ next: true }));
});

describe('account routes (core)', () => {
  it('needs a database, an auth provider and a role policy', () => {
    const app = fakeApp();
    expect(() => mountAccountRoutes(app, { authProvider: provider, permissionsForRole: () => [] })).toThrow(/db/);
    expect(() => mountAccountRoutes(app, { db: {}, permissionsForRole: () => [] })).toThrow(/authProvider/);
    expect(() => mountAccountRoutes(app, { db: {}, authProvider: provider })).toThrow(/permissionsForRole/);
  });

  it('registers sign-in, MFA, password, e-mail, TOTP and recovery-code routes', () => {
    const { app } = base();
    for (const [m, p] of [['POST', '/login'], ['POST', '/login/totp'], ['POST', '/login/recovery'], ['POST', '/logout'], ['GET', '/me'],
      ['POST', '/password/change'], ['POST', '/password/forgot'], ['POST', '/password/reset'], ['POST', '/account/email'],
      ['GET', '/totp/authenticators'], ['POST', '/totp/enroll/start'], ['POST', '/totp/enroll/verify'], ['POST', '/totp/authenticators/:id/remove'],
      ['POST', '/recovery-codes/generate'], ['GET', '/recovery-codes/remaining'], ['GET', '/'], ['GET', '/favicon.ico']]) {
      expect(has(app, m, p), `${m} ${p}`).toBe(true);
    }
  });

  it('mounts its own pages; an application can replace or switch off each one', async () => {
    const own = base();
    for (const p of ['/login', '/forgot-password', '/reset-password', '/ui/password']) expect(has(own.app, 'GET', p), p).toBe(true);
    expect(has(own.app, 'GET', '/ui/account')).toBe(false);
    const { app } = base({ pages: { login: () => '<p>login</p>', forgotPassword: false, forcedPassword: false }, accountShell: (req, res, o) => o.bodyHtml });
    expect(has(app, 'GET', '/forgot-password')).toBe(false);
    expect(has(app, 'GET', '/ui/password')).toBe(false);
    expect(has(app, 'GET', '/ui/account')).toBe(true);
    const sent = await new Promise((resolve) => {
      const res = { type() { return this; }, send: resolve };
      app.routes.find((r) => r.path === '/login').h[0]({ locale: 'ru' }, res);
    });
    expect(sent).toBe('<p>login</p>');
  });

  it('the entry point sends a signed-in user home and everybody else to the sign-in page', async () => {
    const { app } = base({ homePath: '/home' });
    const root = app.routes.find((r) => r.path === '/').h[0];
    expect((await run(root, { user: { id: 1 } })).location).toBe('/home');
    expect((await run(root, {})).location).toBe('/login');
  });

  it('a forced password change closes every path but the allowed ones', async () => {
    const { app } = base({ allowDuringPasswordChange: ['/ui/password'], passwordChangePath: '/ui/password' });
    const gate = app.middleware[0];
    const user = { mustChangePassword: true };
    expect((await run(gate, { user, path: '/ui/password', method: 'GET', headers: {} })).next).toBe(true);
    expect((await run(gate, { user, path: '/logout', method: 'POST', headers: {} })).next).toBe(true);
    const api = await run(gate, { user, path: '/assets', method: 'GET', headers: { accept: 'application/json' } });
    expect(api.code).toBe(403);
    expect(api.body.error).toBe('PASSWORD_CHANGE_REQUIRED');
    const page = await run(gate, { user, path: '/assets', method: 'GET', headers: { accept: 'text/html' } });
    expect(page.location).toBe('/ui/password');
    expect((await run(gate, { user: { mustChangePassword: false }, path: '/assets', method: 'GET', headers: {} })).next).toBe(true);
  });

  it('forgetLoginFailures and userPublicShape are handed back', () => {
    const { api } = base();
    expect(() => api.forgetLoginFailures('Ann')).not.toThrow();
    expect(api.userPublicShape({ id: 3, username: 'ann', role: 'admin', passwordHash: 'x' })).toEqual({ id: 3, username: 'ann', role: 'admin', permissions: ['admin.access'] });
  });
});
