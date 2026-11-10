import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { createSqliteAdapter } from '../src/database/index.js';
import { findUserById, findUserByUsername, createUser } from '../src/auth/users.js';
import { createSession, verifySession } from './helpers/session-fixtures.js';
import {
  UserAdminError,
  validateUsername,
  generateTempPassword,
  countActiveAdmins,
  listUsers,
  createManagedUser,
  renameUser,
  setUserEmail,
  changeUserRole,
  setUserDisabled,
  resetUserPassword,
  forceUserLogout,
  removeUser,
} from '../src/auth/user-admin.js';

const codeOf = (fn) => {
  try {
    fn();
  } catch (e) {
    return e instanceof UserAdminError ? e.code : `other:${e.message}`;
  }
  return null;
};

describe('account administration (core/auth/user-admin)', () => {
  let db;
  let root;
  let alice;
  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
    root = createUser(db, { username: 'root', passwordHash: 'h', role: 'admin', email: 'root@example.com' });
    alice = createUser(db, { username: 'alice', passwordHash: 'h', role: 'operator', email: 'alice@example.com' });
  });
  afterEach(() => db.close());

  const ROLES = ['admin', 'operator'];

  it('validates usernames', () => {
    expect(validateUsername('ivan.petrov')).toBe('ivan.petrov');
    expect(validateUsername('Иван_П')).toBe('Иван_П');
    for (const bad of ['ab', 'a b c', 'x'.repeat(65), 'a;b', '', null, 'deleted-user-7', 'Deleted-User-1']) {
      expect(codeOf(() => validateUsername(bad))).toBe('USERNAME_INVALID');
    }
  });

  it('generates distinct 24-character temporary passwords without look-alike characters', () => {
    const a = generateTempPassword();
    expect(a.length).toBe(24);
    expect(/[0OIl1]/.test(a)).toBe(false);
    expect(a === generateTempPassword()).toBe(false);
  });

  it('lists accounts without secrets; search is literal and case-insensitive; filters and paging work', () => {
    createUser(db, { username: 'bob_x', passwordHash: 'h', role: 'operator' });
    createUser(db, { username: 'b%b', passwordHash: 'h', role: 'operator' });
    const all = listUsers(db);
    expect(all.total).toBe(4);
    expect(all.items.every((u) => !('passwordHash' in u) && !('password_hash' in u) && !('totpSecret' in u))).toBe(true);
    expect(all.items.map((u) => u.username)).toEqual(['alice', 'b%b', 'bob_x', 'root']);
    expect(listUsers(db, { search: 'ALI' }).items.map((u) => u.username)).toEqual(['alice']);
    expect(listUsers(db, { search: 'example.com' }).total).toBe(2);
    expect(listUsers(db, { search: '%' }).items.map((u) => u.username)).toEqual(['b%b']);
    expect(listUsers(db, { search: '_' }).items.map((u) => u.username)).toEqual(['bob_x']);
    expect(listUsers(db, { role: 'admin' }).total).toBe(1);
    db.run(`UPDATE users SET disabled = 1 WHERE username = 'alice'`);
    expect(listUsers(db, { disabled: true }).items[0].username).toBe('alice');
    const page = listUsers(db, { limit: 2, offset: 1 });
    expect(page.items.length).toBe(2);
    expect(page.total).toBe(4);
    expect(page.items[0].username).toBe('b%b');
  });

  it('creates accounts that must change their password; refuses bad, taken and reserved input', () => {
    const u = createManagedUser(db, { username: 'carol', email: 'carol@example.com', role: 'operator', passwordHash: 'x', allowedRoles: ROLES });
    expect(u.mustChangePassword).toBe(true);
    expect(codeOf(() => createManagedUser(db, { username: 'CAROL', passwordHash: 'x', allowedRoles: ROLES }))).toBe('USERNAME_TAKEN');
    expect(codeOf(() => createManagedUser(db, { username: 'dave', email: 'CAROL@example.com', passwordHash: 'x', allowedRoles: ROLES }))).toBe('EMAIL_TAKEN');
    expect(codeOf(() => createManagedUser(db, { username: 'dave', email: 'nope', passwordHash: 'x', allowedRoles: ROLES }))).toBe('EMAIL_INVALID');
    expect(codeOf(() => createManagedUser(db, { username: 'dave', role: 'god', passwordHash: 'x', allowedRoles: ROLES }))).toBe('ROLE_INVALID');
    expect(codeOf(() => createManagedUser(db, { username: 'x', passwordHash: 'x', allowedRoles: ROLES }))).toBe('USERNAME_INVALID');
  });

  it('rename: unique case-insensitively, revokes other sessions, spares the caller, same name is a no-op', () => {
    const s1 = createSession(db, { userId: alice.id, ttlMs: 60_000 });
    const s2 = createSession(db, { userId: alice.id, ttlMs: 60_000 });
    expect(codeOf(() => renameUser(db, alice.id, 'ROOT'))).toBe('USERNAME_TAKEN');
    expect(codeOf(() => renameUser(db, 999, 'zed_zed'))).toBe('NOT_FOUND');
    expect(codeOf(() => renameUser(db, alice.id, 'bad name'))).toBe('USERNAME_INVALID');
    expect(renameUser(db, alice.id, 'alice').revokedSessions).toBe(0);
    const r = renameUser(db, alice.id, 'alicia', { exceptSessionId: s1.id });
    expect(r.user.username).toBe('alicia');
    expect(r.revokedSessions).toBe(1);
    expect(verifySession(db, s1.id)).toBeTruthy();
    expect(verifySession(db, s2.id)).toBeNull();
    expect(findUserByUsername(db, 'alice')).toBeNull();
    // changing only the case of one's own login is allowed (it is not "taken" by oneself)
    expect(renameUser(db, alice.id, 'Alicia').user.username).toBe('Alicia');
  });

  it('e-mail: set, clear, unique, validated', () => {
    expect(setUserEmail(db, alice.id, 'new@example.com').email).toBe('new@example.com');
    expect(setUserEmail(db, alice.id, null).email).toBe(null);
    expect(codeOf(() => setUserEmail(db, alice.id, 'root@example.com'))).toBe('EMAIL_TAKEN');
    expect(codeOf(() => setUserEmail(db, alice.id, 'broken'))).toBe('EMAIL_INVALID');
  });

  it('the last active administrator cannot be demoted, disabled or removed - until there is another', () => {
    expect(countActiveAdmins(db)).toBe(1);
    expect(codeOf(() => changeUserRole(db, root.id, 'operator', { allowedRoles: ROLES }))).toBe('LAST_ADMIN');
    expect(codeOf(() => setUserDisabled(db, root.id, true))).toBe('LAST_ADMIN');
    expect(codeOf(() => removeUser(db, root.id))).toBe('LAST_ADMIN');
    expect(codeOf(() => removeUser(db, root.id, { mode: 'delete' }))).toBe('LAST_ADMIN');
    changeUserRole(db, alice.id, 'admin', { allowedRoles: ROLES });
    expect(countActiveAdmins(db)).toBe(2);
    expect(changeUserRole(db, root.id, 'operator', { allowedRoles: ROLES }).user.role).toBe('operator');
    expect(codeOf(() => setUserDisabled(db, alice.id, true))).toBe('LAST_ADMIN');
    // a disabled admin does not count as active
    changeUserRole(db, root.id, 'admin', { allowedRoles: ROLES });
    setUserDisabled(db, root.id, true);
    expect(countActiveAdmins(db)).toBe(1);
  });

  it('role change revokes sessions; unknown role refused; same role is a no-op', () => {
    const s = createSession(db, { userId: alice.id, ttlMs: 60_000 });
    expect(codeOf(() => changeUserRole(db, alice.id, 'god', { allowedRoles: ROLES }))).toBe('ROLE_INVALID');
    expect(changeUserRole(db, alice.id, 'operator', { allowedRoles: ROLES }).changed).toBe(false);
    expect(verifySession(db, s.id)).toBeTruthy();
    expect(changeUserRole(db, alice.id, 'admin', { allowedRoles: ROLES }).revokedSessions).toBe(1);
    expect(verifySession(db, s.id)).toBeNull();
  });

  it('disable revokes every session; enable brings the login back; repeating is a no-op', () => {
    const s = createSession(db, { userId: alice.id, ttlMs: 60_000 });
    const off = setUserDisabled(db, alice.id, true);
    expect(off.changed).toBe(true);
    expect(off.revokedSessions).toBe(1);
    expect(verifySession(db, s.id)).toBeNull();
    expect(setUserDisabled(db, alice.id, true).changed).toBe(false);
    expect(setUserDisabled(db, alice.id, false).user.disabled).toBe(false);
  });

  it('admin password reset stores the hash, forces a change and signs the user out everywhere', () => {
    const s = createSession(db, { userId: alice.id, ttlMs: 60_000 });
    const r = resetUserPassword(db, alice.id, 'new-hash');
    expect(r.revokedSessions).toBe(1);
    const u = findUserById(db, alice.id);
    expect(u.passwordHash).toBe('new-hash');
    expect(u.mustChangePassword).toBe(true);
    expect(verifySession(db, s.id)).toBeNull();
    expect(codeOf(() => resetUserPassword(db, 999, 'x'))).toBe('NOT_FOUND');
    expect(codeOf(() => resetUserPassword(db, alice.id, ''))).toMatch(/^other:/);
  });

  it('forceUserLogout revokes every session and can demand a new password', () => {
    const s = createSession(db, { userId: alice.id, ttlMs: 60_000 });
    const r = forceUserLogout(db, alice.id);
    expect(r).toEqual({ revokedSessions: 1, mustChangePassword: false });
    expect(verifySession(db, s.id)).toBeNull();
    expect(findUserById(db, alice.id).mustChangePassword).toBe(false);
    expect(forceUserLogout(db, alice.id, { requirePasswordChange: true }).mustChangePassword).toBe(true);
    expect(findUserById(db, alice.id).mustChangePassword).toBe(true);
    expect(codeOf(() => forceUserLogout(db, 999))).toBe('NOT_FOUND');
  });

  it('removeUser anonymizes by default (row stays, login dead) and can delete for good', () => {
    const r = removeUser(db, alice.id);
    expect(r.mode).toBe('anonymize');
    expect(r.username).toBe('alice');
    const gone = findUserById(db, alice.id);
    expect(gone.username).toBe(`deleted-user-${alice.id}`);
    expect(gone.disabled).toBe(true);
    const bob = createUser(db, { username: 'bobby', passwordHash: 'h' });
    removeUser(db, bob.id, { mode: 'delete' });
    expect(findUserById(db, bob.id)).toBeNull();
    expect(codeOf(() => removeUser(db, 999))).toBe('NOT_FOUND');
    expect(() => removeUser(db, alice.id, { mode: 'shred' })).toThrow();
  });
});

describe('forms: the Find and Create buttons sit on the row of their fields', () => {
  it('the theme lines up filter-form fields and buttons, and the users section uses it', async () => {
    const { themeHead } = await import('../src/ui/theme.js');
    expect(themeHead({})).toContain('.adm-filters .adm-btn{flex:none}');
    const src = (await import('node:fs')).readFileSync(new URL('../src/admin/sections-users.js', import.meta.url), 'utf8');
    expect(src).toContain('class="adm-card adm-filters"');
    expect(src.includes('align-items:end;margin-bottom')).toBe(false);
  });
});
