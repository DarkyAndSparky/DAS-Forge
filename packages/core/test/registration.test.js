import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { ensureAuthTables } from '../src/auth/schema.js';
import { findUserByUsername } from '../src/auth/users.js';
import { mountAccountRoutes } from '../src/accounts/index.js';
import { createRegistrationStore } from '../src/accounts/registration.js';
import { ACCOUNT_TEXTS } from '../src/accounts/texts.js';
import { renderLoginPage, renderRegisterPage, renderRegisterConfirmPage } from '../src/accounts/pages.js';

function fakeApp() {
  const routes = [];
  const reg = (method) => (path, ...h) => routes.push({ method, path, h });
  return { routes, use() {}, get: reg('GET'), post: reg('POST'), delete: reg('DELETE') };
}
const provider = { hashPassword: async (p) => `hash:${p}`, verifyPassword: async () => ({ valid: false }) };
const GOOD = 'correct-horse-battery-9';

function setup({ registration = { enabled: true }, mail = true } = {}) {
  const db = createSqliteAdapter({ file: ':memory:' });
  ensureAuthTables(db);
  const app = fakeApp();
  const sent = [];
  const emailService = mail ? { enabled: true, sendEmailVerification: async (m) => { sent.push(m); } } : { enabled: false };
  mountAccountRoutes(app, { db, authProvider: provider, emailService, appConfig: { auth: { registration }, email: { baseUrl: 'https://x.test' } }, permissionsForRole: () => [] });
  const handler = (method, path) => app.routes.find((r) => r.method === method && r.path === path)?.h.at(-1);
  const call = (method, path, body, extra = {}) => new Promise((resolve) => {
    const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); }, type() { return this; }, send(b) { resolve({ code: this.code, html: b }); }, locals: {} };
    Promise.resolve(handler(method, path)({ body, ip: '1.2.3.4', locale: 'ru', headers: {}, socket: {}, ...extra }, res, () => {})).catch((e) => resolve({ error: e }));
  });
  return { db, app, sent, call, has: (m, p) => Boolean(handler(m, p)) };
}
const tokenOf = (sent) => /token=([^&\s]+)/.exec(sent.at(-1).verifyUrl)[1];
const form = (o = {}) => ({ username: 'newbie', email: 'n@example.com', password: GOOD, t: Date.now() - 5000, ...o });

describe('self-registration', () => {
  it('is absent unless switched on', () => {
    const { has } = setup({ registration: { enabled: false } });
    expect(has('GET', '/register')).toBe(false);
    expect(has('POST', '/register')).toBe(false);
  });

  it('creates no account until the mailed link is opened, then creates it once', async () => {
    const { call, db, sent } = setup();
    expect((await call('POST', '/register', form())).code).toBe(202);
    expect(Boolean(findUserByUsername(db, 'newbie'))).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0].verifyUrl).toMatch(/^https:\/\/x\.test\/register\/confirm#token=/);
    const token = tokenOf(sent);
    expect((await call('POST', '/register/confirm', { token })).code).toBe(200);
    expect(findUserByUsername(db, 'newbie').role).toBe('operator');
    expect((await call('POST', '/register/confirm', { token })).code).toBe(400);
  });

  it('a filled hidden field or an instant submit answers the same but sends nothing', async () => {
    const { call, sent, db } = setup();
    expect((await call('POST', '/register', form({ website: 'http://spam' }))).code).toBe(202);
    expect((await call('POST', '/register', form({ t: Date.now() }))).code).toBe(202);
    expect(sent).toHaveLength(0);
    expect(db.get('SELECT COUNT(*) AS n FROM registrations').n).toBe(0);
  });

  it('a weak password and a bad name or e-mail are refused', async () => {
    const { call } = setup();
    expect((await call('POST', '/register', form({ password: 'short' }))).body.error).toBe('WEAK_PASSWORD');
    expect((await call('POST', '/register', form({ username: 'a b' }))).code).toBe(400);
    expect((await call('POST', '/register', form({ email: 'nope' }))).code).toBe(400);
  });

  it('does not reveal a taken username or e-mail, and sends nothing for it', async () => {
    const { call, sent } = setup();
    await call('POST', '/register', form());
    await call('POST', '/register/confirm', { token: tokenOf(sent) });
    const before = sent.length;
    const again = await call('POST', '/register', form({ email: 'other@example.com' }));
    expect(again.code).toBe(202);
    expect(sent).toHaveLength(before);
  });

  it('one mail per address in ten minutes, five requests per address per hour', async () => {
    const { call, sent } = setup();
    await call('POST', '/register', form());
    await call('POST', '/register', form({ username: 'other' }));
    expect(sent).toHaveLength(1);
    for (const i of [1, 2, 3, 4]) await call('POST', '/register', form({ username: `user${i}`, email: `user${i}@example.com` }));
    expect((await call('POST', '/register', form({ username: 'late', email: 'late@example.com' }))).code).toBe(429);
  });

  it('refuses to start while mail is not configured', async () => {
    const { call } = setup({ mail: false });
    expect((await call('POST', '/register', form())).code).toBe(503);
  });

  it('without confirmation (requireEmailConfirmation: false) the account appears at once, with no mail', async () => {
    const { call, db, sent } = setup({ registration: { enabled: true, requireEmailConfirmation: false }, mail: false });
    expect((await call('POST', '/register', form())).code).toBe(201);
    expect(Boolean(findUserByUsername(db, 'newbie'))).toBe(true);
    expect(sent).toHaveLength(0);
  });
});

describe('registration store and pages', () => {
  it('only the hash is stored; tokens expire and work once', () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    let t = 1_000_000;
    const s = createRegistrationStore(db, { now: () => t });
    const token = s.add({ username: 'a', email: 'A@x.test', passwordHash: 'h', ttlHours: 1 });
    expect(db.all('SELECT token_hash FROM registrations').some((r) => r.token_hash === token)).toBe(false);
    expect(s.consume(token)).toEqual({ username: 'a', email: 'a@x.test', passwordHash: 'h' });
    expect(s.consume(token)).toBeNull();
    const old = s.add({ username: 'b', email: 'b@x.test', passwordHash: 'h', ttlHours: 1 });
    t += 2 * 3_600_000;
    expect(s.consume(old)).toBeNull();
  });
  it('texts exist in both languages; the login page links to sign-up only when enabled', () => {
    expect(Object.keys(ACCOUNT_TEXTS.ru).sort()).toEqual(Object.keys(ACCOUNT_TEXTS.en).sort());
    const l = ACCOUNT_TEXTS.en;
    expect(renderLoginPage({ l, locale: 'en', registration: true })).toContain('href="/register"');
    expect(renderLoginPage({ l, locale: 'en' })).not.toContain('href="/register"');
    expect(renderRegisterPage({ l, locale: 'en' })).toContain('/register');
    expect(renderRegisterConfirmPage({ l, locale: 'en' })).toContain('/register/confirm');
  });
});
