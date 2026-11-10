import { describe, it, expect } from 'vitest';
import { tokenCss, themeHead, THEME_TOKENS } from '../src/ui/theme.js';
import { renderAppShell } from '../src/ui/shell.js';
import { ERROR_CATALOG, errorText, resolveLocale } from '../src/http/error-catalog.js';
import { renderErrorPage, notFoundHandler, errorPageHandler } from '../src/http/error-pages.js';

const registry = { getNavigation: () => [{ label: 'Home', path: '/' }], getTranslations: () => ({ ru: {}, en: {} }) };
const vendor = { name: 'T', getLogo: () => null, readLogo: () => null };

function mockRes() {
  return { statusCode: null, body: null, json_: false, headers: {}, status(c) { this.statusCode = c; return this; }, type() { return this; }, send(b) { this.body = b; return this; }, json(b) { this.body = b; this.json_ = true; return this; }, setHeader(k, v) { this.headers[k] = v; } };
}

describe('theme tokens', () => {
  it('has default light and dark values and lets an app override them', () => {
    const css = tokenCss({ tokens: { accent: '#c9a24b', surface: 'var(--void-1)' }, darkTokens: { bg: '#0b0e1a' } });
    expect(css).toContain(`--adm-accent:#c9a24b;`);
    expect(css).toContain('--adm-surface:var(--void-1);');
    expect(css).toContain('--adm-bg:#0b0e1a;');
    expect(css).toContain(`--adm-bg:${THEME_TOKENS.light.bg};`);
    expect(css).toContain('prefers-color-scheme:dark');
    expect(css).toContain('[data-theme="dark"]');
  });

  it('refuses token values or names that could break out of the declaration', () => {
    expect(() => tokenCss({ tokens: { accent: 'red;}body{display:none' } })).toThrow(/invalid value/);
    expect(() => tokenCss({ tokens: { accent: '</style><script>x</script>' } })).toThrow(/invalid value/);
    expect(() => tokenCss({ tokens: { 'bad name': '#fff' } })).toThrow(/invalid token name/);
  });

  it('refuses tokens that load resources and stylesheet URLs that are not a path or https', () => {
    for (const v of ['url(//evil.example/a.png)', 'URL (x)', 'image-set(a 1x)', 'expression(alert(1))']) {
      expect(() => tokenCss({ tokens: { accent: v } })).toThrow(/invalid value/);
    }
    for (const u of ['//evil.example/a.css', 'javascript:alert(1)', 'data:text/css,a{}', 'http://x/a.css', '/a b.css']) {
      expect(() => themeHead({ cssUrl: u })).toThrow(/cssUrl/);
    }
    expect(themeHead({ cssUrl: 'https://cdn.example/a.css' })).toContain('href="https://cdn.example/a.css"');
  });

  it('themeHead adds the nonce and the app stylesheet link after the base styles', () => {
    const head = themeHead({ nonce: 'abc', cssUrl: '/static/app-theme.css' });
    expect(head).toContain('<style nonce="abc">');
    expect(head.indexOf('</style>') < head.indexOf('/static/app-theme.css')).toBe(true);
  });
});

describe('app shell with theme', () => {
  it('renders the toggle, user name, brand and a nonce on the inline script', () => {
    const html = renderAppShell({ moduleRegistry: registry, title: 'Admin', user: { username: 'ann<b>' }, brandHtml: '<b>Logo</b>', nonce: 'n0nce', theme: { tokens: { accent: '#123456' } } });
    expect(html).toContain('<script nonce="n0nce">');
    expect(html).toContain('data-adm-theme-toggle');
    expect(html).toContain('ann&lt;b&gt;');
    expect(html).toContain('<b>Logo</b>');
    expect(html).toContain('--adm-accent:#123456;');
    expect(html).toContain('aria-label="Основное"');
  });
});

describe('error catalog', () => {
  it('has ru and en texts with a hint for every listed code, and falls back by class', () => {
    for (const loc of ['ru', 'en']) {
      for (const code of [400, 401, 403, 404, 405, 409, 413, 429, 500, 503]) {
        const t = errorText(code, loc);
        expect(t.title.length > 0 && t.message.length > 0 && t.hint.length > 0).toBe(true);
      }
    }
    expect(errorText(418, 'en')).toEqual(ERROR_CATALOG.en['4xx']);
    expect(errorText(599, 'ru')).toEqual(ERROR_CATALOG.ru['5xx']);
    expect(errorText(404, 'de')).toEqual(ERROR_CATALOG.ru[404]);
  });

  it('resolves the language from req.locale, then Accept-Language, then the default', () => {
    expect(resolveLocale({ locale: 'en' })).toBe('en');
    expect(resolveLocale({ headers: { 'accept-language': 'de,en-US;q=0.8,ru;q=0.5' } })).toBe('en');
    expect(resolveLocale({ headers: {} }, 'en')).toBe('en');
    expect(resolveLocale({ headers: { 'accept-language': 'fr' } })).toBe('ru');
  });
});

describe('error pages', () => {
  it('shows the localized title, message, hint, home link and the request id', () => {
    const html = renderErrorPage({ vendorIdentity: vendor, statusCode: 403, title: 'Access denied', message: 'm', hint: 'ask an admin', locale: 'en', requestId: 'r-1' });
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('ask an admin');
    expect(html).toContain('>Home<');
    expect(html).toContain('request id: r-1');
  });

  it('applies the app theme tokens', () => {
    const html = renderErrorPage({ vendorIdentity: vendor, statusCode: 404, title: 't', message: 'm', theme: { tokens: { accent: '#abcdef' } } });
    expect(html).toContain('--adm-accent:#abcdef;');
  });

  it('notFoundHandler: HTML for browsers (ru by default, en by Accept-Language), JSON for /api/ and JSON clients', () => {
    const h = notFoundHandler(vendor);
    const ru = mockRes(); h({ id: 'a', headers: {}, path: '/x' }, ru);
    expect(ru.body).toContain('Страница не найдена');
    const en = mockRes(); h({ id: 'a', headers: { 'accept-language': 'en' }, path: '/x' }, en);
    expect(en.body).toContain('Page not found');
    const api = mockRes(); h({ id: 'a', headers: {}, path: '/api/things' }, api);
    expect(api.json_).toBe(true);
    expect(api.body).toMatchObject({ error: 'NOT_FOUND', requestId: 'a' });
    const jc = mockRes(); h({ id: 'a', headers: { accept: 'application/json' }, path: '/x' }, jc);
    expect(jc.json_).toBe(true);
  });

  it('errorPageHandler uses the catalog per status and language; 429/503 JSON carries Retry-After', () => {
    const handler = errorPageHandler(vendor);
    const res = mockRes();
    handler(Object.assign(new Error('x'), { statusCode: 429 }), { id: 'r', headers: { 'accept-language': 'en' }, path: '/p' }, res, () => {});
    expect(res.statusCode).toBe(429);
    expect(res.body).toContain('Too many requests');
    const j = mockRes();
    handler(Object.assign(new Error('x'), { statusCode: 503 }), { id: 'r', headers: { accept: 'application/json' }, path: '/p' }, j, () => {});
    expect(j.headers['Retry-After']).toBe('5');
    expect(j.body.message).toBe(ERROR_CATALOG.ru[503].message);
  });
});
