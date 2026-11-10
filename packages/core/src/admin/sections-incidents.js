import { pickTexts } from '../i18n/overrides.js';
import { IncidentError } from '../privacy/incidents.js';
import { readForm, emptyRow } from './sections.js';
import { pageParams, pagerFor } from './paging.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const INCIDENT_TEXTS = {
  ru: {
    incidents: 'Инциденты',
    hint: 'Журнал инцидентов безопасности. Для инцидента с персональными данными считаются сроки уведомления регулятора от момента обнаружения. Журнал только фиксирует и напоминает, сам ничего не отправляет. Действующие сроки и порядок уведомления сверьте с юристом.',
    declare: 'Зафиксировать инцидент', title: 'Название', description: 'Что произошло', severity: 'Тяжесть', personal: 'Затронуты персональные данные', detected: 'Обнаружен (UTC, пусто — сейчас)',
    sLow: 'Низкая', sMedium: 'Средняя', sHigh: 'Высокая', stOpen: 'Открыт', stNotified: 'Регулятор уведомлён', stClosed: 'Закрыт',
    colId: '№', colTitle: 'Название', colSeverity: 'Тяжесть', colStatus: 'Статус', colDetected: 'Обнаружен', colFirst: 'Первичное уведомление', colDetails: 'Уточнённые сведения', colActions: 'Действия',
    due: 'срок', sent: 'отправлено', overdue: 'просрочено', na: '—', empty: 'Инцидентов нет.',
    update: 'Обновить', firstAt: 'Первичное уведомление отправлено (UTC)', detailsAt: 'Уточнённые сведения отправлены (UTC)', measures: 'Принятые меры', status: 'Статус', save: 'Сохранить', open: 'Подробнее',
    done: 'Сохранено.', bad: 'Не удалось сохранить.',
    e_TITLE_INVALID: 'Название обязательно, до 200 знаков.', e_DESCRIPTION_INVALID: 'Описание — до 4000 знаков.', e_SEVERITY_INVALID: 'Неизвестная тяжесть.', e_DATE_INVALID: 'Дата указана неверно (пример: 2026-11-01T12:00).', e_MEASURES_INVALID: 'Меры — до 4000 знаков.', e_STATUS_INVALID: 'Неизвестный статус.', e_NOT_FOUND: 'Инцидент не найден.',
  },
  en: {
    incidents: 'Incidents',
    hint: 'Register of security incidents. For an incident with personal data the regulator notice deadlines are counted from the moment of detection. The register only records and reminds; it sends nothing itself. Check the current deadlines and procedure with a lawyer.',
    declare: 'Record an incident', title: 'Title', description: 'What happened', severity: 'Severity', personal: 'Personal data is involved', detected: 'Detected (UTC, empty = now)',
    sLow: 'Low', sMedium: 'Medium', sHigh: 'High', stOpen: 'Open', stNotified: 'Regulator notified', stClosed: 'Closed',
    colId: '#', colTitle: 'Title', colSeverity: 'Severity', colStatus: 'Status', colDetected: 'Detected', colFirst: 'First notice', colDetails: 'Details notice', colActions: 'Actions',
    due: 'due', sent: 'sent', overdue: 'overdue', na: '—', empty: 'No incidents.',
    update: 'Update', firstAt: 'First notice sent (UTC)', detailsAt: 'Details sent (UTC)', measures: 'Measures taken', status: 'Status', save: 'Save', open: 'Details',
    done: 'Saved.', bad: 'Could not save.',
    e_TITLE_INVALID: 'A title is required, up to 200 characters.', e_DESCRIPTION_INVALID: 'The description is up to 4000 characters.', e_SEVERITY_INVALID: 'Unknown severity.', e_DATE_INVALID: 'The date is not valid (example: 2026-11-01T12:00).', e_MEASURES_INVALID: 'Measures: up to 4000 characters.', e_STATUS_INVALID: 'Unknown status.', e_NOT_FOUND: 'Incident not found.',
  },
};

const localInput = (iso) => (iso ? String(iso).slice(0, 16) : '');
const fromInput = (v) => { const s = String(v ?? '').trim(); return s ? `${s}${s.length === 16 ? ':00' : ''}Z` : null; };

/** The "Incidents" section: declare, list with notice deadlines, record notices and measures, close. */
export function mountIncidentsSection({ app, guard, page: render, basePath, localeOf, texts = {}, stepUp = [], incidents }) {
  const p = `${basePath}/incidents`;
  const tx = (req) => pickTexts(INCIDENT_TEXTS, texts['admin-incidents'], localeOf(req), 'admin-incidents');
  const actorOf = (req) => req.user?.username ?? null;
  const sev = (l, v) => (v === 'high' ? l.sHigh : v === 'low' ? l.sLow : l.sMedium);
  const sevBadge = (l, v) => `<span class="adm-badge ${v === 'high' ? 'danger' : v === 'low' ? 'info' : 'warn'}">${esc(sev(l, v))}</span>`; // high = red, medium = amber, low = blue
  const st = (l, v) => (v === 'closed' ? l.stClosed : v === 'notified' ? l.stNotified : l.stOpen);
  const dueCell = (l, d, doneAt) => {
    if (!d) return esc(l.na);
    if (doneAt) return `<span class="adm-badge ok">${esc(l.sent)} ${esc(String(doneAt).slice(0, 16))}</span>`;
    return `<span class="adm-badge ${d.overdue ? 'danger' : 'warn'}">${esc(d.overdue ? l.overdue : l.due)} ${esc(d.at.slice(0, 16))}</span>`;
  };
  const toast = (l, req) => (req.query?.msg === 'ok' ? `<div class="adm-toast">${esc(l.done)}</div>` : req.query?.msg === 'bad' ? `<div class="adm-toast" style="border-left-color:var(--adm-danger)">${esc(l[`e_${String(req.query.e ?? '')}`] ?? l.bad)}</div>` : '');
  const field = 'height:2.4rem;box-sizing:border-box';

  app.get(p, ...guard, (req, res) => {
    const l = tx(req);
    const pg = pageParams(req);
    const rows = incidents.list({ limit: pg.size, offset: pg.offset });
    const total = incidents.count();
    const body = rows.length ? rows.map((i) => `<tr><td>${i.id}</td><td><a href="${p}/${i.id}">${esc(i.title)}</a></td><td>${sevBadge(l, i.severity)}</td><td>${esc(st(l, i.status))}</td><td>${esc(i.detectedAt.slice(0, 16))}</td><td>${dueCell(l, i.firstNoticeDue, i.firstNoticeAt)}</td><td>${dueCell(l, i.detailsDue, i.detailsNoticeAt)}</td></tr>`).join('') : emptyRow(7, l.empty);
    const opt = (v, label, cur) => `<option value="${v}"${cur === v ? ' selected' : ''}>${esc(label)}</option>`;
    const form = `<form method="post" action="${p}/declare" class="adm-card" style="display:flex;flex-direction:column;gap:.75rem;max-width:36rem;margin-top:1rem"><h2>${esc(l.declare)}</h2>
<label class="adm-field">${esc(l.title)}<input class="adm-input" name="title" required maxlength="200" style="${field}"></label>
<label class="adm-field">${esc(l.description)}<textarea class="adm-input" name="description" rows="4" maxlength="4000"></textarea></label>
<label class="adm-field">${esc(l.severity)}<select class="adm-input" name="severity" style="${field}">${opt('low', l.sLow)}${opt('medium', l.sMedium, 'medium')}${opt('high', l.sHigh)}</select></label>
<label><input type="checkbox" name="personalData" value="1"> ${esc(l.personal)}</label>
<label class="adm-field">${esc(l.detected)}<input class="adm-input" type="datetime-local" name="detectedAt" style="${field}"></label>
<div><button class="adm-btn primary" type="submit">${esc(l.declare)}</button></div></form>`;
    render(req, res, { active: p, title: l.incidents, bodyHtml: `${toast(l, req)}<div class="adm-card"><p class="adm-muted">${esc(l.hint)}</p></div><div class="adm-card" style="margin-top:1rem;overflow:auto"><table class="adm-table"><thead><tr><th>${esc(l.colId)}</th><th>${esc(l.colTitle)}</th><th>${esc(l.colSeverity)}</th><th>${esc(l.colStatus)}</th><th>${esc(l.colDetected)}</th><th>${esc(l.colFirst)}</th><th>${esc(l.colDetails)}</th></tr></thead><tbody data-paged="incidents">${body}</tbody></table>${pagerFor({ req, res, path: p, name: 'incidents', ...pg, count: rows.length, total, locale: localeOf(req) })}</div>${form}` });
  });

  app.get(`${p}/:id`, ...guard, (req, res) => {
    const l = tx(req);
    const i = incidents.get(req.params.id);
    if (!i) return res.redirect(303, `${p}?msg=bad&e=NOT_FOUND`);
    const opt = (v, label) => `<option value="${v}"${i.status === v ? ' selected' : ''}>${esc(label)}</option>`;
    const sopt = (v, label) => `<option value="${v}"${i.severity === v ? ' selected' : ''}>${esc(label)}</option>`;
    const form = `<form method="post" action="${p}/${i.id}" class="adm-card" style="display:flex;flex-direction:column;gap:.75rem;max-width:36rem;margin-top:1rem">
<label class="adm-field">${esc(l.status)}<select class="adm-input" name="status" style="${field}">${opt('open', l.stOpen)}${opt('notified', l.stNotified)}${opt('closed', l.stClosed)}</select></label>
<label class="adm-field">${esc(l.severity)}<select class="adm-input" name="severity" style="${field}">${sopt('low', l.sLow)}${sopt('medium', l.sMedium)}${sopt('high', l.sHigh)}</select></label>
<label class="adm-field">${esc(l.firstAt)}<input class="adm-input" type="datetime-local" name="firstNoticeAt" value="${esc(localInput(i.firstNoticeAt))}" style="${field}"></label>
<label class="adm-field">${esc(l.detailsAt)}<input class="adm-input" type="datetime-local" name="detailsNoticeAt" value="${esc(localInput(i.detailsNoticeAt))}" style="${field}"></label>
<label class="adm-field">${esc(l.measures)}<textarea class="adm-input" name="measures" rows="5" maxlength="4000">${esc(i.measures)}</textarea></label>
<div><button class="adm-btn primary" type="submit">${esc(l.save)}</button> <a class="adm-btn" href="${p}">${esc(l.incidents)}</a></div></form>`;
    render(req, res, { active: p, title: `${l.incidents} #${i.id}`, bodyHtml: `${toast(l, req)}<div class="adm-card"><h2>${esc(i.title)}</h2><p>${esc(i.description)}</p><p class="adm-muted">${esc(l.detected)}: ${esc(i.detectedAt.slice(0, 16))} · ${esc(l.colFirst)}: ${dueCell(l, i.firstNoticeDue, i.firstNoticeAt)} · ${esc(l.colDetails)}: ${dueCell(l, i.detailsDue, i.detailsNoticeAt)}</p></div>${form}` });
  });

  const fail = (res, err, back, next) => (err instanceof IncidentError ? res.redirect(303, `${back}?msg=bad&e=${encodeURIComponent(err.code)}`) : next(err));

  app.post(`${p}/declare`, ...guard, ...stepUp, async (req, res, next) => {
    try {
      const f = await readForm(req);
      const i = incidents.declare({ title: f.title, description: f.description, severity: String(f.severity ?? 'medium'), personalData: f.personalData === '1', detectedAt: fromInput(f.detectedAt), actor: actorOf(req) });
      res.redirect(303, `${p}/${i.id}?msg=ok`);
    } catch (err) { fail(res, err, p, next); }
  });

  app.post(`${p}/:id`, ...guard, ...stepUp, async (req, res, next) => {
    const back = `${p}/${encodeURIComponent(String(req.params.id).slice(0, 12))}`;
    try {
      const f = await readForm(req);
      const pick = (k) => (f[k] === undefined ? undefined : fromInput(f[k]));
      incidents.update(req.params.id, { status: f.status, severity: f.severity, firstNoticeAt: pick('firstNoticeAt'), detailsNoticeAt: pick('detailsNoticeAt'), measures: f.measures, actor: actorOf(req) });
      res.redirect(303, `${back}?msg=ok`);
    } catch (err) { fail(res, err, back, next); }
  });
}
