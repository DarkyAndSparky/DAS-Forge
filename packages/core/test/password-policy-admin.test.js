import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { ensureAuthTables } from '../src/auth/schema.js';
import { createUser } from '../src/auth/users.js';
import { createAdmin } from '../src/admin/index.js';
import { createPasswordPolicy, PasswordPolicyError } from '../src/auth/password-policy-store.js';
import { checkPasswordPolicy, characterClasses } from '../src/auth/password-policy.js';
import { query } from '../src/audit/index.js';

function setup() {
  const db = createSqliteAdapter({ file: ':memory:' });
  ensureAuthTables(db);
  const policy = createPasswordPolicy({ db, config: {}, appName: 'Workshop' });
  const routes = {};
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; } };
  const requireAuth = () => (req, res, next) => (req.user ? next() : res.status(401).end());
  const requirePermission = (perm) => (req, res, next) => ((req.user.permissions ?? []).includes(perm) ? next() : res.status(403).end());
  createAdmin({ db, passwordPolicy: policy, userManagement: { authProvider: { hashPassword: async (p) => p }, roles: ['admin', 'operator'], adminRole: 'admin' } }).mount(app, { requireAuth, requirePermission });
  return { db, policy, routes };
}
const admin = { id: 1, username: 'root', permissions: ['admin.access'] };
function call(chain, req) {
  return new Promise((resolve) => {
    req.on ??= function (ev, cb) { if (ev === 'end') cb(); return this; };
    const res = { code: 200, body: '', locals: { cspNonce: req.nonce }, set() { return this; }, type() { return this; }, status(c) { this.code = c; return this; } };
    res.end = () => { resolve(res); return res; };
    res.send = (b) => { res.body = b; resolve(res); return res; };
    res.redirect = (c, loc) => { res.code = c; res.location = loc; resolve(res); return res; };
    let i = 0;
    const next = () => { const h = chain[i++]; if (h) Promise.resolve(h(req, res, next)).catch((e) => { res.body = String(e); resolve(res); }); };
    next();
  });
}

describe('password rules', () => {
  it('counts character classes', () => {
    expect(characterClasses('abc')).toBe(1);
    expect(characterClasses('abcDEF')).toBe(2);
    expect(characterClasses('Абв-1x')).toBe(4);
  });

  it('refuses too few classes and words from the context', () => {
    expect(checkPasswordPolicy('abcdefghijkl', { minLength: 12, requireClasses: 3 }).problems).toContain('TOO_FEW_CLASSES');
    expect(checkPasswordPolicy('Abcdefgh1jkl!', { minLength: 12, requireClasses: 4 }).ok).toBe(true);
    expect(checkPasswordPolicy('xx-ivanov-2026-xx', { minLength: 8, context: ['ivanov'] }).problems).toContain('CONTAINS_CONTEXT');
    expect(checkPasswordPolicy('xx-ab-2026-xxxxx', { minLength: 8, context: ['ab'] }).ok).toBe(true);
  });
});

describe('createPasswordPolicy', () => {
  it('starts from the configuration, 12 characters by default', () => {
    const { policy } = setup();
    expect(policy.get()).toMatchObject({ profile: 'nist', minLength: 12, adminMinLength: 12, requireClasses: 0 });
    expect(policy.check('short-pass1').problems).toContain('TOO_SHORT');
    expect(policy.check('long-enough-pass').ok).toBe(true);
  });

  it('saves a profile and individual numbers, shared through the database', () => {
    const { db, policy } = setup();
    policy.set({ profile: 'fstec' });
    expect(policy.get().profile).toBe('fstec');
    expect(policy.check('longenoughpass').problems).toContain('TOO_FEW_CLASSES');
    expect(createPasswordPolicy({ db, config: {} }).get().requireClasses).toBe(4);
    policy.set({ minLength: 14, adminMinLength: 16, requireClasses: 0 });
    expect(policy.get()).toMatchObject({ profile: 'custom', minLength: 14, adminMinLength: 16 });
    expect(policy.check('thirteen-chars', { isAdmin: true }).problems).toContain('TOO_SHORT');
    expect(policy.check('fourteen-chars!').ok).toBe(true);
    policy.reset();
    expect(policy.get().minLength).toBe(12);
  });

  it('rejects bad values and unknown profiles', () => {
    const { policy } = setup();
    expect(() => policy.set({ minLength: 7 })).toThrow(PasswordPolicyError);
    expect(() => policy.set({ minLength: 14, adminMinLength: 13 })).toThrow(PasswordPolicyError);
    expect(() => policy.set({ requireClasses: 5 })).toThrow(PasswordPolicyError);
    expect(() => policy.set({ profile: 'x' })).toThrow(PasswordPolicyError);
  });

  it('refuses the login, the e-mail name and the application name inside a password', () => {
    const { policy } = setup();
    expect(policy.check('my-ivanov-password', { username: 'ivanov' }).problems).toContain('CONTAINS_CONTEXT');
    expect(policy.check('my-petrov-password', { username: 'x', email: 'petrov@example.com' }).problems).toContain('CONTAINS_CONTEXT');
    expect(policy.check('use-workshop-always').problems).toContain('CONTAINS_CONTEXT');
  });

  it('the configured admin length falls back to the general one', () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    const p = createPasswordPolicy({ db, config: { minLength: 9 } });
    expect(p.get()).toMatchObject({ minLength: 9, adminMinLength: 9 });
  });
});

describe('admin section "Password policy"', () => {
  it('shows the page and saves a profile with an audit entry', async () => {
    const { db, policy, routes } = setup();
    createUser(db, { username: 'root', passwordHash: 'h', role: 'admin' });
    const page = await call(routes['GET /admin/password-policy'], { user: admin, query: {} });
    expect(page.body).toContain('name="minLength"');
    const r = await call(routes['POST /admin/password-policy'], { user: admin, body: { profile: 'fstec', minLength: '12', adminMinLength: '12', requireClasses: '0' } });
    expect(r.location).toBe('/admin/password-policy?msg=ok');
    expect(policy.get().profile).toBe('fstec');
    expect(query(db, { action: 'admin.passwordpolicy.set' }).length).toBe(1);
  });

  it('numbers typed by hand win over the unchanged profile; bad numbers are reported', async () => {
    const { policy, routes } = setup();
    await call(routes['POST /admin/password-policy'], { user: admin, body: { profile: 'nist', minLength: '15', adminMinLength: '15', requireClasses: '2' } });
    expect(policy.get()).toMatchObject({ profile: 'custom', minLength: 15, requireClasses: 2 });
    const bad = await call(routes['POST /admin/password-policy'], { user: admin, body: { profile: 'custom', minLength: '3', adminMinLength: '12', requireClasses: '0' } });
    expect(bad.location).toBe('/admin/password-policy?msg=bad&e=MIN_LENGTH_INVALID');
  });

  it('resets to the configured values', async () => {
    const { policy, routes } = setup();
    policy.set({ profile: 'fstec' });
    const r = await call(routes['POST /admin/password-policy/reset'], { user: admin });
    expect(r.code).toBe(303);
    expect(policy.get().profile).toBe('nist');
  });

  it('requires a new password for everyone but yourself, or for administrators only, and signs them out', async () => {
    const { db, routes } = setup();
    createUser(db, { username: 'root', passwordHash: 'h', role: 'admin' });
    createUser(db, { username: 'boss', passwordHash: 'h', role: 'admin' });
    createUser(db, { username: 'ann', passwordHash: 'h', role: 'operator' });
    let r = await call(routes['POST /admin/password-policy/require-change'], { user: admin, body: { scope: 'admins' } });
    expect(r.location).toBe('/admin/password-policy?msg=ok&n=1');
    const flag = (name) => db.get(`SELECT must_change_password AS m FROM users WHERE username = ?`, [name]).m;
    expect([flag('root'), flag('boss'), flag('ann')]).toEqual([0, 1, 0]);
    r = await call(routes['POST /admin/password-policy/require-change'], { user: admin, body: { scope: 'all' } });
    expect(r.location).toBe('/admin/password-policy?msg=ok&n=2');
    expect([flag('root'), flag('ann')]).toEqual([0, 1]);
    expect(query(db, { action: 'admin.passwordpolicy.require_change' }).length).toBe(2);
  });

  it('is refused for a user without the admin permission', async () => {
    const { routes } = setup();
    const r = await call(routes['GET /admin/password-policy'], { user: { id: 2, username: 'x', permissions: [] }, query: {} });
    expect(r.code).toBe(403);
  });
});

describe('password age, history and the leaked list', async () => {
  const { createHash } = await import('node:crypto');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { recordPassword, recentPasswordHashes, passwordExpired } = await import('../src/auth/password-history.js');
  const { createPasswordBlocklist } = await import('../src/auth/password-blocklist.js');
  const { updatePasswordHash } = await import('../src/auth/users.js');
  const { resetUserPassword } = await import('../src/auth/user-admin.js');
  const verify = async (stored, plain) => ({ valid: stored === `h:${plain}` });
  const day = 24 * 60 * 60 * 1000;

  it('stamps an unstamped account on first look and expires it after the allowed days', () => {
    const { db } = setup();
    createUser(db, { username: 'ann', passwordHash: 'h' });
    const id = db.get(`SELECT id FROM users`).id;
    const t0 = Date.now();
    expect(passwordExpired(db, id, 90, t0)).toBe(false);
    expect(passwordExpired(db, id, 90, t0 + 89 * day)).toBe(false);
    expect(passwordExpired(db, id, 90, t0 + 91 * day)).toBe(true);
    expect(passwordExpired(db, id, 0, t0 + 999 * day)).toBe(false);
    recordPassword(db, id, 'h:new', t0 + 91 * day);
    expect(passwordExpired(db, id, 90, t0 + 92 * day)).toBe(false);
  });

  it('keeps the last 24 hashes and records real changes only', () => {
    const { db } = setup();
    createUser(db, { username: 'ann', passwordHash: 'h' });
    const id = db.get(`SELECT id FROM users`).id;
    for (let i = 0; i < 30; i++) recordPassword(db, id, `h:p${i}`);
    expect(recentPasswordHashes(db, id, 100).length).toBe(24);
    expect(recentPasswordHashes(db, id, 2)).toEqual(['h:p29', 'h:p28']);
    const n = recentPasswordHashes(db, id, 100).length;
    updatePasswordHash(db, id, 'h:rehash');
    expect(recentPasswordHashes(db, id, 100).length).toBe(n);
    updatePasswordHash(db, id, 'h:changed', { clearMustChange: true });
    expect(recentPasswordHashes(db, id, 1)).toEqual(['h:changed']);
    resetUserPassword(db, id, 'h:temp');
    expect(recentPasswordHashes(db, id, 1)).toEqual(['h:temp']);
  });

  it('refuses a password the account used before (REUSED), only when history is on', async () => {
    const { db, policy } = setup();
    createUser(db, { username: 'ann', passwordHash: 'h:current-password-1' });
    const id = db.get(`SELECT id FROM users`).id;
    recordPassword(db, id, 'h:older-password-123');
    const ctx = { userId: id, verify, currentHash: 'h:current-password-1' };
    expect((await policy.checkFull('older-password-123', {}, ctx)).ok).toBe(true);
    policy.set({ historyCount: 5 });
    expect((await policy.checkFull('older-password-123', {}, ctx)).problems).toContain('REUSED');
    expect((await policy.checkFull('current-password-1', {}, ctx)).problems).toContain('REUSED');
    expect((await policy.checkFull('totally-new-password', {}, ctx)).ok).toBe(true);
  });

  it('refuses a password found in the local leaked list (LEAKED); a missing file never blocks', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bl-'));
    const sha = (p) => createHash('sha1').update(p).digest('hex').toUpperCase();
    const words = Array.from({ length: 200 }, (_, i) => `leaked-pass-${i}`);
    const file = path.join(dir, 'pwned.txt');
    writeFileSync(file, `${words.map((w) => `${sha(w)}:${w.length}`).sort().join('\r\n')}\r\n`);
    const db = createSqliteAdapter({ file: ':memory:' });
    ensureAuthTables(db);
    const p = createPasswordPolicy({ db, blocklistFile: file });
    for (const w of [words[0], words[77], words[199]]) expect((await p.checkFull(w)).problems).toContain('LEAKED');
    expect((await p.checkFull('not-in-the-list-at-all')).ok).toBe(true);
    expect(await createPasswordBlocklist(path.join(dir, 'nope.txt')).has('x')).toBe(false);
  });

  it('profile FSTEC turns on 90 days and 12 remembered passwords; numbers are validated', () => {
    const { policy } = setup();
    policy.set({ profile: 'fstec' });
    expect(policy.get()).toMatchObject({ maxAgeDays: 90, historyCount: 12 });
    expect(() => policy.set({ historyCount: 25 })).toThrow(PasswordPolicyError);
    expect(() => policy.set({ maxAgeDays: -1 })).toThrow(PasswordPolicyError);
    expect(policy.set({ historyCount: 3 }).profile).toBe('custom');
  });

  it('the policy tells an expired account from a fresh one', () => {
    const { db, policy } = setup();
    createUser(db, { username: 'ann', passwordHash: 'h' });
    const id = db.get(`SELECT id FROM users`).id;
    policy.set({ maxAgeDays: 30 });
    expect(policy.isExpired(id)).toBe(false);
    db.run(`UPDATE users SET password_changed_at = ? WHERE id = ?`, [new Date(Date.now() - 40 * day).toISOString(), id]);
    expect(policy.isExpired(id)).toBe(true);
  });
});

describe('password policy page: two administrators (G-03)', () => {
  it('a stale form is refused with CONFLICT, the policy stays as the first administrator set it', async () => {
    const { routes, policy } = setup();
    const page = await call(routes['GET /admin/password-policy'], { user: admin, query: {} });
    const v = /name="_v" value="([0-9a-f]+)"/.exec(page.body)[1]; // both administrators opened this page
    let r = await call(routes['POST /admin/password-policy'], { user: admin, body: { profile: 'custom', minLength: '14', adminMinLength: '14', requireClasses: '1', _v: v } });
    expect(r.location).toBe('/admin/password-policy?msg=ok');
    r = await call(routes['POST /admin/password-policy'], { user: admin, body: { profile: 'custom', minLength: '9', adminMinLength: '9', requireClasses: '0', _v: v } });
    expect(r.location).toBe('/admin/password-policy?msg=bad&e=CONFLICT');
    expect(policy.get().minLength).toBe(14);
  });
});
