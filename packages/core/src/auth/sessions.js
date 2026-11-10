/**
 * Session rows in SQLite. Since 0.1.73 sessions are created, read and destroyed by
 * express-session through `createSessionStore` (session-store.js); what is left here
 * is what the store and the account-administration code share: the id hash, revoking
 * every session of a user, and housekeeping.
 */
import { createHash } from 'node:crypto';

import { ensureAuthTables } from './schema.js';

/**
 * What the database stores for a session id (audit A11): a SHA-256 of it, so a
 * leaked database or backup holds nothing that can be put in a cookie. The id has
 * 256 bits of entropy, so a plain hash is enough (no secret or salt needed).
 * The browser keeps the raw id; the `h1:` prefix marks the storage format.
 */
export function hashSessionId(sessionId) {
  return `h1:${createHash('sha256').update(String(sessionId)).digest('hex')}`;
}

/**
 * Revokes every session of a user (audit A05): call it on password
 * change, account disable/anonymize/delete and role change - a stolen
 * or stale session must not outlive the credential/privilege it was
 * issued under. `exceptSessionId` keeps the caller's own session alive
 * (e.g. the one performing a password change, which the route then
 * re-issues fresh).
 *
 * @returns {number} how many sessions were deleted
 */
export function destroyUserSessions(db, userId, { exceptSessionId = null } = {}) {
  ensureAuthTables(db);
  const result = exceptSessionId
    ? db.run(`DELETE FROM sessions WHERE user_id = ? AND id != ?`, [userId, hashSessionId(exceptSessionId)])
    : db.run(`DELETE FROM sessions WHERE user_id = ?`, [userId]);
  return result.changes;
}

/**
 * Housekeeping: deletes sessions past their absolute expiry and, with
 * `idleTimeoutMs > 0`, those idle for longer than that. Run it from the scheduler.
 * @returns {number} rows deleted
 */
export function purgeExpiredSessions(db, { idleTimeoutMs = 0 } = {}) {
  ensureAuthTables(db);
  const now = Date.now();
  let removed = Number(db.run(`DELETE FROM sessions WHERE expires_at <= ?`, [new Date(now).toISOString()]).changes);
  if (idleTimeoutMs > 0) {
    removed += Number(
      db.run(`DELETE FROM sessions WHERE COALESCE(last_seen_at, created_at) <= ?`, [new Date(now - idleTimeoutMs).toISOString()]).changes
    );
  }
  return removed;
}
