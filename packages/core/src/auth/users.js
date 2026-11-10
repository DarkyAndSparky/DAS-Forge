import { atomic } from '../database/atomic.js';
import { ensureAuthTables } from './schema.js';
import { destroyUserSessions } from './sessions.js';
import { recordPassword } from './password-history.js';

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role,
    mustChangePassword: Boolean(row.must_change_password),
    totpSecret: row.totp_secret,
    totpEnabled: Boolean(row.totp_enabled),
    disabled: Boolean(row.disabled),
    createdAt: row.created_at,
  };
}

export function countUsers(db) {
  ensureAuthTables(db);
  return db.get(`SELECT COUNT(*) AS count FROM users`).count;
}

export function findUserByUsername(db, username) {
  ensureAuthTables(db);
  return rowToUser(db.get(`SELECT * FROM users WHERE username = ?`, [username]));
}

/**
 * The user with this e-mail (case-insensitive), or null when there is none OR
 * several - an address shared by two accounts must not be able to reset either.
 */
export function findUserByEmail(db, email) {
  ensureAuthTables(db);
  if (typeof email !== 'string' || email === '') return null;
  const rows = db.all(`SELECT * FROM users WHERE lower(email) = lower(?) LIMIT 2`, [email]);
  return rows.length === 1 ? rowToUser(rows[0]) : null;
}

export function findUserById(db, id) {
  ensureAuthTables(db);
  return rowToUser(db.get(`SELECT * FROM users WHERE id = ?`, [id]));
}

export function createUser(
  db,
  { username, email = null, passwordHash, role = 'operator', mustChangePassword = false }
) {
  ensureAuthTables(db);
  const result = db.run(
    `INSERT INTO users (username, email, password_hash, role, must_change_password)
     VALUES (?, ?, ?, ?, ?)`,
    [username, email, passwordHash, role, mustChangePassword ? 1 : 0]
  );
  return findUserById(db, result.lastInsertRowid);
}

/**
 * Updates a user's stored password hash - used both for a normal
 * password change and for lazy legacy-scheme migration (§ architecture
 * Phase 0: a successful legacy-scheme login immediately re-hashes with
 * argon2id and persists it here, with clearMustChange left false since
 * a transparent migration shouldn't force a visible "change password"
 * prompt on the user).
 */
export function updatePasswordHash(db, userId, passwordHash, { clearMustChange } = {}) {
  ensureAuthTables(db);
  if (clearMustChange === undefined) {
    db.run(`UPDATE users SET password_hash = ? WHERE id = ?`, [passwordHash, userId]);
  } else {
    db.run(`UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?`, [
      passwordHash,
      clearMustChange ? 0 : 1,
      userId,
    ]);
    recordPassword(db, userId, passwordHash); // a real change (not the silent re-hash above): restarts the age clock, joins the history
  }
}

/**
 * Changes a user's role and revokes that user's sessions (audit A05): the
 * session keeps a snapshot of the user, so without this a demoted user
 * would keep the old privileges until the session expired.
 * `exceptSessionId` keeps the caller's own session (an admin changing
 * their own role).
 *
 * @returns {{changed: boolean, revokedSessions: number}} changed=false when
 *   the user does not exist or already has that role (nothing revoked)
 */
export function setUserRole(db, userId, role, { exceptSessionId = null } = {}) {
  ensureAuthTables(db);
  if (typeof role !== 'string' || role.trim() === '') throw new TypeError('setUserRole: role must be a non-empty string');
  return atomic(db, () => {
    const user = db.get(`SELECT role FROM users WHERE id = ?`, [userId]);
    if (!user || user.role === role) return { changed: false, revokedSessions: 0 };
    db.run(`UPDATE users SET role = ? WHERE id = ?`, [role, userId]);
    // one transaction: a role never changes while the sessions that carry the old rights survive
    const revokedSessions = destroyUserSessions(db, userId, { exceptSessionId });
    return { changed: true, revokedSessions };
  });
}

export function setTotpSecret(db, userId, secret, { enabled = false } = {}) {
  ensureAuthTables(db);
  db.run(`UPDATE users SET totp_secret = ?, totp_enabled = ? WHERE id = ?`, [
    secret,
    enabled ? 1 : 0,
    userId,
  ]);
}

/**
 * core/privacy's default erase mode (§4.5k: "по умолчанию mode:
 * 'anonymize', не 'delete'"). Replaces every identifying field
 * (username, email, TOTP secret) with a fixed, non-identifying value
 * and disables login - but leaves the row (and its id) in place.
 *
 * This is why `delete` exists as a separate, explicit function: audit
 * log entries reference users by username (a plain string, not a
 * foreign key - see core/audit/schema.js), and audit_log has no
 * update() at all (append-only by design). Anonymizing here does NOT
 * retroactively rewrite past audit entries - "сам факт события
 * остаётся в истории" (§4.5k) means exactly that: audit is an
 * immutable record of what the username WAS at the time, not a live
 * reference that follows the user record forward.
 *
 * @returns the anonymized user, or null if no user with that id exists
 */
export function anonymizeUser(db, id) {
  ensureAuthTables(db);
  if (!findUserById(db, id)) return null;

  const anonymizedUsername = `deleted-user-${id}`;
  // UPDATE does not fire ON DELETE CASCADE, so everything that belongs to the account is removed
  // explicitly: second factors and their secrets, recovery codes, reset tokens, sessions (audit F01, A05).
  db.transaction(() => {
    db.run(
      `UPDATE users
       SET username = ?, email = NULL, password_hash = '', totp_secret = NULL, totp_enabled = 0, disabled = 1
       WHERE id = ?`,
      [anonymizedUsername, id]
    );
    db.run(`DELETE FROM totp_credentials WHERE authenticator_id IN (SELECT id FROM authenticators WHERE user_id = ?)`, [id]);
    db.run(`DELETE FROM authenticators WHERE user_id = ?`, [id]);
    db.run(`DELETE FROM recovery_codes WHERE user_id = ?`, [id]);
    db.run(`DELETE FROM password_resets WHERE user_id = ?`, [id]);
    db.run(`DELETE FROM sessions WHERE user_id = ?`, [id]);
  });
  return findUserById(db, id);
}

/**
 * Hard delete - core/privacy's explicit opt-in erase mode (§4.5k:
 * "Полное 'delete' — доступно явным флагом, когда это действительно
 * требуется юридически"). Unlike anonymizeUser(), this actually removes
 * the row; callers are responsible for deciding this is legally
 * required before calling it - core/privacy's eraseUserData() requires
 * an explicit `mode: 'delete'`, it never defaults to this.
 *
 * @returns true if a user was deleted, false if no user with that id existed
 */
export function deleteUser(db, id) {
  ensureAuthTables(db);
  db.run(`DELETE FROM sessions WHERE user_id = ?`, [id]);
  const result = db.run(`DELETE FROM users WHERE id = ?`, [id]);
  return result.changes > 0;
}
