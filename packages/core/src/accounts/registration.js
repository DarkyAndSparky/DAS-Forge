import { atomic } from '../database/atomic.js';
import { createHash, randomBytes } from 'node:crypto';

/**
 * Pending self-registrations. Nothing exists as an account until the e-mailed link is opened: a bot that fills the
 * form gets no account and costs one mail. Only the SHA-256 of the token is stored, the password is stored as a hash,
 * a token works once and expires.
 */
const sha = (t) => createHash('sha256').update(String(t)).digest('hex');

export function createRegistrationStore(db, { now = Date.now } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS registrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL,
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    ip TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_registrations_email ON registrations(email, created_at)');
  const iso = (t = now()) => new Date(t).toISOString();
  return {
    /** @returns {string} the raw token (only goes into the mail). Earlier pending ones of the same address are cancelled. */
    add({ username, email, passwordHash, ip = null, ttlHours = 24 }) {
      const token = randomBytes(32).toString('base64url');
      atomic(db, () => { // cancel the older request and add the new one together: never two live tokens for one address
        db.run('UPDATE registrations SET used_at = ? WHERE email = ? AND used_at IS NULL', [iso(), email.toLowerCase()]);
        db.run('INSERT INTO registrations (token_hash, username, email, password_hash, ip, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [sha(token), username, email.toLowerCase(), passwordHash, ip, iso(), iso(now() + ttlHours * 3_600_000)]);
      });
      return token;
    },
    /** Uses the token up. @returns {{username: string, email: string, passwordHash: string}|null} */
    consume(token) {
      if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
      const row = db.get('SELECT id, username, email, password_hash FROM registrations WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?', [sha(token), iso()]);
      if (!row) return null;
      const r = db.run('UPDATE registrations SET used_at = ? WHERE id = ? AND used_at IS NULL', [iso(), row.id]);
      return r.changes === 1 ? { username: row.username, email: row.email, passwordHash: row.password_hash } : null;
    },
    /** How many requests this address (or e-mail) made within the window; used for the per-address and per-mail budgets. */
    recent({ ip, email, sinceMs }) {
      const since = iso(now() - sinceMs);
      if (email) return Number(db.get('SELECT COUNT(*) AS n FROM registrations WHERE email = ? AND created_at > ?', [email.toLowerCase(), since])?.n ?? 0);
      return Number(db.get('SELECT COUNT(*) AS n FROM registrations WHERE ip = ? AND created_at > ?', [ip, since])?.n ?? 0);
    },
    /** Deletes what expired more than a day ago or was used. @returns {number} */
    purge() {
      return Number(db.run('DELETE FROM registrations WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)', [iso(now() - 86_400_000), iso(now() - 86_400_000)]).changes);
    },
  };
}
