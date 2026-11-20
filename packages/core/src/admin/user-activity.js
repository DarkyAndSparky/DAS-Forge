import { listAuthenticators } from '../auth/authenticators.js';
import { listAuthenticatorsAsync } from '../auth/async-factors.js';
import { tableExistsAsync } from '../database/helpers-async.js';
import { asyncDb } from '../database/async.js';
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


const LOGIN_SQL = "SELECT entity_id AS uid, MAX(created_at) AS t FROM audit_log WHERE entity = 'user' AND result = 'success' AND action IN ('auth.login', 'auth.login.totp') GROUP BY entity_id";
const SESSIONS_SQL = 'SELECT user_id AS uid, MAX(created_at) AS c, MAX(last_seen_at) AS s FROM sessions WHERE user_id IS NOT NULL GROUP BY user_id';
const DEVICES_SQL = 'SELECT user_id AS uid, MAX(last_seen_at) AS t FROM login_devices GROUP BY user_id';
const USER_IDS_SQL = 'SELECT id FROM users';
const INACTIVE_SQL = 'SELECT id, username, email, role, disabled, created_at FROM users ORDER BY username';
const CARD_USER_SQL = 'SELECT id, username, email, role, disabled, must_change_password, created_at FROM users WHERE id = ?';
const CARD_SESSIONS_SQL = 'SELECT created_at, last_seen_at, expires_at FROM sessions WHERE user_id = ? ORDER BY COALESCE(last_seen_at, created_at) DESC LIMIT 50';
const CARD_DEVICES_SQL = 'SELECT first_seen_at, last_seen_at, first_ip, user_agent FROM login_devices WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 50';
const CARD_RECENT_SQL = "SELECT id, action, result, ip, created_at FROM audit_log WHERE (entity = 'user' AND entity_id = ?) OR actor = ? ORDER BY id DESC LIMIT ?";

const PW_CHANGED_SQL = "SELECT MAX(created_at) AS t FROM audit_log WHERE entity = 'user' AND entity_id = ? AND result = 'success' AND action IN ('auth.password_change', 'auth.password_reset', 'admin.user.reset_password')";

/** The per-user activity map from the rows read from the audit log (`login`), sessions and devices, plus the user ids. */
function activityMap({ login: loginRows, sessions, devices, users }) {
  const login = new Map(loginRows.map((r) => [Number(r.uid), r.t]));
  const sess = new Map(sessions.map((r) => [Number(r.uid), r]));
  const dev = new Map(devices.map((r) => [Number(r.uid), r.t]));
  const out = new Map();
  for (const u of users) {
    const s = sess.get(u.id);
    out.set(u.id, {
      lastLoginAt: iso(maxOf(login.get(u.id), s?.c)),
      lastActivityAt: iso(maxOf(login.get(u.id), s?.c, s?.s, dev.get(u.id))),
    });
  }
  return out;
}

/**
 * When did each user last sign in / show any sign of life (audit R-07). Sources: successful sign-ins in the audit log (may be pruned by
 * retention), sessions (creation and last activity) and known devices. All of it is read, nothing is written.
 * @returns {Map<number, {lastLoginAt: string|null, lastActivityAt: string|null}>}
 */
export function lastActivityByUser(db) {
  return activityMap({
    login: tableExists(db, 'audit_log') ? db.all(LOGIN_SQL) : [],
    sessions: db.all(SESSIONS_SQL),
    devices: tableExists(db, 'login_devices') ? db.all(DEVICES_SQL) : [],
    users: db.all(USER_IDS_SQL),
  });
}

/** `lastActivityByUser` over `asyncDb`. */
export async function lastActivityByUserAsync(db) {
  const a = asyncDb(db);
  return activityMap({
    login: (await tableExistsAsync(a, 'audit_log')) ? await a.all(LOGIN_SQL) : [],
    sessions: await a.all(SESSIONS_SQL),
    devices: (await tableExistsAsync(a, 'login_devices')) ? await a.all(DEVICES_SQL) : [],
    users: await a.all(USER_IDS_SQL),
  });
}

/** The inactive accounts among `users` (rows of INACTIVE_SQL) given the activity map. */
function inactiveFrom(users, act, days, now) {
  const limit = now - Math.max(1, Number(days) || 90) * 86_400_000;
  const out = [];
  for (const u of users) {
    if (u.disabled || isAnonymizedUser(u)) continue;
    const last = ms(act.get(u.id)?.lastActivityAt);
    const reference = last ?? ms(u.created_at);
    if (reference === null || reference >= limit) continue;
    out.push({ id: u.id, username: u.username, email: u.email, role: u.role, createdAt: u.created_at, lastActivityAt: act.get(u.id)?.lastActivityAt ?? null, idleDays: last === null ? null : Math.floor((now - last) / 86_400_000) });
  }
  return out;
}

/**
 * Active accounts with no sign-in or activity for `days` days (or never, and created longer ago than that). Anonymized and already
 * disabled accounts are not listed.
 * @returns {Array<{id: number, username: string, email: string|null, role: string, createdAt: string, lastActivityAt: string|null, idleDays: number|null}>}
 */
export function inactiveUsers(db, { days = 90, now = Date.now() } = {}) {
  return inactiveFrom(db.all(INACTIVE_SQL), lastActivityByUser(db), days, now);
}

/** `inactiveUsers` over `asyncDb`. */
export async function inactiveUsersAsync(db, { days = 90, now = Date.now() } = {}) {
  const a = asyncDb(db);
  return inactiveFrom(await a.all(INACTIVE_SQL), await lastActivityByUserAsync(a), days, now);
}

/** Everything the user card shows. Session ids and session data are NOT included (a session id is a credential). */
export function userCard(db, id, { events = 20 } = {}) {
  const user = db.get(CARD_USER_SQL, [id]);
  if (!user) return null;
  const act = lastActivityByUser(db).get(id) ?? {};
  const sessions = db.all(CARD_SESSIONS_SQL, [id]);
  const devices = tableExists(db, 'login_devices') ? db.all(CARD_DEVICES_SQL, [id]) : [];
  let recent = [];
  let passwordChangedAt = null;
  if (tableExists(db, 'audit_log')) {
    recent = db.all(CARD_RECENT_SQL, [String(id), user.username, events]);
    passwordChangedAt = db.get(PW_CHANGED_SQL, [String(id)])?.t ?? null;
  }
  const factors = listAuthenticators(db, id).filter((a) => a.status === 'active').length;
  return { user, lastLoginAt: act.lastLoginAt ?? null, lastActivityAt: act.lastActivityAt ?? null, passwordChangedAt, activeFactors: factors, sessions, devices, recent };
}

/** `userCard` over `asyncDb`. */
export async function userCardAsync(db, id, { events = 20 } = {}) {
  const a = asyncDb(db);
  const user = await a.get(CARD_USER_SQL, [id]);
  if (!user) return null;
  const act = (await lastActivityByUserAsync(a)).get(id) ?? {};
  const sessions = await a.all(CARD_SESSIONS_SQL, [id]);
  const devices = (await tableExistsAsync(a, 'login_devices')) ? await a.all(CARD_DEVICES_SQL, [id]) : [];
  let recent = [];
  let passwordChangedAt = null;
  if (await tableExistsAsync(a, 'audit_log')) {
    recent = await a.all(CARD_RECENT_SQL, [String(id), user.username, events]);
    passwordChangedAt = (await a.get(PW_CHANGED_SQL, [String(id)]))?.t ?? null;
  }
  const factors = (await listAuthenticatorsAsync(a, id)).filter((x) => x.status === 'active').length;
  return { user, lastLoginAt: act.lastLoginAt ?? null, lastActivityAt: act.lastActivityAt ?? null, passwordChangedAt, activeFactors: factors, sessions, devices, recent };
}
