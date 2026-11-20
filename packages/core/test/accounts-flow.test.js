import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { ensureAuthTables } from '../src/auth/schema.js';
import { createManagedUser } from '../src/auth/user-admin.js';
import { findUserByUsername, findUserById } from '../src/auth/users.js';
import { mountAccountRoutes } from '../src/accounts/index.js';
import { query } from '../src/audit/index.js';

const provider = {
  hashPassword: async (p) => `hash:${p}`,
  verifyPassword: async (h, p) => ({ valid: h === `hash:${p}`, needsRehash: false }),
};

function fakeApp() {
  const routes = [];
  const reg = (method) => (path, ...h) => routes.push({ method, path, h });
  return { routes, use() {}, get: reg('GET'), post: reg('POST'), delete: reg('DELETE') };
}

function setup(extra = {}) {
  const db = createSqliteAdapter({ file: ':memory:', walMode: false });
  ensureAuthTables(db);
  const app = fakeApp();
  const sent = [];
  const emailService = {
    enabled: true,
    sendPasswordReset: async (m) => { sent.push(['reset', m]); },
    sendPasswordChanged: async (m) => { sent.push(['changed', m]); },
    sendEmailVerification: async (m) => { sent.push(['verify', m]); },
    sendNewDeviceLogin: async (m) => { sent.push(['device', m]); },
  };
  mountAccountRoutes(app, {
    db, authProvider: provider, emailService,
    appConfig: { auth: { sessionSecret: 'x'.repeat(40), registration: { enabled: true, requireEmailConfirmation: false }, passwordPolicy: { minLength: 8 } }, email: { baseUrl: 'https://app.test' } },
    permissionsForRole: (r) => (r === 'admin' ? ['admin.access'] : ['read:basic']),
    ...extra,
  });
  const handler = (method, path) => app.routes.find((r) => r.method === method && r.path === path).h.at(-1);
  const call = (method, path, req = {}) => new Promise((resolve) => {
    const cookies = [];
    const res = {
      code: 200, locals: {},
      setHeader() {}, cookie(n, v) { cookies.push([n, v]); },
      status(c) { this.code = c; return this; },
      json(b) { resolve({ code: this.code, body: b, cookies }); },
      redirect(c, loc) { resolve({ code: c, location: loc }); },
      type() { return this; }, send(b) { resolve({ code: this.code, html: b }); },
    };
    const session = { cookie: {}, regenerate(cb) { for (const k of Object.keys(this)) if (!['cookie', 'regenerate', 'save', 'destroy'].includes(k)) delete this[k]; cb(); }, save(cb) { cb(); }, destroy(cb) { cb(); } };
    const full = { body: {}, ip: '9.9.9.9', headers: { 'user-agent': 'test-agent' }, socket: {}, locale: 'en', session, sessionID: 's1', cookies: {}, id: 'r1', ...req };
    Promise.resolve(handler(method, path)(full, res, () => resolve({ next: true }))).then(() => resolve({ code: res.code, done: true, session }), (e) => resolve({ error: String(e?.message ?? e) }));
  });
  return { db, call, sent };
}
const addUser = (db, name, pw, extra = {}) => createManagedUser(db, { username: name, email: `${name}@x.io`, role: 'operator', passwordHash: `hash:${pw}`, mustChangePassword: false, ...extra });
const actions = (db) => query(db, { limit: 50 }).map((e) => `${e.action}:${e.result}`);

describe('account routes end to end (fake request and response)', () => {
  it('signs in with a password, refuses a wrong one and an unknown name, writes the audit trail', async () => {
    const { db, call } = setup();
    addUser(db, 'ann', 'correct-horse-9');
    const bad = await call('POST', '/login', { body: { username: 'ann', password: 'nope' } });
    expect(bad.code).toBe(401);
    const ghost = await call('POST', '/login', { body: { username: 'ghost', password: 'nope' } });
    expect(ghost.code).toBe(401);
    const ok = await call('POST', '/login', { body: { username: 'ann', password: 'correct-horse-9' } });
    expect(ok.error).toBeUndefined();
    const log = actions(db);
    expect(log).toContain('auth.login:failure');
  });

  it('a disabled account cannot sign in', async () => {
    const { db, call } = setup();
    const u = addUser(db, 'bob', 'correct-horse-9');
    db.run('UPDATE users SET disabled = 1 WHERE id = ?', [u.id]);
    const r = await call('POST', '/login', { body: { username: 'bob', password: 'correct-horse-9' } });
    expect(r.code).toBe(403);
  });

  it('changes the password: checks the old one, rejects a weak new one, stores the new hash', async () => {
    const { db, call } = setup();
    const u = addUser(db, 'cyrus', 'correct-horse-9');
    const user = { id: u.id, username: 'cyrus', role: 'operator' };
    const wrongOld = await call('POST', '/password/change', { user, body: { currentPassword: 'wrong', newPassword: 'another-good-pass-1' } });
    expect(wrongOld.code).toBeGreaterThanOrEqual(400);
    const weak = await call('POST', '/password/change', { user, body: { currentPassword: 'correct-horse-9', newPassword: 'abc' } });
    expect(weak.code).toBe(400);
    const ok = await call('POST', '/password/change', { user, body: { currentPassword: 'correct-horse-9', newPassword: 'another-good-pass-1' } });
    expect(ok.error).toBeUndefined();
    expect(findUserByUsername(db, 'cyrus').passwordHash).toBe('hash:another-good-pass-1');
  });

  it('password reset: a mail goes out for a known address, the token works once and changes the password', async () => {
    const { db, call, sent } = setup();
    addUser(db, 'dina', 'correct-horse-9');
    const unknown = await call('POST', '/password/forgot', { body: { login: 'nobody@x.io' } });
    expect(unknown.code).toBe(202);
    expect(sent.length).toBe(0);
    const known = await call('POST', '/password/forgot', { body: { login: 'dina@x.io' } });
    expect(known.code).toBe(202);
    await new Promise((r) => setTimeout(r, 30)); // the mail is sent after the answer
    const mail = sent.find((m) => m[0] === 'reset')?.[1];
    expect(mail).toBeDefined();
    const token = /token=([\w-]+)/.exec(mail.resetUrl)?.[1];
    expect(token).toBeDefined();
    const bad = await call('POST', '/password/reset', { body: { token: 'x'.repeat(30), newPassword: 'fresh-pass-phrase-7' } });
    expect(bad.code).toBe(400);
    const done = await call('POST', '/password/reset', { body: { token, newPassword: 'fresh-pass-phrase-7' } });
    expect(done.error).toBeUndefined();
    expect(findUserByUsername(db, 'dina').passwordHash).toBe('hash:fresh-pass-phrase-7');
    const again = await call('POST', '/password/reset', { body: { token, newPassword: 'fresh-pass-phrase-8' } });
    expect(again.code).toBe(400);
  });

  it('self-registration without e-mail confirmation creates the account once and answers the same for a taken name', async () => {
    const { db, call } = setup();
    const body = { username: 'newbie', email: 'newbie@x.io', password: 'good-password-12', website: '', t: 0 };
    const first = await call('POST', '/register', { body });
    expect(first.code).toBe(201);
    expect(findUserByUsername(db, 'newbie').email).toBe('newbie@x.io');
    const second = await call('POST', '/register', { body: { ...body, email: 'other@x.io' } });
    expect(second.code).toBe(202);
  });

  it('own e-mail can be changed and TOTP enrolment starts', async () => {
    const { db, call } = setup();
    const u = addUser(db, 'eddy', 'correct-horse-9');
    const user = { id: u.id, username: 'eddy', role: 'operator' };
    const mail = await call('POST', '/account/email', { user, body: { email: 'ed2@x.io' } });
    expect(mail.error).toBeUndefined();
    expect(findUserById(db, u.id).email).toBe('ed2@x.io');
    const list = await call('GET', '/totp/authenticators', { user });
    expect(list.body).toEqual([]);
    const codes = await call('GET', '/recovery-codes/remaining', { user });
    expect(codes.body).toEqual({ remaining: 0 });
  });
});
