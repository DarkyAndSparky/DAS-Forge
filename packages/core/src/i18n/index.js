/**
 * Translations for every DAS-Forge app, on top of i18next (the de-facto standard: namespaces, interpolation with
 * escaping, plural rules via Intl.PluralRules, fallback language). i18next is imported lazily - when a module is
 * actually built, never at import time (same rule as the other heavy dependencies, audit D03).
 *
 * Resources are plain objects `{ ru: {key: 'text'}, en: {key: 'text'} }` per namespace. The core registers its own
 * namespace(s); an app adds its own with `addNamespace`. `missingKeys()` lists keys that exist in one language only,
 * which a test can assert to be empty - an untranslated string can no longer slip through silently.
 */

export const DEFAULT_LOCALES = ['ru', 'en'];
export { coreNamespaces } from './catalog.js';
export { setTextOverrides, getTextOverrides, pickTexts } from './overrides.js';

async function loadI18next() {
  try {
    const mod = await import('i18next');
    return mod.default ?? mod;
  } catch (err) {
    throw new Error(`i18next is not installed (npm install i18next): ${err?.message ?? err}`);
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Flattens `{a:{b:'x'}}` to `{ 'a.b': 'x' }` so completeness can be compared key by key. */
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

/**
 * @param {object} [opts]
 * @param {string[]} [opts.locales=['ru','en']]
 * @param {string} [opts.defaultLocale='ru'] - used when a locale is unknown; also the fallback language
 * @param {Record<string, Record<string, object>>} [opts.namespaces] - `{ core: { ru: {...}, en: {...} } }`
 * @param {object} [opts.i18next] - the i18next module (tests inject a stand-in)
 */
export async function createI18n({ locales = DEFAULT_LOCALES, defaultLocale = 'ru', namespaces = {}, i18next } = {}) {
  const lib = i18next ?? (await loadI18next());
  const { api, ready } = build(lib, { locales, defaultLocale, namespaces, sync: false });
  await ready;
  return api;
}

/**
 * The same instance, built synchronously, for code that cannot await at start-up (page renderers called from
 * synchronous factories). The i18next module must be passed in (`import i18next from 'i18next'`): resources are
 * given inline, so i18next initialises at once (`initAsync: false`). Throws when it did not.
 */
export function createI18nSync({ locales = DEFAULT_LOCALES, defaultLocale = 'ru', namespaces = {}, i18next } = {}) {
  if (!i18next) throw new TypeError('createI18nSync: pass the i18next module (import i18next from "i18next")');
  const { api, instance } = build(i18next, { locales, defaultLocale, namespaces, sync: true });
  if (instance.isInitialized === false) throw new Error('createI18nSync: i18next did not initialise synchronously');
  return api;
}

function build(lib, { locales, defaultLocale, namespaces, sync }) {
  if (!locales.includes(defaultLocale)) throw new TypeError('createI18n: defaultLocale must be one of locales');
  const instance = lib.createInstance();
  const registry = new Map(); // ns -> { [locale]: flat object }

  const resources = {};
  for (const lng of locales) resources[lng] = {};
  for (const [ns, bundles] of Object.entries(namespaces)) {
    registry.set(ns, {});
    for (const lng of locales) {
      resources[lng][ns] = bundles?.[lng] ?? {};
      registry.get(ns)[lng] = flatten(bundles?.[lng]);
    }
  }
  const nsList = Object.keys(namespaces);

  const ready = instance.init({
    lng: defaultLocale,
    fallbackLng: defaultLocale,
    supportedLngs: locales,
    ns: nsList.length ? nsList : ['core'],
    defaultNS: nsList[0] ?? 'core',
    resources,
    // interpolated values are HTML-escaped (i18next default), which is what server-rendered pages need
    interpolation: { escapeValue: true },
    returnNull: false,
    // an empty translation counts as missing and falls back (the default since i18next 27; stated so it cannot drift)
    returnEmptyString: false,
    ...(sync ? { initAsync: false } : {}),
  });

  const normalize = (locale) => (locales.includes(locale) ? locale : defaultLocale);

  const api = {
    locales,
    defaultLocale,
    normalize,

    /** `t(locale, 'ns:key', {vars})`; unknown locales use the default, unknown keys come back as the key. */
    t(locale, key, vars) {
      return instance.getFixedT(normalize(locale))(key, vars);
    },

    /** A translator bound to one locale, for templates: `const t = i18n.translator('en')`. */
    translator(locale, ns) {
      return instance.getFixedT(normalize(locale), ns);
    },

    /** Adds (or extends) a namespace, e.g. an app's own texts. */
    addNamespace(ns, bundles) {
      if (!registry.has(ns)) registry.set(ns, {});
      for (const lng of locales) {
        const flat = flatten(bundles?.[lng]);
        registry.get(ns)[lng] = { ...(registry.get(ns)[lng] ?? {}), ...flat };
        instance.addResourceBundle(lng, ns, bundles?.[lng] ?? {}, true, true);
      }
      return api;
    },

    /** Keys present in some languages but not all: `[{ ns, key, missingIn: ['en'] }]`. Empty = fully translated. */
    missingKeys() {
      const out = [];
      for (const [ns, perLocale] of registry) {
        const all = new Set(locales.flatMap((l) => Object.keys(perLocale[l] ?? {})));
        for (const key of [...all].sort()) {
          const missingIn = locales.filter((l) => !(key in (perLocale[l] ?? {})) || perLocale[l][key] === '');
          if (missingIn.length) out.push({ ns, key, missingIn });
        }
      }
      return out;
    },

    /**
     * Express middleware: `req.t(key, vars)` / `res.locals.t` for the request's locale (`req.locale`, set by
     * `ui.localeMiddleware`). Mount it after that middleware.
     */
    middleware() {
      return (req, res, next) => {
        const locale = normalize(req.locale);
        const t = instance.getFixedT(locale);
        req.t = t;
        req.i18n = api;
        if (res.locals) {
          res.locals.t = t;
          res.locals.locale = locale;
        }
        next();
      };
    },
  };
  return { api, instance, ready };
}
