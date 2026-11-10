/**
 * App-level overrides of core texts, without i18next. Namespaces are the ones listed by `i18n.coreNamespaces()`.
 * Only the keys given replace the built-in text; everything else stays.
 *
 *   i18n.setTextOverrides({ 'admin-audit': { en: { audit: 'Journal' } }, errors: { ru: { 404: { title: 'Нет такой страницы' } } } });
 *
 * applies to the whole process (admin, error pages, policy pages, e-mails). `createAdmin({ texts })` adds overrides
 * for the admin only and wins over the process-wide ones.
 */
let GLOBAL = {};

/** Replaces the process-wide overrides (`{}` clears them). */
export function setTextOverrides(map = {}) {
  GLOBAL = map && typeof map === 'object' ? map : {};
}

/** The process-wide override bundle `{ru?, en?}` of a namespace, if any. */
export function getTextOverrides(ns) {
  return GLOBAL[ns];
}

/**
 * @param {{ru: object, en: object}} builtin
 * @param {{ru?: object, en?: object}|undefined} override - local (wins over the process-wide one)
 * @param {'ru'|'en'} locale
 * @param {string} [ns] - namespace, to include the process-wide overrides
 */
export function pickTexts(builtin, override, locale, ns) {
  const lng = locale === 'en' ? 'en' : 'ru';
  const base = builtin[lng] ?? {};
  const global = ns ? GLOBAL[ns]?.[lng] : undefined;
  const local = override?.[lng];
  return global || local ? { ...base, ...global, ...local } : base;
}
