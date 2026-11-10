import { hashPassword, verifyPassword, configurePasswordConcurrency } from './password.js';
import { assertAuthProvider } from './adapter.js';

/**
 * Builds the concrete AuthProvider used by app code - a thin object
 * binding the auth module's functions to one DatabaseAdapter + config,
 * satisfying the AuthProvider behavioral contract (assertAuthProvider).
 *
 * @param {object} opts
 * @param {import('../database/adapter.js')} opts.db - a DatabaseAdapter
 * @param {number} [opts.sessionTtlMs] - ignored since 0.1.73 (sessions are express-session's job; see createSessionStore); accepted so existing callers keep working
 * @param {number} [opts.sessionIdleTimeoutMs] - ignored since 0.1.73, same reason
 * @param {object} [opts.argon2Options]
 * @param {Array} [opts.legacySchemes] - see password.js verifyPassword
 */
export function createAuthProvider({ db, sessionTtlMs, sessionIdleTimeoutMs, argon2Options, legacySchemes = [] }) {
  configurePasswordConcurrency(argon2Options ?? {});
  const provider = {
    hashPassword: (plain) => hashPassword(plain, argon2Options),
    verifyPassword: (stored, plain) => verifyPassword(stored, plain, { legacySchemes }),
  };

  assertAuthProvider(provider);
  return provider;
}
