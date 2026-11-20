import { CompanyBrandingSchema } from './schema.js';
import { ConfigValidationError } from '../config/errors.js';
import { asyncDb } from '../database/async.js';

const SETTINGS_TABLE = 'app_settings';
const BRANDING_KEY = 'company_branding';

/**
 * Ensures the generic key/value settings table exists. Company branding
 * is the first consumer, but this table is intentionally generic
 * (key TEXT PRIMARY KEY, value TEXT as JSON) so other small admin-editable
 * singletons (e.g. future settings) can reuse it instead of each getting
 * a bespoke one-row table.
 */
/** The same table for code that works over `asyncDb`. */
export async function ensureSettingsTableAsync(db) {
  await asyncDb(db).exec(`
    CREATE TABLE IF NOT EXISTS ${SETTINGS_TABLE} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

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
  return parseBranding(db.get(`SELECT value FROM ${SETTINGS_TABLE} WHERE key = ?`, [BRANDING_KEY]));
}

/** The stored row (or undefined) as validated branding; nothing stored gives the schema defaults. */
export function parseBranding(row) {
  return row ? CompanyBrandingSchema.parse(JSON.parse(row.value)) : CompanyBrandingSchema.parse({});
}

/** The validated branding a `set` would save: `current` with `patch` on top. Throws ConfigValidationError. */
export function mergeBranding(current, patch, actor) {
  const result = CompanyBrandingSchema.safeParse({
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
    updatedBy: actor ?? current.updatedBy ?? null,
  });
  if (!result.success) throw new ConfigValidationError(result.error, { sourcePath: 'company_branding' });
  return result.data;
}

/** `getCompanyBranding` over `asyncDb`. */
export async function getCompanyBrandingAsync(db) {
  const a = asyncDb(db);
  await ensureSettingsTableAsync(a);
  return parseBranding(await a.get(`SELECT value FROM ${SETTINGS_TABLE} WHERE key = ?`, [BRANDING_KEY]));
}

/** `setCompanyBranding` over `asyncDb`; the read and the write are one transaction, so two edits cannot overwrite each other. */
export async function setCompanyBrandingAsync(db, patch, { actor } = {}) {
  const a = asyncDb(db);
  await ensureSettingsTableAsync(a);
  return a.transaction(async (tx) => {
    const next = mergeBranding(parseBranding(await tx.get(`SELECT value FROM ${SETTINGS_TABLE} WHERE key = ?`, [BRANDING_KEY])), patch, actor);
    await tx.run(`INSERT INTO ${SETTINGS_TABLE} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [BRANDING_KEY, JSON.stringify(next)]);
    return next;
  }, { mode: 'immediate' });
}

/** `getEffectiveBranding` over `asyncDb`. */
export async function getEffectiveBrandingAsync(db, vendorIdentity, { theme = 'light' } = {}) {
  return effectiveFrom(await getCompanyBrandingAsync(db), vendorIdentity, theme);
}

/**
 * Sets company branding. `patch` is shallow-merged onto the current
 * value so callers can update just `name` without resupplying `logoUrl`.
 * Validates with the same Zod schema used for reads, so bad data can
 * never get written in the first place. Caller is responsible for
 * authorization (admin-only).
 */
export function setCompanyBranding(db, patch, { actor } = {}) {
  ensureSettingsTable(db);
  const current = getCompanyBranding(db);
  const next = mergeBranding(current, patch, actor);

  db.run(
    `INSERT INTO ${SETTINGS_TABLE} (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [BRANDING_KEY, JSON.stringify(next)]
  );

  return next;
}

/**
 * Resolves the "effective" branding for rendering: company branding
 * where set, falling back to vendor identity's own name/logo otherwise.
 * This is what header/login/sidebar should call - About should call
 * vendorIdentity directly instead, since it must never show the
 * customized name in place of the real product name.
 */
export function getEffectiveBranding(db, vendorIdentity, { theme = 'light' } = {}) {
  return effectiveFrom(getCompanyBranding(db), vendorIdentity, theme);
}

function effectiveFrom(company, vendorIdentity, theme) {
  const companyLogoUrl = theme === 'dark' ? company.logoUrlDark ?? company.logoUrl : company.logoUrl;

  return {
    name: company.name ?? vendorIdentity.name,
    logo: companyLogoUrl
      ? { format: 'url', path: companyLogoUrl, theme }
      : vendorIdentity.getLogo(theme),
    isCustomized: Boolean(company.name || company.logoUrl),
  };
}
