import { readForm } from '../admin/sections.js';

const esc = (str) => String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const TEXTS = {
  ru: { title: 'Уведомления', none: 'Новых уведомлений нет.', markAll: 'Отметить все прочитанными', mark: 'Прочитано', open: 'Открыть', bell: 'Уведомления', unread: 'непрочитанных', sev: { info: 'Информация', warning: 'Внимание', critical: 'Важно' } },
  en: { title: 'Notifications', none: 'No notifications.', markAll: 'Mark all as read', mark: 'Mark as read', open: 'Open', bell: 'Notifications', unread: 'unread', sev: { info: 'Info', warning: 'Warning', critical: 'Important' } },
};

/** The bell for the page header: a link to the notifications page with the unread count. Trusted markup. */
export function bellHtml({ url, count, locale = 'ru' }) {
  const t = TEXTS[locale] ?? TEXTS.ru;
  const n = Math.max(0, Number(count) || 0);
  return `<a class="adm-bell" href="${esc(url)}" aria-label="${esc(`${t.bell}: ${n} ${t.unread}`)}" title="${esc(t.bell)}">🔔${n ? `<span class="adm-bell-count">${n > 99 ? '99+' : n}</span>` : ''}</a>`;
}

/** The page body: the user's newest notifications, unread first marked, with "read" buttons. */
export function notificationsBodyHtml({ items, basePath, locale = 'ru' }) {
  const t = TEXTS[locale] ?? TEXTS.ru;
  const unread = items.filter((i) => !i.readAt).length;
  const row = (i) => `<li class="adm-card" style="margin-bottom:.6rem;${i.readAt ? 'opacity:.65;' : `border-left:4px solid var(--adm-${i.severity === 'critical' ? 'danger' : i.severity === 'warning' ? 'warn' : 'accent'});`}">
    <strong>${esc(i.title)}</strong> <span class="adm-badge ${i.severity === 'critical' ? 'danger' : i.severity === 'warning' ? 'warn' : 'info'}">${esc(t.sev[i.severity] ?? i.severity)}</span>
    ${i.body ? `<div class="adm-muted">${esc(i.body)}</div>` : ''}
    <div class="adm-muted" style="font-size:.8rem">${esc(i.createdAt.replace('T', ' ').slice(0, 16))}</div>
    <div style="margin-top:.4rem">${i.link ? `<a class="adm-btn" href="${esc(i.link)}">${esc(t.open)}</a> ` : ''}${i.readAt ? '' : `<form method="post" action="${esc(basePath)}/read" style="display:inline"><input type="hidden" name="id" value="${i.id}"><button class="adm-btn" type="submit">${esc(t.mark)}</button></form>`}</div>
  </li>`;
  return `${unread ? `<form method="post" action="${esc(basePath)}/read" style="margin-bottom:1rem"><button class="adm-btn primary" type="submit">${esc(t.markAll)}</button></form>` : ''}${items.length ? `<ul style="list-style:none;padding:0">${items.map(row).join('')}</ul>` : `<p class="adm-muted">${esc(t.none)}</p>`}`;
}

/**
 * Mounts the page and the "read" action. The application owns its page frame, so it passes `render`.
 * @param {object} app - Express app
 * @param {object} o
 * @param {object} o.notifications - createNotifications() result
 * @param {Function} o.requireAuth - the application's login guard factory result, e.g. `requireAuth()`
 * @param {(req, res, {title: string, bodyHtml: string}) => void} o.render - sends the framed page
 * @param {string} [o.basePath='/ui/notifications']
 * @param {Array<{key: string, label: {ru: string, en: string}}>} [o.categories] - what the user can switch on/off (e.g. security, system); empty = no settings form
 * @param {(req) => 'ru'|'en'} [o.localeOf]
 */
export const PREF_TEXTS = {
  ru: { heading: 'Какие уведомления получать', save: 'Сохранить', levels: { off: 'Не получать', info: 'Все', warning: 'Важные и критичные', critical: 'Только критичные' } },
  en: { heading: 'Which notifications to receive', save: 'Save', levels: { off: 'None', info: 'All', warning: 'Important and critical', critical: 'Critical only' } },
};

/** The per-category settings form. `categories` is `[{key, label: {ru,en}}]`. */
export function prefsFormHtml({ categories, prefs, basePath, locale = 'ru' }) {
  const t = PREF_TEXTS[locale] ?? PREF_TEXTS.ru;
  if (!categories?.length) return '';
  const rows = categories.map((c) => {
    const cur = prefs[c.key] ?? 'info';
    const opts = Object.entries(t.levels).map(([v, l]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`).join('');
    return `<label style="display:flex;gap:.6rem;align-items:center;margin:.4rem 0"><span style="min-width:12rem">${esc(c.label?.[locale] ?? c.label?.ru ?? c.key)}</span><select name="c_${esc(c.key)}">${opts}</select></label>`;
  }).join('');
  return `<form class="adm-card" method="post" action="${esc(basePath)}/prefs" style="margin-top:1.5rem"><h3>${esc(t.heading)}</h3>${rows}<button class="adm-btn primary" type="submit">${esc(t.save)}</button></form>`;
}

export function mountNotificationsPage(app, { notifications, requireAuth, render, basePath = '/ui/notifications', categories = [], localeOf = (req) => (req.locale === 'en' ? 'en' : 'ru') }) {
  app.get(basePath, requireAuth, (req, res) => {
    const locale = localeOf(req);
    const t = TEXTS[locale] ?? TEXTS.ru;
    render(req, res, { title: t.title, bodyHtml: notificationsBodyHtml({ items: notifications.list(req.user.id, { limit: 100 }), basePath, locale })
      + prefsFormHtml({ categories, prefs: notifications.prefs(req.user.id), basePath, locale }) });
  });
  app.post(`${basePath}/prefs`, requireAuth, async (req, res) => {
    const form = await readForm(req);
    for (const c of categories) if (form[`c_${c.key}`] !== undefined) notifications.setPref(req.user.id, c.key, String(form[`c_${c.key}`]));
    res.redirect(303, basePath);
  });
  app.post(`${basePath}/read`, requireAuth, async (req, res) => {
    const id = (await readForm(req)).id;
    if (id !== undefined && id !== '') notifications.markRead(req.user.id, id); else notifications.markAllRead(req.user.id);
    res.redirect(303, basePath);
  });
}
