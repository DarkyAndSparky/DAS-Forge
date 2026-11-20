import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { ensureAuthTables } from '../src/auth/schema.js';
import { mountAccountRoutes } from '../src/accounts/index.js';
import { sessionWatchScript, MIN_WARN_MS } from '../src/ui/session-watch.js';
import { renderAppShell } from '../src/ui/shell.js';

const registry = { getNavigation: () => [], getTranslations: () => ({ ru: {}, en: {} }) };
const shell = (extra) => renderAppShell({ moduleRegistry: registry, nonce: 'N', user: { username: 'ann' }, showLogout: true, ...extra });

describe('session warning (WCAG 2.2.1)', () => {
  it('the script parses, carries both languages, and is empty when switched off', () => {
    const js = sessionWatchScript({ warnMs: 120_000 });
    expect(() => new Function(js)).not.toThrow();
    expect(js).toContain('WARN=120000');
    expect(js).toContain('Сессия скоро закончится');
    expect(js).toContain('Your session is about to end');
    expect(js).not.toContain('innerHTML');
    expect(sessionWatchScript({ warnMs: 0 })).toBe('');
    expect(sessionWatchScript({})).toBe('');
  });
  it('a warning earlier than 20 seconds is raised to 20 seconds', () => {
    expect(sessionWatchScript({ warnMs: 5000 })).toContain(`WARN=${MIN_WARN_MS}`);
  });
  it('the shell adds the script only for a signed-in page with the option on', () => {
    expect(shell({ sessionWarnMs: 120_000 })).toContain('WARN=120000');
    expect(shell({})).not.toContain('WARN=120000');
    expect(shell({ sessionWarnMs: 120_000, user: null })).not.toContain('WARN=120000');
  });

  const setup = (auth = {}) => {
    const db = createSqliteAdapter({ file: ':memory:' });
    ensureAuthTables(db);
    const routes = [];
    const reg = (method) => (path, ...h) => routes.push({ method, path, h });
    mountAccountRoutes({ use() {}, get: reg('GET'), post: reg('POST'), delete: reg('DELETE') }, {
      db, authProvider: { hashPassword: async () => 'h', verifyPassword: async () => ({ valid: false }) }, permissionsForRole: () => [], appConfig: { auth },
    });
    const handler = (m, p) => routes.find((r) => r.method === m && r.path === p).h.at(-1);
    return { status: handler('GET', '/session/status'), extend: handler('POST', '/session/extend') };
  };
  const call = (fn, req) => new Promise((resolve) => {
    const res = { code: 200, set() {}, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
    fn(req, res);
  });
  const mkReq = (extensions = 0) => ({
    id: 'r', user: { id: 1, username: 'ann' }, ip: '1.1.1.1',
    session: { extensions, cookie: { maxAge: 60_000, expires: new Date(Date.now() + 60_000) }, save: (cb) => cb() },
  });

  it('GET /session/status says how long is left', async () => {
    const r = await call(setup().status, mkReq());
    expect(r.body.remainingMs).toBeGreaterThan(50_000);
    expect(r.body.canExtend).toBe(true);
  });
  it('POST /session/extend resets the lifetime and counts; the 10th is the last by default, then CONFLICT', async () => {
    const { extend } = setup({ sessionTtlMs: 3_600_000 });
    const req = mkReq();
    const r = await call(extend, req);
    expect(r.code).toBe(200);
    expect(req.session.extensions).toBe(1);
    expect(req.session.cookie.maxAge).toBe(3_600_000);
    const last = await call(extend, mkReq(9));
    expect(last.code).toBe(200);
    expect(last.body.canExtend).toBe(false);
    const over = await call(extend, mkReq(10));
    expect(over.code).toBe(409);
  });
});
