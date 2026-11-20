import { atomic } from '../database/atomic.js';
import { asyncDb } from '../database/async.js';
import { createHash, randomBytes } from 'node:crypto';

/**
 * Pending self-registrations. Nothing exists as an account until the e-mailed link is opened: a bot that fills the
 * form gets no account and costs one mail. Only the SHA-256 of the token is stored, the password is stored as a hash,
 * a token works once and expires.
 */
const sha = (t) => createHash('sha256').update(String(t)).digest('hex');

const REGISTRATIONS_DDL = `CREATE TABLE IF NOT EXISTS registrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL,
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    ip TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  )`;
const REGISTRATIONS_INDEX = 'CREATE INDEX IF NOT EXISTS idx_registrations_email ON registrations(email, created_at)';
const CANCEL_SQL = 'UPDATE registrations SET used_at = ? WHERE email = ? AND used_at IS NULL';
const ADD_SQL = 'INSERT INTO registrations (token_hash, username, email, password_hash, ip, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)';
const FIND_SQL = 'SELECT id, username, email, password_hash FROM registrations WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?';
const USE_SQL = 'UPDATE registrations SET used_at = ? WHERE id = ? AND used_at IS NULL';
const COUNT_EMAIL_SQL = 'SELECT COUNT(*) AS n FROM registrations WHERE email = ? AND created_at > ?';
const COUNT_IP_SQL = 'SELECT COUNT(*) AS n FROM registrations WHERE ip = ? AND created_at > ?';
const PURGE_SQL = 'DELETE FROM registrations WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)';
const validToken = (t) => typeof t === 'string' && t.length >= 20 && t.length <= 200;

/** The table over `asyncDb`. Call once at start-up, outside a transaction. */
export async function ensureRegistrationsTableAsync(db) {
  const a = asyncDb(db);
  await a.exec(REGISTRATIONS_DDL);
  await a.exec(REGISTRATIONS_INDEX);
}

export function createRegistrationStore(db, { now = Date.now } = {}) {
  db.exec(REGISTRATIONS_DDL);
  db.exec(REGISTRATIONS_INDEX);
  const a = asyncDb(db);
  const iso = (t = now()) => new Date(t).toISOString();
  return {
    /** @returns {string} the raw token (only goes into the mail). Earlier pending ones of the same address are cancelled. */
    add({ username, email, passwordHash, ip = null, ttlHours = 24 }) {
      const token = randomBytes(32).toString('base64url');
      atomic(db, () => { // cancel the older request and add the new one together: never two live tokens for one address
        db.run(CANCEL_SQL, [iso(), email.toLowerCase()]);
        db.run(ADD_SQL,
          [sha(token), username, email.toLowerCase(), passwordHash, ip, iso(), iso(now() + ttlHours * 3_600_000)]);
      });
      return token;
    },
    /** Uses the token up. @returns {{username: string, email: string, passwordHash: string}|null} */
    consume(token) {
      if (!validToken(token)) return null;
      const row = db.get(FIND_SQL, [sha(token), iso()]);
      if (!row) return null;
      const r = db.run(USE_SQL, [iso(), row.id]);
      return r.changes === 1 ? { username: row.username, email: row.email, passwordHash: row.password_hash } : null;
    },
    /** How many requests this address (or e-mail) made within the window; used for the per-address and per-mail budgets. */
    recent({ ip, email, sinceMs }) {
      const since = iso(now() - sinceMs);
      if (email) return Number(db.get(COUNT_EMAIL_SQL, [email.toLowerCase(), since])?.n ?? 0);
      return Number(db.get(COUNT_IP_SQL, [ip, since])?.n ?? 0);
    },
    /** Deletes what expired more than a day ago or was used. @returns {number} */
    purge() {
      return Number(db.run(PURGE_SQL, [iso(now() - 86_400_000), iso(now() - 86_400_000)]).changes);
    },

    // The same operations over `asyncDb`. Create the table once with `ensureRegistrationsTableAsync`.
    async addAsync({ username, email, passwordHash, ip = null, ttlHours = 24 }) {
      const token = randomBytes(32).toString('base64url');
      await a.transaction(async (tx) => { // cancel the older request and add the new one together
        await tx.run(CANCEL_SQL, [iso(), email.toLowerCase()]);
        await tx.run(ADD_SQL, [sha(token), username, email.toLowerCase(), passwordHash, ip, iso(), iso(now() + ttlHours * 3_600_000)]);
      }, { mode: 'immediate' });
      return token;
    },
    async consumeAsync(token) {
      if (!validToken(token)) return null;
      const row = await a.get(FIND_SQL, [sha(token), iso()]);
      if (!row) return null;
      const r = await a.run(USE_SQL, [iso(), row.id]);
      return r.changes === 1 ? { username: row.username, email: row.email, passwordHash: row.password_hash } : null;
    },
    async recentAsync({ ip, email, sinceMs }) {
      const since = iso(now() - sinceMs);
      return Number((await (email ? a.get(COUNT_EMAIL_SQL, [email.toLowerCase(), since]) : a.get(COUNT_IP_SQL, [ip, since])))?.n ?? 0);
    },
    async purgeAsync() {
      return Number((await a.run(PURGE_SQL, [iso(now() - 86_400_000), iso(now() - 86_400_000)])).changes);
    },
  };
}
