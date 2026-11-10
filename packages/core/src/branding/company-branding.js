import { CompanyBrandingSchema } from './schema.js';
import { ConfigValidationError } from '../config/errors.js';

const SETTINGS_TABLE = 'app_settings';
const BRANDING_KEY = 'company_branding';

/**
 * Ensures the generic key/value settings table exists. Company branding
 * is the first consumer, but this table is intentionally generic
 * (key TEXT PRIMARY KEY, value TEXT as JSON) so other small admin-editable
 * singletons (e.g. future settings) can reuse it instead of each getting
 * a bespoke one-row table.
 */
export function ensureSettingsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${SETTINGS_TABLE} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

/**
 * Reads the current company branding. Returns schema defaults
 * (all nulls) if nothing has been set yet - callers should fall back
 * to vendor identity's name/logo when these are null.
 */
export function getCompanyBranding(db) {
  ensureSettingsTable(db);
  const row = db.get(`SELECT value FROM ${SETTINGS_TABLE} WHERE key = ?`, [BRANDING_KEY]);
  if (!row) {
    return CompanyBrandingSchema.parse({});
  }
  return CompanyBrandingSchema.parse(JSON.parse(row.value));
}

/**
 * Sets company branding. `patch` is shallow-merged onto the current
 * value so callers can update just `name` without resupplying `logoUrl`.
 * Validates with the same Zod schema used for reads, so bad data can
 * never get written in the first place (zero-trust §4.5j applied to
 * this admin-only write path too).
 *
 * Caller is responsible for authorization (admin-only) - this function
 * has no opinion on who's allowed to call it.
 */
export function setCompanyBranding(db, patch, { actor } = {}) {
  ensureSettingsTable(db);
  const current = getCompanyBranding(db);

  const result = CompanyBrandingSchema.safeParse({
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
    updatedBy: actor ?? current.updatedBy ?? null,
  });

  if (!result.success) {
    throw new ConfigValidationError(result.error, { sourcePath: 'company_branding' });
  }

  db.run(
    `INSERT INTO ${SETTINGS_TABLE} (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [BRANDING_KEY, JSON.stringify(result.data)]
  );

  return result.data;
}

/**
 * Resolves the "effective" branding for rendering: company branding
 * where set, falling back to vendor identity's own name/logo otherwise.
 * This is what header/login/sidebar should call - About should call
 * vendorIdentity directly instead, since it must never show the
 * customized name in place of the real product name.
 */
export function getEffectiveBranding(db, vendorIdentity, { theme = 'light' } = {}) {
  const company = getCompanyBranding(db);
  const companyLogoUrl = theme === 'dark' ? company.logoUrlDark ?? company.logoUrl : company.logoUrl;

  return {
    name: company.name ?? vendorIdentity.name,
    logo: companyLogoUrl
      ? { format: 'url', path: companyLogoUrl, theme }
      : vendorIdentity.getLogo(theme),
    isCustomized: Boolean(company.name || company.logoUrl),
  };
}
