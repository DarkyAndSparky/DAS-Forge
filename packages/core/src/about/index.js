import { CORE_VERSION } from '../version.js';
import { CORE_IDENTITY } from '../branding/core-identity.js';
import { pageShell } from '../accounts/pages.js';
import { setPoweredByLink } from '../ui/powered-by.js';

/**
 * The public "About" page (no sign-in): what the platform is, the versions of the core and of the applications on it,
 * the licence, the author and where the sources are. It shows NO runtime details (Node, OS, paths, dependency lists):
 * those stay in the administrator's page. The small "Powered by DAS-Forge <version>" line of every page links here.
 */
const TEXTS = {
  ru: {
    title: 'О платформе', versions: 'Версии', core: 'Ядро', licence: 'Лицензия', author: 'Автор', sources: 'Исходный код', apps: 'Приложения',
    description: 'DAS-Forge — общая платформа для внутренних приложений: вход и права, администрирование, журнал действий, копии, переводы и оформление в одном ядре.',
    mit: 'Лицензия MIT', licenceText: 'Полный текст', back: "← На главную",
  },
  en: {
    title: 'About the platform', versions: 'Versions', core: 'Core', licence: 'Licence', author: 'Author', sources: 'Source code', apps: 'Applications',
    description: 'DAS-Forge is a shared platform for internal applications: sign-in and permissions, administration, an activity journal, backups, translations and branding in one core.',
    mit: 'MIT licence', licenceText: 'Full text', back: "← Home",
  },
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const httpsUrl = (u) => { try { const x = new URL(String(u)); return x.protocol === 'https:' ? x.href : null; } catch { return null; } };
const logoSrc = (u) => { const s = String(u ?? ''); return /^\/(?!\/)[^\s"'<>]*$/.test(s) || httpsUrl(s) ? s : null; };

/**
 * @param {object} app - Express app
 * @param {object} [o]
 * @param {string} [o.path='/about']
 * @param {string} [o.appName] - the application that mounts the page
 * @param {string} [o.appVersion]
 * @param {string} [o.coreVersion] - the core version (default: this core)
 * @param {{ru?: string, en?: string}} [o.description] - replaces the platform description
 * @param {{name: string, url?: string}} [o.author]
 * @param {string} [o.copyright] - holder shown with the licence, e.g. "DAS-Forge contributors"
 * @param {string} [o.licenseUrl] - a page with the full licence text (e.g. `/policy/license`)
 * @param {Array<{name: string, url: string}>} [o.repositories] - defaults to the core's repository
 * @param {Array<{name: string, version?: string, logoUrl?: string, repoUrl?: string, description?: string}>} [o.apps] - the applications of the platform with their own logos (a path of this site or an https address)
 * @param {(req) => object} [o.brand] - `{theme, html}` like the account pages
 * @param {boolean} [o.linkPoweredBy=true] - the "Powered by" line of every page leads here
 */
export function mountAboutPage(app, {
  path = '/about', appName = '', appVersion = '', coreVersion = CORE_VERSION, description = null, author = null, copyright = 'DAS-Forge contributors',
  licenseUrl = null, repositories = null, apps = [], brand = null, linkPoweredBy = true,
} = {}) {
  if (!app || typeof app.get !== 'function') throw new TypeError('mountAboutPage: app is required');
  const repos = (repositories ?? [{ name: CORE_IDENTITY.name, url: CORE_IDENTITY.repoUrl }]).map((r) => ({ name: String(r.name ?? ''), url: httpsUrl(r.url) })).filter((r) => r.name && r.url);
  if (linkPoweredBy) setPoweredByLink({ href: path, version: coreVersion });

  app.get(path, (req, res) => {
    const locale = req.locale === 'en' ? 'en' : 'ru';
    const t = TEXTS[locale];
    const b = brand ? brand(req) ?? {} : {};
    const rows = [[t.core, `DAS-Forge ${coreVersion}`], ...(appName && !apps.some((x) => x.name === appName) ? [[appName, appVersion || '—']] : [])];
    const appList = apps.map((a) => {
      const logo = logoSrc(a.logoUrl);
      const repo = httpsUrl(a.repoUrl);
      return `<li style="display:flex;gap:.75rem;align-items:center;margin:.5rem 0">${logo ? `<img src="${esc(logo)}" alt="" height="32" style="max-width:48px;object-fit:contain">` : ''}<div><strong>${repo ? `<a href="${esc(repo)}" target="_blank" rel="noopener">${esc(a.name)}</a>` : esc(a.name)}</strong> ${esc(a.version ?? '')}${a.description ? `<div class="hint">${esc(a.description)}</div>` : ''}</div></li>`;
    }).join('');
    const authorHtml = author?.name ? (httpsUrl(author.url) ? `<a href="${esc(httpsUrl(author.url))}" target="_blank" rel="noopener">${esc(author.name)}</a>` : esc(author.name)) : '';
    const body = `
      <h1>${esc(t.title)}</h1>
      <p>${esc((description && description[locale]) || t.description)}</p>
      <h2>${esc(t.versions)}</h2>
      <table style="width:100%;border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="padding:.25rem 0">${esc(k)}</td><td style="text-align:right"><strong>${esc(v)}</strong></td></tr>`).join('')}</table>
      ${appList ? `<h2>${esc(t.apps)}</h2><ul style="list-style:none;padding:0;margin:0">${appList}</ul>` : ''}
      <h2>${esc(t.licence)}</h2>
      <p>${esc(t.mit)}, © ${esc(copyright)}${logoSrc(licenseUrl)?.startsWith('/') ? ` · <a href="${esc(licenseUrl)}">${esc(t.licenceText)}</a>` : ''}</p>
      ${authorHtml ? `<h2>${esc(t.author)}</h2><p>${authorHtml}</p>` : ''}
      ${repos.length ? `<h2>${esc(t.sources)}</h2><p>${repos.map((r) => `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a>`).join(' · ')}</p>` : ''}
      <p class="hint"><a href="/">${esc(t.back)}</a></p>`;
    res.type('html').send(pageShell(t.title, body, { nonce: res.locals?.cspNonce, locale, brand: { theme: b.theme, html: b.html }, wide: true }));
  });
}
