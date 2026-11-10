import { langSwitchHtml } from './lang-switch.js';
import { themeHead, themeToggleHtml } from './theme.js';
import { modalScript } from './modal.js';
import { TIME_SCRIPT } from './time.js';
import { uiTexts } from './texts.js';
import { poweredByHtml } from './powered-by.js';

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * This is the actual consumer the core/modules §11c TODO note was
 * waiting on: "navigation/routes/translations/search are stored, not
 * yet consumed - wire up when @das-forge/ui exists". This IS that
 * wiring - deliberately minimal (a plain server-rendered nav + content
 * slot, no client framework, no design system), because the honest
 * alternative to "don't build a facade" is "build the smallest real
 * thing", not "build the entire §5.4 aspirational UI framework in one
 * pass". A richer AppShell (client-side routing mounting `routes[].
 * component`, a design system, etc.) is real future work, not faked
 * here.
 *
 * `routes[].component` (also stored by core/modules) has nothing to
 * mount it yet - there is no client-side component registry/bundler
 * wired into core. This shell therefore treats a navigation item's
 * `path` as a server route the app itself has registered a handler for
 * (same as examples/workshop/src/routes.js does), not as a client
 * route - consistent with core/http being a plain Express server, not
 * an SPA host.
 *
 * Navigation items are filtered by `permission` using the same
 * zero-trust default as core/http's serialize(): an item with no
 * `permission` is visible to everyone, one WITH a permission is hidden
 * unless the viewer has it - fail closed, not open.
 *
 * @param {object} opts
 * @param {{getNavigation: () => Array, getTranslations: () => object}} opts.moduleRegistry
 * @param {string[]} [opts.viewerPermissions]
 * @param {'ru'|'en'} [opts.locale='ru']
 * @param {string} [opts.activePath] - highlights the matching nav item
 * @param {string} [opts.title='DAS-Forge']
 * @param {string} [opts.bodyHtml=''] - pre-rendered content for the main slot;
 *   the caller's own route handler is responsible for producing this and
 *   for escaping anything inside it that isn't already trusted markup
 * @param {string} [opts.bellHtml] - trusted markup for the notifications bell in the page header (see notifications.bellHtml)
 * @param {string} [opts.userBadge] - the account type (e.g. the role) shown as a small badge beside the user name
 * @param {string} [opts.navTopHtml] - trusted markup at the top of the menu (e.g. a search box)
 * @param {string} [opts.bannerHtml] - trusted markup above the page header, e.g. `announcement.bannerHtml(locale, { nonce })`
 * @param {Array<{path: string, label: string|{ru: string, en: string}, permission?: string}>} [opts.extraNav] - app-level links shown after the modules' navigation (a label object is translated by locale)
 * @returns {string} a complete HTML document
 */
export function renderAppShell({
  moduleRegistry,
  viewerPermissions = [],
  locale = 'ru',
  activePath = null,
  title = 'DAS-Forge',
  bodyHtml = '',
  theme = {},
  user = null,
  brandHtml = '',
  nonce,
  bodyEndHtml = '',
  bannerHtml = '',
  navTopHtml = '',
  bellHtml = '',
  userBadge = '',
  extraNav = [],
  homeUrl = '',
  accountUrl = '',
  badge = '',
  showLogout = false,
}) {
  const translations = moduleRegistry.getTranslations ? moduleRegistry.getTranslations() : { ru: {}, en: {} };
  const dict = translations[locale] ?? {};
  const ui = uiTexts(locale);
  const t = (key) => (Object.hasOwn(dict, key) ? dict[key] : key); // untranslated key is a visible, honest fallback, not a blank

  const navItems = [...(moduleRegistry.getNavigation ? moduleRegistry.getNavigation() : []), ...extraNav].filter(
    (item) => !item.permission || viewerPermissions.includes(item.permission)
  );
  const labelOf = (l) => (typeof l === 'object' ? (l[locale] ?? l.ru) : t(l));

  const navHtml = navItems
    .map((item) => {
      // `{ heading: label }` is a group title in the menu, not a link
      if (item.heading) return `<div class="adm-nav-group">${escapeHtml(labelOf(item.heading))}</div>`;
      const active = item.path === activePath;
      return `<a class="nav-item${active ? ' active' : ''}" href="${escapeHtml(item.path)}"${active ? ' aria-current="page"' : ''}>${escapeHtml(typeof item.label === 'object' ? (item.label[locale] ?? item.label.ru) : t(item.label))}</a>`;
    })
    .join('\n      ');

  const n = nonce ? ` nonce="${escapeHtml(nonce)}"` : '';

  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  ${themeHead({ ...theme, nonce })}
</head>
<body class="adm">
  <a class="adm-skip" href="#adm-main">${escapeHtml(ui.skip)}</a>
  <nav class="adm-nav" aria-label="${escapeHtml(ui.mainNav)}">
    ${brandHtml ? `<div class="adm-brand">${homeUrl ? `<a class="adm-brand-link" href="${escapeHtml(homeUrl)}">${brandHtml}</a>` : brandHtml}</div>` : ''}
    ${badge ? `<div class="adm-area">${escapeHtml(badge)}</div>` : ''}
    ${navTopHtml}
    ${navHtml || `<p style="padding:0 1rem;opacity:.6">${escapeHtml(ui.noNav)}</p>`}
  </nav>
  <div class="adm-main">
    ${bannerHtml}
    <header class="adm-top">
      <h1>${escapeHtml(title)}</h1>
      ${bellHtml}
      ${user?.username && userBadge ? `<span class="adm-badge info" title="${escapeHtml(userBadge)}">${escapeHtml(userBadge)}</span>` : ''}
      ${user?.username ? (accountUrl ? `<a class="adm-user" href="${escapeHtml(accountUrl)}">${escapeHtml(user.username)}</a>` : `<span class="adm-user">${escapeHtml(user.username)}</span>`) : ''}
      ${user?.username && showLogout ? `<button type="button" class="adm-logout" id="adm-logout">${escapeHtml(ui.signOut)}</button>` : ''}
      ${langSwitchHtml(locale)}
      ${themeToggleHtml(locale)}
    </header>
    <main class="adm-content" id="adm-main" tabindex="-1">
${bodyHtml}
    </main>
<div class="adm-foot">${bodyEndHtml}<div style="margin-top:1rem">${poweredByHtml(locale)}</div></div>
  </div>
<script${n}>${modalScript()}</script>
<script${n}>${TIME_SCRIPT}</script>
${showLogout ? `<script${n}>document.getElementById('adm-logout')?.addEventListener('click',async(ev)=>{const b=ev.currentTarget;b.disabled=true;try{const r=await fetch('/logout',{method:'POST'});if(!r.ok&&!r.redirected)throw new Error('HTTP '+r.status)}catch(e){b.disabled=false;alert(${JSON.stringify(ui.signOutFailed).replace(/</g, '\\u003c')});return}location.href='/login'})</script>` : ''}
</body>
</html>`;
}
