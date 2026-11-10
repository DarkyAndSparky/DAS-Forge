import { atomic } from '../database/atomic.js';
import { randomBytes } from 'node:crypto';

import { ensureAuthTables } from './schema.js';
import { findUserById, createUser, anonymizeUser, deleteUser, setUserRole } from './users.js';
import { destroyUserSessions } from './sessions.js';
import { recordPassword } from './password-history.js';
import { likeEscape } from '../database/query-by-example.js';
import { normalizeLimit } from '../database/identifiers.js';

/**
 * Account administration shared by the CLI (`user ...` commands) and an app's admin
 * panel: every operation validates its input, protects the last active administrator,
 * revokes the sessions that would otherwise outlive the change, and fails with a
 * `UserAdminError` whose `code` the caller maps to a message or an HTTP status.
 *
 * Codes: NOT_FOUND, USERNAME_INVALID, USERNAME_TAKEN, EMAIL_INVALID, EMAIL_TAKEN,
 * ROLE_INVALID, LAST_ADMIN.
 */
export class UserAdminError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'UserAdminError';
    this.code = code;
  }
}

// 3-64 letters/digits and . _ @ - ; no spaces or control characters (keeps audit lines and logs unambiguous).
const USERNAME_RE = /^[\p{L}\p{N}._@-]{3,64}$/u;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const RESERVED_PREFIX = 'deleted-user-';

/** True for an account that was anonymized (its login is the reserved `deleted-user-<id>`): it cannot sign in and cannot be edited. */
export function isAnonymizedUser(user) {
  return String(user?.username ?? '').toLowerCase().startsWith(RESERVED_PREFIX);
}

export function validateUsername(username) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username) || username.toLowerCase().startsWith(RESERVED_PREFIX)) {
    throw new UserAdminError('USERNAME_INVALID', 'username must be 3-64 characters: letters, digits and . _ @ -');
  }
  return username;
}

function normalizeEmail(email) {
  if (email === null || email === undefined || email === '') return null;
  if (typeof email !== 'string' || email.length > 320 || !EMAIL_RE.test(email)) throw new UserAdminError('EMAIL_INVALID', 'not a valid e-mail address');
  return email.trim();
}

/** A random temporary password (no look-alike characters), for "set it and force a change". */
export function generateTempPassword(length = 24) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function mustExist(db, id) {
  const user = findUserById(db, id);
  if (!user) throw new UserAdminError('NOT_FOUND', `no user with id ${id}`);
  return user;
}

function assertUsernameFree(db, username, exceptId = null) {
  const clash = db.get(`SELECT id FROM users WHERE lower(username) = lower(?) AND id != ?`, [username, exceptId ?? -1]);
  if (clash) throw new UserAdminError('USERNAME_TAKEN', `username "${username}" is already in use`);
}

function assertEmailFree(db, email, exceptId = null) {
  if (!email) return;
  const clash = db.get(`SELECT id FROM users WHERE lower(email) = lower(?) AND id != ?`, [email, exceptId ?? -1]);
  if (clash) throw new UserAdminError('EMAIL_TAKEN', 'that e-mail belongs to another account');
}

function assertRole(role, allowedRoles) {
  if (typeof role !== 'string' || role === '' || (allowedRoles && !allowedRoles.includes(role))) {
    throw new UserAdminError('ROLE_INVALID', `role must be one of: ${(allowedRoles ?? []).join(', ') || '(any non-empty string)'}`);
  }
}

/** Enabled accounts holding the administrator role. */
export function countActiveAdmins(db, adminRole = 'admin') {
  ensureAuthTables(db);
  return db.get(`SELECT COUNT(*) AS n FROM users WHERE role = ? AND disabled = 0`, [adminRole]).n;
}

/** Refuses an operation that would leave the system without an enabled administrator. */
function assertNotLastAdmin(db, user, adminRole) {
  if (user.role === adminRole && !user.disabled && countActiveAdmins(db, adminRole) <= 1) {
    throw new UserAdminError('LAST_ADMIN', 'this is the last active administrator');
  }
}

const publicShape = (row) => ({
  id: row.id,
  username: row.username,
  email: row.email,
  role: row.role,
  disabled: Boolean(row.disabled),
  mustChangePassword: Boolean(row.must_change_password),
  createdAt: row.created_at,
  activeAuthenticators: row.active_authenticators,
});

/** One account in the list shape (no secrets), or null. */
export function getManagedUser(db, id) {
  ensureAuthTables(db);
  const row = db.get(
    `SELECT u.id, u.username, u.email, u.role, u.disabled, u.must_change_password, u.created_at,
            (SELECT COUNT(*) FROM authenticators a WHERE a.user_id = u.id AND a.status = 'active') AS active_authenticators
       FROM users u WHERE u.id = ?`,
    [id]
  );
  return row ? publicShape(row) : null;
}

/**
 * Accounts for a list or panel. Never returns the password hash or TOTP secret.
 * `search` matches username or e-mail as plain text (case-insensitive, wildcards escaped).
 * @returns {{items: object[], total: number, limit: number, offset: number}}
 */
export function listUsers(db, { search, role, disabled, limit = 50, offset = 0 } = {}) {
  ensureAuthTables(db);
  const where = [];
  const params = [];
  if (search) {
    const like = `%${likeEscape(String(search).toLowerCase())}%`;
    where.push(`(lower(u.username) LIKE ? ESCAPE '\\' OR lower(COALESCE(u.email, '')) LIKE ? ESCAPE '\\')`);
    params.push(like, like);
  }
  if (role) (where.push('u.role = ?'), params.push(String(role)));
  if (disabled !== undefined && disabled !== null) (where.push('u.disabled = ?'), params.push(disabled ? 1 : 0));
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const lim = normalizeLimit(limit, { fallback: 50, max: 200 });
  const off = Math.max(0, Math.trunc(Number(offset)) || 0);

  const total = db.get(`SELECT COUNT(*) AS n FROM users u${clause}`, params).n;
  const rows = db.all(
    `SELECT u.id, u.username, u.email, u.role, u.disabled, u.must_change_password, u.created_at,
            (SELECT COUNT(*) FROM authenticators a WHERE a.user_id = u.id AND a.status = 'active') AS active_authenticators
       FROM users u${clause} ORDER BY u.username COLLATE NOCASE LIMIT ${lim} OFFSET ${off}`,
    params
  );
  return { items: rows.map(publicShape), total, limit: lim, offset: off };
}

/**
 * Creates an account that must change its password at first login.
 * `passwordHash` comes from the caller (hashing is the app's AuthProvider).
 */
export function createManagedUser(db, { username, email = null, role = 'operator', passwordHash, allowedRoles, mustChangePassword = true }) {
  ensureAuthTables(db);
  validateUsername(username);
  const mail = normalizeEmail(email);
  assertRole(role, allowedRoles);
  assertUsernameFree(db, username);
  assertEmailFree(db, mail);
  if (typeof passwordHash !== 'string' || passwordHash === '') throw new TypeError('createManagedUser: passwordHash is required');
  return createUser(db, { username, email: mail, passwordHash, role, mustChangePassword });
}

/**
 * Changes the login. The session keeps a snapshot of the user, so this user's other
 * sessions are revoked (`exceptSessionId` spares the caller's own, whose snapshot the
 * route refreshes). Audit entries keep the name the user had at the time.
 * @returns {{user: object, revokedSessions: number}}
 */
export function renameUser(db, id, newUsername, { exceptSessionId = null } = {}) {
  ensureAuthTables(db);
  const user = mustExist(db, id);
  validateUsername(newUsername);
  if (user.username === newUsername) return { user, revokedSessions: 0 };
  assertUsernameFree(db, newUsername, id);
  db.run(`UPDATE users SET username = ? WHERE id = ?`, [newUsername, id]);
  const revokedSessions = destroyUserSessions(db, id, { exceptSessionId });
  return { user: findUserById(db, id), revokedSessions };
}

/** Sets or clears (null) the e-mail address; addresses are unique, so one can reset only one account. */
export function setUserEmail(db, id, email) {
  ensureAuthTables(db);
  mustExist(db, id);
  const mail = normalizeEmail(email);
  assertEmailFree(db, mail, id);
  db.run(`UPDATE users SET email = ? WHERE id = ?`, [mail, id]);
  return findUserById(db, id);
}

/** Role change that refuses to demote the last active administrator; revokes that user's sessions. */
export function changeUserRole(db, id, role, { adminRole = 'admin', allowedRoles, exceptSessionId = null } = {}) {
  ensureAuthTables(db);
  return atomic(db, () => {
    const user = mustExist(db, id);
    assertRole(role, allowedRoles);
    if (role !== adminRole) assertNotLastAdmin(db, user, adminRole); // the check and the change in one transaction (G-04)
    const result = setUserRole(db, id, role, { exceptSessionId });
    return { ...result, user: findUserById(db, id) };
  });
}

/** Disable (or enable) login. Disabling revokes every session of the user and cannot hit the last active administrator. */
export function setUserDisabled(db, id, disabled, { adminRole = 'admin', exceptSessionId = null } = {}) {
  ensureAuthTables(db);
  return atomic(db, () => {
    const user = mustExist(db, id);
    if (Boolean(disabled) === user.disabled) return { changed: false, revokedSessions: 0, user };
    if (disabled) assertNotLastAdmin(db, user, adminRole);
    db.run(`UPDATE users SET disabled = ? WHERE id = ?`, [disabled ? 1 : 0, id]);
    const revokedSessions = disabled ? destroyUserSessions(db, id, { exceptSessionId }) : 0;
    return { changed: true, revokedSessions, user: findUserById(db, id) };
  });
}

/**
 * Administrator-set password: the hash is stored, the account must change it at the next
 * login, and every session of the user is revoked (whoever held the old password is out).
 * @returns {{revokedSessions: number}}
 */
export function resetUserPassword(db, id, passwordHash) {
  ensureAuthTables(db);
  mustExist(db, id);
  if (typeof passwordHash !== 'string' || passwordHash === '') throw new TypeError('resetUserPassword: passwordHash is required');
  db.run(`UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?`, [passwordHash, id]);
  recordPassword(db, id, passwordHash);
  return { revokedSessions: destroyUserSessions(db, id) };
}

/**
 * Signs the user out everywhere: every session is revoked. With `requirePasswordChange` the
 * account must also choose a new password at the next login (use it when a password or a
 * device may be compromised).
 * @returns {{revokedSessions: number, mustChangePassword: boolean}}
 */
export function forceUserLogout(db, id, { requirePasswordChange = false } = {}) {
  ensureAuthTables(db);
  mustExist(db, id);
  if (requirePasswordChange) db.run(`UPDATE users SET must_change_password = 1 WHERE id = ?`, [id]);
  return { revokedSessions: destroyUserSessions(db, id), mustChangePassword: Boolean(requirePasswordChange) };
}

/**
 * Makes every active account choose a new password at its next login and signs it out everywhere
 * (use it after a leak or when the password rules get stricter). Accounts that have no password yet are skipped.
 * @param {object} db
 * @param {object} [o]
 * @param {string[]} [o.roles] - only these roles (default: all)
 * @param {number|null} [o.exceptId] - this account is left alone (the administrator who runs it)
 * @returns {{affected: number, revokedSessions: number}}
 */
export function requirePasswordChangeForAll(db, { roles = null, exceptId = null } = {}) {
  ensureAuthTables(db);
  return atomic(db, () => { // all accounts or none: a crash halfway must not leave some of them out
    const rows = db.all(`SELECT id, role FROM users WHERE disabled = 0 AND password_hash IS NOT NULL AND password_hash != ''`);
    let affected = 0;
    let revokedSessions = 0;
    for (const u of rows) {
      if (exceptId != null && u.id === exceptId) continue;
      if (roles && !roles.includes(u.role)) continue;
      db.run(`UPDATE users SET must_change_password = 1 WHERE id = ?`, [u.id]);
      revokedSessions += destroyUserSessions(db, u.id);
      affected++;
    }
    return { affected, revokedSessions };
  });
}

/**
 * Removes an account. `mode: 'anonymize'` (default, §4.5k) blanks the identifying fields and
 * disables login but keeps the row; `'delete'` removes it for good. Neither can hit the last
 * active administrator. Past audit entries keep the old username either way.
 */
export function removeUser(db, id, { mode = 'anonymize', adminRole = 'admin' } = {}) {
  ensureAuthTables(db);
  if (mode !== 'anonymize' && mode !== 'delete') throw new TypeError(`removeUser: unknown mode "${mode}"`);
  return atomic(db, () => {
    const user = mustExist(db, id);
    assertNotLastAdmin(db, user, adminRole);
    if (mode === 'delete') deleteUser(db, id);
    else anonymizeUser(db, id);
    return { mode, username: user.username };
  });
}

/**
 * Removes every second factor of a user (authenticators and recovery codes) and signs the user out everywhere
 * (audit R-06: a lost phone must not need a shell). The password stays; the next sign-in enrols a factor again where the
 * policy demands one. A user who has no factor is refused (`NO_MFA`) so a click cannot silently do nothing.
 * @returns {{removedAuthenticators: number, revokedSessions: number}}
 */
export function resetUserMfa(db, id) {
  ensureAuthTables(db);
  mustExist(db, id);
  const { c } = db.get('SELECT COUNT(*) AS c FROM authenticators WHERE user_id = ?', [id]);
  if (c === 0) throw new UserAdminError('NO_MFA', 'the user has no second factor');
  let removed = 0;
  db.transaction(() => {
    db.run('DELETE FROM totp_credentials WHERE authenticator_id IN (SELECT id FROM authenticators WHERE user_id = ?)', [id]); // secrets first, not left to the cascade
    removed = Number(db.run('DELETE FROM authenticators WHERE user_id = ?', [id]).changes);
    db.run('DELETE FROM recovery_codes WHERE user_id = ?', [id]);
  });
  return { removedAuthenticators: removed, revokedSessions: destroyUserSessions(db, id) };
}
