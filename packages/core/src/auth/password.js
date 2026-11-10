/** argon2 is native: load it on first use so merely importing core (or just
 * core/database) doesn't require a working argon2 binary (audit D03). */
let argon2Promise;
function loadArgon2() {
  argon2Promise ??= import('argon2').then((m) => m.default ?? m);
  return argon2Promise;
}
import { pbkdf2Sync, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { PASSWORD_ABSOLUTE_MAX } from './password-policy.js';

/**
 * Limits how many password hashes/checks run at once (audit I01). argon2 occupies libuv's
 * thread pool (4 threads by default), which also serves files, DNS and crypto: a flood of
 * logins must queue here - and be refused beyond `maxQueue` - instead of starving the server.
 * The limit is process-wide; `configurePasswordConcurrency` sets it (the auth provider does).
 */
export class PasswordBusyError extends Error {
  constructor() {
    super('too many password checks in progress; try again shortly');
    this.name = 'PasswordBusyError';
    this.code = 'PASSWORD_BUSY';
    this.status = 503;
    this.expose = true;
  }
}

const gate = { maxConcurrent: 2, maxQueue: 64, active: 0, waiting: [] };

export function configurePasswordConcurrency({ maxConcurrent, maxQueue } = {}) {
  if (Number.isInteger(maxConcurrent) && maxConcurrent >= 1) gate.maxConcurrent = maxConcurrent;
  if (Number.isInteger(maxQueue) && maxQueue >= 0) gate.maxQueue = maxQueue;
}

/** For /health and tests. */
export function passwordConcurrencyStats() {
  return { active: gate.active, waiting: gate.waiting.length, maxConcurrent: gate.maxConcurrent, maxQueue: gate.maxQueue };
}

async function limited(fn) {
  if (gate.active >= gate.maxConcurrent) {
    if (gate.waiting.length >= gate.maxQueue) throw new PasswordBusyError();
    await new Promise((resolve) => gate.waiting.push(resolve));
  } else {
    gate.active++;
  }
  try {
    return await fn();
  } finally {
    const next = gate.waiting.shift();
    if (next) next(); // the slot passes straight to the next waiter
    else gate.active--;
  }
}

/**
 * argon2id is the target scheme for all 4 apps (confirmed in
 * architecture doc). `options` map to AuthConfigSchema.argon2
 * (memoryCost/timeCost/parallelism) from core/config.
 */
export async function hashPassword(plain, options = {}) {
  if (typeof plain !== 'string' || plain.length > PASSWORD_ABSOLUTE_MAX) {
    throw new RangeError(`password must be a string of at most ${PASSWORD_ABSOLUTE_MAX} characters`);
  }
  const argon2 = await loadArgon2();
  return limited(() =>
    argon2.hash(plain, {
      type: argon2.argon2id,
      memoryCost: options.memoryCost ?? 19456,
      timeCost: options.timeCost ?? 2,
      parallelism: options.parallelism ?? 1,
    })
  );
}

/**
 * Legacy scheme templates — per Phase 0 of the architecture doc, each
 * app's existing hash format gets documented (algorithm, iterations/
 * cost params, salt layout) and wired up as one of these during
 * porting, rather than core guessing a one-size-fits-all legacy format.
 *
 * `storedFormat` tells the template how to split the stored string into
 * {salt, hash} — the 4 apps don't necessarily agree on a separator or
 * encoding, hence it's a small pluggable parser per app, not a single
 * hardcoded layout.
 */

/**
 * PBKDF2 legacy scheme (documented target: procure-it).
 * @param {object} opts
 * @param {number} opts.iterations
 * @param {number} opts.keylen
 * @param {string} opts.digest - e.g. 'sha256'
 * @param {(stored: string) => {salt: string, hash: string}} opts.parseStored
 * @param {(salt: string) => Buffer} [opts.saltDecode] - defaults to hex
 */
export function pbkdf2Scheme({ iterations, keylen, digest, parseStored, saltDecode }) {
  const decodeSalt = saltDecode ?? ((s) => Buffer.from(s, 'hex'));
  return {
    name: 'pbkdf2-legacy',
    verify(stored, plain) {
      const { salt, hash } = parseStored(stored);
      const derived = pbkdf2Sync(plain, decodeSalt(salt), iterations, keylen, digest);
      const expected = Buffer.from(hash, 'hex');
      return derived.length === expected.length && timingSafeEqual(derived, expected);
    },
  };
}

/**
 * scrypt legacy scheme (documented target: atlas, net-monitor —
 * independently implemented, so each gets its own params instance).
 * @param {object} opts
 * @param {number} opts.N
 * @param {number} opts.r
 * @param {number} opts.p
 * @param {number} opts.keylen
 * @param {(stored: string) => {salt: string, hash: string}} opts.parseStored
 * @param {(salt: string) => Buffer} [opts.saltDecode] - defaults to hex
 */
export function scryptScheme({ N, r, p, keylen, parseStored, saltDecode }) {
  const decodeSalt = saltDecode ?? ((s) => Buffer.from(s, 'hex'));
  return {
    name: 'scrypt-legacy',
    verify(stored, plain) {
      const { salt, hash } = parseStored(stored);
      const derived = scryptSync(plain, decodeSalt(salt), keylen, { N, r, p });
      const expected = Buffer.from(hash, 'hex');
      return derived.length === expected.length && timingSafeEqual(derived, expected);
    },
  };
}

/**
 * scrypt with the salt kept in a SEPARATE column (atlas and net-monitor: `users.salt` + `users.hash`).
 * Exact format of those apps, read from their code: crypto.scrypt(password, salt, 64) with Node's default
 * cost (N=16384, r=8, p=1), the salt is used as the plain STRING stored in the column (not decoded),
 * the hash is 128 hex characters. The salt reaches the scheme through `legacyContext.salt`:
 *   verifyPassword(user.hash, plain, { legacySchemes: [scryptSaltColumnScheme()], legacyContext: { salt: user.salt } })
 * Async (libuv thread pool), so it does not block the event loop like scryptSync.
 */
export function scryptSaltColumnScheme({ keylen = 64, N = 16384, r = 8, p = 1 } = {}) {
  return {
    name: 'scrypt-salt-column',
    // 2*keylen hex characters; anything else (argon2, garbage) is not this scheme
    test: (stored) => typeof stored === 'string' && stored.length === keylen * 2 && /^[0-9a-f]+$/i.test(stored),
    verify(stored, plain, context = {}) {
      const salt = context.salt;
      if (typeof salt !== 'string' || salt === '') return false;
      return new Promise((resolve, reject) => {
        scrypt(plain, salt, keylen, { N, r, p }, (err, derived) => {
          if (err) return reject(err);
          const expected = Buffer.from(stored, 'hex');
          resolve(derived.length === expected.length && timingSafeEqual(derived, expected));
        });
      });
    },
  };
}

/**
 * Verifies a plaintext password against a stored hash of ANY supported
 * scheme (current argon2id, or a legacy scheme during migration).
 *
 * @param {string} stored - the stored hash string
 * @param {string} plain - the candidate plaintext password
 * @param {object} [opts]
 * @param {Array<{name:string, test?:(stored:string)=>boolean, verify:(stored:string,plain:string)=>boolean}>} [opts.legacySchemes]
 *   Each app passes the one (or two, for atlas/net-monitor's independent
 *   scrypt implementations) legacy scheme(s) it actually needs, built
 *   via pbkdf2Scheme()/scryptScheme() above. `test` lets a scheme opt
 *   out of being tried for a hash that's obviously not its format
 *   (e.g. wrong length/prefix) - if omitted, the scheme is always tried.
 * @param {object} [opts.legacyContext] - passed as 3rd argument to every scheme's verify (e.g. `{salt}` from a separate column)
 * @returns {Promise<{valid: boolean, scheme: string|null, needsRehash: boolean}>}
 *   needsRehash is true whenever valid came from a legacy scheme - the
 *   caller should immediately re-hash with hashPassword() and persist
 *   it (lazy migration on next successful login, per architecture doc;
 *   no mass forced reset).
 */
export async function verifyPassword(stored, plain, { legacySchemes = [], legacyContext = {} } = {}) {
  // A multi-megabyte "password" must not reach argon2 (cost) - it can't be a real one.
  if (typeof plain !== 'string' || plain.length > PASSWORD_ABSOLUTE_MAX) return { valid: false, scheme: null, needsRehash: false };
  if (stored.startsWith('$argon2')) {
    const argon2 = await loadArgon2();
    const valid = await limited(() => argon2.verify(stored, plain));
    return { valid, scheme: valid ? 'argon2id' : null, needsRehash: false };
  }

  for (const scheme of legacySchemes) {
    if (scheme.test && !scheme.test(stored)) continue;
    try {
      if (await scheme.verify(stored, plain, legacyContext)) {
        return { valid: true, scheme: scheme.name, needsRehash: true };
      }
    } catch (err) {
      // A parser/verify exception is NOT the same as "wrong password": it
      // usually means the stored hash does not have the layout the scheme
      // was configured for (audit D07). Keep trying other schemes, but make
      // the misconfiguration visible instead of looking like a bad password.
      // eslint-disable-next-line no-console
      console.warn(`[das-forge] legacy password scheme "${scheme.name}" threw while verifying (${err.message}) - check its parseStored/format`);
      continue;
    }
  }

  return { valid: false, scheme: null, needsRehash: false };
}
