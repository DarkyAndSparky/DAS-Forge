import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Vendor identity = the "baked in" logo + name of a DAS-Forge-based app
 * (or of the core itself). This is immutable from the UI by design: it
 * lives as a file in the app's own repository (assets/brand/logo.*),
 * not in the database, so no admin/user action can change what an
 * About page says the product actually is.
 *
 * Convention (same for core and for each of the 4 apps):
 *   <package root>/assets/brand/logo.svg          (light theme, preferred)
 *   <package root>/assets/brand/logo.png / .jpg   (light theme, fallback)
 *   <package root>/assets/brand/logo-dark.svg        (dark theme, preferred)
 *   <package root>/assets/brand/logo-dark.png / .jpg (dark theme, fallback)
 *
 * SVG is preferred because it scales cleanly across favicon / header /
 * About / print contexts without shipping multiple raster sizes, but
 * the resolver deliberately falls back to raster formats so a project
 * isn't blocked on having a vector logo ready yet.
 *
 * Theme variants exist because a logo designed for a light background
 * (e.g. dark line-art) can become unreadable on a dark background —
 * a CSS filter/invert is not a reliable fix for a multi-color logo, so
 * this is a separate asset, not a runtime transform. If `logo-dark.*`
 * doesn't exist yet, the resolver falls back to the light variant
 * rather than failing, so a project isn't blocked on having both ready.
 */
function logoCandidates(suffix) {
  return [
    { file: `logo${suffix}.svg`, format: 'svg', mime: 'image/svg+xml' },
    { file: `logo${suffix}.png`, format: 'png', mime: 'image/png' },
    { file: `logo${suffix}.jpg`, format: 'jpg', mime: 'image/jpeg' },
    { file: `logo${suffix}.jpeg`, format: 'jpg', mime: 'image/jpeg' },
  ];
}

const LIGHT_CANDIDATES = logoCandidates('');
const DARK_CANDIDATES = logoCandidates('-dark');

/**
 * Resolves the logo file for a brand assets directory.
 *
 * @param {string} assetsDir
 * @param {object} [opts]
 * @param {'light'|'dark'} [opts.theme='light']
 * @returns {{file,format,mime,path,theme}|null} null if no candidate
 *   exists yet (e.g. app hasn't added one). When theme is 'dark' but no
 *   dark variant exists, falls back to the light variant (returned
 *   object's `theme` reflects what was actually found, so callers can
 *   tell a true dark asset from a fallback).
 */
export function resolveVendorLogo(assetsDir, { theme = 'light' } = {}) {
  const tryCandidates = (candidates, resolvedTheme) => {
    for (const candidate of candidates) {
      const fullPath = path.join(assetsDir, candidate.file);
      if (existsSync(fullPath)) {
        return { ...candidate, path: fullPath, theme: resolvedTheme };
      }
    }
    return null;
  };

  if (theme === 'dark') {
    return tryCandidates(DARK_CANDIDATES, 'dark') ?? tryCandidates(LIGHT_CANDIDATES, 'light');
  }
  return tryCandidates(LIGHT_CANDIDATES, 'light');
}

/**
 * Reads the resolved logo's contents. For SVG this returns a UTF-8
 * string (safe to inline into HTML); for raster formats it returns a
 * Buffer, since those are served as static files / data URIs, not
 * inlined as markup.
 */
export function readVendorLogo(assetsDir, opts) {
  const resolved = resolveVendorLogo(assetsDir, opts);
  if (!resolved) return null;
  const contents =
    resolved.format === 'svg'
      ? readFileSync(resolved.path, 'utf8')
      : readFileSync(resolved.path);
  return { ...resolved, contents };
}

/**
 * Defines a fixed vendor identity for an app or for the core itself.
 * `assetsDir` should point at that package's own assets/brand directory
 * (each app resolves its own, independently of core's).
 */
export function defineVendorIdentity({ name, repoUrl, assetsDir }) {
  if (!name) throw new TypeError('defineVendorIdentity requires a name');
  if (!assetsDir) throw new TypeError('defineVendorIdentity requires assetsDir');

  return Object.freeze({
    name,
    repoUrl: repoUrl ?? null,
    assetsDir,
    /** Light-theme logo (default) — kept for backwards compatibility. */
    get logo() {
      return resolveVendorLogo(assetsDir, { theme: 'light' });
    },
    getLogo(theme = 'light') {
      return resolveVendorLogo(assetsDir, { theme });
    },
    readLogo(theme = 'light') {
      return readVendorLogo(assetsDir, { theme });
    },
    /** True only if a real dark-specific asset exists (not a fallback). */
    hasDarkLogo() {
      return resolveVendorLogo(assetsDir, { theme: 'dark' })?.theme === 'dark';
    },
  });
}
