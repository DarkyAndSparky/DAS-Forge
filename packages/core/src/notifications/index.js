/**
 * Notifications for people: one general place any module or application can write to (`notify`), and the bell and the
 * notifications page read from. Alerts, a sign-in from a new device, a finished export, a password that is about to
 * expire: each producer calls `notify` and nothing else knows about them.
 *
 * A notification belongs to ONE user and can be read or marked only by that user. It holds a title, an optional short
 * text, an optional link INSIDE the application (a path starting with a single "/", nothing external) and a severity.
 */

export const SEVERITIES = ['info', 'warning', 'critical'];
/** What a user can choose per category: nothing at all, or everything from a minimum severity up. */
export const LEVELS = ['off', 'info', 'warning', 'critical'];
const RANK = { info: 1, warning: 2, critical: 3 };

const clip = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim().slice(0, n);
/** A link inside the application only: "/path", never "//host", "http:", "javascript:" or a backslash form. */
const safeLink = (v) => (typeof v === 'string' && /^\/(?![/\\])[^\s\u0000-\u001f\u007f]{0,500}$/.test(v) ? v : null);

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    link TEXT,
    category TEXT NOT NULL DEFAULT 'general',
    created_at TEXT NOT NULL,
    read_at TEXT
  )`);
  try { db.exec("ALTER TABLE notifications ADD COLUMN category TEXT NOT NULL DEFAULT 'general'"); } catch { /* already there */ }
  db.exec(`CREATE TABLE IF NOT EXISTS notification_prefs (
    user_id INTEGER NOT NULL,
    category TEXT NOT NULL,
    level TEXT NOT NULL,
    PRIMARY KEY (user_id, category)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at, id)');
}

/**
 * @param {object} opts
 * @param {object} opts.db - DatabaseAdapter
 * @param {number} [opts.keepDays=90] - `purge()` deletes READ notifications older than this
 * @param {number} [opts.maxPerUser=200] - the oldest READ ones beyond this are dropped; unread are never dropped
 * @param {() => number} [opts.now]
 */
export function createNotifications({ db, keepDays = 90, maxPerUser = 200, now = Date.now } = {}) {
  ensureTable(db);
  const iso = () => new Date(now()).toISOString();

  const api = {
    /** @returns {number|null} the new id, or null when the title is empty */
    notify({ userId, title, body = '', link = null, severity = 'info', category = 'general' } = {}) {
      const uid = Number(userId);
      const t = clip(title, 200);
      if (!Number.isInteger(uid) || uid < 1 || !t) return null;
      const sev = SEVERITIES.includes(severity) ? severity : 'info';
      const cat = clip(category, 40) || 'general';
      // the user's own choice for this category (falls back to "everything")
      const lvl = api.prefs(uid)[cat] ?? 'info';
      if (lvl === 'off' || RANK[sev] < RANK[lvl]) return null;
      const r = db.run('INSERT INTO notifications (user_id, severity, title, body, link, category, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [uid, sev, t, clip(body, 1000), safeLink(link), cat, iso()]);
      // keep the table bounded: read ones beyond the per-user cap go, unread stay
      db.run('DELETE FROM notifications WHERE user_id = ? AND read_at IS NOT NULL AND id NOT IN (SELECT id FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?)',
        [uid, uid, maxPerUser]);
      return Number(r.lastInsertRowid);
    },
    /** The same notification for every user in the list; returns how many were written. */
    notifyMany(userIds, what) {
      let n = 0;
      for (const id of new Set(userIds ?? [])) if (api.notify({ ...what, userId: id }) !== null) n += 1;
      return n;
    },
    /** For every enabled user with this role (e.g. the administrators). */
    notifyRole(role, what) {
      const ids = db.all('SELECT id FROM users WHERE role = ? AND disabled = 0', [String(role)]).map((r) => r.id);
      return api.notifyMany(ids, what);
    },
    /** The user's choices as `{category: level}`; a missing category means "everything". */
    prefs(userId) {
      const out = {};
      for (const r of db.all('SELECT category, level FROM notification_prefs WHERE user_id = ?', [Number(userId)])) out[r.category] = r.level;
      return out;
    },
    /** @returns {boolean} false for an unknown level or category */
    setPref(userId, category, level) {
      const cat = clip(category, 40);
      if (!cat || !LEVELS.includes(level) || !Number.isInteger(Number(userId))) return false;
      db.run('INSERT INTO notification_prefs (user_id, category, level) VALUES (?, ?, ?) ON CONFLICT(user_id, category) DO UPDATE SET level = excluded.level', [Number(userId), cat, level]);
      return true;
    },
    list(userId, { unreadOnly = false, limit = 50 } = {}) {
      const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
      return db.all(`SELECT id, severity, title, body, link, created_at AS createdAt, read_at AS readAt FROM notifications WHERE user_id = ? ${unreadOnly ? 'AND read_at IS NULL' : ''} ORDER BY id DESC LIMIT ?`,
        [Number(userId), lim]);
    },
    unreadCount(userId) {
      return Number(db.get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', [Number(userId)])?.n ?? 0);
    },
    /** Only the owner can mark: another user's id changes nothing. */
    markRead(userId, id) {
      return Number(db.run('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL', [iso(), Number(id), Number(userId)]).changes);
    },
    markAllRead(userId) {
      return Number(db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', [iso(), Number(userId)]).changes);
    },
    /** Deletes read notifications older than `keepDays`; returns how many. */
    purge() {
      const cutoff = new Date(now() - keepDays * 86_400_000).toISOString();
      return Number(db.run('DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < ?', [cutoff]).changes);
    },
  };
  return api;
}
