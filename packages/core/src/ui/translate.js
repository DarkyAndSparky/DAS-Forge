/**
 * Standalone i18n lookup, for route handlers that need a translated
 * string OUTSIDE the AppShell itself (shell.js has its own inline `t()`
 * for rendering navigation). Same registry, same fallback rule: an
 * untranslated key is returned AS-IS rather than blank or throwing -
 * a visibly-wrong-but-honest string is more useful to notice and fix
 * than a silent gap.
 *
 * @param {{getTranslations: () => {ru: object, en: object}}} moduleRegistry
 * @param {'ru'|'en'} locale
 * @param {string} key
 */
export function translate(moduleRegistry, locale, key) {
  const dict = moduleRegistry.getTranslations()[locale] ?? {};
  return Object.hasOwn(dict, key) ? dict[key] : key;
}
