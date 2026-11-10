import { hkdfSync } from 'node:crypto';

import { loadExpressSession } from '../auth/session-store.js';

/**
 * The cookie-signing key is DERIVED from auth.sessionSecret instead of used as is:
 * the same secret also encrypts TOTP secrets, and one key must not serve two purposes.
 */
export function deriveCookieSecret(secret) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new TypeError('session secret must be a string of at least 16 characters');
  }
  return Buffer.from(hkdfSync('sha256', secret, 'das-forge', 'session-cookie', 32)).toString('hex');
}

/**
 * express-session configured the way the platform needs it (zero-trust, §4.5j):
 * signed HttpOnly SameSite=Lax cookie, nothing saved for visitors who store nothing
 * (`saveUninitialized: false`), no resave, and a fresh id on every login via
 * `establishSession`. Mount it AFTER cookie-parser/CSRF and BEFORE `attachUser`.
 *
 * @param {object} opts
 * @param {object} opts.store - from `auth.createSessionStore`
 * @param {string|string[]} opts.secret - `auth.sessionSecret`; extra entries (previous secrets) only verify
 * @param {number} opts.ttlMs - absolute session lifetime (cookie Max-Age)
 * @param {string} [opts.cookieName='das_session']
 * @param {boolean|'auto'} [opts.secure='auto'] - 'auto' follows req.secure (set `trust proxy` behind a proxy)
 * @param {object} [opts.expressSession] - the module (tests inject a stand-in)
 */
/** Name of the session cookie: `das_session`, or `__Host-das_session` with `hostPrefix` (HTTPS only, see `createSessionMiddleware`). */
export function sessionCookieName({ hostPrefix = false } = {}) {
  return hostPrefix ? '__Host-das_session' : 'das_session';
}

export function createSessionMiddleware({ store, secret, ttlMs, cookieName = 'das_session', secure = 'auto', expressSession } = {}) {
  if (!store) throw new TypeError('createSessionMiddleware: store is required');
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('createSessionMiddleware: ttlMs must be a positive number');
  const secrets = [].concat(secret ?? []).map(deriveCookieSecret);
  if (secrets.length === 0) throw new TypeError('createSessionMiddleware: secret is required');
  // A `__Host-` cookie is accepted by browsers only with Secure, Path=/ and no Domain: it cannot be set or
  // overwritten by a sibling sub-domain or over plain HTTP. So the application must be served over HTTPS.
  if (cookieName.startsWith('__Host-')) secure = true;
  const factory = expressSession ?? loadExpressSession();
  const sessions = factory({
    store,
    secret: secrets,
    name: cookieName,
    resave: false,
    saveUninitialized: false,
    rolling: false,
    unset: 'destroy',
    cookie: { httpOnly: true, secure, sameSite: 'lax', maxAge: ttlMs, path: '/' },
  });
  // endSession() clears the cookie under the name this middleware used
  return (req, res, next) => {
    res.locals ??= {};
    res.locals.sessionCookie = { name: cookieName, secure: cookieName.startsWith('__Host-') };
    return sessions(req, res, next);
  };
}

/** `req.user` comes ONLY from the server-side session (`req.session.user`) - never from the request. */
export function attachUser({ revalidate, cacheMs = 30_000, now = Date.now } = {}) {
  const cache = new Map();
  return async (req, res, next) => {
    const user = req.session?.user ?? null;
    if (!user || typeof revalidate !== 'function') {
      req.user = user;
      return next();
    }
    // audit K05: the session snapshot is re-checked against the source of truth (cached briefly),
    // so a missed revocation call cannot keep a disabled user or an old role alive.
    try {
      // keyed by session (a fresh session after a password change must not inherit an old snapshot)
      const key = `${req.sessionID ?? ''}:${user.id ?? req.session.userId}`;
      const src = JSON.stringify(user);
      let hit = cache.get(key);
      if (!hit || hit.src !== src || now() - hit.at >= cacheMs) {
        hit = { at: now(), src, user: (await revalidate(user.id ?? req.session.userId, user)) || null };
        cache.set(key, hit);
        if (cache.size > 1000) cache.delete(cache.keys().next().value);
      }
      req.user = hit.user;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

const call = (fn) => new Promise((resolve, reject) => fn((err) => (err ? reject(err) : resolve())));

/**
 * Logs someone in (or starts the MFA step): a brand new session id (session-fixation
 * protection), then `userId`/`user`/`data` are stored and saved before this resolves.
 * `maxAgeMs` shortens the cookie for short-lived sessions such as a pending MFA step.
 */
export async function establishSession(req, { userId, user, data = {}, maxAgeMs } = {}) {
  if (!req.session) throw new Error('establishSession: no session - is the session middleware mounted?');
  await call((cb) => req.session.regenerate(cb));
  Object.assign(req.session, data);
  if (userId !== undefined) req.session.userId = userId;
  if (user !== undefined) req.session.user = user;
  if (maxAgeMs !== undefined) req.session.cookie.maxAge = maxAgeMs;
  await call((cb) => req.session.save(cb));
  return req.sessionID;
}

/** Ends the current session: removed from the store, cookie cleared. Safe without a session. */
export async function endSession(req, res, { cookieName } = {}) {
  if (req.session) await call((cb) => req.session.destroy(cb));
  const used = res.locals?.sessionCookie;
  const name = cookieName ?? used?.name ?? 'das_session';
  res.clearCookie(name, { path: '/', ...(name.startsWith('__Host-') || used?.secure ? { secure: true } : {}) });
}
