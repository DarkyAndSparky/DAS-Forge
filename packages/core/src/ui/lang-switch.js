const FLAGS = {
  ru: '<svg viewBox="0 0 24 16" width="24" height="16" aria-hidden="true"><rect width="24" height="5.34" fill="#fff"/><rect y="5.33" width="24" height="5.34" fill="#0039a6"/><rect y="10.66" width="24" height="5.34" fill="#d52b1e"/></svg>',
  en: '<svg viewBox="0 0 24 16" width="24" height="16" aria-hidden="true"><rect width="24" height="16" fill="#012169"/><path d="M0 0l24 16M24 0L0 16" stroke="#fff" stroke-width="3"/><path d="M0 0l24 16M24 0L0 16" stroke="#c8102e" stroke-width="1.2"/><path d="M12 0v16M0 8h24" stroke="#fff" stroke-width="5"/><path d="M12 0v16M0 8h24" stroke="#c8102e" stroke-width="3"/></svg>',
};
import { uiTexts } from './texts.js';

/**
 * One button for the interface language: shows the flag of the CURRENT language, a click switches to the other.
 * Works without JavaScript (a plain link carrying `?lang=`). Returns trusted markup.
 *
 * @param {'ru'|'en'} locale - the language shown now
 * @param {{param?: string, href?: string}} [opts] - query parameter name; href overrides the whole target
 */
export function langSwitchHtml(locale, { param = 'lang', href } = {}) {
  const cur = locale === 'en' ? 'en' : 'ru';
  const next = cur === 'en' ? 'ru' : 'en';
  const ui = uiTexts(cur);
  const title = (cur === 'en' ? ui.switchToRu : ui.switchToEn).replace(/"/g, '&quot;');
  const target = href ?? `?${param}=${next}`;
  return `<a class="lang-switch" href="${target.replace(/"/g, '&quot;')}" title="${title}" aria-label="${title}" style="display:inline-flex;align-items:center;gap:.4rem;box-sizing:border-box;height:34px;padding:0 10px;border:1px solid var(--adm-border,#ccc);border-radius:8px;background:var(--adm-surface,transparent);color:inherit;text-decoration:none;font-size:.8rem;line-height:1">${FLAGS[cur]}<span>${cur.toUpperCase()}</span></a>`;
}
