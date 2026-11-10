import { createRequire } from 'node:module';

import { ensureAuthTables } from './schema.js';
import { hashSessionId, purgeExpiredSessions, destroyUserSessions } from './sessions.js';

/**
 * express-session is an OPTIONAL peer dependency: it is loaded when a store or
 * the middleware is actually built, never at import time (audit D03).
 */
export function loadExpressSession() {
  try {
    return createRequire(import.meta.url)('express-session');
  } catch (err) {
    throw new Error(`express-session is not installed (npm install express-session): ${err?.message ?? err}`);
  }
}

const defer = (fn) => setImmediate(fn);

/** The user a stored session belongs to - a logged-in user or one half-way through MFA. */
function userIdOf(session) {
  const id = session?.userId ?? session?.pendingUserId;
  return Number.isInteger(id) ? id : null;
}

/**
 * A SQLite-backed express-session store on the existing `sessions` table.
 *
 *  - rows are keyed by `hashSessionId(sid)` (audit A11): the database never holds a cookie value;
 *  - `user_id` is filled from `session.userId` / `session.pendingUserId`, which is what lets
 *    `destroyUserSessions` revoke every session of a user (password change, role change, disable);
 *  - absolute expiry comes from `session.cookie.expires` (else `ttlMs`); with `idleTimeoutMs > 0`
 *    a session unused for that long is dead; `last_seen_at` is refreshed by `touch`,
 *    at most once per `touchIntervalMs`.
 *
 * @param {object} opts
 * @param {object} opts.db - DatabaseAdapter
 * @param {number} [opts.ttlMs=28800000] - used only for sessions that carry no cookie expiry
 * @param {number} [opts.idleTimeoutMs=0]
 * @param {number} [opts.touchIntervalMs=60000]
 * @param {object} [opts.expressSession] - the express-session module (tests inject a stand-in)
 * @param {(userId:number)=>boolean} [opts.isUserActive] - audit K04: when given, `set` refuses to write a session of a
 *   user that no longer exists or is disabled, so a request still in flight cannot resurrect a revoked session
 */
export function createSessionStore({ db, ttlMs = 8 * 60 * 60 * 1000, idleTimeoutMs = 0, touchIntervalMs = 60_000, expressSession, isUserActive } = {}) {
  if (!db) throw new TypeError('createSessionStore: db is required');
  const Base = (expressSession ?? loadExpressSession()).Store;
  ensureAuthTables(db);

  const expiryOf = (session) => {
    const fromCookie = session?.cookie?.expires ? new Date(session.cookie.expires).getTime() : NaN;
    return new Date(Number.isFinite(fromCookie) ? fromCookie : Date.now() + ttlMs).toISOString();
  };

  class SqliteSessionStore extends Base {
    get(sid, cb) {
      defer(() => {
        try {
          const key = hashSessionId(sid);
          const row = db.get(`SELECT * FROM sessions WHERE id = ?`, [key]);
          if (!row) return cb(null, null);
          const now = Date.now();
          const lastSeen = new Date(row.last_seen_at ?? row.created_at).getTime();
          if (new Date(row.expires_at).getTime() <= now || (idleTimeoutMs > 0 && now - lastSeen >= idleTimeoutMs)) {
            db.run(`DELETE FROM sessions WHERE id = ?`, [key]);
            return cb(null, null);
          }
          return cb(null, JSON.parse(row.data));
        } catch (err) {
          return cb(err);
        }
      });
    }

    set(sid, session, cb) {
      defer(() => {
        try {
          const uid = userIdOf(session);
          if (uid !== null && isUserActive && !isUserActive(uid)) {
            db.run(`DELETE FROM sessions WHERE id = ?`, [hashSessionId(sid)]);
            return cb?.(null);
          }
          const nowIso = new Date().toISOString();
          db.run(
            `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, data) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, expires_at = excluded.expires_at,
               last_seen_at = excluded.last_seen_at, data = excluded.data`,
            [hashSessionId(sid), userIdOf(session), nowIso, expiryOf(session), nowIso, JSON.stringify(session)]
          );
          cb?.(null);
        } catch (err) {
          cb?.(err);
        }
      });
    }

    touch(sid, session, cb) {
      defer(() => {
        try {
          const key = hashSessionId(sid);
          const row = db.get(`SELECT last_seen_at, created_at FROM sessions WHERE id = ?`, [key]);
          if (!row) return cb?.(null);
          const now = Date.now();
          const lastSeen = new Date(row.last_seen_at ?? row.created_at).getTime();
          const every = Math.min(touchIntervalMs, idleTimeoutMs > 0 ? idleTimeoutMs / 2 : touchIntervalMs);
          if (now - lastSeen >= every) {
            db.run(`UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?`, [new Date(now).toISOString(), expiryOf(session), key]);
          }
          return cb?.(null);
        } catch (err) {
          return cb?.(err);
        }
      });
    }

    destroy(sid, cb) {
      defer(() => {
        try {
          db.run(`DELETE FROM sessions WHERE id = ?`, [hashSessionId(sid)]);
          cb?.(null);
        } catch (err) {
          cb?.(err);
        }
      });
    }

    length(cb) {
      defer(() => {
        try {
          cb(null, db.get(`SELECT COUNT(*) AS n FROM sessions`).n);
        } catch (err) {
          cb(err);
        }
      });
    }

    clear(cb) {
      defer(() => {
        try {
          db.run(`DELETE FROM sessions`);
          cb?.(null);
        } catch (err) {
          cb?.(err);
        }
      });
    }

    /** Revokes every session of a user, optionally keeping the caller's own (`exceptSid`). */
    destroyUserSessions(userId, { exceptSid = null } = {}) {
      return destroyUserSessions(db, userId, { exceptSessionId: exceptSid });
    }

    /** Housekeeping for the scheduler: expired and idle sessions. */
    purgeExpired() {
      return purgeExpiredSessions(db, { idleTimeoutMs });
    }
  }

  return new SqliteSessionStore();
}
