import { sendError } from './respond.js';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';

/**
 * Rate limiting and failure lockout - audit findings A02 (brute force
 * on /login, TOTP and recovery codes) and the `security.rateLimit`
 * config block (config/schema.js).
 *
 * createRateLimiter() is `express-rate-limit` configured for this
 * module's conventions (JSON 429 body, Retry-After, IPv6-safe default
 * key); createFailureTracker() is the credential-failure lockout that no
 * request-rate library provides, and stays this module's own code.
 *
 * Both keep their state in process memory. That is a deliberate,
 * documented limitation: a deployment running several server processes
 * behind one load balancer gets a limit PER PROCESS, not global.
 * express-rate-limit's `store` option is the seam for a shared store.
 */

const DEFAULT_MAX_KEYS = 10_000;

/**
 * Fixed-window request counter as Express middleware (express-rate-limit).
 * Over the limit it answers 429 `{error: 'RATE_LIMITED', fields: [], retryAfterSec}`
 * with a Retry-After header and never calls next(). IETF `RateLimit` /
 * `RateLimit-Policy` headers (draft-7) are sent on every response.
 *
 * Express applies the middleware asynchronously (it returns a promise);
 * `trust proxy` must be configured correctly by the app (core/http
 * applyServerSettings) or every client behind a proxy shares one budget.
 *
 * @param {object} opts
 * @param {number} opts.windowMs
 * @param {number} opts.max - requests allowed per key per window
 * @param {(req: any) => string} [opts.keyFn] - defaults to the client IP (IPv6 addresses grouped by /56)
 * @returns {Function & {reset: (key: string) => void}} `reset(key)` forgets one key (e.g. after a successful login)
 */
export function createRateLimiter({ windowMs, max, keyFn } = {}) {
  if (!Number.isInteger(windowMs) || windowMs <= 0) throw new TypeError('rateLimiter: windowMs must be a positive integer');
  if (!Number.isInteger(max) || max <= 0) throw new TypeError('rateLimiter: max must be a positive integer');

  const limiter = rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Always supplied: tolerates a request without `ip` (non-Express servers, test harnesses)
    // by pooling it under one key instead of failing.
    keyGenerator: (req) => {
      if (keyFn) return keyFn(req);
      const ip = req.ip ?? req.socket?.remoteAddress;
      if (!ip) return 'unknown';
      try {
        return ipKeyGenerator(ip);
      } catch {
        return String(ip); // not a parseable address: still a stable key
      }
    },
    // Our default key already goes through ipKeyGenerator; a caller's keyFn is its own business.
    validate: { keyGeneratorIpFallback: false },
    handler: (req, res) => {
      const resetTime = req.rateLimit?.resetTime;
      const waitMs = resetTime instanceof Date ? resetTime.getTime() - Date.now() : windowMs;
      const retryAfterSec = Math.max(1, Math.ceil(waitMs / 1000));
      res.setHeader?.('Retry-After', String(retryAfterSec));
      sendError(req, res, 429, { error: 'RATE_LIMITED', fields: [], retryAfterSec });
    },
  });

  const middleware = (req, res, next) => limiter(req, res, next);
  middleware.reset = (key) => limiter.resetKey(key);
  return middleware;
}

/**
 * Failure counter with exponential lockout, for credential checks
 * (password, TOTP, recovery code). Unlike createRateLimiter it is
 * driven explicitly by the route: check() before verifying, then
 * recordFailure() or reset() after.
 *
 * Lock schedule: the first `maxFailures - 1` misses are free, the
 * `maxFailures`-th locks for `baseLockMs`, and every further miss
 * doubles the lock, capped at `maxLockMs`. Failures older than
 * `resetAfterMs` without a new miss are forgotten.
 *
 * Keys should be chosen so that an unknown username locks exactly like
 * a real one (key on the ATTEMPTED name) - otherwise the lockout itself
 * becomes a user-enumeration oracle.
 *
 * @param {object} [opts]
 * @param {number} [opts.maxFailures=5]
 * @param {number} [opts.baseLockMs=30000]
 * @param {number} [opts.maxLockMs=900000]
 * @param {number} [opts.resetAfterMs=900000]
 * @param {() => number} [opts.now]
 * @param {number} [opts.maxKeys]
 */
/** Failure-tracker key for a client address: IPv6 grouped by /56 like the request limiter (audit I02/K07). */
export function clientKey(ip) {
  if (!ip) return 'unknown';
  try {
    return ipKeyGenerator(String(ip));
  } catch {
    return String(ip);
  }
}

export function createFailureTracker({
  maxFailures = 5,
  baseLockMs = 30_000,
  maxLockMs = 15 * 60_000,
  resetAfterMs = 15 * 60_000,
  now = Date.now,
  maxKeys = DEFAULT_MAX_KEYS,
  onLock,
} = {}) {
  const state = new Map(); // key -> { failures, lockedUntil, lastFailureAt }

  function current(key, t) {
    const s = state.get(key);
    if (!s) return null;
    if (s.lockedUntil <= t && t - s.lastFailureAt > resetAfterMs) {
      state.delete(key);
      return null;
    }
    return s;
  }

  return {
    /** @returns {{locked: false} | {locked: true, retryAfterMs: number}} */
    check(key) {
      const t = now();
      const s = current(key, t);
      if (s && s.lockedUntil > t) return { locked: true, retryAfterMs: s.lockedUntil - t };
      return { locked: false };
    },

    /** Records one failed attempt. @returns {{locked: boolean, failures: number, retryAfterMs?: number}} */
    recordFailure(key) {
      const t = now();
      let s = current(key, t);
      if (!s) {
        if (state.size >= maxKeys) {
          for (const [k, v] of state) {
            if (v.lockedUntil <= t && t - v.lastFailureAt > resetAfterMs) state.delete(k);
          }
          // Still full: evict the oldest key that is NOT locked (audit I02: flooding the table with
          // junk keys must not free a locked-out attacker). Only when every key is locked, drop
          // the lock that expires soonest, so memory stays bounded.
          while (state.size >= maxKeys) {
            let victim;
            let soonest;
            for (const [k, v] of state) {
              if (v.lockedUntil <= t) { victim = k; break; }
              if (soonest === undefined || v.lockedUntil < soonest.until) soonest = { key: k, until: v.lockedUntil };
            }
            state.delete(victim ?? soonest.key);
          }
        }
        s = { failures: 0, lockedUntil: 0, lastFailureAt: t };
        state.set(key, s);
      }
      s.failures += 1;
      s.lastFailureAt = t;
      if (s.failures >= maxFailures) {
        const lockMs = Math.min(maxLockMs, baseLockMs * 2 ** (s.failures - maxFailures));
        s.lockedUntil = t + lockMs;
        // Called once per lock-out start (the first failure over the limit), e.g. `alerts.lockoutWatcher()`.
        if (s.failures === maxFailures) { try { onLock?.(key, { failures: s.failures, retryAfterMs: lockMs }); } catch { /* never breaks sign-in */ } }
        return { locked: true, failures: s.failures, retryAfterMs: lockMs };
      }
      return { locked: false, failures: s.failures };
    },

    /** Forgets a key - call after a successful credential check. */
    reset(key) {
      state.delete(key);
    },

    /** Forgets every key that starts with `prefix` (e.g. all `name|ip` pairs of one username). @returns {number} how many */
    resetPrefix(prefix) {
      let n = 0;
      for (const k of [...state.keys()]) {
        if (String(k).startsWith(prefix)) { state.delete(k); n++; }
      }
      return n;
    },

    /** Active lock-outs only, soonest-to-expire first: what an administrator sees (audit R-08). Memory only: a restart empties it. */
    list() {
      const t = now();
      const out = [];
      for (const [key, s] of state) if (s.lockedUntil > t) out.push({ key, failures: s.failures, retryAfterMs: s.lockedUntil - t, lastFailureAt: s.lastFailureAt });
      return out.sort((a, b) => a.retryAfterMs - b.retryAfterMs);
    },

    size: () => state.size,
  };
}
