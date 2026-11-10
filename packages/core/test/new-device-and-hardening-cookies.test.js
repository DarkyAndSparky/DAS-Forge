import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { ensureAuthTables } from '../src/auth/schema.js';
import { createUser } from '../src/auth/users.js';
import { recognizeDevice, describeAgent, DEVICE_COOKIE } from '../src/auth/devices.js';
import { renderEmail } from '../src/email/templates.js';
import { securityTxt } from '../src/http/security-txt.js';
import { sessionCookieName, createSessionMiddleware, endSession } from '../src/http/session.js';

function mem() {
  const db = createSqliteAdapter({ file: ':memory:' });
  ensureAuthTables(db);
  createUser(db, { username: 'ann', passwordHash: 'h', role: 'operator' });
  return db;
}

describe('device recognition', () => {
  it('registers the first browser silently, recognises it, and reports another one as new', () => {
    const db = mem();
    const first = recognizeDevice(db, { userId: 1, ip: '10.0.0.1', userAgent: 'x' });
    expect(first.isNew).toBe(true);
    expect(first.firstEver).toBe(true);
    const again = recognizeDevice(db, { userId: 1, deviceId: first.deviceId });
    expect(again).toMatchObject({ isNew: false, deviceId: first.deviceId });
    const other = recognizeDevice(db, { userId: 1, ip: '10.0.0.9' });
    expect(other.isNew).toBe(true);
    expect(other.firstEver).toBe(false);
    expect(other.deviceId).not.toBe(first.deviceId);
  });
  it('a cookie value is never stored as is, and one account\'s device is new for another', () => {
    const db = mem();
    createUser(db, { username: 'bob', passwordHash: 'h', role: 'operator' });
    const a = recognizeDevice(db, { userId: 1 });
    expect(db.all('SELECT device_hash FROM login_devices').every((r) => r.device_hash !== a.deviceId)).toBe(true);
    const b = recognizeDevice(db, { userId: 2, deviceId: a.deviceId });
    expect(b.isNew).toBe(true);
    expect(b.firstEver).toBe(true);
  });
  it('a malformed cookie value is replaced, not trusted', () => {
    const db = mem();
    const r = recognizeDevice(db, { userId: 1, deviceId: "x'; DROP TABLE users;--" });
    expect(r.deviceId).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(DEVICE_COOKIE).toBe('das_device');
  });
  it('removing the user removes the devices', () => {
    const db = mem();
    recognizeDevice(db, { userId: 1 });
    db.run('DELETE FROM users WHERE id = 1');
    expect(Number(db.get('SELECT COUNT(*) AS n FROM login_devices').n)).toBe(0);
  });
  it('describes a browser in a few words', () => {
    expect(describeAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/156.0 Safari/537.36')).toBe('Chrome / Windows');
    expect(describeAgent('')).toBe('?');
  });
  it('the e-mail says when, from where and on what, in both languages', () => {
    const d = { when: '2026-10-31 01:00:00 UTC', ip: '203.0.113.7', device: 'Chrome / Windows' };
    const ru = renderEmail('newDeviceLogin', d, { locale: 'ru' });
    expect(ru.subject).toBe('Вход с нового устройства');
    expect(JSON.stringify(ru)).toContain('203.0.113.7');
    expect(renderEmail('newDeviceLogin', d, { locale: 'en' }).subject).toBe('Sign-in from a new device');
  });
});

describe('security.txt', () => {
  const run = (cfg, req) => new Promise((resolve) => {
    const res = { headers: {}, set(k, v) { this.headers[k] = v; return this; }, type(t) { this.t = t; return this; }, send(b) { this.body = b; resolve({ res: this, next: false }); } };
    securityTxt(cfg, { now: () => Date.parse('2026-10-31T00:00:00Z') })({ method: 'GET', ...req }, res, () => resolve({ res, next: true }));
  });
  it('is served with a contact and an expiry, a bare address becomes mailto:', async () => {
    const { res } = await run({ contact: ['sec@example.org'], policy: 'https://example.org/SECURITY.md' }, { path: '/.well-known/security.txt' });
    expect(res.body).toContain('Contact: mailto:sec@example.org');
    expect(res.body).toContain('Expires: 2027-04-29');
    expect(res.body).toContain('Policy: https://example.org/SECURITY.md');
  });
  it('is not served without a contact, and other paths pass through; newlines cannot inject fields', async () => {
    expect((await run({}, { path: '/.well-known/security.txt' })).next).toBe(true);
    expect((await run({ contact: ['a@b.c'] }, { path: '/x' })).next).toBe(true);
    const { res } = await run({ contact: ['a@b.c'], policy: 'https://e.org/p\nContact: mailto:evil@x' }, { path: '/.well-known/security.txt' });
    expect(res.body.split('\n').filter((l) => l.startsWith('Contact:')).length).toBe(1);
  });
});

describe('__Host- session cookie', () => {
  it('is named only on request, forces Secure and is cleared with Secure', async () => {
    expect(sessionCookieName()).toBe('das_session');
    expect(sessionCookieName({ hostPrefix: true })).toBe('__Host-das_session');
    let opts;
    const stub = (o) => { opts = o; return (req, res, next) => next(); };
    const mw = createSessionMiddleware({ store: {}, secret: 'x'.repeat(20), ttlMs: 1000, cookieName: '__Host-das_session', expressSession: stub });
    const res = { locals: {}, cleared: null, clearCookie(n, o) { this.cleared = [n, o]; } };
    await new Promise((r) => mw({}, res, r));
    expect(opts.name).toBe('__Host-das_session');
    expect(opts.cookie.secure).toBe(true);
    await endSession({}, res);
    expect(res.cleared[0]).toBe('__Host-das_session');
    expect(res.cleared[1].secure).toBe(true);
  });
  it('the default stays the plain name and "auto" secure', async () => {
    let opts;
    createSessionMiddleware({ store: {}, secret: 'x'.repeat(20), ttlMs: 1000, expressSession: (o) => { opts = o; return () => {}; } });
    expect(opts.name).toBe('das_session');
    expect(opts.cookie.secure).toBe('auto');
  });
});
