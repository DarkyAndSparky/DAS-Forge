import { pageParams, pagerFor } from './paging.js';
import { pickTexts } from '../i18n/overrides.js';
import { timeHtml } from '../ui/time.js';
import { readForm } from './sections.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const ALERT_TEXTS = {
  ru: {
    title: 'Алерты', hint: 'Сбои и подозрительные события: упавшие задачи и копии, нарушенная цепочка аудита, волна блокировок входа, ошибки диагностики. Повтор того же алерта не рассылается заново, а увеличивает счётчик.',
    time: 'Время', severity: 'Важность', alert: 'Событие', repeats: 'Повторов', mail: 'Письмо',
    info: 'инфо', warning: 'предупреждение', critical: 'критично',
    sent: 'отправлено', notSent: 'не отправлено', empty: 'Алертов нет.',
    action: 'Действия', acked: 'квитировано', ack: 'Квитировать', muteFor: 'Заглушить на', mute1h: '1 час', mute1d: '1 сутки', mute7d: '7 суток', muted: 'заглушено', mutesTitle: 'Действующие заглушки', unmute: 'Снять', until: 'до', escalated: 'эскалировано', done: 'Готово',
    noContacts: 'Адреса для писем не заданы (security.incidentContacts) или почта выключена: алерты видны здесь и в логе.',
  },
  en: {
    title: 'Alerts', hint: 'Failures and suspicious events: failed jobs and backups, a broken audit chain, a wave of sign-in lock-outs, diagnostics errors. A repeat of the same alert is not mailed again; it raises a counter.',
    time: 'Time', severity: 'Severity', alert: 'Event', repeats: 'Repeats', mail: 'E-mail',
    info: 'info', warning: 'warning', critical: 'critical',
    sent: 'sent', notSent: 'not sent', empty: 'No alerts.',
    action: 'Actions', acked: 'acknowledged', ack: 'Acknowledge', muteFor: 'Mute for', mute1h: '1 hour', mute1d: '1 day', mute7d: '7 days', muted: 'muted', mutesTitle: 'Active mutes', unmute: 'Lift', until: 'until', escalated: 'escalated', done: 'Done',
    noContacts: 'No recipients (security.incidentContacts) or e-mail is off: alerts are shown here and in the log.',
  },
};

/** "Alerts" admin section: the newest alerts, one row each. */
export function mountAlertsSection({ app, guard, page: render, basePath, localeOf, texts = {}, stepUp = [], alerts, mailConfigured = false }) {
  const p = `${basePath}/alerts`;
  const actions = (a, l) => {
    const ack = a.ackedAt ? `<span class="adm-muted">${esc(l.acked)}${a.ackedBy ? `: ${esc(a.ackedBy)}` : ''}</span>` : `<form method="post" action="${p}/ack" style="display:inline"><input type="hidden" name="id" value="${esc(a.id)}"><button class="adm-btn" type="submit">${esc(l.ack)}</button></form>`;
    const mute = `<form method="post" action="${p}/mute" style="display:inline-flex;gap:.25rem;margin-left:.5rem"><input type="hidden" name="key" value="${esc(a.key)}"><select class="adm-input" name="hours" aria-label="${esc(l.muteFor)}"><option value="1">${esc(l.mute1h)}</option><option value="24">${esc(l.mute1d)}</option><option value="168">${esc(l.mute7d)}</option></select><button class="adm-btn" type="submit">${esc(l.muteFor)}</button></form>`;
    return `${ack}${mute}`;
  };

  app.get(p, ...guard, (req, res) => {
    const l = pickTexts(ALERT_TEXTS, texts['admin-alerts'], localeOf(req), 'admin-alerts');
    const pg = pageParams(req);
    const list = alerts.list({ limit: pg.size, offset: pg.offset });
    const alertTotal = alerts.count();
    const rows = list.map((a) => `<tr><td>${timeHtml(a.createdAt, localeOf(req))}</td><td><span class="adm-badge ${a.severity === 'critical' ? 'danger' : a.severity === 'warning' ? 'warn' : 'info'}">${esc(l[a.severity] ?? a.severity)}</span></td><td><strong>${esc(a.title)}</strong><div class="adm-muted">${esc(a.message)}</div></td><td>${a.repeats ? esc(a.repeats) : '<span class="adm-muted">—</span>'}</td><td>${esc(a.notified ? l.sent : l.notSent)}${a.notifyError ? ` <span class="adm-muted">(${esc(a.notifyError)})</span>` : ''}${a.muted ? ` <span class="adm-badge">${esc(l.muted)}</span>` : ''}${a.escalatedAt ? ` <span class="adm-badge warn">${esc(l.escalated)}</span>` : ''}</td><td>${actions(a, l)}</td></tr>`).join('');
    const mutes = alerts.mutes();
    const muteBox = mutes.length ? `<div class="adm-card"><h2>${esc(l.mutesTitle)}</h2><table class="adm-table"><tbody>${mutes.map((m) => `<tr><td><code>${esc(m.key)}</code></td><td>${esc(l.until)} ${timeHtml(m.until, localeOf(req))}</td><td><form method="post" action="${p}/unmute"><input type="hidden" name="key" value="${esc(m.key)}"><button class="adm-btn" type="submit">${esc(l.unmute)}</button></form></td></tr>`).join('')}</tbody></table></div>` : '';
    const toast = req.query?.msg === 'ok' ? `<div class="adm-toast">${esc(l.done)}</div>` : '';
    const note = mailConfigured ? '' : `<p class="adm-muted">${esc(l.noContacts)}</p>`;
    render(req, res, {
      active: p, title: l.title,
      bodyHtml: `${toast}<p class="adm-muted">${esc(l.hint)}</p>${note}${muteBox}${rows ? `<div class="adm-card"><table class="adm-table"><thead><tr><th>${esc(l.time)}</th><th>${esc(l.severity)}</th><th>${esc(l.alert)}</th><th>${esc(l.repeats)}</th><th>${esc(l.mail)}</th><th>${esc(l.action)}</th></tr></thead><tbody data-paged="alerts">${rows}</tbody></table>${pagerFor({ req, res, path: p, name: 'alerts', ...pg, count: list.length, total: alertTotal, locale: localeOf(req) })}</div>` : `<p>${esc(l.empty)}</p>`}`,
    });
  });


  app.post(`${p}/ack`, ...guard, ...stepUp, async (req, res, next) => {
    try {
      const form = await readForm(req);
      alerts.ack(Number(form.id), req.user?.username ?? null);
      res.redirect(303, `${p}?msg=ok`);
    } catch (err) { next(err); }
  });

  app.post(`${p}/mute`, ...guard, ...stepUp, async (req, res, next) => {
    try {
      const form = await readForm(req);
      const hours = [1, 24, 168].includes(Number(form.hours)) ? Number(form.hours) : 1;
      alerts.mute(String(form.key ?? '').slice(0, 120), hours * 3_600_000, req.user?.username ?? null);
      res.redirect(303, `${p}?msg=ok`);
    } catch (err) { next(err); }
  });

  app.post(`${p}/unmute`, ...guard, ...stepUp, async (req, res, next) => {
    try {
      const form = await readForm(req);
      alerts.unmute(String(form.key ?? '').slice(0, 120));
      res.redirect(303, `${p}?msg=ok`);
    } catch (err) { next(err); }
  });
}
