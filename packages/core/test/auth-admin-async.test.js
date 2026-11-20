import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { createSqliteAdapter } from '../src/database/index.js';
import * as auth from '../src/auth/index.js';

const fresh = () => createSqliteAdapter({ file: ':memory:', walMode: false });
const code = async (p) => { try { await p; return null; } catch (e) { return e.code ?? e.message; } };
async function setup() {
  const db = fresh();
  const admin = await auth.createManagedUserAsync(db, { username: 'root', email: 'root@x.io', role: 'admin', passwordHash: 'h' });
  const ann = await auth.createManagedUserAsync(db, { username: 'Ann', email: 'ann@x.io', passwordHash: 'h' });
  return { db, admin, ann };
}

describe('asynchronous account administration', () => {
  it('validates, refuses duplicates, lists without secrets, pages and searches', async () => {
    const { db } = await setup();
    expect(await code(auth.createManagedUserAsync(db, { username: 'ab', passwordHash: 'h' }))).toBe('USERNAME_INVALID');
    expect(await code(auth.createManagedUserAsync(db, { username: 'ANN', passwordHash: 'h' }))).toBe('USERNAME_TAKEN');
    expect(await code(auth.createManagedUserAsync(db, { username: 'new1', email: 'ANN@x.io', passwordHash: 'h' }))).toBe('EMAIL_TAKEN');
    expect(await code(auth.createManagedUserAsync(db, { username: 'new2', email: 'bad', passwordHash: 'h' }))).toBe('EMAIL_INVALID');
    expect(await code(auth.createManagedUserAsync(db, { username: 'new3', role: 'x', allowedRoles: ['admin'], passwordHash: 'h' }))).toBe('ROLE_INVALID');
    const all = await auth.listUsersAsync(db);
    expect(all.items.map((u) => u.username)).toEqual(['Ann', 'root']);
    expect('passwordHash' in all.items[0]).toBe(false);
    expect(all.items[0]).toMatchObject({ mustChangePassword: true, activeAuthenticators: 0 });
    expect((await auth.listUsersAsync(db, { search: 'RO%' })).total).toBe(0);
    expect((await auth.listUsersAsync(db, { search: 'roo' })).items.length).toBe(1);
    expect((await auth.listUsersAsync(db, { role: 'admin', limit: 1 })).items.length).toBe(1);
    expect(await auth.getManagedUserAsync(db, 999)).toBeNull();
  });

  it('keeps the last active administrator, in every way to lose one', async () => {
    const { db, admin, ann } = await setup();
    expect(await code(auth.changeUserRoleAsync(db, admin.id, 'operator'))).toBe('LAST_ADMIN');
    expect(await code(auth.setUserDisabledAsync(db, admin.id, true))).toBe('LAST_ADMIN');
    expect(await code(auth.removeUserAsync(db, admin.id))).toBe('LAST_ADMIN');
    expect(await auth.countActiveAdminsAsync(db)).toBe(1);
    await auth.changeUserRoleAsync(db, ann.id, 'admin');
    expect((await auth.changeUserRoleAsync(db, admin.id, 'operator')).changed).toBe(true);
    expect(await code(auth.removeUserAsync(db, ann.id, { mode: 'bogus' }))).toMatch(/unknown mode/);
    expect(await code(auth.changeUserRoleAsync(db, 999, 'x'))).toBe('NOT_FOUND');
  });

  it('disable, rename, e-mail, password reset and forced logout revoke sessions', async () => {
    const { db, ann } = await setup();
    await auth.ensureAuthTablesAsync(db);
    const sess = (id) => db.run('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', [auth.hashSessionId(id), ann.id, new Date().toISOString(), new Date(Date.now() + 1e6).toISOString()]);
    sess('a'); sess('b'); sess('c');
    expect((await auth.renameUserAsync(db, ann.id, 'Annie', { exceptSessionId: 'a' })).revokedSessions).toBe(2);
    expect((await auth.renameUserAsync(db, ann.id, 'Annie')).revokedSessions).toBe(0);
    sess('d');
    expect(await auth.resetUserPasswordAsync(db, ann.id, 'newhash')).toEqual({ revokedSessions: 2 });
    expect(await auth.recentPasswordHashesAsync(db, ann.id, 3)).toEqual(['newhash']);
    sess('e');
    expect(await auth.forceUserLogoutAsync(db, ann.id, { requirePasswordChange: true })).toEqual({ revokedSessions: 1, mustChangePassword: true });
    sess('f');
    expect(await auth.setUserDisabledAsync(db, ann.id, true)).toMatchObject({ changed: true, revokedSessions: 1 });
    expect(await auth.setUserDisabledAsync(db, ann.id, true)).toMatchObject({ changed: false });
    expect((await auth.setUserEmailAsync(db, ann.id, null)).email).toBeNull();
    expect(await code(auth.setUserEmailAsync(db, ann.id, 'root@x.io'))).toBe('EMAIL_TAKEN');
  });

  it('requirePasswordChangeForAll skips the caller and other roles; reset MFA needs a factor', async () => {
    const { db, admin, ann } = await setup();
    await auth.updatePasswordHashAsync(db, ann.id, 'h', { clearMustChange: true });
    await auth.updatePasswordHashAsync(db, admin.id, 'h', { clearMustChange: true });
    expect(await auth.requirePasswordChangeForAllAsync(db, { exceptId: admin.id, roles: ['operator'] })).toMatchObject({ affected: 1 });
    expect((await auth.findUserByIdAsync(db, ann.id)).mustChangePassword).toBe(true);
    expect((await auth.findUserByIdAsync(db, admin.id)).mustChangePassword).toBe(false);
    expect(await code(auth.resetUserMfaAsync(db, ann.id))).toBe('NO_MFA');
    const e = await auth.startTotpEnrollmentAsync(db, ann.id, { accountName: 'ann' });
    await auth.generateRecoveryCodesAsync(db, ann.id, { count: 2 });
    expect((await auth.resetUserMfaAsync(db, ann.id)).removedAuthenticators).toBe(1);
    expect(db.get('SELECT COUNT(*) AS c FROM totp_credentials').c + db.get('SELECT COUNT(*) AS c FROM recovery_codes').c).toBe(0);
    expect(e.authenticatorId).toBeGreaterThan(0);
  });

  it('removeUser anonymizes by default and can delete', async () => {
    const { db, admin, ann } = await setup();
    expect(await auth.removeUserAsync(db, ann.id)).toEqual({ mode: 'anonymize', username: 'Ann' });
    expect((await auth.findUserByIdAsync(db, ann.id)).username).toBe(`deleted-user-${ann.id}`);
    expect((await auth.removeUserAsync(db, ann.id, { mode: 'delete', adminRole: 'nobody' })).mode).toBe('delete');
    expect(await auth.findUserByIdAsync(db, ann.id)).toBeNull();
    expect(admin.id).toBeGreaterThan(0);
  });
});

describe('asynchronous MFA roles', () => {
  it('sets, reads and refuses bad names; shares storage with the synchronous store', async () => {
    const db = fresh();
    const s = auth.createMfaRoleStoreAsync({ db });
    expect(await s.list()).toEqual([]);
    expect(await s.setRole('admin', true)).toEqual({ roles: ['admin'], changed: true });
    expect(await s.setRole('admin', true)).toEqual({ roles: ['admin'], changed: false });
    expect(auth.createMfaRoleStore({ db }).list()).toEqual(['admin']);
    expect(await s.has('admin')).toBe(true);
    expect(await s.setRole('admin', false)).toEqual({ roles: [], changed: true });
    await expect(s.setRole('bad role!', true)).rejects.toThrow(/not valid/);
  });
});

describe('asynchronous session store', () => {
  const express = { Store: class extends EventEmitter {} };
  const call = (fn, ...args) => new Promise((res, rej) => fn(...args, (err, v) => (err ? rej(err) : res(v))));
  it('stores under a hash, reads back, revokes by user, expires and refuses inactive users', async () => {
    const db = fresh();
    await auth.ensureAuthTablesAsync(db);
    const u = await auth.createUserAsync(db, { username: 'sess', passwordHash: 'h' });
    let active = true;
    const st = auth.createSessionStoreAsync({ db, expressSession: express, isUserActive: async () => active });
    await call(st.set.bind(st), 'sid1', { userId: u.id, cookie: { expires: new Date(Date.now() + 1e6) } });
    expect(db.get('SELECT id FROM sessions').id).toBe(auth.hashSessionId('sid1'));
    expect(await call(st.get.bind(st), 'sid1')).toMatchObject({ userId: u.id });
    expect(await call(st.get.bind(st), 'nope')).toBeNull();
    expect(await call(st.length.bind(st))).toBe(1);
    await call(st.touch.bind(st), 'sid1', { cookie: {} });
    active = false;
    await call(st.set.bind(st), 'sid1', { userId: u.id });
    expect(await call(st.length.bind(st))).toBe(0);
    active = true;
    await call(st.set.bind(st), 'sid2', { userId: u.id });
    await call(st.set.bind(st), 'sid3', { userId: u.id });
    expect(await st.destroyUserSessions(u.id, { exceptSid: 'sid2' })).toBe(1);
    await call(st.destroy.bind(st), 'sid2');
    await call(st.set.bind(st), 'old', { cookie: { expires: new Date(Date.now() - 1000) } });
    expect(await call(st.get.bind(st), 'old')).toBeNull();
    db.run("INSERT INTO sessions (id, user_id, created_at, expires_at, data) VALUES ('h1:bad', NULL, ?, ?, 'not json')", [new Date().toISOString(), new Date(Date.now() + 1e6).toISOString()]);
    expect(await st.purgeExpired()).toBe(0);
    await call(st.clear.bind(st));
    expect(await call(st.length.bind(st))).toBe(0);
  });
  it('a failing database reaches the callback instead of crashing', async () => {
    const db = fresh();
    const st = auth.createSessionStoreAsync({ db, expressSession: express }); // tables were never created
    await expect(call(st.get.bind(st), 'x')).rejects.toThrow(/no such table/);
  });
});
