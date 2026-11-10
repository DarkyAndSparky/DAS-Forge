import { randomBytes } from 'node:crypto';

import { hashSessionId } from '../../src/auth/sessions.js';
import { ensureAuthTables } from '../../src/auth/schema.js';

/**
 * Test-only stand-ins for "a user has a session row": since 0.1.73 production
 * sessions are created by express-session through core's SQLite store, so these
 * write and read the SAME rows (hashed id, same columns) without needing
 * express-session. They are fixtures, not an API.
 */
export function createSession(db, { userId, ttlMs = 60_000, data = {} }) {
  ensureAuthTables(db);
  const id = randomBytes(32).toString('base64url');
  const now = new Date();
  db.run(`INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, data) VALUES (?, ?, ?, ?, ?, ?)`, [
    hashSessionId(id),
    userId,
    now.toISOString(),
    new Date(now.getTime() + ttlMs).toISOString(),
    now.toISOString(),
    JSON.stringify(data),
  ]);
  return { id, userId, data };
}

/** The live (unexpired) row for a raw session id, or null. */
export function verifySession(db, sessionId) {
  const row = db.get(`SELECT * FROM sessions WHERE id = ?`, [hashSessionId(sessionId)]);
  if (!row || new Date(row.expires_at).getTime() <= Date.now()) return null;
  return { id: sessionId, userId: row.user_id, data: JSON.parse(row.data) };
}
