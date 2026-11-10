import { DEFAULT_TEXTS, KINDS, PLATFORM_LICENSE, MIT_TEXT } from './defaults.js';
import { renderPolicyText } from './render.js';
import { pickTexts } from '../i18n/overrides.js';
import { themeHead } from '../ui/theme.js';
import { langSwitchHtml } from '../ui/lang-switch.js';
import { uiTexts } from '../ui/texts.js';
import { themeToggleHtml } from '../ui/theme.js';
import { resolveLocale } from '../http/error-catalog.js';
import { readDependencies } from '../admin/sections-ops.js';
import { readForm } from '../admin/sections.js';
import { log } from '../audit/log.js';
import { contextFromRequest } from '../audit/context.js';
export { DEFAULT_TEXTS, KINDS, PLATFORM_LICENSE, MIT_TEXT } from './defaults.js';
export { renderPolicyText } from './render.js';

const COOKIE = 'das_consent';
const MAX_BODY = 100_000;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const UI = {
  ru: {
    banner: 'Мы используем только необходимые cookie для работы входа. Дополнительные — только с вашего согласия.',
    accept: 'Принять', decline: 'Отказаться', more: 'Подробнее', policy: 'Политика использования', cookies: 'Cookie', license: 'Лицензионное соглашение', components: 'Компоненты и лицензии',
    compTitle: 'Компоненты и лицензии', pkg: 'Пакет', version: 'Версия', licenseCol: 'Лицензия', copyleft: 'копилефт',
    compIntro: 'Платформа и приложение построены на открытых компонентах. Компоненты с лицензиями GPL/LGPL/AGPL (отмечены) используются на условиях этих лицензий; полные тексты — по ссылкам.',
    licenseTexts: 'Тексты лицензий',
  },
  en: {
    banner: 'We use only the cookies needed for sign-in. Additional ones only with your consent.',
    accept: 'Accept', decline: 'Decline', more: 'Learn more', policy: 'Usage policy', cookies: 'Cookies', license: 'Licence agreement', components: 'Components and licences',
    compTitle: 'Components and licences', pkg: 'Package', version: 'Version', licenseCol: 'Licence', copyleft: 'copyleft',
    compIntro: 'The platform and the application are built on open-source components. Components under GPL/LGPL/AGPL licences (marked) are used under those licences; full texts are linked.',
    licenseTexts: 'Licence texts',
  },
};

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function safeBack(v) {
  const s = String(v ?? '/');
  return /^\/(?![/\\])[^\s\u0000-\u001f]{0,500}$/.test(s) ? s : '/';
}

export function ensurePolicyTable(db) {
  // A table made before the licence agreement existed only allows two kinds: rebuild it once, keeping the rows.
  const old = db.get(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'policy_texts'`)?.sql;
  if (old && !old.includes("'license'")) {
    db.exec('BEGIN');
    try {
      db.exec('ALTER TABLE policy_texts RENAME TO policy_texts_old');
      db.exec(`CREATE TABLE policy_texts (
    locale TEXT NOT NULL CHECK (locale IN ('ru','en')),
    kind TEXT NOT NULL CHECK (kind IN ('usage','cookies','license')),
    body TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT,
    PRIMARY KEY (locale, kind)
  )`);
      db.exec('INSERT INTO policy_texts SELECT locale, kind, body, updated_at, updated_by FROM policy_texts_old');
      db.exec('DROP TABLE policy_texts_old');
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS policy_texts (
    locale TEXT NOT NULL CHECK (locale IN ('ru','en')),
    kind TEXT NOT NULL CHECK (kind IN ('usage','cookies','license')),
    body TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT,
    PRIMARY KEY (locale, kind)
  )`);
}

/**
 * Policy pages + cookie notice, one entry point for the platform and every app:
 *   GET /policy, /policy/cookies, /policy/components (public), POST /consent (accept|decline).
 *   Texts: platform defaults (ru/en), replaceable per application in the admin section.
 *   `bannerHtml(req,res)` / `pageEnd(req,res)` are inserted by the shell, error pages and admin pages.
 *
 * @param {object} o
 * @param {object} o.db
 * @param {string} [o.appName='DAS-Forge']
 * @param {object} [o.theme] - {tokens, darkTokens, cssUrl}
 * @param {{packageJsonPath:string, nodeModulesDir?:string|string[]}[]} [o.dependencySources] - package.json files whose dependencies are listed with their licences
 * @param {string} [o.basePath='/policy']
 * @param {boolean} [o.secureCookie] - force the Secure flag (default: from req.secure)
 */
export function createPolicy({ db, appName = 'DAS-Forge', theme = {}, dependencySources = [], basePath = '/policy', secureCookie, platformCopyright = 'DAS-Forge contributors' } = {}) {
  ensurePolicyTable(db);
  const localeOf = (req) => (req.query?.lang === 'en' ? 'en' : req.query?.lang === 'ru' ? 'ru' : resolveLocale(req, 'ru'));

  function getText(locale, kind) {
    const row = db.get(`SELECT body, updated_at, updated_by FROM policy_texts WHERE locale = ? AND kind = ?`, [locale, kind]);
    if (row) return { body: row.body, custom: true, updatedAt: row.updated_at, updatedBy: row.updated_by };
    return { body: DEFAULT_TEXTS[locale][kind], custom: false, updatedAt: null, updatedBy: null };
  }

  function setText(locale, kind, body, by = null) {
    if (!['ru', 'en'].includes(locale) || !KINDS.includes(kind)) throw new TypeError('policy: bad locale or kind');
    const text = String(body ?? '');
    if (text.trim() === '') throw new TypeError('policy: empty text (use reset to return to the default)');
    if (text.length > MAX_BODY) throw new TypeError(`policy: text is longer than ${MAX_BODY} characters`);
    db.run(
      `INSERT INTO policy_texts (locale, kind, body, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(locale, kind) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      [locale, kind, text, new Date().toISOString(), by]
    );
  }

  function resetText(locale, kind) {
    return Number(db.run(`DELETE FROM policy_texts WHERE locale = ? AND kind = ?`, [locale, kind]).changes);
  }

  /** 'accepted' | 'declined' | null (no choice yet). */
  function consentOf(req) {
    const v = parseCookies(req.headers?.cookie)[COOKIE];
    return v === 'accepted' || v === 'declined' ? v : null;
  }

  function links(locale) {
    const u = pickTexts(UI, undefined, locale, 'policy-ui');
    return `<nav aria-label="${esc(u.policy)}" style="margin:1.5rem 0 .5rem;font-size:.85rem;display:flex;gap:1rem;flex-wrap:wrap"><a href="${basePath}?lang=${locale}">${esc(u.policy)}</a><a href="${basePath}/cookies?lang=${locale}">${esc(u.cookies)}</a><a href="${basePath}/license?lang=${locale}">${esc(u.license)}</a><a href="${basePath}/components?lang=${locale}">${esc(u.components)}</a></nav>`;
  }

  function bannerHtml(req, res, locale = localeOf(req)) {
    if (consentOf(req)) return '';
    const u = pickTexts(UI, undefined, locale, 'policy-ui');
    const back = esc(safeBack(req.originalUrl ?? req.url ?? '/'));
    const form = (choice, label, primary) => `<form method="post" action="/consent" style="display:inline"><input type="hidden" name="back" value="${back}"><input type="hidden" name="choice" value="${choice}"><button type="submit" style="font:inherit;padding:.35rem .9rem;border-radius:6px;cursor:pointer;border:1px solid var(--adm-border,#888);background:${primary ? 'var(--adm-accent,#2f6fdd)' : 'var(--adm-surface-2,#eee)'};color:${primary ? 'var(--adm-accent-text,#fff)' : 'var(--adm-text,#111)'}">${esc(label)}</button></form>`;
    return `<aside role="region" aria-label="Cookies" style="position:fixed;left:0;right:0;bottom:0;z-index:1000;display:flex;gap:.75rem 1rem;flex-wrap:wrap;align-items:center;justify-content:center;padding:.75rem 1rem;background:var(--adm-surface,#fff);color:var(--adm-text,#111);border-top:1px solid var(--adm-border,#ccc);font:14px/1.4 system-ui,sans-serif;text-align:left"><span>${esc(u.banner)} <a href="${basePath}/cookies?lang=${locale}">${esc(u.more)}</a></span>${form('declined', u.decline, false)}${form('accepted', u.accept, true)}</aside>`;
  }

  /** Footer links + banner, for the `bodyEnd`/`bodyEndHtml` slots of shell, error pages and admin pages. */
  function pageEnd(req, res, locale = localeOf(req)) {
    return links(locale) + bannerHtml(req, res, locale);
  }

  function dependencyRows() {
    const rows = [];
    for (const src of dependencySources) {
      try { rows.push(...readDependencies(src)); } catch { /* unreadable package.json: skip */ }
    }
    const seen = new Set();
    return rows.filter((r) => (seen.has(r.name) ? false : seen.add(r.name))).sort((a, b) => a.name.localeCompare(b.name));
  }

  function publicPage(req, res, { title, bodyHtml, locale }) {
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(`<!DOCTYPE html>
<html lang="${locale}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
${themeHead({ ...theme, nonce: res.locals?.cspNonce })}
<style>body{display:block}.pol{max-width:820px;margin:0 auto;padding:1.5rem 1rem 6rem}.pol h1{font-size:1.5rem}.pol h2{font-size:1.1rem;margin-top:1.5rem}.pol code{background:var(--adm-surface-2);padding:0 .25rem;border-radius:3px}.pol table{width:100%}</style>
</head>
<body class="adm"><main class="pol"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem"><a href="/">← ${esc(uiTexts(locale).back)}</a><span style="display:flex;gap:.5rem;align-items:center">${langSwitchHtml(locale)}${themeToggleHtml(locale)}</span></div>${bodyHtml}${pageEnd(req, res, locale)}</main></body></html>`);
  }

  function mount(app) {
    const textPage = (kind) => (req, res) => {
      const locale = localeOf(req);
      const { body } = getText(locale, kind);
      // the licence page: the platform's fixed part first, then the application owner's editable agreement
      const platform = kind === 'license' ? `<article>${renderPolicyText(PLATFORM_LICENSE[locale])}<pre style="white-space:pre-wrap;font-family:inherit;font-size:.9rem">${esc(MIT_TEXT.replace('{{holder}}', platformCopyright))}</pre></article><hr style="margin:2rem 0">` : '';
      publicPage(req, res, { title: pickTexts(UI, undefined, locale, 'policy-ui')[kind === 'usage' ? 'policy' : kind], locale, bodyHtml: `${platform}<article>${renderPolicyText(body, { app: appName })}</article>` });
    };
    app.get(basePath, textPage('usage'));
    app.get(`${basePath}/cookies`, textPage('cookies'));
    app.get(`${basePath}/license`, textPage('license'));
    app.get(`${basePath}/components`, (req, res) => {
      const locale = localeOf(req);
      const u = pickTexts(UI, undefined, locale, 'policy-ui');
      const rows = dependencyRows().map((d) => {
        const lic = d.license ?? '—';
        const copyleft = /GPL/i.test(lic);
        const lk = /^[A-Za-z0-9.+-]+$/.test(lic) ? `<a href="https://spdx.org/licenses/${esc(lic)}.html" rel="noopener noreferrer" target="_blank">${esc(lic)}</a>` : esc(lic);
        return `<tr><td>${esc(d.name)}</td><td>${esc(d.installed ?? '')}</td><td>${lk}${copyleft ? ` <span class="adm-badge warn">${esc(u.copyleft)}</span>` : ''}</td></tr>`;
      }).join('');
      publicPage(req, res, {
        title: u.compTitle, locale,
        bodyHtml: `<h1>${esc(u.compTitle)}</h1><p>${esc(u.compIntro)}</p><p>${esc(u.licenseTexts)}: <a href="https://www.gnu.org/licenses/gpl-3.0.html" rel="noopener noreferrer" target="_blank">GPL-3.0</a>, <a href="https://www.gnu.org/licenses/lgpl-3.0.html" rel="noopener noreferrer" target="_blank">LGPL-3.0</a>, <a href="https://www.gnu.org/licenses/agpl-3.0.html" rel="noopener noreferrer" target="_blank">AGPL-3.0</a>, <a href="https://spdx.org/licenses/MIT.html" rel="noopener noreferrer" target="_blank">MIT</a>, <a href="https://www.apache.org/licenses/LICENSE-2.0" rel="noopener noreferrer" target="_blank">Apache-2.0</a></p><table class="adm-table"><thead><tr><th>${esc(u.pkg)}</th><th>${esc(u.version)}</th><th>${esc(u.licenseCol)}</th></tr></thead><tbody>${rows}</tbody></table>`,
      });
    });
    app.post('/consent', async (req, res) => {
      const form = await readForm(req);
      const choice = form.choice === 'accepted' ? 'accepted' : form.choice === 'declined' ? 'declined' : null;
      if (choice) {
        const secure = secureCookie ?? Boolean(req.secure);
        res.append?.('Set-Cookie', `${COOKIE}=${choice}; Path=/; Max-Age=${180 * 86400}; SameSite=Lax${secure ? '; Secure' : ''}`);
        if (!res.append) res.setHeader('Set-Cookie', `${COOKIE}=${choice}; Path=/; Max-Age=${180 * 86400}; SameSite=Lax${secure ? '; Secure' : ''}`);
      }
      res.redirect(303, safeBack(form.back));
    });
  }

  /** Admin section "Политики" (called by createAdmin when `policy` is passed). */
  function mountAdmin({ app, guard, page, basePath: adminBase, localeOf: adminLocale, db: adb, stepUp = [] }) {
    const p = `${adminBase}/policy`;
    const T = {
      ru: { language: 'Язык текстов', title: 'Политики', usage: 'Политика использования', cookies: 'Cookie', license: 'Лицензионное соглашение', save: 'Сохранить', reset: 'Вернуть шаблон', file: 'Загрузить из файла (.md, .txt)', custom: 'свой текст', def: 'шаблон платформы', upd: 'обновлено', hint: 'Разметка: # заголовок, ## раздел, - пункт списка, **жирный**, [текст](ссылка), {{app}} — название приложения. HTML не поддерживается.', done: 'Готово', bad: 'Не сохранено', open: 'Открыть страницу' },
      en: { language: 'Language of the texts', title: 'Policies', usage: 'Usage policy', cookies: 'Cookies', license: 'Licence agreement', save: 'Save', reset: 'Restore template', file: 'Load from file (.md, .txt)', custom: 'custom text', def: 'platform template', upd: 'updated', hint: 'Markup: # heading, ## section, - list item, **bold**, [text](link), {{app}} = application name. HTML is not supported.', done: 'Done', bad: 'Not saved', open: 'Open page' },
    };
    app.get(p, ...guard, (req, res) => {
      const locale = adminLocale(req);
      const t = T[locale];
      const nonce = res.locals?.cspNonce ? ` nonce="${esc(res.locals.cspNonce)}"` : '';
      const msg = req.query?.msg === 'ok' ? `<div class="adm-toast">${esc(t.done)}</div>` : req.query?.msg === 'bad' ? `<div class="adm-toast" style="border-left-color:var(--adm-danger)">${esc(t.bad)}</div>` : '';
      const shown = req.query?.textlang === 'ru' || req.query?.textlang === 'en' ? req.query.textlang : locale;
      const tabs = `<nav style="display:flex;gap:.5rem;margin:.75rem 0" aria-label="${esc(t.language)}">${['ru', 'en'].map((l2) => `<a class="adm-btn${l2 === shown ? ' primary' : ''}" href="${p}?textlang=${l2}"${l2 === shown ? ' aria-current="page"' : ''}>${l2.toUpperCase()}</a>`).join('')}</nav>`;
      const blocks = [shown].flatMap((loc) => KINDS.map((kind) => {
        const cur = getText(loc, kind);
        const id = `t-${loc}-${kind}`;
        return `<div class="adm-card" style="margin-bottom:1rem"><h2>${esc(t[kind])} — ${loc.toUpperCase()} <span class="adm-badge ${cur.custom ? 'info' : ''}">${esc(cur.custom ? t.custom : t.def)}</span>${cur.updatedAt ? ` <span class="adm-muted">${esc(t.upd)}: ${esc(cur.updatedAt)} ${esc(cur.updatedBy ?? '')}</span>` : ''}</h2>
<form method="post" action="${p}/save"><input type="hidden" name="locale" value="${loc}"><input type="hidden" name="kind" value="${kind}">
<textarea id="${id}" name="body" class="adm-input" rows="12" style="width:100%;font-family:ui-monospace,monospace" maxlength="${MAX_BODY}">${esc(cur.body)}</textarea>
<p style="margin:.5rem 0"><button class="adm-btn primary" type="submit">${esc(t.save)}</button> <label class="adm-btn" style="display:inline-block">${esc(t.file)}<input type="file" accept=".md,.txt,text/plain" data-load="${id}" style="display:none"></label> <a href="${basePath}${kind === 'usage' ? '' : `/${kind}`}?lang=${loc}" target="_blank" rel="noopener">${esc(t.open)}</a></p></form>
<form method="post" action="${p}/reset"><input type="hidden" name="locale" value="${loc}"><input type="hidden" name="kind" value="${kind}"><button class="adm-btn danger" type="submit" data-confirm="${esc(t.reset)}?">${esc(t.reset)}</button></form></div>`;
      })).join('');
      const script = `<script${nonce}>document.addEventListener('change',function(e){var i=e.target;if(!i.dataset||!i.dataset.load||!i.files||!i.files[0])return;var f=i.files[0];if(f.size>${MAX_BODY}){alert('>${MAX_BODY}');return}var r=new FileReader();r.onload=function(){document.getElementById(i.dataset.load).value=String(r.result)};r.readAsText(f,'utf-8')});</script>`;
      page(req, res, { active: p, title: t.title, bodyHtml: `${msg}<p class="adm-muted">${esc(t.hint)}</p>${tabs}${blocks}${script}` });
    });
    app.post(`${p}/save`, ...guard, ...stepUp, async (req, res) => {
      const form = await readForm(req, MAX_BODY + 4096);
      try {
        setText(form.locale, form.kind, form.body, req.user?.username ?? null);
        log(adb, { ...contextFromRequest(req), action: 'admin.policy.save', entity: 'policy', entityId: `${form.locale}/${form.kind}`, meta: { length: String(form.body).length } });
        res.redirect(303, `${p}?textlang=${form.locale === 'en' ? 'en' : 'ru'}&msg=ok`);
      } catch { res.redirect(303, `${p}?textlang=${form.locale === 'en' ? 'en' : 'ru'}&msg=bad`); }
    });
    app.post(`${p}/reset`, ...guard, ...stepUp, async (req, res) => {
      const form = await readForm(req);
      if (!['ru', 'en'].includes(form.locale) || !KINDS.includes(form.kind)) return res.redirect(303, `${p}?msg=bad`);
      resetText(form.locale, form.kind);
      log(adb, { ...contextFromRequest(req), action: 'admin.policy.reset', entity: 'policy', entityId: `${form.locale}/${form.kind}` });
      res.redirect(303, `${p}?textlang=${form.locale}&msg=ok`);
    });
  }

  return { mount, mountAdmin, getText, setText, resetText, consentOf, bannerHtml, pageEnd, basePath };
}

export { UI as POLICY_UI_TEXTS };
