import { asyncDb } from '../database/async.js';
import { columnsAsync, hasColumnAsync } from '../database/helpers-async.js';
import { sessionsPurged } from './schema.js';
import { rowToUser } from './users.js';
import { hashSessionId } from './sessions.js';
import { PASSWORD_HISTORY_MAX, DAY_MS } from './password-history.js';

/**
 * The asynchronous face of users, sessions and password history (ADR-0010, step 4). Same tables, same behaviour as the synchronous
 * functions of users.js, sessions.js, password-history.js and schema.js; code that already works over `asyncDb` calls these.
 * The statements are SQLite's (AUTOINCREMENT, datetime('now')); the driver hands them to the dialect layer. When every caller
 * has moved, the synchronous originals are removed and these lose the `Async` suffix.
 */
const ensured = new WeakSet();

/** Creates the auth tables once per database. Call it at start-up, outside a transaction that may be rolled back. */
export async function ensureAuthTablesAsync(db) {
  const a = asyncDb(db);
  if (ensured.has(a)) return;
  const hasColumn = (table, column) => hasColumnAsync(a, table, column);

  await a.exec(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, email TEXT, password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'operator', must_change_password INTEGER NOT NULL DEFAULT 0, totp_secret TEXT,
      totp_enabled INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));`);
  await a.exec(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL, last_seen_at TEXT, data TEXT NOT NULL DEFAULT '{}');`);
  await a.exec(`CREATE TABLE IF NOT EXISTS password_resets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);`);
  if (!(await hasColumn('users', 'password_changed_at'))) await a.exec('ALTER TABLE users ADD COLUMN password_changed_at TEXT');
  await a.exec(`CREATE TABLE IF NOT EXISTS password_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_password_history_user ON password_history(user_id, id);`);
  if (!(await hasColumn('sessions', 'last_seen_at'))) await a.exec('ALTER TABLE sessions ADD COLUMN last_seen_at TEXT');
  if ((await columnsAsync(a, 'sessions')).some((c) => c.name === 'user_id' && c.notnull === 1)) {
    await a.exec(`CREATE TABLE sessions_rebuild (
        id TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL, last_seen_at TEXT, data TEXT NOT NULL DEFAULT '{}');
      INSERT INTO sessions_rebuild (id, user_id, created_at, expires_at, last_seen_at, data)
        SELECT id, user_id, created_at, expires_at, last_seen_at, data FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_rebuild RENAME TO sessions;`);
  }
  if (!sessionsPurged.has(db)) {
    sessionsPurged.add(db);
    await a.run(`DELETE FROM sessions WHERE id NOT LIKE 'h1:%'`);
  }
  await a.exec(`CREATE TABLE IF NOT EXISTS authenticators (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('totp')), status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active')),
      name TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used_at TEXT, expires_at TEXT);`);
  await a.exec('CREATE INDEX IF NOT EXISTS idx_authenticators_user ON authenticators(user_id);');
  await a.exec(`CREATE TABLE IF NOT EXISTS totp_credentials (
      authenticator_id INTEGER PRIMARY KEY REFERENCES authenticators(id) ON DELETE CASCADE,
      secret TEXT NOT NULL, period INTEGER NOT NULL DEFAULT 30, last_used_step INTEGER);`);
  if (!(await hasColumn('totp_credentials', 'last_used_step'))) await a.exec('ALTER TABLE totp_credentials ADD COLUMN last_used_step INTEGER');
  await a.exec(`CREATE TABLE IF NOT EXISTS recovery_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), used_at TEXT);`);
  await a.exec('CREATE INDEX IF NOT EXISTS idx_recovery_codes_user ON recovery_codes(user_id);');

  // one-time move of the flat TOTP columns into the multi-authenticator tables (idempotent)
  if (await hasColumn('users', 'totp_secret')) {
    for (const u of await a.all('SELECT id, totp_secret, totp_enabled FROM users WHERE totp_secret IS NOT NULL')) {
      if (await a.get(`SELECT id FROM authenticators WHERE user_id = ? AND type = 'totp' LIMIT 1`, [u.id])) continue;
      const r = await a.run(`INSERT INTO authenticators (user_id, type, status, name) VALUES (?, 'totp', ?, 'Migrated authenticator')`, [u.id, u.totp_enabled ? 'active' : 'pending']);
      await a.run('INSERT INTO totp_credentials (authenticator_id, secret) VALUES (?, ?)', [r.lastInsertRowid, u.totp_secret]);
    }
  }
  ensured.add(a);
}

// ---- users -------------------------------------------------------------------------------------------------------------------

export async function countUsersAsync(db) {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  return (await a.get('SELECT COUNT(*) AS count FROM users')).count;
}

export async function findUserByUsernameAsync(db, username) {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  return rowToUser(await a.get('SELECT * FROM users WHERE username = ?', [username]));
}

/** The user with this e-mail (case-insensitive), or null when there is none OR several. */
export async function findUserByEmailAsync(db, email) {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  if (typeof email !== 'string' || email === '') return null;
  const rows = await a.all('SELECT * FROM users WHERE lower(email) = lower(?) LIMIT 2', [email]);
  return rows.length === 1 ? rowToUser(rows[0]) : null;
}

export async function findUserByIdAsync(db, id) {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  return rowToUser(await a.get('SELECT * FROM users WHERE id = ?', [id]));
}

export async function createUserAsync(db, { username, email = null, passwordHash, role = 'operator', mustChangePassword = false }) {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  const r = await a.run('INSERT INTO users (username, email, password_hash, role, must_change_password) VALUES (?, ?, ?, ?, ?)', [
    username, email, passwordHash, role, mustChangePassword ? 1 : 0,
  ]);
  return findUserByIdAsync(a, r.lastInsertRowid);
}

export async function updatePasswordHashAsync(db, userId, passwordHash, { clearMustChange } = {}) {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  if (clearMustChange === undefined) {
    await a.run('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, userId]);
  } else {
    await a.run('UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?', [passwordHash, clearMustChange ? 0 : 1, userId]);
    await recordPasswordAsync(a, userId, passwordHash);
  }
}

/** Changes the role and revokes the user's sessions in one transaction. @returns {Promise<{changed:boolean, revokedSessions:number}>} */
export async function setUserRoleAsync(db, userId, role, { exceptSessionId = null } = {}) {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  if (typeof role !== 'string' || role.trim() === '') throw new TypeError('setUserRole: role must be a non-empty string');
  return a.transaction(async (tx) => {
    const user = await tx.get('SELECT role FROM users WHERE id = ?', [userId]);
    if (!user || user.role === role) return { changed: false, revokedSessions: 0 };
    await tx.run('UPDATE users SET role = ? WHERE id = ?', [role, userId]);
    return { changed: true, revokedSessions: await destroyUserSessionsAsync(tx, userId, { exceptSessionId }) };
  }, { mode: 'immediate' });
}

export async function setTotpSecretAsync(db, userId, secret, { enabled = false } = {}) {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  await a.run('UPDATE users SET totp_secret = ?, totp_enabled = ? WHERE id = ?', [secret, enabled ? 1 : 0, userId]);
}

/** Replaces every identifying field and removes what belongs to the account; the row and its id stay. @returns the user or null */
export async function anonymizeUserAsync(db, id) {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  if (!(await findUserByIdAsync(a, id))) return null;
  await a.transaction(async (tx) => {
    await tx.run(`UPDATE users SET username = ?, email = NULL, password_hash = '', totp_secret = NULL, totp_enabled = 0, disabled = 1 WHERE id = ?`, [`deleted-user-${id}`, id]);
    await tx.run('DELETE FROM totp_credentials WHERE authenticator_id IN (SELECT id FROM authenticators WHERE user_id = ?)', [id]);
    await tx.run('DELETE FROM authenticators WHERE user_id = ?', [id]);
    await tx.run('DELETE FROM recovery_codes WHERE user_id = ?', [id]);
    await tx.run('DELETE FROM password_resets WHERE user_id = ?', [id]);
    await tx.run('DELETE FROM sessions WHERE user_id = ?', [id]);
  });
  return findUserByIdAsync(a, id);
}

/** Hard delete (explicit opt-in of core/privacy). @returns {Promise<boolean>} */
export async function deleteUserAsync(db, id) {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  return a.transaction(async (tx) => {
    await tx.run('DELETE FROM sessions WHERE user_id = ?', [id]);
    return Number((await tx.run('DELETE FROM users WHERE id = ?', [id])).changes) > 0;
  });
}

// ---- sessions ----------------------------------------------------------------------------------------------------------------

/** Revokes every session of a user (password change, disable, role change). @returns {Promise<number>} */
export async function destroyUserSessionsAsync(db, userId, { exceptSessionId = null } = {}) {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  const r = exceptSessionId
    ? await a.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', [userId, hashSessionId(exceptSessionId)])
    : await a.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
  return Number(r.changes);
}

/** Deletes sessions past their absolute expiry and, with `idleTimeoutMs > 0`, the idle ones. @returns {Promise<number>} */
export async function purgeExpiredSessionsAsync(db, { idleTimeoutMs = 0 } = {}) {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  const now = Date.now();
  let removed = Number((await a.run('DELETE FROM sessions WHERE expires_at <= ?', [new Date(now).toISOString()])).changes);
  if (idleTimeoutMs > 0) {
    removed += Number((await a.run('DELETE FROM sessions WHERE COALESCE(last_seen_at, created_at) <= ?', [new Date(now - idleTimeoutMs).toISOString()])).changes);
  }
  return removed;
}

// ---- password history --------------------------------------------------------------------------------------------------------

export async function recordPasswordAsync(db, userId, passwordHash, now = Date.now()) {
  const a = asyncDb(db);
  const at = new Date(now).toISOString();
  await a.run('UPDATE users SET password_changed_at = ? WHERE id = ?', [at, userId]);
  await a.run('INSERT INTO password_history (user_id, password_hash, created_at) VALUES (?, ?, ?)', [userId, passwordHash, at]);
  await a.run('DELETE FROM password_history WHERE user_id = ? AND id NOT IN (SELECT id FROM password_history WHERE user_id = ? ORDER BY id DESC LIMIT ?)', [userId, userId, PASSWORD_HISTORY_MAX]);
}

export async function recentPasswordHashesAsync(db, userId, count) {
  if (!(count > 0)) return [];
  return (await asyncDb(db).all('SELECT password_hash AS h FROM password_history WHERE user_id = ? ORDER BY id DESC LIMIT ?', [userId, Math.min(count, PASSWORD_HISTORY_MAX)])).map((r) => r.h);
}

export async function passwordExpiredAsync(db, userId, days, now = Date.now()) {
  if (!(days > 0)) return false;
  const a = asyncDb(db);
  const row = await a.get('SELECT password_changed_at AS at FROM users WHERE id = ?', [userId]);
  if (!row) return false;
  if (!row.at) {
    await a.run('UPDATE users SET password_changed_at = ? WHERE id = ?', [new Date(now).toISOString(), userId]);
    return false;
  }
  const t = Date.parse(row.at);
  return Number.isFinite(t) && now - t > days * DAY_MS;
}
