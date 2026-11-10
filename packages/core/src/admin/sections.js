import { writeCsv } from '../csv/index.js';
import { pageParams, pagerFor, pagerHtml } from './paging.js';
import { query, page, count } from '../audit/query.js';
import { pickTexts } from '../i18n/overrides.js';
import { describeEvent } from '../audit/catalog.js';
import { summarize } from '../audit/summary.js';
import { svgBarChart } from './charts.js';
import { timeHtml } from '../ui/time.js';
import { verifyChain } from '../audit/chain.js';
import { log } from '../audit/log.js';
import { contextFromRequest } from '../audit/context.js';
import { parseDuration } from '../security/bans.js';
import { createDbLastRunStore } from '../scheduler/state.js';

/** One full-width row with a hint for an empty table. */
export const emptyRow = (cols, text) => `<tr><td colspan="${cols}" class="adm-empty">${String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))}</td></tr>`;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const L = {
  ru: {
    live: 'Живая лента: новые события появляются сами', audit: 'Аудит', security: 'Безопасность', summaryTab: 'Сводка', period: 'Период', last24: '24 часа', last7: '7 суток', last30: '30 суток', sEvents: 'Событий', sLogins: 'Входов', sFails: 'Неудачных входов', sLocks: 'Блокировок', sNewDev: 'Новых устройств', sAdmin: 'Действий админов', sActive: 'Вошло человек', sPerDay: 'Входы и неудачи по дням', sTopIps: 'Больше всего неудачных входов: адреса', sTopLogins: 'Больше всего неудачных входов: имена', sTopActions: 'Частые действия', sNone: 'Нет данных', sNote: 'Адреса показаны так, как записаны в журнале (по умолчанию обезличены).', actor: 'Кто', action: 'Действие', summary: 'Что произошло', category: 'Категория', result: 'Результат', since: 'С', until: 'По',
    filter: 'Фильтр', eventCard: 'Событие', fieldName: 'Поле', fieldValue: 'Значение', details: 'Подробности', changed: 'Что изменилось', was: 'Было', became: 'Стало', noDetails: 'Подробностей нет', sameRequest: 'Все события этого запроса', objectHistory: 'История объекта', byActor: 'Действия этого пользователя', back: '← К журналу', hashLbl: 'Хеш записи', prevHashLbl: 'Хеш предыдущей', request: 'Запрос', entityId: 'Номер объекта', today: 'Сегодня', week: '7 дней', exportNote: 'Выгрузка идёт потоком и содержит все записи по фильтру, вместе с подробностями и хешами.', logins: 'Входы', allEvents: 'Все события', json: 'JSON', when: 'Когда', entity: 'Объект', ip: 'IP', next: 'Дальше →', verify: 'Проверить цепочку', csv: 'CSV',
    okTxt: 'Успех', failTxt: 'Ошибка', deniedTxt: 'Отказано', emptyAudit: 'Записей нет. Измените фильтр или сбросьте его.', emptyBans: 'Банов нет. Добавьте адрес или логин выше.', emptySessions: 'Активных сессий нет.', chainOk: 'Цепочка целостна', chainBad: 'Цепочка нарушена в записи', checked: 'проверено записей', bans: 'Баны', kind: 'Тип',
    value: 'Значение', reason: 'Причина', until2: 'До', forever: 'бессрочно', by: 'Кем', lift: 'Снять', ban: 'Забанить',
    duration: 'Срок (30m, 2h, 7d; пусто = бессрочно)', sessions: 'Сессии', user: 'Пользователь', created: 'Создана', seen: 'Активность',
    expires: 'Истекает', revoke: 'Завершить', none: 'нет', done: 'Готово', bad: 'Некорректные данные', total: 'Всего', any: 'все',
    confirm: 'Подтвердить действие?',
  },
  en: {
    live: 'Live feed: new events appear by themselves', audit: 'Audit', security: 'Security', summaryTab: 'Summary', period: 'Period', last24: '24 hours', last7: '7 days', last30: '30 days', sEvents: 'Events', sLogins: 'Sign-ins', sFails: 'Failed sign-ins', sLocks: 'Lockouts', sNewDev: 'New devices', sAdmin: 'Admin actions', sActive: 'People signed in', sPerDay: 'Sign-ins and failures per day', sTopIps: 'Most failed sign-ins: addresses', sTopLogins: 'Most failed sign-ins: names', sTopActions: 'Frequent actions', sNone: 'No data', sNote: 'Addresses are shown as stored in the log (pseudonymised by default).', actor: 'Actor', action: 'Action', summary: 'What happened', category: 'Category', result: 'Result', since: 'Since', until: 'Until',
    filter: 'Filter', eventCard: 'Event', fieldName: 'Field', fieldValue: 'Value', details: 'Details', changed: 'What changed', was: 'Was', became: 'Became', noDetails: 'No details', sameRequest: 'All events of this request', objectHistory: 'History of this object', byActor: 'Actions of this user', back: '← Back to the journal', hashLbl: 'Entry hash', prevHashLbl: 'Previous hash', request: 'Request', entityId: 'Object number', today: 'Today', week: '7 days', exportNote: 'The export is streamed and holds every entry matching the filter, with details and hashes.', logins: 'Sign-ins', allEvents: 'All events', json: 'JSON', when: 'When', entity: 'Entity', ip: 'IP', next: 'Next →', verify: 'Verify chain', csv: 'CSV',
    okTxt: 'Success', failTxt: 'Failure', deniedTxt: 'Denied', emptyAudit: 'No entries. Change the filter or clear it.', emptyBans: 'No bans. Add an address or a login above.', emptySessions: 'No active sessions.', chainOk: 'Chain intact', chainBad: 'Chain broken at entry', checked: 'entries checked', bans: 'Bans', kind: 'Type',
    value: 'Value', reason: 'Reason', until2: 'Until', forever: 'permanent', by: 'By', lift: 'Lift', ban: 'Ban',
    duration: 'Duration (30m, 2h, 7d; empty = permanent)', sessions: 'Sessions', user: 'User', created: 'Created', seen: 'Last seen',
    expires: 'Expires', revoke: 'Revoke', none: 'none', done: 'Done', bad: 'Invalid input', total: 'Total', any: 'any',
    confirm: 'Confirm this action?',
  },
};

/** Reads a urlencoded form body without needing a body-parser (16 KB cap); uses req.body if a parser already ran. */
export function readForm(req, limit = 16384) {
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) return Promise.resolve(req.body);
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size <= limit) chunks.push(c); });
    req.on('error', () => resolve({}));
    req.on('end', () => {
      if (size > limit) return resolve({});
      resolve(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    });
  });
}


function filtersFrom(q) {
  const f = {};
  for (const k of ['actor', 'action', 'entity', 'entityId', 'requestId', 'result', 'since', 'until']) if (q[k]) f[k] = String(q[k]).slice(0, 100);
  if (q.view === 'logins') f.view = 'logins';
  if (f.result && !['success', 'failure'].includes(f.result)) delete f.result;
  return f;
}

// the action and actor boxes search for a part of the text ("task" finds every task action); "Who" stays exact because names can be pseudonymised
/** The action as a person reads it: the catalogue name, a mark for important ones, and the code underneath. */
const actionCell = (e, locale) => {
  const d = describeEvent(e, locale);
  if (!d.known) return esc(e.action);
  const mark = d.severity === 'critical' ? ' <span class="adm-badge danger">!</span>' : d.severity === 'warning' ? ' <span class="adm-badge warn">!</span>' : '';
  return `<span title="${esc(d.categoryTitle)}">${esc(d.title)}</span>${mark}<div class="adm-muted" style="font-size:.8em">${esc(e.action)}</div>`;
};

const toQuery = ({ view, action, ...f }) => {
  const q = { ...f };
  if (action) q.actionContains = action;
  return view === 'logins' ? { ...q, actionPrefix: 'auth.login' } : q;
};

function validDate(v) {
  try { return !v || !Number.isNaN(new Date(v).getTime()); } catch { return false; }
}

/** The "live feed" switch under the audit table: polls the server every 5 seconds and puts new rows on top. Not on older pages. */
function liveHtml({ path, qs, lastId, paged, label, nonce }) {
  if (paged) return '';
  const n = nonce ? ` nonce="${esc(nonce)}"` : '';
  return `<p><label class="adm-muted"><input type="checkbox" id="adm-live"> ${esc(label)}</label></p><script${n}>(function(){var c=document.getElementById('adm-live'),b=document.querySelector('tbody[data-paged="audit"]');if(!c||!b)return;var last=${Number(lastId) || 0},t=null,url=${JSON.stringify(`${path}/live?${qs}`)};function poll(){fetch(url+'&after='+last,{credentials:'same-origin',headers:{Accept:'application/json'}}).then(function(r){return r.ok?r.json():null}).then(function(d){if(!d||!d.count)return;var e=b.querySelector('tr td[colspan]');if(e)e.parentNode.remove();var rs=new DOMParser().parseFromString('<table><tbody>'+d.rows+'</tbody></table>','text/html').querySelectorAll('tbody > tr');b.prepend.apply(b,Array.prototype.slice.call(rs));last=d.lastId}).catch(function(){})}c.addEventListener('change',function(){if(c.checked){poll();t=setInterval(poll,5000)}else{clearInterval(t);t=null}})})();</script>`;
}

/** What the object was called when the event happened: the login for a user, `target` for the rest (kept in `meta`). */
const targetOf = (e) => {
  const v = e.entity === 'user' ? (e.meta?.username ?? e.meta?.target) : e.meta?.target;
  return typeof v === 'string' && v ? v : null;
};
const targetHtml = (e) => (targetOf(e) ? ` <span class="adm-muted">(${esc(targetOf(e))})</span>` : '');

export function mountAuditSection({ app, db, guard, exportGuard = guard, canExport = () => true, canSeeSensitive = () => true, page: render, basePath, localeOf, texts = {}, stepUp = [] }) {
  const path = `${basePath}/audit`;

  const rowHtml = (e, l, locale, sens = true) => `<tr><td><a href="${path}/event/${esc(e.id)}">${esc(e.id)}</a></td><td>${timeHtml(e.createdAt, locale)}</td><td>${esc(e.actor ?? '—')}</td><td>${actionCell(e, locale)}</td><td>${esc(e.entity ?? '')}${e.entityId != null ? `#${esc(e.entityId)}` : ''}${targetHtml(e)}</td><td><span class="adm-badge ${e.result === 'success' ? 'ok' : 'danger'}">${esc(e.result === 'success' ? l.okTxt : e.result === 'failure' ? l.failTxt : e.result === 'denied' ? l.deniedTxt : e.result)}</span></td><td>${sens ? esc(e.ip ?? '') : ''}</td></tr>`;

  app.get(path, ...guard, (req, res) => {
    const l = pickTexts(L, texts['admin-audit'], localeOf(req), 'admin-audit');
    const f = filtersFrom(req.query ?? {});
    const bad = !validDate(f.since) || !validDate(f.until);
    if (bad) { delete f.since; delete f.until; }
    const before = Number(req.query?.before) > 0 ? Number(req.query.before) : undefined;
    const { items, nextBeforeId } = page(db, { ...toQuery(f), beforeId: before, limit: 50 });
    const total = count(db, toQuery(f));
    const qs = new URLSearchParams(f);
    const input = (name, label, type = 'text') => `<label class="adm-field">${esc(label)}<input class="adm-input" type="${type}" name="${name}" value="${esc(f[name] ?? '')}"></label>`;
    let banner = '';
    if (req.query?.verify) {
      const r = verifyChain(db);
      if (r.ok) { try { createDbLastRunStore(db).set('alerts-audit-chain', new Date().toISOString()); } catch { /* the diagnostics just will not see this check */ } }
      banner = `<div class="adm-card" style="margin-bottom:1rem"><span class="adm-badge ${r.ok ? 'ok' : 'danger'}">${r.ok ? esc(l.chainOk) : `${esc(l.chainBad)} #${esc(r.brokenAtId)}`}</span> <span class="adm-muted">${esc(l.checked)}: ${esc(r.checked)}</span></div>`;
    }
    const rows = items.map((e) => rowHtml(e, l, localeOf(req), canSeeSensitive(req))).join('') || emptyRow(7, l.emptyAudit);
    const day = (back) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 16);
    const preset = (label, since) => `<a class="adm-btn" href="${path}?${esc(new URLSearchParams({ ...f, since, until: '' }).toString().replace(/&until=(?=&|$)/, ''))}">${esc(label)}</a>`;
    const tabs = `<p class="adm-tabs"><a class="adm-btn${f.view ? '' : ' primary'}" href="${path}">${esc(l.allEvents)}</a> <a class="adm-btn${f.view ? ' primary' : ''}" href="${path}?view=logins">${esc(l.logins)}</a> <a class="adm-btn" href="${path}/summary">${esc(l.summaryTab)}</a> ${preset(l.today, new Date(new Date().setHours(0, 0, 0, 0)).toISOString().slice(0, 16))} ${preset(l.week, day(7))}</p>`;
    const body = `${banner}${tabs}<form method="get" class="adm-card adm-filters">${f.view ? '<input type="hidden" name="view" value="logins">' : ''}
${input('actor', l.actor)}${input('action', l.action)}${input('entity', l.entity)}${input('entityId', l.entityId)}${input('requestId', l.request)}
<label class="adm-field">${esc(l.result)}<select class="adm-input" name="result"><option value="">${esc(l.any)}</option><option value="success"${f.result === 'success' ? ' selected' : ''}>${esc(l.okTxt)}</option><option value="failure"${f.result === 'failure' ? ' selected' : ''}>${esc(l.failTxt)}</option></select></label>
${input('since', l.since, 'datetime-local')}${input('until', l.until, 'datetime-local')}
<button class="adm-btn primary" type="submit">${esc(l.filter)}</button>
${canExport(req) ? `<a class="adm-btn" title="${esc(l.exportNote)}" href="${path}.csv?${esc(qs)}">${esc(l.csv)}</a>
<a class="adm-btn" title="${esc(l.exportNote)}" href="${path}.json?${esc(qs)}">${esc(l.json)}</a>` : ''}
<a class="adm-btn" href="${path}?${esc(new URLSearchParams({ ...f, verify: '1' }))}">${esc(l.verify)}</a>
</form>
<div class="adm-card"><p class="adm-muted">${esc(l.total)}: ${esc(total)}</p>
<table class="adm-table"><thead><tr><th>#</th><th>${esc(l.when)}</th><th>${esc(l.actor)}</th><th>${esc(l.action)}</th><th>${esc(l.entity)}</th><th>${esc(l.result)}</th><th>${esc(l.ip)}</th></tr></thead><tbody data-paged="audit">${rows}</tbody></table>
${liveHtml({ path, qs, lastId: items.length ? items[0].id : 0, paged: before !== undefined, label: l.live, nonce: res.locals?.cspNonce })}
${pagerHtml({ name: 'audit', shown: items.length, total, nextUrl: nextBeforeId ? `${path}?${new URLSearchParams({ ...f, before: String(nextBeforeId) })}` : '', locale: localeOf(req), nonce: res.locals?.cspNonce })}</div>`;
    render(req, res, { active: path, title: l.audit, bodyHtml: body });
  });

  function filtersOf(req) {
    const f = filtersFrom(req.query ?? {});
    if (!validDate(f.since) || !validDate(f.until)) { delete f.since; delete f.until; }
    return f;
  }

  const hashesOf = (ids) => {
    const m = new Map();
    if (!ids.length) return m;
    for (const r of db.all(`SELECT id, hash, prev_hash FROM audit_log WHERE id IN (${ids.map(() => '?').join(',')})`, ids)) m.set(r.id, r);
    return m;
  };

  /**
   * Streams every entry matching the filter, batch by batch (nothing is cut off, memory stays flat), with the details
   * (`meta`) and the chain hashes. The export itself is written to the journal once it is finished, with the row count.
   */
  function streamExport(req, res, { format }) {
    const f = filtersOf(req);
    const sens = canSeeSensitive(req);
    // Without the sensitive right the export carries neither the address nor the details (G-13).
    const ALL = ['id', 'createdAt', 'actor', 'action', 'entity', 'entityId', 'result', 'requestId', 'ip', 'meta', 'hash', 'prevHash'];
    const keep = ALL.map((c) => sens || (c !== 'ip' && c !== 'meta'));
    const COLS = ALL.filter((_, i) => keep[i]);
    const excel = localeOf(req);
    res.set('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="audit.${format}"`).set('Cache-Control', 'no-store');
    let beforeId;
    let total = 0;
    let first = true;
    if (format === 'json') res.write('[');
    else res.write(writeCsv([COLS], { excel }));
    for (;;) {
      if (res.destroyed || res.writableEnded) return;
      const batch = query(db, { ...toQuery(f), beforeId, limit: 1000 });
      if (batch.length) {
        const hashes = hashesOf(batch.map((e) => e.id));
        const rows = batch.map((e) => {
          const h = hashes.get(e.id);
          return [e.id, e.createdAt, e.actor ?? null, e.action, e.entity ?? null, e.entityId ?? null, e.result, e.requestId ?? null, e.ip ?? null, e.meta ?? null, h?.hash ?? null, h?.prev_hash ?? null].filter((_, i) => keep[i]);
        });
        if (format === 'json') {
          for (const row of rows) { res.write(`${first ? '\n' : ',\n'}${JSON.stringify(Object.fromEntries(COLS.map((c, i) => [c, row[i]])))}`); first = false; }
        } else {
          res.write(`\r\n${writeCsv(rows.map((row) => row.map((v, i) => (COLS[i] === 'meta' && v ? JSON.stringify(v) : v))), { excel, bom: false })}`);
        }
        total += batch.length;
        beforeId = batch[batch.length - 1].id;
      }
      if (batch.length < 1000) break;
    }
    log(db, { ...contextFromRequest(req), action: 'admin.audit.export', entity: 'audit', meta: { rows: total, format, filters: f, ...(sens ? {} : { withoutSensitive: true }) } });
    res.end(format === 'json' ? '\n]\n' : '\r\n');
  }

  app.get(`${path}.csv`, ...exportGuard, (req, res) => streamExport(req, res, { format: 'csv' }));
  app.get(`${path}.json`, ...exportGuard, (req, res) => streamExport(req, res, { format: 'json' }));

  // Live feed: the rows newer than `after`, for the current filter, ready to put on top of the table.
  app.get(`${path}/live`, ...guard, (req, res) => {
    const l = pickTexts(L, texts['admin-audit'], localeOf(req), 'admin-audit');
    const f = filtersOf(req);
    const after = Math.max(0, Math.trunc(Number(req.query?.after)) || 0);
    const items = query(db, { ...toQuery(f), afterId: after, limit: 50 }); // oldest first, at most 50 per poll
    res.set('Cache-Control', 'no-store');
    res.json({ rows: items.map((e) => rowHtml(e, l, localeOf(req), canSeeSensitive(req))).reverse().join(''), lastId: items.length ? items[items.length - 1].id : after, count: items.length });
  });

  // Summary for a period: the numbers, a chart per day, and the noisiest sources of failed sign-ins.
  app.get(`${path}/summary`, ...guard, (req, res) => {
    const l = pickTexts(L, texts['admin-audit'], localeOf(req), 'admin-audit');
    const days = [1, 7, 30].includes(Number(req.query?.days)) ? Number(req.query.days) : 7;
    const r = summarize(db, { since: new Date(Date.now() - days * 86_400_000).toISOString() });
    const card = (label, value) => `<div class="adm-card" style="flex:1 1 9rem"><div class="adm-muted">${esc(label)}</div><div style="font-size:1.6rem;font-weight:600">${esc(value)}</div></div>`;
    const list = (title, rows) => `<div class="adm-card" style="flex:1 1 18rem"><h3>${esc(title)}</h3>${rows.length ? `<table class="adm-table"><tbody>${rows.map((x) => `<tr><td><code>${esc(x.key)}</code></td><td>${esc(x.count)}</td></tr>`).join('')}</tbody></table>` : `<p class="adm-muted">${esc(l.sNone)}</p>`}</div>`;
    const chart = r.perDay.length ? svgBarChart(r.perDay.map((d) => ({ label: d.day.slice(5), value: d.failures })), { title: l.sPerDay, unit: l.sFails }) : `<p class="adm-muted">${esc(l.sNone)}</p>`;
    const t = r.totals;
    const periods = [[1, l.last24], [7, l.last7], [30, l.last30]].map(([d, label]) => `<a class="adm-btn${d === days ? ' primary' : ''}" href="${path}/summary?days=${d}">${esc(label)}</a>`).join(' ');
    render(req, res, { active: path, title: l.summaryTab, bodyHtml: `<p>${periods} <a class="adm-btn" href="${path}">${esc(l.back)}</a></p>
<div style="display:flex;flex-wrap:wrap;gap:.75rem">${card(l.sEvents, t.events)}${card(l.sLogins, t.logins)}${card(l.sFails, t.loginFailures)}${card(l.sLocks, t.lockouts)}${card(l.sNewDev, t.newDevices)}${card(l.sAdmin, t.adminActions)}${card(l.sActive, t.activeUsers)}</div>
<div class="adm-card" style="margin-top:.75rem"><h3>${esc(l.sPerDay)}</h3>${chart}</div>
<div style="display:flex;flex-wrap:wrap;gap:.75rem;margin-top:.75rem">${canSeeSensitive(req) ? list(l.sTopIps, r.topFailedIps) : ''}${list(l.sTopLogins, r.topFailedLogins)}${list(l.sTopActions, r.topActions.map((x) => ({ key: describeEvent({ action: x.key }, localeOf(req)).title, count: x.count })))}</div>
<p class="adm-muted">${esc(l.sNote)}</p>` });
  });

  // One event with everything it holds, and the ways to move on from it.
  app.get(`${path}/event/:id`, ...guard, (req, res) => {
    const l = pickTexts(L, texts['admin-audit'], localeOf(req), 'admin-audit');
    const id = Number(req.params.id);
    const e = Number.isInteger(id) && id > 0 ? query(db, { afterId: id - 1, limit: 1 })[0] : null;
    if (!e || e.id !== id) return res.status(404).type('html').send(`<!doctype html><title>404</title><p>404</p>`);
    const h = hashesOf([id]).get(id);
    const d = describeEvent(e, localeOf(req));
    const sens = canSeeSensitive(req);
    const changes = !sens ? [] : e.meta?.changes && typeof e.meta.changes === 'object' && !Array.isArray(e.meta.changes) ? Object.entries(e.meta.changes) : [];
    const meta = sens && e.meta && typeof e.meta === 'object' ? Object.entries(e.meta).filter(([k]) => !(k === 'changes' && changes.length)) : [];
    const cell = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v ?? ''));
    const line = (k, v) => `<tr><th style="text-align:left;width:11rem">${esc(k)}</th><td>${esc(cell(v))}</td></tr>`;
    const link = (href, label) => `<a class="adm-btn" href="${href}">${esc(label)}</a>`;
    const q = (o) => `${path}?${new URLSearchParams(o)}`;
    const links = [
      e.requestId ? link(q({ requestId: e.requestId }), l.sameRequest) : '',
      e.entity && e.entityId != null ? link(q({ entity: e.entity, entityId: e.entityId }), l.objectHistory) : '',
      e.actor ? link(q({ actor: e.actor }), l.byActor) : '',
    ].join(' ');
    const body = `<p>${link(path, l.back)}</p><div class="adm-card"><table class="adm-table"><tbody>${line('#', e.id)}${line(l.when, e.createdAt)}${line(l.actor, e.actor ?? '—')}${line(l.action, d.known ? `${d.title} (${e.action})` : e.action)}${d.phrase ? line(l.summary, d.phrase) : ''}${d.known ? line(l.category, d.categoryTitle) : ''}${line(l.entity, `${e.entity ?? ''}${e.entityId != null ? `#${e.entityId}` : ''}${targetOf(e) ? ` (${targetOf(e)})` : ''}`)}${line(l.result, e.result)}${sens ? line(l.ip, e.ip ?? '') : ''}${line(l.request, e.requestId ?? '')}${line(l.hashLbl, h?.hash ?? '')}${line(l.prevHashLbl, h?.prev_hash ?? '')}</tbody></table></div>
${changes.length ? `<div class="adm-card"><h2>${esc(l.changed)}</h2><table class="adm-table"><thead><tr><th>${esc(l.fieldName)}</th><th>${esc(l.was)}</th><th>${esc(l.became)}</th></tr></thead><tbody>${changes.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(cell(v?.from))}</td><td>${esc(cell(v?.to))}</td></tr>`).join('')}</tbody></table></div>` : ''}<div class="adm-card"><h2>${esc(l.details)}</h2>${meta.length ? `<table class="adm-table"><thead><tr><th>${esc(l.fieldName)}</th><th>${esc(l.fieldValue)}</th></tr></thead><tbody>${meta.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(cell(v))}</td></tr>`).join('')}</tbody></table>` : `<p class="adm-muted">${esc(l.noDetails)}</p>`}</div><p>${links}</p>`;
    render(req, res, { active: path, title: `${l.eventCard} #${e.id}`, bodyHtml: body });
  });
  return path;
}

export function mountSecuritySection({ app, db, guard, page: render, basePath, localeOf, texts = {}, bans, stepUp = [] }) {
  const path = `${basePath}/security`;

  function sessionRows({ limit, offset }) {
    try {
      return {
        items: db.all(`SELECT s.id, s.created_at, s.last_seen_at, s.expires_at, u.username FROM sessions s LEFT JOIN users u ON u.id = s.user_id ORDER BY COALESCE(s.last_seen_at, s.created_at) DESC LIMIT ? OFFSET ?`, [limit, offset]),
        total: db.get('SELECT COUNT(*) AS n FROM sessions').n,
      };
    } catch { return { items: [], total: 0 }; }
  }

  app.get(path, ...guard, (req, res) => {
    const l = pickTexts(L, texts['admin-audit'], localeOf(req), 'admin-audit');
    const notice = req.query?.msg === 'ok' ? `<div class="adm-toast">${esc(l.done)}</div>` : req.query?.msg === 'bad' ? `<div class="adm-toast" style="border-left-color:var(--adm-danger)">${esc(l.bad)}</div>` : '';
    const action = (p, label, cls = '') => `<form method="post" action="${p}" style="display:inline"><button class="adm-btn ${cls}" type="submit" data-confirm="${esc(label)}?">${esc(label)}</button></form>`;
    const bp = pageParams(req, 'bans');
    const sp = pageParams(req, 'sessions');
    const banItems = bans.list({ active: true, limit: bp.size, offset: bp.offset });
    const banTotal = bans.count({ active: true });
    const sessPage = sessionRows({ limit: sp.size, offset: sp.offset });
    const banRows = banItems.map((b) => `<tr><td>${esc(b.id)}</td><td>${esc(b.kind)}</td><td>${esc(b.value)}</td><td>${esc(b.reason ?? '')}</td><td>${b.expiresAt ? timeHtml(b.expiresAt, localeOf(req)) : esc(l.forever)}</td><td>${esc(b.createdBy ?? '')}</td><td>${action(`${path}/bans/${b.id}/lift`, l.lift)}</td></tr>`).join('') || emptyRow(7, l.emptyBans);
    const sess = sessPage.items.map((s) => `<tr><td>${esc(s.username ?? '—')}</td><td>${timeHtml(s.created_at, localeOf(req))}</td><td>${timeHtml(s.last_seen_at, localeOf(req))}</td><td>${timeHtml(s.expires_at, localeOf(req))}</td><td>${action(`${path}/sessions/${encodeURIComponent(s.id)}/revoke`, l.revoke, 'danger')}</td></tr>`).join('') || emptyRow(5, l.emptySessions);
    const body = `${notice}<div class="adm-card" style="margin-bottom:1rem"><h2>${esc(l.bans)}</h2>
<form method="post" action="${path}/bans" style="display:flex;gap:.75rem;flex-wrap:wrap;align-items:end;margin-bottom:1rem">
<label class="adm-field">${esc(l.kind)}<select class="adm-input" name="kind"><option value="ip">ip</option><option value="user">user</option></select></label>
<label class="adm-field">${esc(l.value)}<input class="adm-input" name="value" required maxlength="64"></label>
<label class="adm-field">${esc(l.reason)}<input class="adm-input" name="reason" maxlength="500"></label>
<label class="adm-field">${esc(l.duration)}<input class="adm-input" name="duration" maxlength="8"></label>
<button class="adm-btn danger" type="submit">${esc(l.ban)}</button></form>
<table class="adm-table"><thead><tr><th>#</th><th>${esc(l.kind)}</th><th>${esc(l.value)}</th><th>${esc(l.reason)}</th><th>${esc(l.until2)}</th><th>${esc(l.by)}</th><th></th></tr></thead><tbody data-paged="bans">${banRows}</tbody></table>${pagerFor({ req, res, path, name: 'bans', param: 'bans', ...bp, count: banItems.length, total: banTotal, locale: localeOf(req) })}</div>
<div class="adm-card"><h2>${esc(l.sessions)}</h2><table class="adm-table"><thead><tr><th>${esc(l.user)}</th><th>${esc(l.created)}</th><th>${esc(l.seen)}</th><th>${esc(l.expires)}</th><th></th></tr></thead><tbody data-paged="sessions">${sess}</tbody></table>${pagerFor({ req, res, path, name: 'sessions', param: 'sessions', ...sp, count: sessPage.items.length, total: sessPage.total, locale: localeOf(req), withScript: false })}</div>`;
    render(req, res, { active: path, title: l.security, bodyHtml: body });
  });

  const back = (res, ok) => res.redirect(303, `${path}?msg=${ok ? 'ok' : 'bad'}`);

  app.post(`${path}/bans`, ...guard, ...stepUp, async (req, res) => {
    const form = await readForm(req);
    try {
      const me = req.user?.username ?? null;
      if (form.kind === 'user' && me && String(form.value).trim() === me) return back(res, false); // no self-lockout
      if (form.kind === 'ip' && req.ip && String(form.value).trim() === req.ip) return back(res, false);
      bans.ban({ kind: form.kind, value: form.value, reason: form.reason || null, by: me, durationMs: parseDuration(form.duration || null), ctx: contextFromRequest(req) });
      return back(res, true);
    } catch { return back(res, false); }
  });

  app.post(`${path}/bans/:id/lift`, ...guard, ...stepUp, (req, res) => {
    const n = bans.lift({ id: req.params.id, by: req.user?.username ?? null, ctx: contextFromRequest(req) });
    back(res, n > 0);
  });

  app.post(`${path}/sessions/:id/revoke`, ...guard, ...stepUp, (req, res) => {
    const row = db.get(`SELECT s.id, u.username FROM sessions s LEFT JOIN users u ON u.id = s.user_id WHERE s.id = ?`, [String(req.params.id)]);
    if (!row) return back(res, false);
    db.run(`DELETE FROM sessions WHERE id = ?`, [row.id]);
    log(db, { ...contextFromRequest(req), action: 'admin.session.revoke', entity: 'session', meta: { user: row.username ?? null } });
    back(res, true);
  });
  return path;
}

export { L as AUDIT_SECURITY_TEXTS };
