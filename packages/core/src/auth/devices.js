import { createHash, randomBytes } from 'node:crypto';

/**
 * Remembers which browsers a user has signed in from, so a sign-in from a browser never seen before can be reported
 * to the account owner (the quickest sign that a password was stolen).
 *
 * A browser is recognised by a long random value in the `das_device` cookie, not by its address or user-agent
 * (both change too often and would cause a notice at every network change). Only the SHA-256 of that value is stored.
 * The first browser ever seen for an account is registered silently: a new account must not start with a warning.
 */
export const DEVICE_COOKIE = 'das_device';
export const DEVICE_COOKIE_MAX_AGE_MS = 400 * 24 * 3600 * 1000; // the longest a browser keeps a cookie

export function ensureDeviceTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS login_devices (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_hash TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      first_ip TEXT,
      user_agent TEXT,
      PRIMARY KEY (user_id, device_hash)
    );
  `);
}

const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
export const newDeviceId = () => randomBytes(24).toString('base64url');

/**
 * @param {object} db
 * @param {{userId: number, deviceId?: string|null, ip?: string, userAgent?: string, now?: () => number}} o
 * @returns {{deviceId: string, isNew: boolean, firstEver: boolean}} `deviceId` is what the cookie must hold afterwards
 */
export function recognizeDevice(db, { userId, deviceId = null, ip = null, userAgent = null, now = Date.now } = {}) {
  ensureDeviceTable(db);
  const t = new Date(now()).toISOString();
  const valid = typeof deviceId === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(deviceId);
  if (valid) {
    const known = db.run('UPDATE login_devices SET last_seen_at = ? WHERE user_id = ? AND device_hash = ?', [t, userId, hash(deviceId)]);
    if (Number(known.changes) > 0) return { deviceId, isNew: false, firstEver: false };
  }
  const id = valid ? deviceId : newDeviceId();
  const existing = Number(db.get('SELECT COUNT(*) AS n FROM login_devices WHERE user_id = ?', [userId]).n);
  db.run('INSERT OR IGNORE INTO login_devices (user_id, device_hash, first_seen_at, last_seen_at, first_ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, hash(id), t, t, ip ? String(ip).slice(0, 64) : null, userAgent ? String(userAgent).slice(0, 300) : null]);
  return { deviceId: id, isNew: true, firstEver: existing === 0 };
}

/** "Chrome on Windows" from a user-agent string: enough for a human to recognise their own device. */
export function describeAgent(ua = '') {
  const s = String(ua);
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\/|Opera/.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : null;
  const os = /Windows/.test(s) ? 'Windows' : /Android/.test(s) ? 'Android' : /iPhone|iPad|iOS/.test(s) ? 'iOS' : /Mac OS X|Macintosh/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : null;
  return browser && os ? `${browser} / ${os}` : browser ?? os ?? '?';
}
