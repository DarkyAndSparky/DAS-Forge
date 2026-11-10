import { CORE_IDENTITY } from '../branding/core-identity.js';
import { uiTexts } from './texts.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const imgCache = new Map();

// Where the line leads: the platform's public About page when an app mounts one (about/index.js), else the repository.
let link = null;
/** @param {{href: string, version?: string}|null} l - `null` goes back to the repository link */
export function setPoweredByLink(l) { link = l && typeof l.href === 'string' && l.href.startsWith('/') ? { href: l.href, version: l.version ? String(l.version) : '' } : null; }

/** The core's mark as a data-URI <img> for one theme (cached; empty when the core ships no logo). */
function coreMark(theme) {
  if (!imgCache.has(theme)) {
    let html = '';
    try {
      const logo = CORE_IDENTITY.readLogo(theme);
      if (logo) html = `<img class="adm-created-logo adm-created-${theme}" src="data:${logo.mime};base64,${Buffer.from(logo.contents).toString('base64')}" alt="" height="16">`;
    } catch { /* a missing or unreadable logo only drops the mark */ }
    imgCache.set(theme, html);
  }
  return imgCache.get(theme);
}

/**
 * The small "Powered by DAS-Forge" line with the core's logo (light and dark variants), shown on every
 * page of an app built on the core: sign-in, error and maintenance pages, the shell footer. The styles
 * come with `themeHead()` (and with the error page's own head).
 * @param {'ru'|'en'} [locale]
 */
export function poweredByHtml(locale = 'ru') {
  const text = `${esc(uiTexts(locale).poweredBy)} ${esc(CORE_IDENTITY.name)}${link?.version ? ` ${esc(link.version)}` : ''}`;
  const inner = `${coreMark('light')}${coreMark('dark')}<span>${text}</span>`;
  if (link) return `<a class="adm-created" href="${esc(link.href)}">${inner}</a>`;
  return CORE_IDENTITY.repoUrl
    ? `<a class="adm-created" href="${esc(CORE_IDENTITY.repoUrl)}" target="_blank" rel="noopener">${inner}</a>`
    : `<span class="adm-created">${inner}</span>`;
}
