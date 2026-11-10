import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { THEME_TOKENS } from '../ui/theme.js';
import { sendUpload } from '../files/serve-upload.js';
import { getCompanyBranding } from './company-branding.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Black or white text, whichever reads better on `hex` (WCAG relative luminance). */
export function readableOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return lum > 0.4 ? '#0b1220' : '#ffffff';
}

/** Where uploaded branding logos live: a sub-directory, so the app's own upload housekeeping never sees them. */
export function brandingUploadDir(uploadsDir) {
  const dir = path.join(path.resolve(uploadsDir), 'branding');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The app's theme with the administrator's accent colors applied on top (light and dark separately).
 * Call it per request: `theme: appearance.themeFor(db, baseTheme)`.
 */
export function themeWithBranding(db, baseTheme = {}) {
  let b;
  try { b = getCompanyBranding(db); } catch { return baseTheme; }
  if (!b.accent && !b.accentDark) return baseTheme;
  const tokens = { ...(baseTheme.tokens ?? {}) };
  const darkTokens = { ...(baseTheme.darkTokens ?? {}) };
  const light = b.accent ?? tokens.accent ?? THEME_TOKENS.light.accent;
  const dark = b.accentDark ?? darkTokens.accent ?? THEME_TOKENS.dark.accent;
  Object.assign(tokens, { accent: light, 'accent-text': readableOn(light), 'nav-active': light });
  Object.assign(darkTokens, { accent: dark, 'accent-text': readableOn(dark), 'nav-active': dark });
  return { ...baseTheme, tokens, darkTokens };
}

/**
 * Brand block for the shell header/menu: the company logo (light and dark variants) next to the company name,
 * or only the name. `fallbackName` is the vendor/product name used when no company name is set.
 */
export function brandingHtml(db, { fallbackName = '', logoBase = '/branding/logo' } = {}) {
  let b;
  try { b = getCompanyBranding(db); } catch { b = {}; }
  const name = b.name ?? fallbackName;
  const v = b.updatedAt ? `?v=${encodeURIComponent(Date.parse(b.updatedAt) || 0)}` : '';
  const alt = esc(name);
  let img = '';
  if (b.logoFile || b.logoFileDark) {
    const both = b.logoFile && b.logoFileDark;
    const light = b.logoFile ? `<img class="adm-logo adm-logo-light" src="${logoBase}/light${v}" alt="${alt}">` : '';
    const dark = b.logoFileDark ? `<img class="adm-logo adm-logo-dark" src="${logoBase}/dark${v}" alt="${alt}">` : '';
    // a single logo is used for both themes
    const only = b.logoFile ? light : dark;
    img = both ? light + dark : only.replace(/adm-logo-(light|dark)/, 'adm-logo-single');
  }
  return `${img}${name ? `<span>${esc(name)}</span>` : ''}`;
}


/** Public route for the logo (the login page needs it before anyone is signed in). */
export function mountLogoRoute(app, { db, uploadsDir, path: routePath = '/branding/logo' } = {}) {
  const dir = brandingUploadDir(uploadsDir);
  app.get(`${routePath}/:theme`, async (req, res, next) => {
    try {
      const b = getCompanyBranding(db);
      const dark = req.params.theme === 'dark';
      if (req.params.theme !== 'light' && !dark) return res.status(404).end();
      const file = dark ? b.logoFileDark ?? b.logoFile : b.logoFile ?? b.logoFileDark;
      if (!file) return res.status(404).end();
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
      if (!(await sendUpload(res, dir, file))) return res.status(404).end();
      return undefined;
    } catch (err) { return next(err); }
  });
}

/** A vendor logo as a data-URI image for one theme, or '' when the app ships none. */
function vendorLogoImg(vendorIdentity, theme, cls) {
  try {
    const logo = vendorIdentity?.readLogo?.(theme);
    if (!logo) return '';
    const b64 = Buffer.from(logo.contents).toString('base64');
    return `<img class="adm-logo ${cls}" src="data:${logo.mime};base64,${b64}" alt="">`;
  } catch { return ''; }
}

/**
 * The app's brand block for every page: the logo and name the administrator set under "Appearance",
 * and for whatever they left empty, the app's own vendor identity (assets/brand logo, product name).
 * With no database (an error page while the database is down) pass `db = null`.
 * @param {object|null} db
 * @param {object} vendorIdentity - `branding.defineVendorIdentity()` of the app
 * @param {{logoBase?: string}} [opts]
 */
export function brandBlockHtml(db, vendorIdentity, { logoBase = '/branding/logo' } = {}) {
  let b = {};
  if (db) { try { b = getCompanyBranding(db); } catch { b = {}; } }
  if (b.logoFile || b.logoFileDark) return brandingHtml(db, { fallbackName: vendorIdentity?.name ?? '', logoBase });
  const name = b.name ?? vendorIdentity?.name ?? '';
  const both = vendorIdentity?.hasDarkLogo?.();
  const img = both
    ? vendorLogoImg(vendorIdentity, 'light', 'adm-logo-light') + vendorLogoImg(vendorIdentity, 'dark', 'adm-logo-dark')
    : vendorLogoImg(vendorIdentity, 'light', 'adm-logo-single');
  return `${img}${name ? `<span>${esc(name)}</span>` : ''}`;
}
