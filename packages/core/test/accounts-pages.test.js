import { describe, it, expect } from 'vitest';
import { pickTexts } from '../src/i18n/overrides.js';
import { ACCOUNT_TEXTS } from '../src/accounts/texts.js';
import { renderLoginPage, renderForcedPasswordPage, renderForgotPasswordPage, renderResetPasswordPage, renderAccountBody } from '../src/accounts/pages.js';

const l = (locale, override) => pickTexts(ACCOUNT_TEXTS, override, locale);
const scriptOf = (html) => [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');

describe('account texts', () => {
  it('have the same keys in both languages and no empty text', () => {
    expect(Object.keys(ACCOUNT_TEXTS.ru).sort()).toEqual(Object.keys(ACCOUNT_TEXTS.en).sort());
    for (const lng of ['ru', 'en']) for (const [k, v] of Object.entries(ACCOUNT_TEXTS[lng])) expect(String(v).trim(), `${lng}.${k}`).not.toBe('');
  });

  it('every key the pages ask for exists', () => {
    const src = [renderLoginPage, renderForcedPasswordPage, renderForgotPasswordPage, renderResetPasswordPage];
    const html = src.map((r) => r({ l: l('en'), locale: 'en' })).join('') + renderAccountBody({ user: { username: 'a' }, authenticators: [], l: l('en') });
    expect(html).not.toContain('undefined');
  });
});

describe('the pages follow the locale', () => {
  const pages = { login: renderLoginPage, forced: renderForcedPasswordPage, forgot: renderForgotPasswordPage, reset: renderResetPasswordPage };

  it('English and Russian carry their own texts, and the browser script gets them as JSON', () => {
    for (const [name, render] of Object.entries(pages)) {
      const en = render({ locale: 'en', l: l('en'), nonce: 'n' });
      const ru = render({ locale: 'ru', l: l('ru'), nonce: 'n' });
      expect(en, name).toContain('<html lang="en">');
      expect(ru, name).toContain('<html lang="ru">');
      expect(ru, name).toMatch(/[А-Яа-я]/);
      expect(en, name).not.toMatch(/<h1>[^<]*[А-Яа-я]/);
      expect(() => JSON.parse(/const T = (\{.*\});/.exec(ru)[1]), name).not.toThrow();
      expect(ru, name).toContain('Powered by');
    }
    expect(renderLoginPage({ locale: 'en', l: l('en') })).toContain('Wrong username or password.');
    expect(renderLoginPage({ locale: 'ru', l: l('ru') })).toContain('Неверный логин или пароль.');
    expect(renderResetPasswordPage({ locale: 'ru', l: l('ru') })).toContain('Пароль слишком короткий.');
  });

  it('no hard-coded English is left inside the scripts of the Russian pages', () => {
    const ru = Object.values(pages).map((r) => r({ locale: 'ru', l: l('ru') })).join('\n');
    const script = scriptOf(ru);
    for (const phrase of ['Wrong username', 'Invalid code', 'Too many attempts', 'do not match', 'not acceptable']) expect(script).not.toContain(phrase);
  });

  it('the title carries the application name, escaped once; the brand block and the paths are the caller\'s', () => {
    const html = renderLoginPage({ locale: 'en', l: l('en'), appName: 'My <App>', brand: { html: '<b id="brandmark">x</b>' }, homePath: '/home', passwordChangePath: '/pw' });
    expect(html).toContain('<title>Sign in — My &lt;App&gt;</title>');
    expect(html).toContain('<b id="brandmark">x</b>');
    expect(html).toContain('"/pw"');
    expect(html).toContain('"/home"');
  });

  it('a reworded text replaces only its own key', () => {
    const html = renderLoginPage({ locale: 'en', l: l('en', { en: { loginTitle: 'Welcome back' } }) });
    expect(html).toContain('<h1>Welcome back</h1>');
    expect(html).toContain('Forgot your password?');
  });
});

describe('the account page', () => {
  const args = { user: { username: 'ann' }, authenticators: [{ id: 1, name: null, status: 'active' }, { id: 2, name: 'Phone', status: 'pending' }], mfaRequiredForRole: true, nonce: 'n' };

  it('renders Russian and English with their own words', () => {
    const ru = renderAccountBody({ ...args, l: l('ru') });
    const en = renderAccountBody({ ...args, l: l('en') });
    expect(ru).toContain('Смена пароля');
    expect(ru).toContain('Без названия');
    expect(ru).toContain('ожидает подтверждения');
    expect(en).toContain('Change password');
    expect(en).toContain('Unnamed');
    expect(en).toContain('pending confirmation');
    for (const phrase of ['Wrong current', 'Password changed', 'E-mail saved', 'Wrong code', 'Cannot remove', 'manual entry']) expect(scriptOf(ru)).not.toContain(phrase);
    expect(JSON.parse(/const T = (\{.*\});/.exec(ru)[1]).pwWrong).toBe('Неверный текущий пароль.');
  });

  it('has an interface block: language links and theme buttons that use the shell storage key', () => {
    const ru = renderAccountBody({ ...args, l: l('ru'), locale: 'ru', accountPath: '/ui/account' });
    expect(ru).toContain('Интерфейс');
    expect(ru).toContain('href="/ui/account?lang=en"');
    expect(ru).toContain('<strong>RU</strong>');
    expect(ru).toContain('data-theme-set="dark"');
    expect(ru).toContain("localStorage.setItem('adm-theme'");
    const en = renderAccountBody({ ...args, l: l('en'), locale: 'en' });
    expect(en).toContain('Follow the system');
    expect(en).toContain('<strong>EN</strong>');
  });

  it('has a mini menu with the four parts, each part tagged, working without script', () => {
    const html = renderAccountBody({ ...args, l: l('en') });
    for (const id of ['pw', 'email', 'ui', 'mfa']) {
      expect(html).toContain(`href="#${id}"`);
      expect(html).toContain(`data-acc="${id}"`);
    }
    expect((html.match(/data-acc="mfa"/g) || []).length).toBe(2); // two-factor and recovery codes share a tab
    expect(html).toContain('.acc-js [data-acc]{display:none}'); // hidden only once the script has run
  });

  it('escapes names and statuses it does not know', () => {
    const html = renderAccountBody({ ...args, authenticators: [{ id: 3, name: '<b>x</b>', status: '<i>' }], l: l('en') });
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;i&gt;');
  });
});

describe('password length shown on the pages', () => {
  it('the field limit follows the length the page is given, not a fixed 8', () => {
    const forced = renderForcedPasswordPage({ nonce: 'n', locale: 'en', l: l('en'), minLength: 14 });
    expect(forced.match(/minlength="14"/g)).toHaveLength(2);
    expect(forced).not.toContain('minlength="8"');
    expect(forced).not.toContain('{min}'.replace('{min}', '8 char'));
    const account = renderAccountBody({ user: { username: 'ann', role: 'operator' }, authenticators: [], nonce: 'n', l: l('en'), locale: 'en', minLength: 14 });
    expect(account).toContain('minlength="14"');
  });

  it('the texts carry a {min} placeholder in both languages', () => {
    for (const lng of ['ru', 'en']) for (const k of ['forcedNewPassword', 'accountPwNew']) expect(ACCOUNT_TEXTS[lng][k]).toContain('{min}');
  });
});
