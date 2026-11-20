import { ensureSettingsTable } from '../branding/company-branding.js';
import { checkPasswordPolicy } from './password-policy.js';
import { recentPasswordHashes, passwordExpired } from './password-history.js';
import { createPasswordDictionary } from './password-dictionary.js';

const KEY = 'password_policy';

/** Ready-made sets of rules. `nist`: long, no composition rules. `fstec`: the same length plus all four character classes (alphabet of 70+ symbols). */
export const PASSWORD_PROFILES = Object.freeze({
  nist: Object.freeze({ minLength: 12, adminMinLength: 12, requireClasses: 0, maxAgeDays: 0, historyCount: 0 }),
  fstec: Object.freeze({ minLength: 12, adminMinLength: 12, requireClasses: 4, maxAgeDays: 90, historyCount: 12 }),
});

/** Thrown by `set()`; `code` is one of MIN_LENGTH_INVALID, ADMIN_MIN_LENGTH_INVALID, CLASSES_INVALID, MAX_AGE_INVALID, HISTORY_INVALID, PROFILE_UNKNOWN. */
export class PasswordPolicyError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'PasswordPolicyError';
    this.code = code;
  }
}

const int = (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v);

/** The configuration's values (`auth.passwordPolicy`) with their defaults. */
export function baseRules(config = {}) {
  return {
    minLength: config.minLength ?? PASSWORD_PROFILES.nist.minLength,
    adminMinLength: config.adminMinLength ?? config.minLength ?? PASSWORD_PROFILES.nist.adminMinLength,
    requireClasses: config.requireClasses ?? 0,
    maxAgeDays: config.maxAgeDays ?? 0,
    historyCount: config.historyCount ?? 0,
    maxLength: config.maxLength ?? 128,
  };
}

function profileOf(v) {
  for (const [name, p] of Object.entries(PASSWORD_PROFILES)) {
    if (p.minLength === v.minLength && p.adminMinLength === v.adminMinLength && p.requireClasses === v.requireClasses && p.maxAgeDays === v.maxAgeDays && p.historyCount === v.historyCount) return name;
  }
  return 'custom';
}

/**
 * The rules in force from the configuration (`b`, see baseRules) and the saved row (`s`, or null). A stored number counts only inside the
 * same limits `set()` enforces: a damaged or edited row (minLength 1, say) must not quietly weaken the rules.
 */
export function effectiveRules(b, s) {
  const st = s ?? {};
  const within = (x, lo, hi, fallback) => (Number.isInteger(x) && x >= lo && x <= hi ? x : fallback);
  const v = {
    minLength: within(st.minLength, 8, b.maxLength, b.minLength),
    adminMinLength: within(st.adminMinLength, 8, b.maxLength, b.adminMinLength),
    requireClasses: within(st.requireClasses, 0, 4, b.requireClasses),
    maxAgeDays: within(st.maxAgeDays, 0, 3650, b.maxAgeDays),
    historyCount: within(st.historyCount, 0, 24, b.historyCount),
    maxLength: b.maxLength,
  };
  v.adminMinLength = Math.max(v.adminMinLength, v.minLength);
  return { profile: profileOf(v), ...v };
}

/** The rules a `set()` call would save on top of the current ones `cur`; throws PasswordPolicyError for a bad value. */
export function nextRules(cur, { profile, minLength, adminMinLength, requireClasses, maxAgeDays, historyCount } = {}) {
  let next = { minLength: cur.minLength, adminMinLength: cur.adminMinLength, requireClasses: cur.requireClasses, maxAgeDays: cur.maxAgeDays, historyCount: cur.historyCount };
  if (profile !== undefined && profile !== '' && profile !== 'custom') {
    if (!PASSWORD_PROFILES[profile]) throw new PasswordPolicyError('PROFILE_UNKNOWN');
    next = { ...PASSWORD_PROFILES[profile] };
  }
  if (minLength !== undefined) next.minLength = int(minLength);
  if (adminMinLength !== undefined) next.adminMinLength = int(adminMinLength);
  if (requireClasses !== undefined) next.requireClasses = int(requireClasses);
  if (maxAgeDays !== undefined) next.maxAgeDays = int(maxAgeDays);
  if (historyCount !== undefined) next.historyCount = int(historyCount);
  if (!Number.isInteger(next.minLength) || next.minLength < 8 || next.minLength > cur.maxLength) throw new PasswordPolicyError('MIN_LENGTH_INVALID');
  if (!Number.isInteger(next.adminMinLength) || next.adminMinLength < next.minLength || next.adminMinLength > cur.maxLength) throw new PasswordPolicyError('ADMIN_MIN_LENGTH_INVALID');
  if (!Number.isInteger(next.requireClasses) || next.requireClasses < 0 || next.requireClasses > 4) throw new PasswordPolicyError('CLASSES_INVALID');
  if (!Number.isInteger(next.maxAgeDays) || next.maxAgeDays < 0 || next.maxAgeDays > 3650) throw new PasswordPolicyError('MAX_AGE_INVALID');
  if (!Number.isInteger(next.historyCount) || next.historyCount < 0 || next.historyCount > 24) throw new PasswordPolicyError('HISTORY_INVALID');
  return next;
}

export { KEY as PASSWORD_POLICY_KEY };

/**
 * The password rules an administrator can change at run time. Until something is saved the values come from the
 * configuration (`auth.passwordPolicy`); a saved policy lives in `app_settings` and applies at once to every process
 * sharing the database. Administrators (accounts with the `admin.access` permission) may get a longer minimum.
 *
 * @param {object} o
 * @param {object} o.db
 * @param {{minLength?: number, adminMinLength?: number, requireClasses?: number, maxLength?: number}} [o.config]
 * @param {string} [o.appName] - a password containing it is refused
 * @param {string} [o.blocklistFile] - leaked-password list ("Pwned Passwords" format, sorted by hash); a password found in it is refused
 */
export function createPasswordPolicy({ db, config = {}, appName = '', blocklistFile = null } = {}) {
  if (!db) throw new TypeError('createPasswordPolicy: db is required');
  const dictionary = createPasswordDictionary({ db, configFile: blocklistFile });
  const base = () => baseRules(config);

  function stored() {
    try {
      ensureSettingsTable(db);
      const row = db.get(`SELECT value FROM app_settings WHERE key = ?`, [KEY]);
      return row ? JSON.parse(row.value) : null;
    } catch {
      return null;
    }
  }

  /** The rules in force: `{ profile, minLength, adminMinLength, requireClasses, maxLength }`. */
  function get() {
    return effectiveRules(base(), stored());
  }

  /**
   * Saves the rules. Pass `profile` to take a ready-made set, or the individual numbers (alone or on top of a profile).
   * @returns {object} what `get()` now returns
   */
  function set({ profile, minLength, adminMinLength, requireClasses, maxAgeDays, historyCount } = {}) {
    const next = nextRules(get(), { profile, minLength, adminMinLength, requireClasses, maxAgeDays, historyCount });
    ensureSettingsTable(db);
    db.run(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [KEY, JSON.stringify(next)]);
    return get();
  }

  /** Back to the values of the configuration. */
  function reset() {
    ensureSettingsTable(db);
    db.run(`DELETE FROM app_settings WHERE key = ?`, [KEY]);
    return get();
  }

  /**
   * Judges a new password under the current rules.
   * @param {string} plain
   * @param {{username?: string, email?: string|null, currentPassword?: string, isAdmin?: boolean}} [who]
   */
  function check(plain, { username, email, currentPassword, isAdmin = false } = {}) {
    const v = get();
    const context = [username, typeof email === 'string' ? email.split('@')[0] : null, appName].filter(Boolean);
    return checkPasswordPolicy(plain, {
      minLength: isAdmin ? v.adminMinLength : v.minLength,
      maxLength: v.maxLength,
      requireClasses: v.requireClasses,
      username, currentPassword, context, words: dictionary.words(),
    });
  }

  /**
   * `check()` plus the rules that need the database or the disk: a password the account already used (the last `historyCount`
   * ones and the current one) and the leaked-password list. Pass `userId` and `verify(storedHash, plain) => Promise<{valid}>`.
   * Adds the codes REUSED and LEAKED.
   */
  async function checkFull(plain, who = {}, { userId = null, verify = null, currentHash = null } = {}) {
    const r = check(plain, who);
    if (typeof plain !== 'string') return r;
    const problems = [...r.problems];
    const v = get();
    if (userId != null && verify && v.historyCount > 0) {
      const hashes = [...new Set([currentHash, ...recentPasswordHashes(db, userId, v.historyCount)].filter(Boolean))];
      for (const h of hashes) {
        if ((await verify(h, plain)).valid) { problems.push('REUSED'); break; }
      }
    }
    if (await dictionary.fileHas(plain)) problems.push('LEAKED');
    return { ok: problems.length === 0, problems };
  }

  /** True when this account's password is older than the allowed age (it must then be changed at the next sign-in). */
  function isExpired(userId) {
    return passwordExpired(db, userId, get().maxAgeDays);
  }

  return { get, set, reset, check, checkFull, isExpired, dictionary, profiles: PASSWORD_PROFILES };
}
