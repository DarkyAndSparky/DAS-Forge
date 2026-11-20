import { describe, it, expect } from 'vitest';
import { THEME_TOKENS, tokenCss } from '../src/ui/theme.js';
import { contrastRatio, checkThemeContrast, clientThemeCss, buildThemeData, mountThemeData } from '../src/ui/theme-data.js';

function fakeApp() {
  const routes = new Map();
  return { get: (p, h) => routes.set(p, h), routes, call(p, headers = {}) {
    const out = { headers: {}, code: 200, body: undefined };
    const res = { set: (k, v) => { out.headers[k.toLowerCase()] = v; }, status: (c) => { out.code = c; return res; }, send: (b) => { out.body = b; }, end: () => {} };
    routes.get(p)({ headers }, res);
    return out;
  } };
}

describe('contrast', () => {
  it('computes WCAG ratios', () => {
    expect(Math.round(contrastRatio('#000000', '#ffffff'))).toBe(21);
    expect(contrastRatio('#fff', '#fff')).toBe(1);
  });
  it('every pair of the light and dark themes meets AA, the high-contrast theme meets AAA', () => {
    for (const name of ['light', 'dark']) {
      const bad = checkThemeContrast(THEME_TOKENS[name]).filter((r) => !r.ok);
      expect(bad, `${name}: ${JSON.stringify(bad)}`).toEqual([]);
    }
    const bad = checkThemeContrast(THEME_TOKENS.contrast, { level: 'AAA' }).filter((r) => !r.ok);
    expect(bad, JSON.stringify(bad)).toEqual([]);
  });
  it('catches a bad pair', () => {
    expect(checkThemeContrast({ ...THEME_TOKENS.light, text: '#cccccc' }).some((r) => !r.ok)).toBe(true);
  });
});

describe('theme as data', () => {
  it('client css carries the same values as --das-* next to the server\'s --adm-*', () => {
    const css = clientThemeCss();
    for (const [k, v] of Object.entries(THEME_TOKENS.light)) {
      expect(css).toContain(`--adm-${k}:${v};`);
      expect(css).toContain(`--das-${k}:${v};`);
    }
    expect(css.startsWith(tokenCss().slice(0, 20))).toBe(true);
    expect(clientThemeCss({ tokens: { accent: '#123456' } })).toContain('--das-accent:#123456;');
  });
  it('serves css and texts with ETag, no-cache for the plain address, immutable for the hashed one, 304 on a match', () => {
    const app = fakeApp();
    const { paths } = mountThemeData(app, { bundles: { ru: { a: 'А' }, en: { a: 'A' } } });
    const plain = app.call('/ui/theme.css');
    expect(plain.headers['cache-control']).toBe('no-cache');
    expect(plain.headers['content-type']).toMatch(/^text\/css/);
    const hashed = app.call(paths.css);
    expect(hashed.headers['cache-control']).toMatch(/immutable/);
    expect(hashed.body).toBe(plain.body);
    expect(app.call('/ui/theme.css', { 'if-none-match': plain.headers.etag }).code).toBe(304);
    expect(JSON.parse(app.call(paths.i18n.ru).body)).toEqual({ a: 'А' });
    expect(app.call('/ui/i18n/en.json').headers['content-type']).toMatch(/json/);
  });
  it('the hash changes with the content and a bad language code is refused', () => {
    expect(buildThemeData({ tokens: { accent: '#111111' } }).cssHash).not.toBe(buildThemeData().cssHash);
    let e; try { buildThemeData({ bundles: { '../x': {} } }); } catch (x) { e = x; }
    expect(e instanceof TypeError).toBe(true);
  });
  it('defaults to the core ui texts', () => {
    expect(Object.keys(buildThemeData().i18n).sort()).toEqual(['en', 'ru']);
  });
});
