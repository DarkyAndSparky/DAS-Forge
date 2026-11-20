import { asyncDb } from '../database/async.js';
import { likeEscape } from '../database/query-by-example.js';
import { normalizeLimit } from '../database/identifiers.js';
import { ensureSettingsTableAsync } from '../branding/company-branding.js';
import {
  ensureAuthTablesAsync, findUserByIdAsync, createUserAsync, anonymizeUserAsync, deleteUserAsync, setUserRoleAsync,
  destroyUserSessionsAsync, recordPasswordAsync, purgeExpiredSessionsAsync,
} from './async.js';
import { UserAdminError, validateUsername, normalizeEmail, assertRole, publicShape } from './user-admin.js';
import { hashSessionId } from './sessions.js';
import { loadExpressSession } from './session-store.js';

/**
 * Account administration, MFA roles and the express-session store over `asyncDb` (ADR-0010, step 6). Same rules, same error
 * codes (`UserAdminError`) as user-admin.js, mfa-roles.js and session-store.js. Differences: the list is ordered with
 * `lower(username)` (no SQLite `COLLATE NOCASE`), and `isUserActive` of the session store may return a Promise.
 */

async function mustExist(a, id) {
  const user = await findUserByIdAsync(a, id);
  if (!user) throw new UserAdminError('NOT_FOUND', `no user with id ${id}`);
  return user;
}
async function assertUsernameFree(a, username, exceptId = null) {
  if (await a.get('SELECT id FROM users WHERE lower(username) = lower(?) AND id != ?', [username, exceptId ?? -1])) {
    throw new UserAdminError('USERNAME_TAKEN', `username "${username}" is already in use`);
  }
}
async function assertEmailFree(a, email, exceptId = null) {
  if (!email) return;
  if (await a.get('SELECT id FROM users WHERE lower(email) = lower(?) AND id != ?', [email, exceptId ?? -1])) {
    throw new UserAdminError('EMAIL_TAKEN', 'that e-mail belongs to another account');
  }
}

export async function countActiveAdminsAsync(db, adminRole = 'admin') {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  return (await a.get('SELECT COUNT(*) AS n FROM users WHERE role = ? AND disabled = 0', [adminRole])).n;
}
async function assertNotLastAdmin(a, user, adminRole) {
  if (user.role === adminRole && !user.disabled && (await countActiveAdminsAsync(a, adminRole)) <= 1) {
    throw new UserAdminError('LAST_ADMIN', 'this is the last active administrator');
  }
}

const SHAPE_SQL = `SELECT u.id, u.username, u.email, u.role, u.disabled, u.must_change_password, u.created_at,
            (SELECT COUNT(*) FROM authenticators a WHERE a.user_id = u.id AND a.status = 'active') AS active_authenticators
       FROM users u`;

export async function getManagedUserAsync(db, id) {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  const row = await a.get(`${SHAPE_SQL} WHERE u.id = ?`, [id]);
  return row ? publicShape(row) : null;
}

/** @returns {Promise<{items:object[], total:number, limit:number, offset:number}>} */
export async function listUsersAsync(db, { search, role, disabled, limit = 50, offset = 0 } = {}) {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  const where = [];
  const params = [];
  if (search) {
    const like = `%${likeEscape(String(search).toLowerCase())}%`;
    where.push(`(lower(u.username) LIKE ? ESCAPE '\\' OR lower(COALESCE(u.email, '')) LIKE ? ESCAPE '\\')`);
    params.push(like, like);
  }
  if (role) { where.push('u.role = ?'); params.push(String(role)); }
  if (disabled !== undefined && disabled !== null) { where.push('u.disabled = ?'); params.push(disabled ? 1 : 0); }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const lim = normalizeLimit(limit, { fallback: 50, max: 200 });
  const off = Math.max(0, Math.trunc(Number(offset)) || 0);
  const total = (await a.get(`SELECT COUNT(*) AS n FROM users u${clause}`, params)).n;
  const rows = await a.all(`${SHAPE_SQL}${clause} ORDER BY lower(u.username), u.username LIMIT ${lim} OFFSET ${off}`, params);
  return { items: rows.map(publicShape), total, limit: lim, offset: off };
}

export async function createManagedUserAsync(db, { username, email = null, role = 'operator', passwordHash, allowedRoles, mustChangePassword = true }) {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  validateUsername(username);
  const mail = normalizeEmail(email);
  assertRole(role, allowedRoles);
  await assertUsernameFree(a, username);
  await assertEmailFree(a, mail);
  if (typeof passwordHash !== 'string' || passwordHash === '') throw new TypeError('createManagedUser: passwordHash is required');
  return createUserAsync(a, { username, email: mail, passwordHash, role, mustChangePassword });
}

export async function renameUserAsync(db, id, newUsername, { exceptSessionId = null } = {}) {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  const user = await mustExist(a, id);
  validateUsername(newUsername);
  if (user.username === newUsername) return { user, revokedSessions: 0 };
  await assertUsernameFree(a, newUsername, id);
  return a.transaction(async (tx) => {
    await tx.run('UPDATE users SET username = ? WHERE id = ?', [newUsername, id]);
    const revokedSessions = await destroyUserSessionsAsync(tx, id, { exceptSessionId });
    return { user: await findUserByIdAsync(tx, id), revokedSessions };
  }, { mode: 'immediate' });
}

export async function setUserEmailAsync(db, id, email) {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  await mustExist(a, id);
  const mail = normalizeEmail(email);
  await assertEmailFree(a, mail, id);
  await a.run('UPDATE users SET email = ? WHERE id = ?', [mail, id]);
  return findUserByIdAsync(a, id);
}

export async function changeUserRoleAsync(db, id, role, { adminRole = 'admin', allowedRoles, exceptSessionId = null } = {}) {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  return a.transaction(async (tx) => {
    const user = await mustExist(tx, id);
    assertRole(role, allowedRoles);
    if (role !== adminRole) await assertNotLastAdmin(tx, user, adminRole);
    const result = await setUserRoleAsync(tx, id, role, { exceptSessionId });
    return { ...result, user: await findUserByIdAsync(tx, id) };
  }, { mode: 'immediate' });
}

export async function setUserDisabledAsync(db, id, disabled, { adminRole = 'admin', exceptSessionId = null } = {}) {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  return a.transaction(async (tx) => {
    const user = await mustExist(tx, id);
    if (Boolean(disabled) === user.disabled) return { changed: false, revokedSessions: 0, user };
    if (disabled) await assertNotLastAdmin(tx, user, adminRole);
    await tx.run('UPDATE users SET disabled = ? WHERE id = ?', [disabled ? 1 : 0, id]);
    const revokedSessions = disabled ? await destroyUserSessionsAsync(tx, id, { exceptSessionId }) : 0;
    return { changed: true, revokedSessions, user: await findUserByIdAsync(tx, id) };
  }, { mode: 'immediate' });
}

export async function resetUserPasswordAsync(db, id, passwordHash) {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  await mustExist(a, id);
  if (typeof passwordHash !== 'string' || passwordHash === '') throw new TypeError('resetUserPassword: passwordHash is required');
  return a.transaction(async (tx) => {
    await tx.run('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', [passwordHash, id]);
    await recordPasswordAsync(tx, id, passwordHash);
    return { revokedSessions: await destroyUserSessionsAsync(tx, id) };
  }, { mode: 'immediate' });
}

export async function forceUserLogoutAsync(db, id, { requirePasswordChange = false } = {}) {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  await mustExist(a, id);
  return a.transaction(async (tx) => {
    if (requirePasswordChange) await tx.run('UPDATE users SET must_change_password = 1 WHERE id = ?', [id]);
    return { revokedSessions: await destroyUserSessionsAsync(tx, id), mustChangePassword: Boolean(requirePasswordChange) };
  }, { mode: 'immediate' });
}

export async function requirePasswordChangeForAllAsync(db, { roles = null, exceptId = null } = {}) {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  return a.transaction(async (tx) => {
    const rows = await tx.all(`SELECT id, role FROM users WHERE disabled = 0 AND password_hash IS NOT NULL AND password_hash != ''`);
    let affected = 0;
    let revokedSessions = 0;
    for (const u of rows) {
      if (exceptId != null && u.id === exceptId) continue;
      if (roles && !roles.includes(u.role)) continue;
      await tx.run('UPDATE users SET must_change_password = 1 WHERE id = ?', [u.id]);
      revokedSessions += await destroyUserSessionsAsync(tx, u.id);
      affected++;
    }
    return { affected, revokedSessions };
  }, { mode: 'immediate' });
}

export async function removeUserAsync(db, id, { mode = 'anonymize', adminRole = 'admin' } = {}) {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  if (mode !== 'anonymize' && mode !== 'delete') throw new TypeError(`removeUser: unknown mode "${mode}"`);
  return a.transaction(async (tx) => {
    const user = await mustExist(tx, id);
    await assertNotLastAdmin(tx, user, adminRole);
    if (mode === 'delete') await deleteUserAsync(tx, id);
    else await anonymizeUserAsync(tx, id);
    return { mode, username: user.username };
  }, { mode: 'immediate' });
}

export async function resetUserMfaAsync(db, id) {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  await mustExist(a, id);
  const { c } = await a.get('SELECT COUNT(*) AS c FROM authenticators WHERE user_id = ?', [id]);
  if (c === 0) throw new UserAdminError('NO_MFA', 'the user has no second factor');
  return a.transaction(async (tx) => {
    await tx.run('DELETE FROM totp_credentials WHERE authenticator_id IN (SELECT id FROM authenticators WHERE user_id = ?)', [id]);
    const removed = Number((await tx.run('DELETE FROM authenticators WHERE user_id = ?', [id])).changes);
    await tx.run('DELETE FROM recovery_codes WHERE user_id = ?', [id]);
    return { removedAuthenticators: removed, revokedSessions: await destroyUserSessionsAsync(tx, id) };
  }, { mode: 'immediate' });
}

// ---- MFA roles ---------------------------------------------------------------------------------------------------------------

const MFA_KEY = 'mfa_required_roles';
const MFA_MAX_ROLES = 50;
const ROLE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** `createMfaRoleStore` for asynchronous code: every method returns a Promise. */
export function createMfaRoleStoreAsync({ db }) {
  if (!db) throw new TypeError('createMfaRoleStoreAsync: db is required');
  const a = asyncDb(db);
  async function list() {
    try {
      const row = await a.get('SELECT value FROM app_settings WHERE key = ?', [MFA_KEY]);
      if (!row) return [];
      const v = JSON.parse(row.value);
      if (!Array.isArray(v)) return [];
      return [...new Set(v.filter((r) => typeof r === 'string' && ROLE_RE.test(r)))].sort();
    } catch {
      return []; // no table yet, or a damaged row
    }
  }
  const has = async (role) => typeof role === 'string' && (await list()).includes(role);
  async function setRole(role, required) {
    if (typeof role !== 'string' || !ROLE_RE.test(role)) throw new TypeError('role name is not valid');
    const before = await list();
    const next = required ? [...new Set([...before, role])].sort() : before.filter((r) => r !== role);
    if (next.length > MFA_MAX_ROLES) throw new RangeError('too many roles');
    const changed = next.length !== before.length;
    if (changed) {
      await ensureSettingsTableAsync(a);
      await a.run('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [MFA_KEY, JSON.stringify(next)]);
    }
    return { roles: next, changed };
  }
  return { list, has, setRole };
}

// ---- express-session store ---------------------------------------------------------------------------------------------------

const userIdOf = (session) => {
  const id = session?.userId ?? session?.pendingUserId;
  return Number.isInteger(id) ? id : null;
};

/**
 * `createSessionStore` over `asyncDb`: the same rows, keys and rules; express-session's callbacks are fed from Promises.
 * Create the tables first (`await ensureAuthTablesAsync(db)`) - a constructor cannot wait.
 */
export function createSessionStoreAsync({ db, ttlMs = 8 * 60 * 60 * 1000, idleTimeoutMs = 0, touchIntervalMs = 60_000, expressSession, isUserActive } = {}) {
  if (!db) throw new TypeError('createSessionStoreAsync: db is required');
  const a = asyncDb(db);
  const Base = (expressSession ?? loadExpressSession()).Store;
  const expiryOf = (session) => {
    const fromCookie = session?.cookie?.expires ? new Date(session.cookie.expires).getTime() : NaN;
    return new Date(Number.isFinite(fromCookie) ? fromCookie : Date.now() + ttlMs).toISOString();
  };
  const settle = (promise, cb, ok = (v) => v) => {
    promise.then((v) => cb?.(null, ok(v)), (err) => cb?.(err));
  };

  class AsyncSessionStore extends Base {
    get(sid, cb) {
      settle((async () => {
        const key = hashSessionId(sid);
        const row = await a.get('SELECT * FROM sessions WHERE id = ?', [key]);
        if (!row) return null;
        const now = Date.now();
        const lastSeen = new Date(row.last_seen_at ?? row.created_at).getTime();
        if (new Date(row.expires_at).getTime() <= now || (idleTimeoutMs > 0 && now - lastSeen >= idleTimeoutMs)) {
          await a.run('DELETE FROM sessions WHERE id = ?', [key]);
          return null;
        }
        let data = null;
        try { data = JSON.parse(row.data); } catch { /* handled below */ }
        if (data === null || typeof data !== 'object' || Array.isArray(data)) {
          await a.run('DELETE FROM sessions WHERE id = ?', [key]);
          return null;
        }
        return data;
      })(), cb);
    }

    set(sid, session, cb) {
      settle((async () => {
        const uid = userIdOf(session);
        if (uid !== null && isUserActive && !(await isUserActive(uid))) {
          await a.run('DELETE FROM sessions WHERE id = ?', [hashSessionId(sid)]);
          return;
        }
        const nowIso = new Date().toISOString();
        await a.run(
          `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, data) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, expires_at = excluded.expires_at,
             last_seen_at = excluded.last_seen_at, data = excluded.data`,
          [hashSessionId(sid), uid, nowIso, expiryOf(session), nowIso, JSON.stringify(session)]
        );
      })(), cb, () => null);
    }

    touch(sid, session, cb) {
      settle((async () => {
        const key = hashSessionId(sid);
        const row = await a.get('SELECT last_seen_at, created_at FROM sessions WHERE id = ?', [key]);
        if (!row) return;
        const now = Date.now();
        const lastSeen = new Date(row.last_seen_at ?? row.created_at).getTime();
        const every = Math.min(touchIntervalMs, idleTimeoutMs > 0 ? idleTimeoutMs / 2 : touchIntervalMs);
        if (now - lastSeen >= every) await a.run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?', [new Date(now).toISOString(), expiryOf(session), key]);
      })(), cb, () => null);
    }

    destroy(sid, cb) {
      settle(a.run('DELETE FROM sessions WHERE id = ?', [hashSessionId(sid)]), cb, () => null);
    }

    length(cb) {
      settle(a.get('SELECT COUNT(*) AS n FROM sessions'), cb, (r) => r.n);
    }

    clear(cb) {
      settle(a.run('DELETE FROM sessions'), cb, () => null);
    }

    destroyUserSessions(userId, { exceptSid = null } = {}) {
      return destroyUserSessionsAsync(a, userId, { exceptSessionId: exceptSid });
    }

    purgeExpired() {
      return purgeExpiredSessionsAsync(a, { idleTimeoutMs });
    }
  }
  return new AsyncSessionStore();
}
