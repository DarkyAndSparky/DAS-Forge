import { describe, it, expect } from 'vitest';
import { langSwitchHtml } from '../src/ui/lang-switch.js';
import { renderErrorPage } from '../src/http/error-pages.js';

const vendor = { name: 'T', getLogo: () => null, readLogo: () => null };

describe('langSwitchHtml', () => {
  it('is one link that shows the current language and points at the other', () => {
    const ru = langSwitchHtml('ru');
    expect(ru).toContain('href="?lang=en"');
    expect(ru).toContain('>RU<');
    expect(ru.match(/<a /g)).toHaveLength(1);
    const en = langSwitchHtml('en');
    expect(en).toContain('href="?lang=ru"');
    expect(en).toContain('>EN<');
  });
  it('escapes a custom href', () => {
    expect(langSwitchHtml('ru', { href: '/x"y' })).toContain('href="/x&quot;y"');
  });
});

describe('error page sign-in button', () => {
  const base = { vendorIdentity: vendor, title: 't', message: 'm' };
  it('401 with loginUrl gets a Sign in / Войти button next to the home link', () => {
    const ru = renderErrorPage({ ...base, statusCode: 401, loginUrl: '/login' });
    expect(ru).toContain('href="/login">Войти</a>');
    expect(renderErrorPage({ ...base, statusCode: 401, loginUrl: '/login', locale: 'en' })).toContain('>Sign in</a>');
  });
  it('other statuses and a missing loginUrl get none; the language button is on every page', () => {
    expect(renderErrorPage({ ...base, statusCode: 404, loginUrl: '/login' })).not.toContain('class="home login"');
    expect(renderErrorPage({ ...base, statusCode: 401 })).not.toContain('class="home login"');
    expect(renderErrorPage({ ...base, statusCode: 404 })).toContain('class="lang-switch"');
  });
});
