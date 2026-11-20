/**
 * Admin / app theme: one small stylesheet built on semantic tokens (`--adm-*`), no framework, no
 * external fonts or CDN (works in a closed network, passes the CSP). Light and dark come from
 * `prefers-color-scheme` and can be forced with `data-theme="light|dark|contrast"` on <html> (the toggle in
 * the shell stores the choice in localStorage). `contrast` is the high-contrast theme for low vision: black and white with
 * a yellow accent, every text pair above 7:1 (WCAG AAA), thick borders and focus ring, underlined links, no motion. It is
 * also what the system's own request (`prefers-contrast: more`) gets while the user has not chosen a theme. An app's
 * `tokens` never reach it: a brand colour must not weaken it.
 *
 * Each application brings its own look WITHOUT forking the core CSS:
 *   - `tokens`: { accent: '#c9a24b', surface: 'var(--void-1)' } overrides tokens (applies to both
 *     schemes; use `darkTokens` for dark-only overrides);
 *   - `cssUrl`: the app's own stylesheet, loaded AFTER the base one, may override the tokens or
 *     anything else.
 * Token values are validated: they cannot carry `;`, braces or markup (a theme is configuration,
 * but a value that breaks out of the declaration would be CSS/markup injection).
 */

import { uiTexts } from './texts.js';

export const THEME_TOKENS = {
  light: {
    bg: '#f4f5f7', surface: '#ffffff', 'surface-2': '#f8f9fb', border: '#dfe2e8', text: '#1b1f27', 'text-dim': '#5a6372',
    accent: '#2f6fdd', 'accent-text': '#ffffff', ok: '#1a8f4c', warn: '#b7791f', danger: '#c62f3b', info: '#1f7fa8',
    nav: '#ffffff', 'nav-text': '#3a4252', 'nav-active': '#2f6fdd',
  },
  dark: {
    bg: '#101216', surface: '#181b21', 'surface-2': '#1e222a', border: '#2c313b', text: '#e7e9ee', 'text-dim': '#9aa2b0',
    accent: '#5b9bff', 'accent-text': '#0b1220', ok: '#4cc27d', warn: '#e0a63a', danger: '#ef6670', info: '#4fb3d9',
    nav: '#0c0e12', 'nav-text': '#b4b9c4', 'nav-active': '#f0975c',
  },
  // High contrast: contrast against `bg` is 21:1 for text, 15.9:1 for dim text, 9.6:1 or more for every status colour.
  contrast: {
    bg: '#000000', surface: '#000000', 'surface-2': '#0d0d0d', border: '#ffffff', text: '#ffffff', 'text-dim': '#e0e0e0',
    accent: '#ffd400', 'accent-text': '#000000', ok: '#5cff8f', warn: '#ffd400', danger: '#ff8f8f', info: '#6fdcff',
    nav: '#000000', 'nav-text': '#ffffff', 'nav-active': '#ffd400',
  },
};

/** Everything the high-contrast theme changes beyond colours; `sel` is the selector prefix that switches it on. */
const contrastRules = (sel) => `${sel} a{text-decoration:underline;text-underline-offset:.15em;text-decoration-thickness:2px}
${sel} *,${sel} *::before,${sel} *::after{transition:none!important;animation:none!important;text-shadow:none!important;box-shadow:none!important}
${sel} :focus-visible{outline:3px solid var(--adm-accent)!important;outline-offset:2px!important}
${sel} .adm-card,${sel} .adm-btn,${sel} .adm-input,${sel} .adm-theme-btn,${sel} dialog.adm-dialog,${sel} .adm-content input,${sel} .adm-content select,${sel} .adm-content textarea{border:2px solid var(--adm-border)!important}
${sel} .adm-nav a.nav-item.active{background:transparent;outline:2px solid var(--adm-nav-active);outline-offset:-2px}
${sel} .adm-content th,${sel} .adm-content td{border-bottom:1px solid var(--adm-border)}
${sel} ::selection{background:var(--adm-accent);color:var(--adm-accent-text)}
`;


const KEY = /^[a-z0-9-]{1,40}$/;
const VALUE = /^[#a-zA-Z0-9\s().,%/_'"+-]{1,200}$/;
// A token is a colour/size/font, never a resource: url(), image-set(), expression() would let a value
// load something from another host (tracking, exfiltration) even without `;` or braces.
const FORBIDDEN_VALUE = /url\s*\(|image-set\s*\(|expression\s*\(|@import/i;
// The app's own stylesheet: a path on this host or an https URL; no `javascript:`/`data:`/protocol-relative.
const CSS_URL = /^(?:\/(?!\/)|https:\/\/)[^\s"'<>\\]*$/;

function declarations(tokens) {
  return Object.entries(tokens)
    .map(([k, v]) => {
      if (!KEY.test(k)) throw new TypeError(`theme: invalid token name "${k}"`);
      if (typeof v !== 'string' || !VALUE.test(v) || FORBIDDEN_VALUE.test(v)) throw new TypeError(`theme: invalid value for token "${k}"`);
      return `--adm-${k}:${v};`;
    })
    .join('');
}

/** `:root` rules for the default tokens plus the app's overrides. */
export function tokenCss({ tokens = {}, darkTokens = {} } = {}) {
  const light = declarations({ ...THEME_TOKENS.light, ...tokens });
  const dark = declarations({ ...THEME_TOKENS.dark, ...tokens, ...darkTokens });
  const contrast = declarations(THEME_TOKENS.contrast); // not overridable, on purpose
  return (
    `:root{color-scheme:light dark;${light}}` +
    `@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${dark}}}` +
    `:root[data-theme="dark"]{color-scheme:dark;${dark}}` +
    `:root[data-theme="light"]{color-scheme:light;${light}}` +
    // The system asks for more contrast and the user has not picked a theme: give it the high-contrast one.
    `@media (prefers-contrast:more){:root:not([data-theme]){color-scheme:dark;${contrast}}}` +
    `:root[data-theme="contrast"]{color-scheme:dark;${contrast}}`
  );
}

/** Component styles (shell, cards, tables, badges, buttons, forms, dialog, toast). Uses only tokens. */
export const BASE_CSS = `
*{box-sizing:border-box}
html{scrollbar-gutter:stable;scroll-padding-top:4.5rem}
@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}
html:has(dialog:modal){overflow:hidden}
dialog.adm-dialog{overscroll-behavior:contain}
:where(.adm) img{max-width:100%;height:auto;aspect-ratio:var(--adm-img-ratio,auto);object-fit:var(--adm-img-fit,fill);object-position:var(--adm-img-position,50% 50%)}
body.adm{margin:0;font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--adm-bg);color:var(--adm-text);display:flex;min-height:100vh}
.adm a{color:var(--adm-accent)}
.adm h1,.adm h2,.adm h3{line-height:1.25}
.adm-nav{width:230px;flex-shrink:0;background:var(--adm-nav);color:var(--adm-nav-text);padding:.75rem 0;overflow-y:auto;border-right:1px solid var(--adm-border);position:sticky;top:0;height:100vh}
.adm-skip{position:absolute;left:-999px;top:0;z-index:1000;padding:.5rem .9rem;background:var(--adm-accent,#2563eb);color:#fff;border-radius:0 0 6px 0;text-decoration:none}
.adm-skip:focus{left:0}
.adm-nav .adm-brand{padding:.25rem 1rem .9rem;font-weight:600;display:flex;align-items:center;gap:.5rem}
.adm-nav .adm-brand svg,.adm-nav .adm-brand img{height:28px;width:auto}
.adm-nav a.nav-item{display:block;margin:2px .5rem;padding:.5rem .75rem;color:inherit;text-decoration:none;border-radius:6px;transition:background .12s}
.adm-nav a.nav-item:hover{background:rgba(127,127,127,.14)}
.adm-nav a.nav-item.active{background:color-mix(in srgb,var(--adm-nav-active) 16%,transparent);color:var(--adm-nav-active);font-weight:600}
.adm-nav a.nav-item:focus-visible,.adm-btn:focus-visible,.adm-input:focus-visible,.adm-content input:focus-visible,.adm-content select:focus-visible,.adm-content textarea:focus-visible,.adm-content button:focus-visible{outline:2px solid var(--adm-accent);outline-offset:2px}
.adm-main{flex:1;min-width:0;display:flex;flex-direction:column}
.adm-top{display:flex;align-items:center;flex-wrap:wrap;gap:.5rem .75rem;padding:.6rem 1.5rem;background:var(--adm-surface);border-bottom:1px solid var(--adm-border);position:sticky;top:0;z-index:5}
.adm-top h1{font-size:1.05rem;margin:0;flex:1 1 12rem;min-width:0;overflow-wrap:anywhere}
.adm-top .adm-user{color:var(--adm-text-dim);text-decoration:none}
.adm-top a.adm-user:hover{color:var(--adm-accent);text-decoration:underline}
.adm-top .adm-logout{font:inherit;cursor:pointer;background:transparent;color:var(--adm-accent);border:1px solid var(--adm-accent);border-radius:6px;padding:0 .7rem;height:34px;box-sizing:border-box}
.adm-top .adm-logout:hover{background:var(--adm-accent);color:var(--adm-on-accent,#fff)}
.adm-nav .adm-brand-link{display:flex;align-items:center;gap:.5rem;color:inherit;text-decoration:none}
.adm-nav .adm-area{padding:0 1rem .6rem;font-size:.7rem;letter-spacing:.08em;text-transform:uppercase;color:var(--adm-accent)}
.adm-content{padding:1.5rem;flex:1;width:100%;max-width:1200px}
.adm-content h1{font-size:1.5rem;margin:.2rem 0 1rem}
.adm-content h2{font-size:1.15rem;margin:1.75rem 0 .6rem}
.adm-content h3{font-size:1rem;margin:1.25rem 0 .5rem}
.adm-content>p:first-child{color:var(--adm-text-dim)}
.adm-content input:not([type=checkbox]):not([type=radio]):not([type=file]),.adm-content select,.adm-content textarea{font:inherit;padding:.4rem .65rem;border-radius:6px;border:1px solid var(--adm-border);background:var(--adm-surface);color:var(--adm-text);max-width:100%}
.adm-content input:focus,.adm-content select:focus,.adm-content textarea:focus{border-color:var(--adm-accent)}
[hidden]{display:none!important}
.adm-content button,.adm-btn{font:inherit;padding:.4rem .9rem;border-radius:6px;border:1px solid var(--adm-border);background:var(--adm-surface);color:var(--adm-text);cursor:pointer;transition:border-color .12s,background .12s,box-shadow .12s;box-shadow:0 1px 0 rgba(0,0,0,.04)}
.adm-content button:hover,.adm-btn:hover{border-color:var(--adm-accent);background:var(--adm-surface-2)}
.adm-content button:active,.adm-btn:active{transform:translateY(1px)}
.adm-content button:disabled,.adm-btn:disabled{opacity:.5;cursor:not-allowed}
.adm-btn.primary,.adm-content button[type=submit]:not(.adm-btn){background:var(--adm-accent);border-color:var(--adm-accent);color:var(--adm-accent-text)}
.adm-btn.primary:hover,.adm-content button[type=submit]:not(.adm-btn):hover{filter:brightness(1.08);background:var(--adm-accent)}
.adm-btn.danger{border-color:var(--adm-danger);color:var(--adm-danger)}
.adm-btn.danger.solid{background:var(--adm-danger);color:#fff}
.adm-content form{margin:.5rem 0}
.adm-content label{margin-right:.4rem}
.adm-content ul{padding-left:1.25rem}
.adm-content pre,.adm-content code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.9em}
.adm-content pre{background:var(--adm-surface-2);border:1px solid var(--adm-border);border-radius:8px;padding:.75rem;overflow:auto}
.adm-grid{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.adm-card{background:var(--adm-surface);border:1px solid var(--adm-border);border-radius:10px;padding:1rem 1.1rem;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.adm-card h2{font-size:.8rem;text-transform:uppercase;letter-spacing:.04em;color:var(--adm-text-dim);margin:0 0 .6rem}
.adm-bar{height:6px;border-radius:3px;background:var(--adm-border);margin-top:.6rem;overflow:hidden}
.adm-bar span{display:block;height:100%;background:var(--adm-accent)}
.adm-bar.near span{background:var(--adm-warn)}
.adm-bar.over span{background:var(--adm-danger)}
.adm-stat{font-size:1.8rem;font-weight:600;line-height:1.1}
table,table.adm-table{width:100%;border-collapse:collapse}
.adm-content table{background:var(--adm-surface);border:1px solid var(--adm-border);border-radius:8px;overflow:hidden}
.adm-table th,.adm-table td,.adm-content th,.adm-content td{padding:.5rem .75rem;text-align:left;border-bottom:1px solid var(--adm-border);vertical-align:top}
.adm-table th,.adm-content th{font-size:.8rem;color:var(--adm-text-dim);font-weight:600;background:var(--adm-surface-2)}
a.adm-btn{text-decoration:none}
.adm-scroll{overflow-x:auto;max-width:100%}
.adm-scroll>table{min-width:36rem}
.adm-empty{padding:1.25rem .75rem;text-align:center;color:var(--adm-text-dim)}
.adm-filters{display:flex;gap:.75rem;flex-wrap:wrap;align-items:flex-end;margin-bottom:1rem}
.adm-filters .adm-field{margin-bottom:0;flex:1 1 10rem;min-width:0;max-width:20rem}
.adm-filters .adm-field .adm-input{width:100%}
.adm-filters .adm-btn{flex:none}
.adm-filters .adm-input,.adm-filters .adm-btn{height:2.4rem;box-sizing:border-box}
.adm-filters .adm-btn{display:inline-flex;align-items:center}
.adm-content input[type=file]::file-selector-button{font:inherit;margin-right:.6rem;padding:.35rem .8rem;border-radius:6px;border:1px solid var(--adm-border);background:var(--adm-surface-2);color:var(--adm-text);cursor:pointer}
.adm-table tbody tr:hover,.adm-content tbody tr:hover{background:var(--adm-surface-2)}
.adm-badge{display:inline-block;padding:.1rem .5rem;border-radius:999px;font-size:.75rem;border:1px solid currentColor}
.adm-badge.ok{color:var(--adm-ok)}.adm-badge.warn{color:var(--adm-warn)}.adm-badge.danger{color:var(--adm-danger)}.adm-badge.info{color:var(--adm-info)}
.adm-input{font:inherit;padding:.4rem .65rem;border-radius:6px;border:1px solid var(--adm-border);background:var(--adm-surface);color:var(--adm-text)}
.adm-field{display:flex;flex-direction:column;gap:.25rem;margin-bottom:.75rem}
.adm-field .adm-error{color:var(--adm-danger);font-size:.8rem}
dialog.adm-dialog{background:var(--adm-surface);color:var(--adm-text);border:1px solid var(--adm-border);border-radius:14px;padding:1.4rem 1.5rem 1.2rem;width:min(440px,calc(100vw - 2rem));box-shadow:0 20px 50px rgba(0,0,0,.35);animation:adm-pop .14s ease-out}
dialog.adm-dialog h2{margin:0 0 .5rem;font-size:1.1rem}
dialog.adm-dialog p{margin:0 0 1rem;color:var(--adm-text);white-space:pre-line}
dialog.adm-chart-dialog{width:min(1100px,calc(100vw - 2rem))}
[data-chart] svg{cursor:zoom-in}
.adm-bell{position:relative;text-decoration:none;font-size:1.15rem;padding:.2rem .4rem;border-radius:6px}
.adm-bell:hover,.adm-bell:focus-visible{background:rgba(127,127,127,.14)}
.adm-bell-count{position:absolute;top:-.25rem;right:-.2rem;min-width:1.1rem;padding:0 .25rem;border-radius:999px;background:var(--adm-danger);color:#fff;font-size:.65rem;line-height:1.1rem;text-align:center;font-weight:700}
.adm-search{margin:.5rem .75rem}
.adm-search input{width:100%;box-sizing:border-box;padding:.4rem .6rem;border:1px solid var(--adm-border);border-radius:6px;background:var(--adm-bg);color:inherit;font:inherit;font-size:.85rem}
.adm-nav-group{margin:1rem 1rem .25rem;font-size:.7rem;letter-spacing:.06em;text-transform:uppercase;color:var(--adm-text-dim)}
.adm-chart-open{float:right;background:none;border:0;color:var(--adm-text-dim);font-size:1rem;cursor:pointer;padding:0 .25rem;line-height:1}
.adm-chart-open:hover,.adm-chart-open:focus-visible{color:var(--adm-accent)}
.adm-tip{position:fixed;z-index:1000;pointer-events:none;padding:.25rem .5rem;border-radius:6px;background:var(--adm-text);color:var(--adm-surface);font-size:.8rem;line-height:1.25;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.25)}
.adm-hit:hover{fill:var(--adm-accent);fill-opacity:.12}
dialog.adm-dialog::backdrop{background:rgba(10,12,16,.55);backdrop-filter:blur(2px)}
.adm-dialog-actions{display:flex;justify-content:flex-end;gap:.6rem;margin-top:1rem}
@keyframes adm-pop{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}}
.adm-toast{position:fixed;right:1rem;bottom:1rem;background:var(--adm-surface);border:1px solid var(--adm-border);border-left:4px solid var(--adm-accent);padding:.6rem .9rem;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.25)}
.adm-muted{color:var(--adm-text-dim)}
.adm-foot{padding:0 1.5rem 5rem;font-size:.85rem}
@media (max-width:760px){body.adm{flex-direction:column}.adm-nav{width:auto;height:auto;position:static;display:flex;flex-wrap:wrap;padding:.25rem;border-right:0;border-bottom:1px solid var(--adm-border)}.adm-content{padding:1rem}}
${contrastRules(':root[data-theme="contrast"]')}@media (prefers-contrast:more){${contrastRules(':root:not([data-theme])')}}
`;

/** Icon button for the theme toggle (light -> dark -> high contrast); which icon shows follows <html data-theme>. */
/** Logo switching for light/dark (kept here so the UI layer has no dependency on branding). */
const LOGO_CSS_INLINE = `
.adm-logo{max-height:34px;max-width:160px;width:auto;object-fit:contain}
.adm-logo-dark{display:none}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .adm-logo-dark{display:inline}:root:not([data-theme="light"]) .adm-logo-light{display:none}}
:root[data-theme="dark"] .adm-logo-dark,:root[data-theme="contrast"] .adm-logo-dark{display:inline}:root[data-theme="dark"] .adm-logo-light,:root[data-theme="contrast"] .adm-logo-light{display:none}
@media (prefers-contrast:more){:root:not([data-theme]) .adm-logo-dark{display:inline}:root:not([data-theme]) .adm-logo-light{display:none}}
`;

/** The "Powered by" line (ui/powered-by.js): small, muted, the core's mark switches with the theme. */
export const CREATED_BY_CSS = `
.adm-created{display:inline-flex;align-items:center;gap:.4rem;font-size:.78rem;color:var(--adm-text-dim);text-decoration:none}
a.adm-created:hover{color:var(--adm-text)}
.adm-created-logo{height:16px;width:auto;display:block}
.adm-created-dark{display:none}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .adm-created-dark{display:block}:root:not([data-theme="light"]) .adm-created-light{display:none}}
:root[data-theme="dark"] .adm-created-dark,:root[data-theme="contrast"] .adm-created-dark{display:block}:root[data-theme="dark"] .adm-created-light,:root[data-theme="contrast"] .adm-created-light{display:none}
@media (prefers-contrast:more){:root:not([data-theme]) .adm-created-dark{display:block}:root:not([data-theme]) .adm-created-light{display:none}}
`;

/** Logo switching for light/dark pages that have no shell (exported for the error and maintenance pages). */
export const LOGO_CSS = LOGO_CSS_INLINE;

export const THEME_BUTTON_CSS = `
.adm-theme-btn{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;padding:0;border-radius:8px;border:1px solid var(--adm-border);background:var(--adm-surface);color:var(--adm-text);cursor:pointer}
.adm-theme-btn:hover{border-color:var(--adm-accent)}
.adm-theme-btn svg{width:18px;height:18px;display:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
:root:not([data-theme]) .adm-theme-btn .i-light,:root[data-theme="light"] .adm-theme-btn .i-light,:root[data-theme="dark"] .adm-theme-btn .i-dark,:root[data-theme="contrast"] .adm-theme-btn .i-contrast{display:block}
@media (prefers-color-scheme:dark){:root:not([data-theme]) .adm-theme-btn .i-light{display:none}:root:not([data-theme]) .adm-theme-btn .i-dark{display:block}}
@media (prefers-contrast:more){:root:not([data-theme]) .adm-theme-btn .i-light,:root:not([data-theme]) .adm-theme-btn .i-dark{display:none}:root:not([data-theme]) .adm-theme-btn .i-contrast{display:block}}
`;


/** The toggle button markup (two inline SVG icons, no fonts). `locale` only picks the tooltip language. */
export function themeToggleHtml(locale = 'ru') {
  const title = escapeAttr(uiTexts(locale).themeToggle);
  return `<button type="button" class="adm-theme-btn" data-adm-theme-toggle title="${title}" aria-label="${title}"><svg class="i-light" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg><svg class="i-dark" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg><svg class="i-contrast" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 3v18a9 9 0 0 0 0-18z" fill="currentColor"/></svg></button>`;
}

/** Toggle: light, then dark, then high contrast, then light again (the system choice is made on the account page), remembered in localStorage (never required to work). */
export const THEME_SCRIPT = `(function(){var r=document.documentElement;try{var s=localStorage.getItem('adm-theme');if(s==='light'||s==='dark'||s==='contrast')r.setAttribute('data-theme',s)}catch(e){}
document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('[data-adm-theme-toggle]');if(!b)return;var m=function(q){return window.matchMedia&&matchMedia(q).matches};var c=r.getAttribute('data-theme')||(m('(prefers-contrast: more)')?'contrast':m('(prefers-color-scheme: dark)')?'dark':'light');var n=c==='light'?'dark':c==='dark'?'contrast':'light';
r.setAttribute('data-theme',n);try{localStorage.setItem('adm-theme',n)}catch(e){}})})();`;

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * <style> (tokens + components) and, when `cssUrl` is given, the app's own stylesheet after it.
 * @param {{tokens?: object, darkTokens?: object, cssUrl?: string, nonce?: string}} [theme]
 */
export function themeHead(theme = {}) {
  const css = tokenCss(theme) + BASE_CSS + THEME_BUTTON_CSS + LOGO_CSS_INLINE + CREATED_BY_CSS;
  if (css.includes('</style')) throw new TypeError('theme: invalid CSS');
  if (theme.cssUrl && !CSS_URL.test(theme.cssUrl)) throw new TypeError('theme: cssUrl must be a path or an https URL');
  const link = theme.cssUrl ? `\n  <link rel="stylesheet" href="${escapeAttr(theme.cssUrl)}">` : '';
  const n = theme.nonce ? ` nonce="${escapeAttr(theme.nonce)}"` : '';
  return `<style${n}>${css}</style>${link}\n  <script${n}>${THEME_SCRIPT}</script>`;
}
