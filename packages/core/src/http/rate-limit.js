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
  store = null,
  flushMs = 1000,
  maxBatch = 500,
} = {}) {
  const state = new Map(); // key -> { failures, lockedUntil, lastFailureAt }
  // Persistence (A2): `store` (see security/failure-store.js) keeps the counters across restarts and processes. The map stays the
  // working copy, so `check`/`recordFailure` remain synchronous and a request never waits for the database. Changes are written
  // together at most once per `flushMs` (and at most `maxBatch` rows per write), so a flood of failures is one batch a second, not a query per attempt.
  const dirty = new Set();
  const removed = new Set();
  const removedPrefixes = [];
  let timer = null;
  let flushing = null;
  const touch = (key) => { removed.delete(key); dirty.add(key); schedule(); };
  function schedule() {
    if (!store || timer) return;
    timer = setTimeout(() => { timer = null; flush().catch(() => { /* retried at the next change; a failing database must not break sign-in */ }); }, flushMs);
    timer.unref?.();
  }

  function current(key, t) {
    const s = state.get(key);
    if (!s) return null;
    if (s.lockedUntil <= t && t - s.lastFailureAt > resetAfterMs) {
      state.delete(key);
      return null;
    }
    return s;
  }

  function merge(rows) {
    const t = now();
    let n = 0;
    for (const r of rows) {
      if (removed.has(r.key)) continue;
      const live = r.lockedUntil > t || t - r.lastFailureAt <= resetAfterMs;
      if (!live) continue;
      const s = state.get(r.key);
      if (!s) {
        if (state.size >= maxKeys && r.lockedUntil <= t) continue;
        state.set(r.key, { failures: r.failures, lockedUntil: r.lockedUntil, lastFailureAt: r.lastFailureAt });
        n += 1;
      } else {
        s.failures = Math.max(s.failures, r.failures);
        s.lockedUntil = Math.max(s.lockedUntil, r.lockedUntil);
        s.lastFailureAt = Math.max(s.lastFailureAt, r.lastFailureAt);
      }
    }
    return n;
  }

  async function flush() {
    if (flushing) return flushing; // one write at a time
    flushing = (async () => {
      try {
        const prefixes = removedPrefixes.splice(0);
        for (const p of prefixes) await store.removePrefix(p);
        const gone = [...removed].slice(0, maxBatch);
        if (gone.length) { gone.forEach((k) => removed.delete(k)); await store.remove(gone); }
        const keys = [...dirty].slice(0, maxBatch);
        keys.forEach((k) => dirty.delete(k));
        const rows = keys.map((k) => ({ key: k, s: state.get(k) })).filter((x) => x.s).map(({ key, s }) => ({ key, failures: s.failures, lockedUntil: s.lockedUntil, lastFailureAt: s.lastFailureAt }));
        try { await store.save(rows); } catch (err) { keys.forEach((k) => dirty.add(k)); throw err; }
        if (dirty.size > 0 || removed.size > 0) schedule();
      } finally { flushing = null; }
    })();
    return flushing;
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
      touch(key);
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
      if (store) { dirty.delete(key); removed.add(key); schedule(); }
    },

    /** Forgets every key that starts with `prefix` (e.g. all `name|ip` pairs of one username). @returns {number} how many */
    resetPrefix(prefix) {
      let n = 0;
      for (const k of [...state.keys()]) {
        if (String(k).startsWith(prefix)) { state.delete(k); dirty.delete(k); n++; }
      }
      if (store) { removedPrefixes.push(prefix); schedule(); }
      return n;
    },

    /** Reads the stored counters into memory (call once at start). With a `store`, a restart no longer clears the lock-outs. */
    async hydrate() {
      if (!store) return 0;
      return merge(await store.load());
    },

    /** Takes over counters other processes wrote: the larger value of each column wins, so a lock set elsewhere applies here too. */
    async refresh() {
      if (!store) return 0;
      return merge(await store.load());
    },

    /** Writes pending changes now (also done by the timer). Safe to call at shutdown. */
    async flush() {
      if (!store) return;
      return flush();
    },

    /** Stops the timer after a last write. */
    async close() {
      if (timer) { clearTimeout(timer); timer = null; }
      await this.flush();
    },

    /** Removes stored counters that are quiet and not locked (a scheduler job calls this). */
    async purgeStore() {
      if (!store) return;
      const t = now();
      await store.purge({ now: t, quietBefore: t - resetAfterMs });
    },

    /** Active lock-outs only, soonest-to-expire first: what an administrator sees (audit R-08). With a `store` they survive a restart. */
    list() {
      const t = now();
      const out = [];
      for (const [key, s] of state) if (s.lockedUntil > t) out.push({ key, failures: s.failures, retryAfterMs: s.lockedUntil - t, lastFailureAt: s.lastFailureAt });
      return out.sort((a, b) => a.retryAfterMs - b.retryAfterMs);
    },

    size: () => state.size,
  };
}
