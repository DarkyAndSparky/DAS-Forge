/**
 * Theme and translations as data (D2): the same tokens the server pages use, served to any client (custom elements,
 * React, Vue) so that it does not copy colours or texts.
 *
 *   GET <base>/theme.css            tokens as `--das-*` (and the page's own `--adm-*`), ETag, `Cache-Control: no-cache`
 *   GET <base>/theme.<hash>.css     the same content, `immutable` (the hash is of the content)
 *   GET <base>/i18n/<lng>.json      the `ui` texts of that language, same caching
 *
 * `checkThemeContrast` gives the contrast of every text/background pair of a theme (WCAG 2.2), so a theme can be tested.
 */
import { createHash } from 'node:crypto';
import { tokenCss } from './theme.js';
import { UI_TEXTS } from './texts.js';

/** Relative luminance of `#rrggbb` / `#rgb` (WCAG 2.2). */
function luminance(hex) {
  let h = String(hex).replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) throw new TypeError(`not a hex colour: ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two `#rrggbb` colours, 1..21. */
export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Pairs a theme must satisfy: [foreground token, background token, minimum ratio at AA, minimum at AAA]. */
export const CONTRAST_PAIRS = [
  ['text', 'bg', 4.5, 7], ['text', 'surface', 4.5, 7], ['text', 'surface-2', 4.5, 7],
  ['text-dim', 'bg', 4.5, 7], ['text-dim', 'surface', 4.5, 7],
  ['accent-text', 'accent', 4.5, 7], ['nav-text', 'nav', 4.5, 7],
  ['nav-active', 'nav', 3, 3], ['accent', 'surface', 3, 3],
  ['ok', 'surface', 3, 3], ['warn', 'surface', 3, 3], ['danger', 'surface', 3, 3], ['info', 'surface', 3, 3],
];

/**
 * @param {Record<string,string>} tokens - one theme (`THEME_TOKENS.light`, ...), colours as hex
 * @param {{level?: 'AA'|'AAA'}} [o] - AAA is what the high-contrast theme is held to
 * @returns {{fg:string, bg:string, ratio:number, min:number, ok:boolean}[]}
 */
export function checkThemeContrast(tokens, { level = 'AA' } = {}) {
  return CONTRAST_PAIRS.map(([fg, bg, aa, aaa]) => {
    const ratio = contrastRatio(tokens[fg], tokens[bg]);
    const min = level === 'AAA' ? aaa : aa;
    return { fg, bg, ratio: Math.round(ratio * 100) / 100, min, ok: ratio >= min };
  });
}

/** The token stylesheet for clients: the server's `--adm-*` plus the same values as `--das-*`. */
export function clientThemeCss({ tokens = {}, darkTokens = {} } = {}) {
  const css = tokenCss({ tokens, darkTokens });
  return `${css.replace(/--adm-([a-z0-9-]+):([^;]+);/g, (m, k, v) => `${m}--das-${k}:${v};`)}`;
}

const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/**
 * @param {object} [o]
 * @param {Record<string,string>} [o.tokens]
 * @param {Record<string,string>} [o.darkTokens]
 * @param {Record<string, Record<string,string>>} [o.bundles] - language -> texts (default: the core's `ui` texts)
 * @returns {{css: string, cssHash: string, i18n: Record<string,{json:string, hash:string}>}}
 */
export function buildThemeData({ tokens = {}, darkTokens = {}, bundles = UI_TEXTS } = {}) {
  const css = clientThemeCss({ tokens, darkTokens });
  const i18n = {};
  for (const [lng, texts] of Object.entries(bundles)) {
    if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(lng)) throw new TypeError(`i18n: bad language code "${lng}"`);
    const json = JSON.stringify(texts);
    i18n[lng] = { json, hash: hash(json) };
  }
  return { css, cssHash: hash(css), i18n };
}

/**
 * Mounts the routes on an Express app. Public on purpose (no data of anyone; the login page needs them too).
 * @param {{get: Function}} app
 * @param {object} [o] - as `buildThemeData`, plus `basePath` (default '/ui')
 * @returns {{paths: {css: string, i18n: Record<string,string>}}} the content-addressed addresses
 */
export function mountThemeData(app, { basePath = '/ui', ...data } = {}) {
  const d = buildThemeData(data);
  const send = (req, res, type, body, etag, immutable) => {
    res.set('Content-Type', `${type}; charset=utf-8`);
    res.set('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('ETag', `"${etag}"`);
    if (req.headers['if-none-match'] === `"${etag}"`) return res.status(304).end();
    return res.send(body);
  };
  app.get(`${basePath}/theme.css`, (req, res) => send(req, res, 'text/css', d.css, d.cssHash, false));
  app.get(`${basePath}/theme.${d.cssHash}.css`, (req, res) => send(req, res, 'text/css', d.css, d.cssHash, true));
  const paths = { css: `${basePath}/theme.${d.cssHash}.css`, i18n: {} };
  for (const [lng, b] of Object.entries(d.i18n)) {
    app.get(`${basePath}/i18n/${lng}.json`, (req, res) => send(req, res, 'application/json', b.json, b.hash, false));
    app.get(`${basePath}/i18n/${lng}.${b.hash}.json`, (req, res) => send(req, res, 'application/json', b.json, b.hash, true));
    paths.i18n[lng] = `${basePath}/i18n/${lng}.${b.hash}.json`;
  }
  return { paths };
}
