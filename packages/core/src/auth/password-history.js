/**
 * Password age and the list of previous password hashes (only hashes, never plain text).
 * The age clock of an account without a stamp starts the first time it is looked at.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
export const PASSWORD_HISTORY_MAX = 24;

/** Notes that the account just chose `passwordHash`: stamps the time and keeps the last PASSWORD_HISTORY_MAX hashes. */
export function recordPassword(db, userId, passwordHash, now = Date.now()) {
  const at = new Date(now).toISOString();
  db.run(`UPDATE users SET password_changed_at = ? WHERE id = ?`, [at, userId]);
  db.run(`INSERT INTO password_history (user_id, password_hash, created_at) VALUES (?, ?, ?)`, [userId, passwordHash, at]);
  db.run(`DELETE FROM password_history WHERE user_id = ? AND id NOT IN (SELECT id FROM password_history WHERE user_id = ? ORDER BY id DESC LIMIT ?)`, [userId, userId, PASSWORD_HISTORY_MAX]);
}

/** The `count` most recent previous hashes of the account, newest first. */
export function recentPasswordHashes(db, userId, count) {
  if (!(count > 0)) return [];
  return db.all(`SELECT password_hash AS h FROM password_history WHERE user_id = ? ORDER BY id DESC LIMIT ?`, [userId, Math.min(count, PASSWORD_HISTORY_MAX)]).map((r) => r.h);
}

/** True when the password is older than `days` (0 or less = never). An unstamped account is stamped now and is not expired. */
export function passwordExpired(db, userId, days, now = Date.now()) {
  if (!(days > 0)) return false;
  const row = db.get(`SELECT password_changed_at AS at FROM users WHERE id = ?`, [userId]);
  if (!row) return false;
  if (!row.at) {
    db.run(`UPDATE users SET password_changed_at = ? WHERE id = ?`, [new Date(now).toISOString(), userId]);
    return false;
  }
  const t = Date.parse(row.at);
  return Number.isFinite(t) && now - t > days * DAY_MS;
}
