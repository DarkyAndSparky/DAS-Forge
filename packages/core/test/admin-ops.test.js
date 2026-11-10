import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createLogDestination } from '../src/logs/destination.js';
import { createSqliteAdapter } from '../src/database/index.js';
import { ensureAuthTables } from '../src/auth/schema.js';
import { createUser } from '../src/auth/users.js';
import { createAdmin, compareVersions, checkLatest } from '../src/admin/index.js';
import { userVersion } from '../src/admin/sections-users.js';
import { query, log as auditLog } from '../src/audit/index.js';

function build(opts = {}) {
  const db = createSqliteAdapter({ file: ':memory:' });
  ensureAuthTables(db);
  const routes = {};
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; } };
  const requireAuth = () => (req, res, next) => (req.user ? next() : res.status(401).end());
  const requirePermission = (perm) => (req, res, next) => ((req.user.permissions ?? []).includes(perm) ? next() : res.status(403).end());
  createAdmin({ db, ...opts }).mount(app, { requireAuth, requirePermission });
  return { db, routes };
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

describe('users section', () => {
  it('lists, disables (not yourself, not the last admin) and audits', async () => {
    const { db, routes } = build();
    createUser(db, { username: 'root', passwordHash: 'h', role: 'admin' });
    createUser(db, { username: 'ann<b>', passwordHash: 'h', role: 'operator' });
    const page = await call(routes['GET /admin/users'], { user: admin, query: {} });
    expect(page.body).toContain('ann&lt;b&gt;');
    const annId = db.get(`SELECT id FROM users WHERE role = 'operator'`).id;
    let r = await call(routes['POST /admin/users/:id/disable'], { user: admin, params: { id: String(annId) } });
    expect(r.location).toBe('/admin/users?msg=ok');
    expect(db.get(`SELECT disabled FROM users WHERE id = ?`, [annId]).disabled).toBe(1);
    r = await call(routes['POST /admin/users/:id/disable'], { user: admin, params: { id: '1' } });
    expect(r.location).toBe('/admin/users?msg=bad&e=SELF');
    r = await call(routes['POST /admin/users/:id/enable'], { user: admin, params: { id: String(annId) } });
    expect(db.get(`SELECT disabled FROM users WHERE id = ?`, [annId]).disabled).toBe(0);
    expect(query(db, { action: 'admin.user.disable' }).length).toBe(1);
  });
});

describe('users section: account administration', () => {
  function manage(extra = {}) {
    const sent = [];
    const opts = {
      userManagement: {
        authProvider: { hashPassword: async (p) => `hash:${p}` },
        roles: ['admin', 'operator'],
        email: { service: { enabled: true, sendPasswordReset: async (m) => { sent.push(m); } }, baseUrl: 'https://app.test/' },
        ...extra,
      },
    };
    const { db, routes } = build(opts);
    createUser(db, { username: 'root', passwordHash: 'h', role: 'admin' });
    return { db, routes, sent };
  }
  const actor = { id: 99, username: 'boss', permissions: ['admin.access'] };
  const byName = (db, name) => db.get(`SELECT * FROM users WHERE username = ?`, [name]);

  it('creates an account with a one-time temporary password that is never audited', async () => {
    const { db, routes } = manage();
    const r = await call(routes['POST /admin/users/create'], { user: actor, body: { username: 'bob', email: 'bob@example.com', role: 'operator' } });
    expect(r.code).toBe(200);
    const row = byName(db, 'bob');
    expect(row.must_change_password).toBe(1);
    const shown = /hash:/.test(row.password_hash) ? row.password_hash.slice(5) : null;
    expect(r.body).toContain(shown);
    const entry = query(db, { action: 'admin.user.create' })[0];
    expect(JSON.stringify(entry)).not.toContain(shown);
    const bad = await call(routes['POST /admin/users/create'], { user: actor, body: { username: 'x', role: 'operator' } });
    expect(bad.location).toBe('/admin/users?msg=bad&e=USERNAME_INVALID');
    const role = await call(routes['POST /admin/users/create'], { user: actor, body: { username: 'carol', role: 'root' } });
    expect(role.location).toBe('/admin/users?msg=bad&e=ROLE_INVALID');
  });

  it('edits login and e-mail: unique, audited, sessions of that user end', async () => {
    const { db, routes } = manage();
    createUser(db, { username: 'ann', email: 'ann@example.com', passwordHash: 'h', role: 'operator' });
    createUser(db, { username: 'bob', passwordHash: 'h', role: 'operator' });
    const ann = byName(db, 'ann').id;
    let r = await call(routes['POST /admin/users/:id/profile'], { user: actor, params: { id: String(ann) }, body: { username: 'anna', email: '' } });
    expect(r.location).toBe('/admin/users?msg=ok');
    expect(byName(db, 'anna').email).toBeNull();
    r = await call(routes['POST /admin/users/:id/profile'], { user: actor, params: { id: String(ann) }, body: { username: 'bob', email: '' } });
    expect(r.location).toBe('/admin/users?msg=bad&e=USERNAME_TAKEN');
    r = await call(routes['POST /admin/users/:id/profile'], { user: actor, params: { id: String(ann) }, body: { username: 'anna', email: 'nope' } });
    expect(r.location).toBe('/admin/users?msg=bad&e=EMAIL_INVALID');
    expect(query(db, { action: 'admin.user.update' })).toHaveLength(1);
  });

  it('changes a role but never demotes the last administrator or yourself', async () => {
    const { db, routes } = manage();
    createUser(db, { username: 'ann', passwordHash: 'h', role: 'operator' });
    const ann = byName(db, 'ann').id;
    let r = await call(routes['POST /admin/users/:id/role'], { user: actor, params: { id: String(ann) }, body: { role: 'admin' } });
    expect(r.location).toBe('/admin/users?msg=ok');
    expect(byName(db, 'ann').role).toBe('admin');
    r = await call(routes['POST /admin/users/:id/role'], { user: actor, params: { id: String(ann) }, body: { role: 'operator' } });
    expect(r.location).toBe('/admin/users?msg=ok');
    r = await call(routes['POST /admin/users/:id/role'], { user: actor, params: { id: '1' }, body: { role: 'operator' } });
    expect(r.location).toBe('/admin/users?msg=bad&e=LAST_ADMIN');
    r = await call(routes['POST /admin/users/:id/role'], { user: { ...actor, id: ann }, params: { id: String(ann) }, body: { role: 'admin' } });
    expect(r.location).toBe('/admin/users?msg=bad&e=SELF');
  });

  it('resets a password: temporary (shown once, change forced) or by e-mail (link, no token in the audit)', async () => {
    const seen = [];
    const { db, routes, sent } = manage({ onPasswordReset: (u) => seen.push(u.username) });
    createUser(db, { username: 'ann', email: 'ann@example.com', passwordHash: 'old', role: 'operator' });
    const ann = byName(db, 'ann').id;
    let r = await call(routes['POST /admin/users/:id/reset'], { user: actor, params: { id: String(ann) }, body: { mode: 'temporary' } });
    expect(r.code).toBe(200);
    expect(byName(db, 'ann').password_hash).toMatch(/^hash:/);
    expect(byName(db, 'ann').must_change_password).toBe(1);
    expect(seen).toEqual(['ann']);
    r = await call(routes['POST /admin/users/:id/reset'], { user: actor, params: { id: String(ann) }, body: { mode: 'email' } });
    expect(r.location).toBe('/admin/users?msg=ok');
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('ann@example.com');
    expect(sent[0].resetUrl).toMatch(/^https:\/\/app\.test\/reset-password#token=/);
    const token = sent[0].resetUrl.split('token=')[1];
    expect(JSON.stringify(query(db, { action: 'admin.user.reset_password' }))).not.toContain(token);
    r = await call(routes['POST /admin/users/:id/reset'], { user: { ...actor, id: ann }, params: { id: String(ann) }, body: { mode: 'temporary' } });
    expect(r.location).toBe('/admin/users?msg=bad&e=SELF');
  });

  it('refuses e-mail reset without mail or without an address', async () => {
    const { db, routes } = manage({ email: undefined });
    createUser(db, { username: 'ann', email: 'ann@example.com', passwordHash: 'old', role: 'operator' });
    const r = await call(routes['POST /admin/users/:id/reset'], { user: actor, params: { id: String(byName(db, 'ann').id) }, body: { mode: 'email' } });
    expect(r.location).toBe('/admin/users?msg=bad&e=EMAIL_UNAVAILABLE');
    const m = manage();
    createUser(m.db, { username: 'dan', passwordHash: 'old', role: 'operator' });
    const r2 = await call(m.routes['POST /admin/users/:id/reset'], { user: actor, params: { id: String(byName(m.db, 'dan').id) }, body: { mode: 'email' } });
    expect(r2.location).toBe('/admin/users?msg=bad&e=NO_EMAIL');
  });

  describe('user card and inactive accounts (R-07)', () => {
    const DAY = 86_400_000;
    const seed = (db, name, { daysAgo = null, created = 400, role = 'operator' } = {}) => {
      createUser(db, { username: name, email: `${name}@example.com`, passwordHash: 'h', role });
      const id = byName(db, name).id;
      db.run('UPDATE users SET created_at = ? WHERE id = ?', [new Date(Date.now() - created * DAY).toISOString(), id]);
      if (daysAgo !== null) {
        const t = new Date(Date.now() - daysAgo * DAY).toISOString();
        db.run('INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)', [`sid-${name}`, id, t, new Date(Date.now() + DAY).toISOString(), t]);
      }
      return id;
    };

    it('lists only active accounts idle longer than N days (never-signed-in ones by creation date), not disabled or fresh ones', async () => {
      const { db, routes } = manage();
      seed(db, 'old1', { daysAgo: 200 });
      seed(db, 'fresh', { daysAgo: 3 });
      seed(db, 'never', { daysAgo: null, created: 300 });
      seed(db, 'newbie', { daysAgo: null, created: 5 });
      const off = seed(db, 'off', { daysAgo: 500 });
      db.run('UPDATE users SET disabled = 1 WHERE id = ?', [off]);
      const page = await call(routes['GET /admin/users/inactive'], { user: actor, query: { days: '90' } });
      expect(page.body).toContain('old1');
      expect(page.body).toContain('never');
      expect(page.body).not.toContain('>fresh<');
      expect(page.body).not.toContain('>newbie<');
      expect(page.body).not.toContain('>off<');
      expect(page.body).toContain('/admin/users/inactive/disable');
    });

    it('bulk disable closes sessions, mails, audits each, skips the last administrator and yourself', async () => {
      const { db, routes } = manage();
      const old = seed(db, 'old1', { daysAgo: 200 });
      seed(db, 'lonelyadmin', { daysAgo: 300, role: 'admin' }); // 'root' (from manage) is also an admin, so this one may go
      const r = await call(routes['POST /admin/users/inactive/disable'], { user: actor, query: {}, body: { days: '90' } });
      expect(r.location).toMatch(/^\/admin\/users\/inactive\?days=90&msg=bulk&n=\d+&s=\d+$/);
      expect(byName(db, 'old1').disabled).toBe(1);
      expect(db.get('SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?', [old]).c).toBe(0);
      expect(query(db, { action: 'admin.user.disable' }).some((e) => e.meta.reason === 'inactive_90d')).toBe(true);
      expect(query(db, { action: 'admin.user.disable_inactive' })).toHaveLength(1);
      // the active administrator count stays above zero
      expect(db.get("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND disabled = 0").c).toBeGreaterThan(0);
    });

    it('the card shows dates, sessions, devices and events, never a session id', async () => {
      const { db, routes } = manage();
      const id = seed(db, 'ann', { daysAgo: 2 });
      db.exec('CREATE TABLE IF NOT EXISTS login_devices (user_id INTEGER, device_hash TEXT, first_seen_at TEXT, last_seen_at TEXT, first_ip TEXT, user_agent TEXT)');
      db.run('INSERT INTO login_devices VALUES (?, ?, ?, ?, ?, ?)', [id, 'h1', new Date().toISOString(), new Date().toISOString(), '10.1.2.3', 'Mozilla/5.0 (Windows NT 10.0) Chrome/120']);
      auditLog(db, { actor: 'ann', action: 'auth.login', entity: 'user', entityId: id });
      const page = await call(routes['GET /admin/users/:id'], { user: actor, params: { id: String(id) }, query: {} });
      expect(page.body).toContain('Карточка пользователя');
      expect(page.body).toContain('10.1.2.3');
      expect(page.body).toContain('Chrome');
      expect(page.body).toContain('auth.login');
      expect(page.body).not.toContain('sid-ann');
    });
  });

  describe('second factor reset and letters to the user (R-06, R-22)', () => {
    const notices = [];
    const mailed = () => manage({ email: { service: { enabled: true, sendPasswordReset: async () => {}, sendSystemNotice: async (m) => { notices.push(['notice', m]); }, sendAccountBanned: async (m) => { notices.push(['banned', m]); }, sendAccountUnbanned: async (m) => { notices.push(['unbanned', m]); } }, baseUrl: 'https://app.test/' } });
    const enrol = (db, userId) => {
      const a = db.run("INSERT INTO authenticators (user_id, type, name, status) VALUES (?, 'totp', 'phone', 'active')", [userId]);
      db.run('INSERT INTO totp_credentials (authenticator_id, secret) VALUES (?, ?)', [a.lastInsertRowid, 'sealed']);
      db.run("INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, 'h')", [userId]);
    };

    it('reset removes factors and codes, signs the user out, writes audit and mails the user', async () => {
      notices.length = 0;
      const { db, routes } = mailed();
      createUser(db, { username: 'ann', email: 'ann@example.com', passwordHash: 'h', role: 'operator' });
      const ann = byName(db, 'ann').id;
      enrol(db, ann);
      let r = await call(routes['POST /admin/users/:id/reset-mfa'], { user: actor, params: { id: String(ann) }, body: {} });
      expect(r.location).toBe('/admin/users?msg=ok');
      expect(db.get('SELECT COUNT(*) AS c FROM authenticators WHERE user_id = ?', [ann]).c).toBe(0);
      expect(db.get('SELECT COUNT(*) AS c FROM recovery_codes WHERE user_id = ?', [ann]).c).toBe(0);
      expect(db.get('SELECT COUNT(*) AS c FROM totp_credentials').c).toBe(0);
      expect(notices.at(-1)[1].subject).toBe('Второй фактор сброшен');
      expect(notices.at(-1)[1].to).toBe('ann@example.com');
      expect(query(db, { action: 'admin.user.reset_mfa' })[0].meta).toMatchObject({ removedAuthenticators: 1, notified: true });
      r = await call(routes['POST /admin/users/:id/reset-mfa'], { user: actor, params: { id: String(ann) }, body: {} });
      expect(r.location).toBe('/admin/users?msg=bad&e=NO_MFA');
      r = await call(routes['POST /admin/users/:id/reset-mfa'], { user: { ...actor, id: ann }, params: { id: String(ann) }, body: {} });
      expect(r.location).toBe('/admin/users?msg=bad&e=SELF');
    });

    it('new recovery codes are shown once, replace the old set, and need a confirmed authenticator', async () => {
      notices.length = 0;
      const { db, routes } = mailed();
      createUser(db, { username: 'ann', email: 'ann@example.com', passwordHash: 'h', role: 'operator' });
      const ann = byName(db, 'ann').id;
      let r = await call(routes['POST /admin/users/:id/recovery-codes'], { user: actor, params: { id: String(ann) }, body: {} });
      expect(r.location).toBe('/admin/users?msg=bad&e=NO_ACTIVE_MFA');
      enrol(db, ann);
      r = await call(routes['POST /admin/users/:id/recovery-codes'], { user: actor, params: { id: String(ann) }, body: {} });
      expect(r.code).toBe(200);
      expect(r.body.match(/<li><code>/g).length).toBe(8);
      expect(db.get('SELECT COUNT(*) AS c FROM recovery_codes WHERE user_id = ?', [ann]).c).toBe(8);
      const audited = JSON.stringify(query(db, { action: 'admin.user.recovery_codes' }));
      for (const code of r.body.match(/<code>([^<]+)<\/code>/g)) expect(audited).not.toContain(code.replace(/<\/?code>/g, ''));
      expect(JSON.stringify(notices)).not.toMatch(/<code>/); // the letter carries no codes
      expect(notices.at(-1)[1].subject).toBe('Выпущены новые коды восстановления');
    });

    it('role change, forced sign-out, temporary password and disable/enable each mail the user; a missing address or mail never blocks', async () => {
      notices.length = 0;
      const { db, routes } = mailed();
      createUser(db, { username: 'ann', email: 'ann@example.com', passwordHash: 'h', role: 'operator' });
      createUser(db, { username: 'dan', passwordHash: 'h', role: 'operator' }); // no address
      const ann = byName(db, 'ann').id; const dan = byName(db, 'dan').id;
      await call(routes['POST /admin/users/:id/role'], { user: actor, params: { id: String(ann) }, body: { role: 'admin' } });
      await call(routes['POST /admin/users/:id/logout'], { user: actor, params: { id: String(ann) }, body: {} });
      const temp = await call(routes['POST /admin/users/:id/reset'], { user: actor, params: { id: String(ann) }, body: { mode: 'temporary' } });
      await call(routes['POST /admin/users/:id/disable'], { user: actor, params: { id: String(ann) }, body: {} });
      await call(routes['POST /admin/users/:id/enable'], { user: actor, params: { id: String(ann) }, body: {} });
      expect(notices.map((n) => n[0])).toEqual(['notice', 'notice', 'notice', 'banned', 'unbanned']);
      expect(notices[0][1].message).toContain('operator → admin');
      const tempPassword = temp.body.match(/<code[^>]*>([^<]+)<\/code>/)[1];
      expect(JSON.stringify(notices)).not.toContain(tempPassword); // the letter never carries the password
      expect(query(db, { action: 'admin.user.update' })[0].meta.notified).toBe(true);
      // no address: the action works, nothing is sent, the audit says so
      const before = notices.length;
      const r = await call(routes['POST /admin/users/:id/logout'], { user: actor, params: { id: String(dan) }, body: {} });
      expect(r.location).toBe('/admin/users?msg=ok');
      expect(notices.length).toBe(before);
      expect(query(db, { action: 'admin.user.force_logout' })[0].meta.notified).toBe(false);
    });
  });

  it('forces a sign-out, optionally with a password change', async () => {
    const { db, routes } = manage();
    createUser(db, { username: 'ann', passwordHash: 'h', role: 'operator' });
    const ann = byName(db, 'ann').id;
    let r = await call(routes['POST /admin/users/:id/logout'], { user: actor, params: { id: String(ann) }, body: {} });
    expect(r.location).toBe('/admin/users?msg=ok');
    expect(byName(db, 'ann').must_change_password).toBe(0);
    r = await call(routes['POST /admin/users/:id/logout'], { user: actor, params: { id: String(ann) }, body: { requireChange: '1' } });
    expect(byName(db, 'ann').must_change_password).toBe(1);
    expect(query(db, { action: 'admin.user.force_logout' })).toHaveLength(2);
  });

  it('lifts the sign-in lock through the app hook and audits it', async () => {
    const seen = [];
    const { db, routes } = manage({ onUnlock: (u) => seen.push(u.username) });
    createUser(db, { username: 'ann', passwordHash: 'h', role: 'operator' });
    const r = await call(routes['POST /admin/users/:id/unlock'], { user: actor, params: { id: String(byName(db, 'ann').id) }, body: {} });
    expect(r.location).toBe('/admin/users?msg=ok');
    expect(seen).toEqual(['ann']);
    expect(query(db, { action: 'admin.user.unlock' })).toHaveLength(1);
    const plain = manage();
    createUser(plain.db, { username: 'bob', passwordHash: 'h', role: 'operator' });
    const r2 = await call(plain.routes['POST /admin/users/:id/unlock'], { user: actor, params: { id: String(byName(plain.db, 'bob').id) }, body: {} });
    expect(r2.location).toContain('msg=bad');
  });

  it('removes only with confirmation; hard delete only when allowed', async () => {
    const { db, routes } = manage();
    createUser(db, { username: 'ann', passwordHash: 'h', role: 'operator' });
    const ann = byName(db, 'ann').id;
    let r = await call(routes['POST /admin/users/:id/remove'], { user: actor, params: { id: String(ann) }, body: { mode: 'anonymize' } });
    expect(r.location).toBe('/admin/users?msg=bad&e=CONFIRM');
    r = await call(routes['POST /admin/users/:id/remove'], { user: actor, params: { id: String(ann) }, body: { mode: 'delete', confirm: '1' } });
    expect(r.location).toBe('/admin/users?msg=bad&e=FORBIDDEN');
    r = await call(routes['POST /admin/users/:id/remove'], { user: actor, params: { id: String(ann) }, body: { mode: 'anonymize', confirm: '1' } });
    expect(r.location).toBe('/admin/users?msg=ok');
    expect(byName(db, 'ann')).toBeUndefined();
    const list = await call(routes['GET /admin/users'], { user: { ...actor, id: 1 }, query: {} });
    expect(list.body).toContain(`deleted-user-${ann}`);
    expect(list.body).not.toContain(`/admin/users/${ann}/enable`);
    expect(list.body).not.toContain(`/admin/users/${ann}/reset`);
    const again = await call(routes['POST /admin/users/:id/enable'], { user: actor, params: { id: String(ann) } });
    expect(again.location).toBe('/admin/users?msg=bad&e=NOT_FOUND');
    const hard = manage({ allowDelete: true });
    createUser(hard.db, { username: 'zed', passwordHash: 'h', role: 'operator' });
    const zed = byName(hard.db, 'zed').id;
    await call(hard.routes['POST /admin/users/:id/remove'], { user: actor, params: { id: String(zed) }, body: { mode: 'delete', confirm: '1' } });
    expect(hard.db.get(`SELECT id FROM users WHERE id = ?`, [zed])).toBeUndefined();
  });

  it('draws the action forms only for other accounts and only with management on', async () => {
    const { db, routes } = manage();
    createUser(db, { username: 'ann', passwordHash: 'h', role: 'operator' });
    const page = await call(routes['GET /admin/users'], { user: { ...actor, id: 1 }, query: {}, nonce: 'abc' });
    expect(page.body).toContain('/admin/users/create');
    expect(page.body).toContain('id="admConfirm"');
    expect(page.body).toContain('adm-remove');
    expect(page.body).toContain('<script nonce="abc">');
    expect(page.body).toContain('/admin/users/2/reset');
    expect(page.body).not.toContain('/admin/users/1/reset');
    const plain = build();
    expect(plain.routes['POST /admin/users/create']).toBeUndefined();
  });

  it('requires the provider and the roles', () => {
    expect(() => build({ userManagement: { roles: ['a'] } })).toThrow(/hashPassword/);
    expect(() => build({ userManagement: { authProvider: { hashPassword: async () => 'h' }, roles: [] } })).toThrow(/roles/);
  });

  it('a stale form is refused with CONFLICT, a current one is saved, a form without a fingerprint still works', async () => {
    const { db, routes } = manage();
    createUser(db, { username: 'ann', email: 'ann@example.com', passwordHash: 'h', role: 'operator' });
    const ann = byName(db, 'ann');
    const stale = userVersion(ann); // the form both administrators opened
    let r = await call(routes['POST /admin/users/:id/role'], { user: actor, params: { id: String(ann.id) }, body: { role: 'admin', _v: stale } });
    expect(r.location).toBe('/admin/users?msg=ok'); // the first one saves
    r = await call(routes['POST /admin/users/:id/profile'], { user: actor, params: { id: String(ann.id) }, body: { username: 'anna', email: '', _v: stale } });
    expect(r.location).toBe('/admin/users?msg=bad&e=CONFLICT'); // the second one is told, not silently applied
    expect(byName(db, 'ann').email).toBe('ann@example.com');
    r = await call(routes['POST /admin/users/:id/profile'], { user: actor, params: { id: String(ann.id) }, body: { username: 'anna', email: '', _v: userVersion(byName(db, 'ann')) } });
    expect(r.location).toBe('/admin/users?msg=ok'); // after reloading the page it goes through
    r = await call(routes['POST /admin/users/:id/role'], { user: actor, params: { id: String(ann.id) }, body: { role: 'operator' } });
    expect(r.location).toBe('/admin/users?msg=ok'); // no fingerprint = not checked
  });
});

describe('backups, logs, about sections', () => {
  it('backups lists files and runs a job', async () => {
    let ran = 0;
    const { db, routes } = build({ backups: { list: async () => [{ destinationId: 'd1', file: 'b.zip', sizeBytes: 2048, createdAt: 'x' }], run: async () => { ran++; } } });
    const page = await call(routes['GET /admin/backups'], { user: admin, query: {} });
    expect(page.body).toContain('b.zip');
    expect(page.body).toContain('2.0 KB');
    const r = await call(routes['POST /admin/backups/run'], { user: admin });
    expect(r.location).toBe('/admin/backups?msg=ok');
    expect(ran).toBe(1);
    expect(query(db, { action: 'admin.backup.run' }).length).toBe(1);
  });

  it('logs shows sink counters, or says there are none', async () => {
    const a = build({ logDestination: { stats: () => [{ type: 'http', sent: 5, dropped: 1, spilled: 0, queued: 2, failures: 3, lastError: '<x>' }] } });
    const p = await call(a.routes['GET /admin/logs'], { user: admin, query: {} });
    expect(p.body).toContain('&lt;x&gt;');
    const b = build({ logDestination: { stats: () => [] } });
    expect((await call(b.routes['GET /admin/logs'], { user: admin, query: {} })).body).toContain('stdout');
  });

  it('logs: shows where each sink writes and what it takes, never a secret; the test button reaches every sink (G-13)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'logs-'));
    const file = path.join(dir, 'app.log');
    const logDestination = createLogDestination({
      sinks: [
        { type: 'file', path: file, streams: ['app', 'audit'], minLevel: 'warn' },
        { type: 'http', url: 'http://127.0.0.1:1/ingest?token=SECRET-TOKEN', headers: { authorization: 'Bearer SECRET-HEADER' }, retryBaseMs: 5, flushIntervalMs: 5 },
      ],
      warn: () => {},
    });
    const { db, routes } = build({ logDestination });
    const page = await call(routes['GET /admin/logs'], { user: admin, query: {} });
    expect(page.body).toContain(file);
    expect(page.body).toContain('http://127.0.0.1:1/ingest');
    expect(page.body).toContain('app, audit');
    expect(page.body).toContain('≥ warn');
    expect(page.body).not.toContain('SECRET-TOKEN');
    expect(page.body).not.toContain('SECRET-HEADER');

    const r = await call(routes['POST /admin/logs/test'], { user: admin, body: {} });
    expect(r.code).toBe(200);
    expect(r.body).toMatch(/доставлено|delivered/);
    expect(r.body).toMatch(/не доставлено|not delivered/);
    const res = await logDestination.test({ timeoutMs: 2000 });
    expect(res.map((x) => x.ok)).toEqual([true, false]); // the file got the line (filters bypassed), the dead address did not
    expect(readFileSync(file, 'utf8')).toContain('das-forge log sink test');
    expect(res[1].error).toBeTruthy();
    const entry = query(db, { action: 'admin.logs.test' })[0];
    expect(entry.result).toBe('failure');
    expect(entry.meta).toMatchObject({ sinks: 2, failed: 1 });
    await logDestination.close({ timeoutMs: 50 });
  });

  it('about reads dependencies/licenses and checks npm with a fake fetch', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'about-'));
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { foo: '^1.0.0', bar: '^2.0.0' } }));
    mkdirSync(path.join(dir, 'node_modules/foo'), { recursive: true });
    writeFileSync(path.join(dir, 'node_modules/foo/package.json'), JSON.stringify({ version: '1.2.0', license: 'MIT' }));
    const fetchFn = async (url) => ({ ok: !url.includes('bar'), json: async () => ({ version: '1.3.0' }) });
    const { routes } = build({ about: { packageJsonPath: path.join(dir, 'package.json'), appName: 'app', appVersion: '9.9.9', fetchFn } });
    let page = await call(routes['GET /admin/about'], { user: admin, query: {} });
    expect(page.body).toContain('MIT');
    expect(page.body).toContain('9.9.9');
    await call(routes['POST /admin/about/check'], { user: admin, body: { x: '1' } });
    page = await call(routes['GET /admin/about'], { user: admin, query: {} });
    expect(page.body).toContain('1.3.0');
    expect(page.body).toContain('обновление');
  });

  it('backups shows the automatic backup settings and saves them, with an audit entry', async () => {
    let state = { enabled: true, schedule: '0 3 * * *', time: '03:00', nextRun: '2026-10-30T03:00:00.000Z' };
    const calls = [];
    const schedule = { get: () => state, set: (v) => { calls.push(v); if (v.time === 'bad') { const e = new Error('x'); e.code = 'TIME_INVALID'; throw e; } state = { ...state, enabled: v.enabled, time: v.time ?? state.time }; return state; } };
    const { db, routes } = build({ backups: { list: async () => [], run: async () => {}, schedule, info: { retentionDays: 14, destinations: ['local-1', 'nas'] } } });
    const page = await call(routes['GET /admin/backups'], { user: admin, query: { lang: 'en' } });
    expect(page.body).toContain('Automatic backups');
    expect(page.body).toContain('/admin/backups/schedule');
    expect(page.body).toContain('value="03:00"');
    expect(page.body).toContain('14');
    expect(page.body).toContain('local-1, nas');
    let r = await call(routes['POST /admin/backups/schedule'], { user: admin, body: { enabled: '1', time: '01:30' } });
    expect(r.location).toBe('/admin/backups?msg=ok');
    expect(calls[0]).toEqual({ enabled: true, time: '01:30' });
    r = await call(routes['POST /admin/backups/schedule'], { user: admin, body: { enabled: '1', time: 'bad' } });
    expect(r.location).toBe('/admin/backups?msg=bad&e=TIME_INVALID');
    const bad = await call(routes['GET /admin/backups'], { user: admin, query: { lang: 'en', msg: 'bad', e: 'TIME_INVALID' } });
    expect(bad.body).toContain('Enter the time as HH:MM');
    expect(query(db, { action: 'admin.backup.schedule' }).length).toBe(1);
  });

  it('about shows the diagnostics schedule form and saves it through the setting, with an audit entry', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'about4-'));
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'app', dependencies: {} }));
    let state = { enabled: true, schedule: '5 3 * * *', time: '03:05', nextRun: '2026-10-30T03:05:00.000Z' };
    const calls = [];
    const doctorSchedule = { get: () => state, set: (v) => { calls.push(v); if (v.time === 'bad') { const e = new Error('x'); e.code = 'TIME_INVALID'; throw e; } state = { ...state, enabled: v.enabled, time: v.time ?? state.time }; return state; } };
    const { db, routes } = build({ about: { packageJsonPath: path.join(dir, 'package.json'), doctor: async () => ({ categories: [], summary: { ok: 0, warn: 0, fail: 0 } }), doctorSchedule } });
    const page = await call(routes['GET /admin/about'], { user: admin, query: { lang: 'en' } });
    expect(page.body).toContain('/admin/about/doctor-schedule');
    expect(page.body).toContain('Run automatically every day');
    expect(page.body).toContain('value="03:05"');
    let r = await call(routes['POST /admin/about/doctor-schedule'], { user: admin, body: { enabled: '1', time: '06:15' } });
    expect(r.location).toBe('/admin/about?msg=ok');
    expect(calls[0]).toEqual({ enabled: true, time: '06:15' });
    r = await call(routes['POST /admin/about/doctor-schedule'], { user: admin, body: { time: '09:00' } });
    expect(calls[1].enabled).toBe(false); // the checkbox was not ticked
    r = await call(routes['POST /admin/about/doctor-schedule'], { user: admin, body: { enabled: '1', time: 'bad' } });
    expect(r.location).toBe('/admin/about?msg=bad&e=TIME_INVALID');
    expect(query(db, { action: 'admin.doctor.schedule' }).length).toBe(2);
  });

  it('about shows the dependencies of the core next to the application ones, with their purpose', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'about3-'));
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'app', dependencies: { zod: '^4.0.0' } }));
    const { routes } = build({ about: { packageJsonPath: path.join(dir, 'package.json'), appName: 'app', appVersion: '1.0.0' } });
    const en = await call(routes['GET /admin/about'], { user: admin, query: { lang: 'en' } });
    expect(en.body).toContain('Application dependencies');
    expect(en.body).toContain('Core dependencies (@das-forge/core)');
    expect(en.body).toContain('helmet');
    expect(en.body).toContain('Security headers');
    expect(en.body).toContain('optional'); // pino-pretty
    const ru = await call(routes['GET /admin/about'], { user: admin, query: { lang: 'ru' } });
    expect(ru.body).toContain('Заголовки безопасности');
    const off = build({ about: { packageJsonPath: path.join(dir, 'package.json'), coreDependencies: false } });
    expect((await call(off.routes['GET /admin/about'], { user: admin, query: { lang: 'en' } })).body).not.toContain('Core dependencies');
  });

  it('about also shows health, runs diagnostics on demand and prints the npm update command', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'about2-'));
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { foo: '^1.0.0' } }));
    mkdirSync(path.join(dir, 'node_modules/foo'), { recursive: true });
    writeFileSync(path.join(dir, 'node_modules/foo/package.json'), JSON.stringify({ version: '1.2.0', license: 'MIT' }));
    const fetchFn = async () => ({ ok: true, json: async () => ({ version: '1.3.0' }) });
    const doctor = async () => ({ categories: [{ name: 'Storage', checks: [{ name: 'data dir', status: 'warn', message: 'almost full <b>' }] }], summary: { ok: 0, warn: 1, fail: 0 } });
    const { db, routes } = build({ about: { packageJsonPath: path.join(dir, 'package.json'), fetchFn, health: () => ({ status: 'ok', database: 'ok', uptime: 3700 }), doctor } });
    let page = await call(routes['GET /admin/about'], { user: admin, query: { lang: 'en' } });
    expect(page.body).toContain('Health');
    expect(page.body).toContain('1h 1m');
    expect(page.body).toContain('have not run yet');
    await call(routes['POST /admin/about/doctor'], { user: admin, body: { x: '1' } });
    page = await call(routes['GET /admin/about'], { user: admin, query: { lang: 'en' } });
    expect(page.body).toContain('data dir');
    expect(page.body).toContain('almost full &lt;b&gt;');
    expect(query(db, { action: 'admin.about.doctor' }).length).toBe(1);
    await call(routes['POST /admin/about/check'], { user: admin, body: { x: '1' } });
    page = await call(routes['GET /admin/about'], { user: admin, query: { lang: 'en' } });
    expect(page.body).toContain('npm install foo@1.3.0');
  });

  it('checkLatest ignores a registry version that is not plain semver', async () => {
    const out = await checkLatest(['a', 'b', 'c'], { fetchFn: async (u) => ({ ok: true, json: async () => ({ version: u.endsWith('/a/latest') ? '1.2.3-rc.1' : u.endsWith('/b/latest') ? '1.0.0; rm -rf /' : { x: 1 } }) }) });
    expect(out).toEqual({ a: '1.2.3-rc.1', b: null, c: null });
  });

  it('compareVersions and checkLatest', async () => {
    expect(compareVersions('1.10.0', '1.9.9') > 0).toBe(true);
    expect(compareVersions('^2.0.0', '2.0.0')).toBe(0);
    expect(compareVersions('0.45.1', '0.45.2') < 0).toBe(true);
    const out = await checkLatest(['a', '@s/b'], { fetchFn: async (u) => { if (u.includes('%2F')) throw new Error('down'); return { ok: true, json: async () => ({ version: '3.0.0' }) }; } });
    expect(out).toEqual({ a: '3.0.0', '@s/b': null });
  });
});

describe('app overrides of core admin texts', () => {
  it('replaces only the given keys, per language', async () => {
    const { routes } = build({ texts: { 'admin-overview': { en: { overview: 'Dashboard' } } } });
    const en = await call(routes['GET /admin'], { user: admin, query: { lang: 'en' } });
    expect(en.body).toContain('Dashboard');
    expect(en.body).toContain('Uptime');
    const ru = await call(routes['GET /admin'], { user: admin, query: {} });
    expect(ru.body).toContain('Обзор');
    expect(ru.body).not.toContain('Dashboard');
  });
});

describe('backups section: verify, and the overview migrations tile', () => {
  const list = [{ destinationId: 'local-1', file: 'a.zip', path: '/data/backups/a.zip', sizeBytes: 10, createdAt: new Date().toISOString() }, { destinationId: 'ftp', file: 'b.zip', path: '/x/b.zip', supported: false, sizeBytes: 1, createdAt: new Date().toISOString() }];
  it('verifies only a file the list handed out, audits, reports the outcome', async () => {
    const seen = [];
    const { db, routes } = build({ backups: { list: () => list, verify: async (f) => { seen.push(f); return { ok: f.endsWith('a.zip'), message: 'integrity OK' }; } } });
    const page = await call(routes['GET /admin/backups'], { user: admin, query: {} });
    expect(page.body).toContain('/admin/backups/verify');
    expect(page.body.match(/action="\/admin\/backups\/verify"/g).length).toBe(1); // the unsupported row has no button
    let r = await call(routes['POST /admin/backups/verify'], { user: admin, body: { file: '/data/backups/a.zip' } });
    expect(r.location).toBe('/admin/backups?msg=ok&e=VERIFIED');
    r = await call(routes['POST /admin/backups/verify'], { user: admin, body: { file: '/etc/passwd' } });
    expect(r.location).toBe('/admin/backups?msg=bad&e=NOT_FOUND');
    r = await call(routes['POST /admin/backups/verify'], { user: admin, body: { file: '/x/b.zip' } });
    expect(r.location).toBe('/admin/backups?msg=bad&e=NOT_FOUND');
    expect(seen).toEqual(['/data/backups/a.zip']);
    expect(query(db, { action: 'admin.backup.verify' }).length).toBe(1);
  });
  it('a failed verification is reported, not thrown', async () => {
    const { routes } = build({ backups: { list: () => list, verify: async () => { throw new Error('bad key'); } } });
    const r = await call(routes['POST /admin/backups/verify'], { user: admin, body: { file: '/data/backups/a.zip' } });
    expect(r.location).toBe('/admin/backups?msg=bad&e=VERIFY_FAILED');
  });
  it('the overview shows the migrations tile only when some are pending', async () => {
    const { routes } = build({ migrations: () => [{ name: '001', applied: true }, { name: '002', applied: true }, { name: '003', applied: false }] });
    const page = await call(routes['GET /admin'], { user: admin, query: {} });
    expect(page.body).toContain('1 ожидают применения');
    const ok = build({ migrations: () => [{ name: '001', applied: true }] });
    expect((await call(ok.routes['GET /admin'], { user: admin, query: {} })).body).not.toContain('ожидают применения');
  });
});

describe('mail section: test letter', () => {
  const mk = (sendTest) => build({ mail: { service: { enabled: true, sendTest }, queue: null } });

  it('shows the form and sends one letter now, auditing a masked address', async () => {
    const sent = [];
    const { db, routes } = mk(async (m) => { sent.push(m); return { sent: true }; });
    const page = await call(routes['GET /admin/mail'], { user: { ...admin, email: 'root@example.com' }, query: {}, headers: {} });
    expect(page.body).toContain('action="/admin/mail/test"');
    expect(page.body).toContain('value="root@example.com"');
    const r = await call(routes['POST /admin/mail/test'], { user: admin, body: { to: 'ann@example.com' }, headers: {} });
    expect(r.location).toBe('/admin/mail?msg=ok');
    expect(sent).toEqual([{ to: 'ann@example.com', locale: expect.any(String) }]);
    const rows = query(db, { action: 'admin.mail.test' });
    expect(rows.length).toBe(1);
    expect(JSON.stringify(rows[0])).not.toContain('ann@example.com');
  });

  it('refuses a bad or multiple address without sending', async () => {
    let n = 0;
    const { routes } = mk(async () => { n += 1; return { sent: true }; });
    for (const to of ['nope', 'a@b.co, c@d.co', '', 'a@b']) {
      const r = await call(routes['POST /admin/mail/test'], { user: admin, body: { to }, headers: {} });
      expect(r.location).toBe('/admin/mail?msg=bad&e=ADDR');
    }
    expect(n).toBe(0);
  });

  it('reports the SMTP failure by its code only, and a switched-off mail as such', async () => {
    let { db, routes } = mk(async () => { const e = new Error('535 secret-password-here'); e.code = 'EMAIL_AUTH'; throw e; });
    let r = await call(routes['POST /admin/mail/test'], { user: admin, body: { to: 'a@b.co' }, headers: {} });
    expect(r.location).toBe('/admin/mail?msg=bad&e=EMAIL_AUTH');
    expect(r.location).not.toContain('secret');
    expect(query(db, { action: 'admin.mail.test' })[0].result).toBe('failure');
    ({ routes } = mk(async () => ({ sent: false, skipped: 'disabled' })));
    r = await call(routes['POST /admin/mail/test'], { user: admin, body: { to: 'a@b.co' }, headers: {} });
    expect(r.location).toBe('/admin/mail?msg=off');
  });
});

describe('processing register section', () => {
  const registry = { entries: [{ id: 'core.users', source: 'core', ru: { name: 'Учётные записи', purpose: 'Вход', data: 'логин', legalBasis: '=cmd', retention: 'пока есть запись', erasure: 'обезличивание' }, en: { name: 'Accounts', purpose: 'Sign-in', data: 'login', legalBasis: '=cmd', retention: 'while it exists', erasure: 'anonymise' } }], gaps: ['module.crm'] };

  it('shows the table in the language of the page, flags gaps and offers downloads', async () => {
    const { routes } = build({ processingRegistry: () => registry });
    const ru = await call(routes['GET /admin/registry'], { user: admin, query: { lang: 'ru' }, headers: {} });
    expect(ru.body).toContain('Учётные записи');
    expect(ru.body).toContain('module.crm');
    expect(ru.body).toContain('href="/admin/registry.csv"');
    expect(ru.body).toContain('href="/admin/registry.json"');
  });

  it('downloads md, csv and json, guards formulas in csv and audits each export', async () => {
    const { db, routes } = build({ processingRegistry: () => registry });
    const csv = await call(routes['GET /admin/registry.csv'], { user: admin, query: {}, headers: {} });
    expect(csv.body).toContain("'=cmd");
    const json = await call(routes['GET /admin/registry.json'], { user: admin, query: {}, headers: {} });
    expect(JSON.parse(json.body).gaps).toEqual(['module.crm']);
    await call(routes['GET /admin/registry.md'], { user: admin, query: {}, headers: {} });
    expect(query(db, { action: 'admin.registry.export' }).length).toBe(3);
  });

  it('is absent without the option', () => {
    const { routes } = build({});
    expect(routes['GET /admin/registry']).toBeUndefined();
  });
});
