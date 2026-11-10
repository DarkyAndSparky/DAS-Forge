import { createHash, randomBytes } from 'node:crypto';

import { ensureAuthTables } from './schema.js';

/**
 * One-time password-reset tokens.
 *
 * Only the SHA-256 of a token is stored: a leaked database (or backup) does
 * not hand out working reset links. A token is single-use, expires, and
 * issuing a new one cancels the user's earlier ones. The raw token exists
 * only in the e-mailed link.
 */
const hash = (token) => createHash('sha256').update(String(token)).digest('hex');

/**
 * @param {object} db
 * @param {number} userId
 * @param {{ttlMinutes?: number, now?: number}} [opts]
 * @returns {{token: string, expiresAt: string}}
 */
export function createPasswordResetToken(db, userId, { ttlMinutes = 30, now = Date.now() } = {}) {
  ensureAuthTables(db);
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now + ttlMinutes * 60_000).toISOString();
  db.run(`UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL`, [new Date(now).toISOString(), userId]);
  db.run(`INSERT INTO password_resets (user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)`, [
    userId,
    hash(token),
    new Date(now).toISOString(),
    expiresAt,
  ]);
  return { token, expiresAt };
}

/** Whose token this is, WITHOUT using it up (to validate a new password first). @returns {{userId: number}|null} */
export function peekPasswordResetToken(db, token, { now = Date.now() } = {}) {
  ensureAuthTables(db);
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  const row = db.get(`SELECT user_id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`, [hash(token), new Date(now).toISOString()]);
  return row ? { userId: row.user_id } : null;
}

/**
 * Burns the token and returns whose it was; null for unknown, used or
 * expired. The UPDATE is the check, so two concurrent requests with the
 * same token cannot both succeed.
 *
 * @returns {{userId: number}|null}
 */
export function consumePasswordResetToken(db, token, { now = Date.now() } = {}) {
  ensureAuthTables(db);
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  const nowIso = new Date(now).toISOString();
  const h = hash(token);
  const row = db.get(`SELECT id, user_id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`, [h, nowIso]);
  if (!row) return null;
  const result = db.run(`UPDATE password_resets SET used_at = ? WHERE id = ? AND used_at IS NULL`, [nowIso, row.id]);
  return result.changes === 1 ? { userId: row.user_id } : null;
}

/** Deletes tokens that expired more than `olderThanMs` ago (housekeeping). @returns {number} */
export function purgePasswordResetTokens(db, { olderThanMs = 24 * 3_600_000, now = Date.now() } = {}) {
  ensureAuthTables(db);
  return db.run(`DELETE FROM password_resets WHERE expires_at < ?`, [new Date(now - olderThanMs).toISOString()]).changes;
}
