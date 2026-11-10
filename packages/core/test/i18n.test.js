import { describe, it, expect } from 'vitest';
import { createI18n, createI18nSync } from '../src/i18n/index.js';

/** A tiny stand-in with the i18next surface the module uses (the real package is exercised by the user's npm test). */
function fakeI18next() {
  return {
    createInstance() {
      let opts;
      const store = {};
      const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const lookup = (lng, ns, key) => key.split('.').reduce((o, k) => (o == null ? o : o[k]), store[lng]?.[ns]);
      return {
        async init(o) { opts = o; for (const [l, nss] of Object.entries(o.resources)) store[l] = { ...nss }; },
        addResourceBundle(lng, ns, res) { store[lng] ??= {}; store[lng][ns] = { ...(store[lng][ns] ?? {}), ...res }; },
        getFixedT(lng, ns) {
          return (key, vars = {}) => {
            let useNs = ns ?? opts.defaultNS;
            let k = key;
            if (key.includes(':')) [useNs, k] = key.split(':');
            const v = lookup(lng, useNs, k) ?? lookup(opts.fallbackLng, useNs, k);
            if (typeof v !== 'string') return k;
            return v.replace(/\{\{(\w+)\}\}/g, (_, n) => esc(vars[n] ?? ''));
          };
        },
      };
    },
  };
}

const build = (extra = {}) =>
  createI18n({
    i18next: fakeI18next(),
    namespaces: { core: { ru: { hello: 'Привет, {{name}}', nav: { home: 'Главная' } }, en: { hello: 'Hello, {{name}}', nav: { home: 'Home' } } } },
    ...extra,
  });

describe('createI18n', () => {
  it('translates per locale with nested keys and falls back to the default locale for unknown ones', async () => {
    const i18n = await build();
    expect(i18n.t('en', 'nav.home')).toBe('Home');
    expect(i18n.t('ru', 'nav.home')).toBe('Главная');
    expect(i18n.t('de', 'nav.home')).toBe('Главная');
    expect(i18n.t('en', 'nope')).toBe('nope');
  });

  it('interpolated values are HTML-escaped', async () => {
    const i18n = await build();
    expect(i18n.t('en', 'hello', { name: '<img onerror=x>' })).toBe('Hello, &lt;img onerror=x&gt;');
  });

  it('an app adds its own namespace; missingKeys finds keys that exist in one language only', async () => {
    const i18n = await build();
    expect(i18n.missingKeys()).toEqual([]);
    i18n.addNamespace('app', { ru: { a: 'А', b: 'Б' }, en: { a: 'A' } });
    expect(i18n.t('en', 'app:a')).toBe('A');
    expect(i18n.missingKeys()).toEqual([{ ns: 'app', key: 'b', missingIn: ['en'] }]);
  });

  it('the middleware gives req.t and res.locals.t for req.locale', async () => {
    const i18n = await build();
    const req = { locale: 'en' };
    const res = { locals: {} };
    i18n.middleware()(req, res, () => {});
    expect(req.t('nav.home')).toBe('Home');
    expect(res.locals.t('nav.home')).toBe('Home');
    expect(res.locals.locale).toBe('en');
    const req2 = { locale: 'xx' };
    i18n.middleware()(req2, { locals: {} }, () => {});
    expect(req2.t('nav.home')).toBe('Главная');
  });

  it('rejects a default locale outside the supported ones', async () => {
    await expect(createI18n({ i18next: fakeI18next(), locales: ['ru'], defaultLocale: 'en' })).rejects.toThrow();
  });
});

describe('createI18nSync', () => {
  const namespaces = { app: { ru: { hello: 'Привет, {{name}}' }, en: { hello: 'Hello, {{name}}' } } };

  it('is usable at once, without awaiting, and passes initAsync: false', () => {
    const lib = fakeI18next();
    let seen;
    const orig = lib.createInstance;
    lib.createInstance = () => { const i = orig(); const init = i.init; i.init = (o) => { seen = o; return init(o); }; return i; };
    const i18n = createI18nSync({ i18next: lib, namespaces });
    expect(seen.initAsync).toBe(false);
    expect(i18n.t('en', 'app:hello', { name: '<b>' })).toBe('Hello, &lt;b&gt;');
    expect(i18n.translator('ru', 'app')('hello', { name: 'Я' })).toBe('Привет, Я');
    expect(i18n.missingKeys()).toEqual([]);
  });

  it('needs the i18next module and refuses an instance that did not initialise at once', () => {
    expect(() => createI18nSync({ namespaces })).toThrow(/pass the i18next module/);
    const lib = { createInstance: () => ({ isInitialized: false, init: async () => {}, getFixedT: () => () => '' }) };
    expect(() => createI18nSync({ i18next: lib, namespaces })).toThrow(/did not initialise synchronously/);
  });
});
