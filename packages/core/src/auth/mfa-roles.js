import { ensureSettingsTable } from '../branding/company-branding.js';

const KEY = 'mfa_required_roles';
const MAX_ROLES = 50;
const ROLE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * Which roles must have a second factor, set by an administrator at run time (kept in `app_settings`, shared by every
 * process on the database, so no restart). It adds to what the application already demands in code
 * (`mfaRequiredForRole`): the two are OR-ed, a setting can only make the rule stricter.
 *
 * What "required" does (see `accounts`): a user of such a role with no active factor is let in, but only to the
 * account page where the factor is set up, until one is confirmed.
 *
 * @param {{ db: object }} o
 */
export function createMfaRoleStore({ db }) {
  if (!db) throw new TypeError('createMfaRoleStore: db is required');

  /** @returns {string[]} sorted, only well-formed names (a damaged row reads as an empty list) */
  function list() {
    try {
      const row = db.get(`SELECT value FROM app_settings WHERE key = ?`, [KEY]);
      if (!row) return [];
      const v = JSON.parse(row.value);
      if (!Array.isArray(v)) return [];
      return [...new Set(v.filter((r) => typeof r === 'string' && ROLE_RE.test(r)))].sort();
    } catch {
      return []; // no table yet, or a damaged row
    }
  }

  const has = (role) => typeof role === 'string' && list().includes(role);

  /**
   * Switches one role on or off.
   * @param {string} role
   * @param {boolean} required
   * @returns {{ roles: string[], changed: boolean }}
   */
  function setRole(role, required) {
    if (typeof role !== 'string' || !ROLE_RE.test(role)) throw new TypeError('role name is not valid');
    const before = list();
    const next = required ? [...new Set([...before, role])].sort() : before.filter((r) => r !== role);
    if (next.length > MAX_ROLES) throw new RangeError('too many roles');
    const changed = next.length !== before.length;
    if (changed) {
      ensureSettingsTable(db);
      db.run(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [KEY, JSON.stringify(next)]);
    }
    return { roles: next, changed };
  }

  return { list, has, setRole };
}
