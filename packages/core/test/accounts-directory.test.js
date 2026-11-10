import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { ensureAuthTables } from '../src/auth/schema.js';
import { findUserByUsername } from '../src/auth/users.js';
import { createManagedUser } from '../src/auth/user-admin.js';
import { mountAccountRoutes } from '../src/accounts/index.js';
import { createDirectoryLinks } from '../src/accounts/directory.js';
import { query } from '../src/audit/index.js';

function fakeApp() {
  const routes = [];
  const reg = (method) => (path, ...h) => routes.push({ method, path, h });
  return { routes, use() {}, get: reg('GET'), post: reg('POST'), delete: reg('DELETE') };
}
const provider = { hashPassword: async (p) => `hash:${p}`, verifyPassword: async (h, p) => ({ valid: h === `hash:${p}`, needsRehash: false }) };

function setup(directoryResult) {
  const db = createSqliteAdapter({ file: ':memory:' });
  ensureAuthTables(db);
  const app = fakeApp();
  const calls = [];
  const directory = { source: 'ldap', allowedRoles: ['admin', 'operator'], authenticate: async (u, p) => { calls.push([u, p]); return directoryResult(u, p); } };
  mountAccountRoutes(app, { db, authProvider: provider, directory, permissionsForRole: () => [] });
  const login = app.routes.find((r) => r.method === 'POST' && r.path === '/login').h.at(-1);
  const run = (body) => new Promise((resolve) => {
    const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); }, type() { return this; }, send() { resolve({ code: this.code }); } };
    Promise.resolve(login({ body, ip: '1.2.3.4', headers: {}, socket: {}, locale: 'ru' }, res, () => {})).then(() => resolve({ code: res.code, done: true }), (e) => resolve({ error: e, code: res.code }));
  });
  return { db, calls, run };
}
const ok = { ok: true, username: 'ann', email: 'ann@corp.example', role: 'operator', dn: 'uid=ann,dc=corp' };

describe('directory (LDAP/AD) sign-in', () => {
  it('creates and links an account for an unknown name the directory accepts', async () => {
    const { db, run } = setup(() => ok);
    await run({ username: 'ann', password: 'secret-pass-1' }); // the session step needs a real request; the account is made before it
    const u = findUserByUsername(db, 'ann');
    expect(u.role).toBe('operator');
    expect(u.email).toBe('ann@corp.example');
    expect(Boolean(u.mustChangePassword)).toBe(false);
    expect(createDirectoryLinks(db).get(u.id)).toEqual({ source: 'ldap', dn: 'uid=ann,dc=corp' });
    expect(query(db, { action: 'auth.directory.provision' }).length).toBe(1);
  });

  it('refuses with one answer whatever the directory said, and logs the reason', async () => {
    for (const code of ['NOT_FOUND', 'INVALID_CREDENTIALS', 'UNAVAILABLE']) {
      const { db, run } = setup(() => ({ ok: false, code }));
      const r = await run({ username: 'ann', password: 'x-password-1' });
      expect(r.code).toBe(401);
      expect(r.body).toEqual({ error: 'INVALID_CREDENTIALS', fields: [] });
      expect(Boolean(findUserByUsername(db, "ann"))).toBe(false);
      expect(query(db, { action: 'auth.login' })[0].meta.reason).toBe(`directory_${code.toLowerCase()}`);
    }
  });

  it('a local account is never checked against the directory and cannot be taken over by it', async () => {
    const { db, calls, run } = setup(() => ok);
    createManagedUser(db, { username: 'ann', email: null, role: 'admin', passwordHash: 'hash:local-pass-1', mustChangePassword: false });
    const r = await run({ username: 'ann', password: 'wrong-pass-1' });
    expect(r.code).toBe(401);
    expect(calls).toEqual([]);
    expect(createDirectoryLinks(db).get(findUserByUsername(db, 'ann').id)).toBeNull();
  });

  it('a directory-managed account is checked in the directory every time; a disabled one stays out', async () => {
    let answer = ok;
    const { db, calls, run } = setup(() => answer);
    await run({ username: 'ann', password: 'secret-pass-1' });
    const id = findUserByUsername(db, 'ann').id;
    answer = { ok: false, code: 'INVALID_CREDENTIALS' };
    expect((await run({ username: 'ann', password: 'secret-pass-1' })).code).toBe(401);
    answer = ok;
    db.run('UPDATE users SET disabled = 1 WHERE id = ?', [id]);
    expect((await run({ username: 'ann', password: 'secret-pass-1' })).code).toBe(403);
    expect(calls.length).toBe(3);
  });

  it('a directory outage does not count as a failed attempt', async () => {
    const { run } = setup(() => ({ ok: false, code: 'UNAVAILABLE' }));
    for (let i = 0; i < 30; i++) expect((await run({ username: 'bob', password: 'x-password-1' })).code).toBe(401); // never 429
  });
});
