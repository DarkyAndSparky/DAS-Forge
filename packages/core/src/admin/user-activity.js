import { listAuthenticators } from '../auth/authenticators.js';
import { isAnonymizedUser } from '../auth/user-admin.js';

/** Audit rows store UTC as `YYYY-MM-DD HH:MM:SS` (SQLite), sessions and devices as ISO: both become a millisecond count. */
function ms(v) {
  if (!v) return null;
  const s = String(v);
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isFinite(t) ? t : null;
}
const maxOf = (...xs) => xs.map(ms).filter((x) => x !== null).reduce((a, b) => Math.max(a, b), -Infinity);
const iso = (t) => (Number.isFinite(t) ? new Date(t).toISOString() : null);

function tableExists(db, name) {
  return Boolean(db.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", [name]));
}

/**
 * When did each user last sign in / show any sign of life (audit R-07). Sources: successful sign-ins in the audit log (may be pruned by
 * retention), sessions (creation and last activity) and known devices. All of it is read, nothing is written.
 * @returns {Map<number, {lastLoginAt: string|null, lastActivityAt: string|null}>}
 */
export function lastActivityByUser(db) {
  const login = new Map();
  if (tableExists(db, 'audit_log')) {
    for (const r of db.all("SELECT entity_id AS uid, MAX(created_at) AS t FROM audit_log WHERE entity = 'user' AND result = 'success' AND action IN ('auth.login', 'auth.login.totp') GROUP BY entity_id")) login.set(Number(r.uid), r.t);
  }
  const sess = new Map();
  for (const r of db.all('SELECT user_id AS uid, MAX(created_at) AS c, MAX(last_seen_at) AS s FROM sessions WHERE user_id IS NOT NULL GROUP BY user_id')) sess.set(Number(r.uid), r);
  const dev = new Map();
  if (tableExists(db, 'login_devices')) for (const r of db.all('SELECT user_id AS uid, MAX(last_seen_at) AS t FROM login_devices GROUP BY user_id')) dev.set(Number(r.uid), r.t);
  const out = new Map();
  for (const u of db.all('SELECT id FROM users')) {
    const s = sess.get(u.id);
    out.set(u.id, {
      lastLoginAt: iso(maxOf(login.get(u.id), s?.c)),
      lastActivityAt: iso(maxOf(login.get(u.id), s?.c, s?.s, dev.get(u.id))),
    });
  }
  return out;
}

/**
 * Active accounts with no sign-in or activity for `days` days (or never, and created longer ago than that). Anonymized and already
 * disabled accounts are not listed.
 * @returns {Array<{id: number, username: string, email: string|null, role: string, createdAt: string, lastActivityAt: string|null, idleDays: number|null}>}
 */
export function inactiveUsers(db, { days = 90, now = Date.now() } = {}) {
  const limit = now - Math.max(1, Number(days) || 90) * 86_400_000;
  const act = lastActivityByUser(db);
  const out = [];
  for (const u of db.all('SELECT id, username, email, role, disabled, created_at FROM users ORDER BY username')) {
    if (u.disabled || isAnonymizedUser(u)) continue;
    const last = ms(act.get(u.id)?.lastActivityAt);
    const reference = last ?? ms(u.created_at);
    if (reference === null || reference >= limit) continue;
    out.push({ id: u.id, username: u.username, email: u.email, role: u.role, createdAt: u.created_at, lastActivityAt: act.get(u.id)?.lastActivityAt ?? null, idleDays: last === null ? null : Math.floor((now - last) / 86_400_000) });
  }
  return out;
}

/** Everything the user card shows. Session ids and session data are NOT included (a session id is a credential). */
export function userCard(db, id, { events = 20 } = {}) {
  const user = db.get('SELECT id, username, email, role, disabled, must_change_password, created_at FROM users WHERE id = ?', [id]);
  if (!user) return null;
  const act = lastActivityByUser(db).get(id) ?? {};
  const sessions = db.all('SELECT created_at, last_seen_at, expires_at FROM sessions WHERE user_id = ? ORDER BY COALESCE(last_seen_at, created_at) DESC LIMIT 50', [id]);
  const devices = tableExists(db, 'login_devices') ? db.all('SELECT first_seen_at, last_seen_at, first_ip, user_agent FROM login_devices WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 50', [id]) : [];
  let recent = [];
  let passwordChangedAt = null;
  if (tableExists(db, 'audit_log')) {
    recent = db.all("SELECT id, action, result, ip, created_at FROM audit_log WHERE (entity = 'user' AND entity_id = ?) OR actor = ? ORDER BY id DESC LIMIT ?", [String(id), user.username, events]);
    passwordChangedAt = db.get("SELECT MAX(created_at) AS t FROM audit_log WHERE entity = 'user' AND entity_id = ? AND result = 'success' AND action IN ('auth.password_change', 'auth.password_reset', 'admin.user.reset_password')", [String(id)])?.t ?? null;
  }
  const factors = listAuthenticators(db, id).filter((a) => a.status === 'active').length;
  return { user, lastLoginAt: act.lastLoginAt ?? null, lastActivityAt: act.lastActivityAt ?? null, passwordChangedAt, activeFactors: factors, sessions, devices, recent };
}
