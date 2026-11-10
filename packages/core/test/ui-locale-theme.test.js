import { describe, it, expect } from 'vitest';
import { localeMiddleware } from '../src/ui/locale.js';
import { themeHead, themeToggleHtml, THEME_SCRIPT } from '../src/ui/theme.js';
import { renderErrorPage } from '../src/http/error-pages.js';
import { renderAppShell } from '../src/ui/shell.js';

function run(req) {
  const cookies = [];
  const res = { cookie: (n, v, o) => cookies.push({ n, v, o }) };
  localeMiddleware()({ headers: {}, query: {}, ...req }, res, () => {});
  return cookies;
}

describe('localeMiddleware', () => {
  it('?lang= sets req.locale and remembers it in a cookie', () => {
    const req = { query: { lang: 'en' } };
    const cookies = [];
    localeMiddleware()(req, { cookie: (n, v, o) => cookies.push({ n, v, o }) }, () => {});
    expect(req.locale).toBe('en');
    expect(cookies[0].n).toBe('das_lang');
    expect(cookies[0].v).toBe('en');
    expect(cookies[0].o.path).toBe('/');
  });
  it('then the cookie, then Accept-Language, then the fallback; junk is ignored', () => {
    const a = { headers: { cookie: 'x=1; das_lang=en' }, query: {} };
    localeMiddleware()(a, {}, () => {});
    expect(a.locale).toBe('en');
    const b = { headers: { 'accept-language': 'de,en;q=0.8' }, query: {} };
    localeMiddleware()(b, {}, () => {});
    expect(b.locale).toBe('en');
    const c = { headers: { cookie: 'das_lang=fr' }, query: { lang: 'zz' } };
    localeMiddleware({ fallback: 'ru' })(c, {}, () => {});
    expect(c.locale).toBe('ru');
    expect(run({ query: {} })).toEqual([]);
  });
});

describe('one theme everywhere', () => {
  const vendor = { name: 'T', getLogo: () => null, readLogo: () => null };
  it('themeHead carries the theme script, so every page that uses it follows the saved choice', () => {
    const head = themeHead({ nonce: 'N' });
    expect(head).toContain('<script nonce="N">');
    expect(head).toContain(THEME_SCRIPT);
    expect(head).toContain('.adm-theme-btn');
  });
  it('the toggle is an icon button with light/dark icons, no text label', () => {
    const b = themeToggleHtml('en');
    expect((b.match(/<svg/g) || []).length).toBe(2);
    expect(b).toContain('data-adm-theme-toggle');
    expect(b).toContain('Theme: light / dark');
    expect(b).not.toContain('i-auto');
    expect(THEME_SCRIPT).not.toContain("?'':'dark'");
    expect(b.replace(/<[^>]+>/g, '')).toBe('');
  });
  it('error pages and the shell both have the toggle and the script (the shell once, not twice)', () => {
    const page = renderErrorPage({ vendorIdentity: vendor, statusCode: 404, title: 't', message: 'm', nonce: 'N2' });
    expect(page).toContain('data-adm-theme-toggle');
    expect(page).toContain('<script nonce="N2">');
    const shell = renderAppShell({ moduleRegistry: { getNavigation: () => [], getTranslations: () => ({ ru: {}, en: {} }) }, nonce: 'N3' });
    expect(shell.split(THEME_SCRIPT).length - 1).toBe(1);
    expect(shell).toContain('data-adm-theme-toggle');
  });
  it('extraNav entries are translated by locale and filtered by permission', () => {
    const html = renderAppShell({
      moduleRegistry: { getNavigation: () => [], getTranslations: () => ({ ru: {}, en: {} }) },
      locale: 'en',
      viewerPermissions: ['a'],
      extraNav: [{ path: '/x', label: { ru: 'Икс', en: 'Ex' } }, { path: '/y', label: { ru: 'Игрек', en: 'Why' }, permission: 'b' }],
    });
    expect(html).toContain('>Ex<');
    expect(html).not.toContain('Why');
  });
  it('has a skip link, a focusable main landmark, and does not read prototype keys as translations (E04, E07)', () => {
    const html = renderAppShell({
      moduleRegistry: {
        getNavigation: () => [{ path: '/a', label: 'constructor' }, { path: '/b', label: 'toString' }],
        getTranslations: () => ({ ru: { known: 'Известно' }, en: {} }),
      },
      locale: 'en',
    });
    expect(html).toContain('<a class="adm-skip" href="#adm-main">Skip to content</a>');
    expect(html).toContain('id="adm-main"');
    expect(html).toContain('>constructor<');
    expect(html).toContain('>toString<');
  });
});

describe('renderAppShell header', () => {
  const reg = { getNavigation: () => [], getTranslations: () => ({ ru: {}, en: {} }) };
  it('links the logo home, the user name to the account, adds sign-out and the area label', () => {
    const html = renderAppShell({ moduleRegistry: reg, user: { username: 'admin' }, brandHtml: '<b>x</b>', homeUrl: '/ui', accountUrl: '/ui/account', showLogout: true, badge: 'Администрирование' });
    expect(html).toContain('<a class="adm-brand-link" href="/ui"><b>x</b></a>');
    expect(html).toContain('<a class="adm-user" href="/ui/account">admin</a>');
    expect(html).toContain('id="adm-logout"');
    expect(html).toContain('<div class="adm-area">Администрирование</div>');
  });
  it('sign-out does not swallow a failure (G-11): the script reports it and stays on the page', () => {
    for (const locale of ['ru', 'en']) {
      const html = renderAppShell({ moduleRegistry: reg, user: { username: 'admin' }, brandHtml: '<b>x</b>', showLogout: true, locale });
      const js = html.split('<script').map((x) => x.split('</script>')[0].replace(/^[^>]*>/, '')).find((x) => x.includes("'/logout'"));
      expect(js).toBeTruthy();
      expect(js).not.toContain('catch(e){}');
      expect(js).toContain('alert(');
      expect(() => new Function(js)).not.toThrow();
    }
  });
  it('stays plain without those options', () => {
    const html = renderAppShell({ moduleRegistry: reg, user: { username: 'admin' }, brandHtml: '<b>x</b>' });
    expect(html).not.toContain('adm-logout"');
    expect(html).toContain('<span class="adm-user">admin</span>');
  });
});
