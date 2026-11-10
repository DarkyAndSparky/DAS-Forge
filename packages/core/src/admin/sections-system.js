import { pageParams, pagerFor } from './paging.js';
import { pickTexts } from '../i18n/overrides.js';
import { log } from '../audit/log.js';
import { contextFromRequest } from '../audit/context.js';
import { timeHtml } from '../ui/time.js';
import { emptyRow, readForm } from './sections.js';
import { describeCron } from '../scheduler/cron-describe.js';
import { describeEnv } from '../config/env.js';
import { configKeyMatches } from './search.js';
import { describeSources, schemaDefaults } from '../config/sources.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const SYSTEM_TEXTS = {
  ru: {
    tasks: 'Задачи', mail: 'Почта', config: 'Конфигурация',
    tasksHint: 'Задачи планировщика: расписание, состояние и результат последнего запуска. «Запустить сейчас» выполняет задачу вне расписания; если она уже работает, повторный запуск пропускается.',
    taskName: 'Задача', schedule: 'Расписание', state: 'Состояние', lastRun: 'Последний запуск', lastError: 'Последняя ошибка', run: 'Запустить сейчас',
    running: 'выполняется', failed: 'ошибка', ok: 'в порядке', never: 'ещё не запускалась', emptyTasks: 'Задач нет. Зарегистрируйте их в планировщике (scheduler.registerJob).',
    taskDone: 'Задача выполнена', taskBad: 'Задача завершилась ошибкой', taskUnknown: 'Такой задачи нет',
    schedEdit: 'Изменить расписание', schedCron: 'Расписание (cron)', schedOrDaily: 'или каждый день в', schedSave: 'Сохранить', schedReset: 'Вернуть исходное', schedChanged: 'изменено администратором', schedSaved: 'Расписание сохранено', schedDefault: 'Исходное', managedIn: 'Настраивается в разделе', e_CRON_INVALID: 'Расписание не распознано: нужны 5 полей cron или время ЧЧ:ММ',
    cronHelp: 'Расписание — пять полей cron: минута, час, день месяца, месяц, день недели. Примеры: «30 4 * * 0» — по воскресеньям в 04:30; «*/15 * * * *» — каждые 15 минут; «0 3 * * *» — каждый день в 03:00. Время сервера. Изменение действует сразу и сохраняется после перезапуска.',
    mailHint: 'Очередь писем: что ждёт отправки, что ушло и что не удалось. Адреса показаны в сокращённом виде, тексты писем здесь не хранятся.',
    mailOff: 'Отправка писем выключена (email.enabled): письма не уходят.', mailOn: 'Отправка писем включена.',
    pending: 'Ожидает', sending: 'Отправляется', sent: 'Отправлено', failedN: 'Не удалось',
    scenario: 'Сценарий', recipients: 'Получатели', status: 'Статус', attempts: 'Попыток', next: 'Следующая попытка', error: 'Ошибка', created: 'Создано',
    emptyMail: 'Писем в очереди нет.',
    cancelBtn: 'Отменить', purgeBtn: 'Очистить завершённые', purgeHint: 'Удаляет отправленные и неудавшиеся письма старше суток из списка (ожидающие не трогает).', cancelled: 'Письмо отменено.', purged: 'Удалено записей:', actions: 'Действия', retryNote: 'Повтор неудавшихся недоступен: содержимое письма стирается сразу после отправки или отказа.', testTitle: 'Проверка отправки', testHint: 'Тестовое письмо уходит сразу, минуя очередь, и покажет настоящий ответ почтового сервера.', testTo: 'Адрес получателя', testSend: 'Отправить тестовое письмо', testOk: 'Письмо отправлено. Проверьте ящик (и папку «Спам»).', testOff: 'Отправка писем выключена (email.enabled): тестовое письмо не отправлено.', testBad: 'Не удалось отправить', testBadAddr: 'Укажите один корректный адрес.',
    configHint: 'Только чтение. Значения секретов скрыты; ссылки вида env:ИМЯ показаны как есть. Изменить настройки можно в файле конфигурации или переменных окружения.',
    path: 'Параметр', value: 'Значение', envTitle: 'Переменные окружения', envHint: 'Значения не показываются. Переменная перекрывает файл настроек; вариант ИМЯ_FILE читает значение из файла (секреты Docker/Kubernetes).', envName: 'Переменная', envSource: 'Откуда', envSet: 'задана', envFile: 'из файла (_FILE)', envBoth: 'задана (файл _FILE игнорируется)', envUnset: 'не задана', envUnknown: 'Заданы, но ничем не читаются', envUnknownHint: 'Скорее всего, опечатка: такая переменная молча игнорируется.', envDidYouMean: 'возможно, имелась в виду', hidden: 'скрыто', source: 'Источник', srcEnv: 'переменная окружения', srcFile: 'файл настроек', srcDefault: 'умолчание', changed: 'отличается от умолчания', onlyChanged: 'Только заданные и изменённые', empty: '(пусто)', emptyConfig: 'Конфигурация не передана.', search: 'Поиск по имени', find: 'Найти',
    alertTasks: 'Есть задачи с ошибкой последнего запуска', alertMail: 'В очереди почты есть письма, которые не удалось отправить',
  },
  en: {
    tasks: 'Tasks', mail: 'Mail', config: 'Configuration',
    tasksHint: 'Scheduler tasks: schedule, state and the result of the last run. "Run now" runs a task outside its schedule; if it is already running the extra run is skipped.',
    taskName: 'Task', schedule: 'Schedule', state: 'State', lastRun: 'Last run', lastError: 'Last error', run: 'Run now',
    running: 'running', failed: 'failed', ok: 'ok', never: 'never ran', emptyTasks: 'No tasks. Register them in the scheduler (scheduler.registerJob).',
    taskDone: 'Task finished', taskBad: 'The task failed', taskUnknown: 'No such task',
    schedEdit: 'Change schedule', schedCron: 'Schedule (cron)', schedOrDaily: 'or every day at', schedSave: 'Save', schedReset: 'Restore default', schedChanged: 'changed by an administrator', schedSaved: 'Schedule saved', schedDefault: 'Default', managedIn: 'Managed in the section', e_CRON_INVALID: 'Schedule not recognised: 5 cron fields or a time HH:MM are needed',
    cronHelp: 'A schedule is five cron fields: minute, hour, day of month, month, day of week. Examples: "30 4 * * 0" - Sundays at 04:30; "*/15 * * * *" - every 15 minutes; "0 3 * * *" - every day at 03:00. Server time. A change applies at once and survives a restart.',
    mailHint: 'The mail queue: what waits to be sent, what went out and what failed. Addresses are shown shortened; mail bodies are not kept here.',
    mailOff: 'Sending mail is off (email.enabled): nothing is sent.', mailOn: 'Sending mail is on.',
    pending: 'Pending', sending: 'Sending', sent: 'Sent', failedN: 'Failed',
    scenario: 'Scenario', recipients: 'Recipients', status: 'Status', attempts: 'Attempts', next: 'Next attempt', error: 'Error', created: 'Created',
    emptyMail: 'The queue is empty.',
    cancelBtn: 'Cancel', purgeBtn: 'Clear finished', purgeHint: 'Removes sent and failed letters older than a day from the list (waiting ones are untouched).', cancelled: 'The letter was cancelled.', purged: 'Rows removed:', actions: 'Actions', retryNote: 'Retrying failed letters is not possible: the content is erased as soon as a letter is sent or fails.', testTitle: 'Delivery check', testHint: 'The test letter goes out at once, not through the queue, and shows the real answer of the mail server.', testTo: 'Recipient address', testSend: 'Send a test letter', testOk: 'The letter was sent. Check the mailbox (and the spam folder).', testOff: 'Sending mail is off (email.enabled): no test letter was sent.', testBad: 'Could not send', testBadAddr: 'Enter one valid address.',
    configHint: 'Read only. Secret values are hidden; references like env:NAME are shown as they are. Change settings in the configuration file or the environment.',
    path: 'Setting', value: 'Value', envTitle: 'Environment variables', envHint: 'Values are not shown. A variable overrides the settings file; NAME_FILE reads the value from a file (Docker/Kubernetes secrets).', envName: 'Variable', envSource: 'Source', envSet: 'set', envFile: 'from a file (_FILE)', envBoth: 'set (the _FILE variable is ignored)', envUnset: 'not set', envUnknown: 'Set but read by nothing', envUnknownHint: 'Most likely a typo: such a variable is silently ignored.', envDidYouMean: 'did you mean', hidden: 'hidden', source: 'Source', srcEnv: 'environment variable', srcFile: 'settings file', srcDefault: 'default', changed: 'differs from the default', onlyChanged: 'Only set and changed', empty: '(empty)', emptyConfig: 'No configuration was passed.', search: 'Search by name', find: 'Find',
    alertTasks: 'Some tasks failed on their last run', alertMail: 'The mail queue has mails that could not be sent',
  },
};

const SECRET_KEY = /(secret|password|passwd|\bpass\b|token|apikey|api_key|privatekey|private_key|encryptionkey|credential|authorization|\bkey\b)/i;
const SAFE_KEY = /(keyfile|keypath|keylength|maxkeys|monkey)/i;


/** Flattens a configuration object into `[path, value]` rows; secret values are replaced by `null` (shown as hidden). */
export function flattenConfig(obj, prefix = '', out = []) {
  if (Array.isArray(obj)) {
    if (obj.length === 0) out.push([prefix, []]);
    obj.forEach((v, i) => flattenConfig(v, `${prefix}[${i}]`, out));
    return out;
  }
  if (obj && typeof obj === 'object') {
    const keys = Object.keys(obj);
    if (keys.length === 0 && prefix) out.push([prefix, {}]);
    for (const k of keys) {
      const path = prefix ? `${prefix}.${k}` : k;
      const v = obj[k];
      const secret = SECRET_KEY.test(k) && !SAFE_KEY.test(k);
      if (secret && typeof v === 'string' && v !== '') out.push([path, /^env:[A-Za-z_][A-Za-z0-9_]*$/.test(v) ? v : null]);
      else if (secret && Array.isArray(v)) v.forEach((x, i) => out.push([`${path}[${i}]`, typeof x === 'string' && /^env:[A-Za-z_][A-Za-z0-9_]*$/.test(x) ? x : null]));
      else flattenConfig(v, path, out);
    }
    return out;
  }
  out.push([prefix, obj]);
  return out;
}

const tx = (texts, req, localeOf) => pickTexts(SYSTEM_TEXTS, texts['admin-system'], localeOf(req), 'admin-system');

/** Tasks that failed on their last run (the overview warns about them). */
export function failedTasks(scheduler) {
  try { return scheduler.listJobs().filter((j) => j.lastError); } catch { return []; }
}

/** Mail queue problems: failed mails or mails waiting far longer than a retry round. */
export function mailProblems(queue) {
  try { return queue.stats().failed > 0; } catch { return false; }
}

/** "Tasks" section: the scheduler's jobs with a run-now action. */
export function mountTasksSection({ app, db, guard, page: render, basePath, localeOf, texts = {}, stepUp = [], scheduler, taskSchedules = null, managedTasks = {} }) {
  const p = `${basePath}/tasks`;
  const SECTION_LABEL = { backups: { ru: 'Резервные копии', en: 'Backups' }, about: { ru: 'О системе', en: 'About' } };
  app.get(p, ...guard, (req, res) => {
    const l = tx(texts, req, localeOf);
    const locale = localeOf(req);
    const msg = req.query?.msg === 'ok' ? `<div class="adm-toast">${esc(req.query.e === 'SCHED' ? l.schedSaved : l.taskDone)}</div>` : req.query?.msg === 'bad' ? `<div class="adm-toast" style="border-left-color:var(--adm-danger)">${esc(req.query.e === 'UNKNOWN' ? l.taskUnknown : (l[`e_${String(req.query.e ?? '')}`] ?? l.taskBad))}</div>` : '';
    const jobs = scheduler.listJobs();
    const rows = jobs.map((j) => {
      const state = j.running ? `<span class="adm-badge info">${esc(l.running)}</span>` : j.lastError ? `<span class="adm-badge danger">${esc(l.failed)}</span>` : `<span class="adm-badge ok">${esc(l.ok)}</span>`;
      const reading = describeCron(j.expression, locale);
      let edit = '';
      const managed = managedTasks[j.name];
      const href = `${p}/${encodeURIComponent(j.name)}`;
      if (managed && SECTION_LABEL[managed]) {
        edit = `<div class="adm-muted">${esc(l.managedIn)} <a href="${basePath}/${managed}">${esc(SECTION_LABEL[managed][locale] ?? SECTION_LABEL[managed].ru)}</a></div>`;
      } else if (taskSchedules) {
        const changed = taskSchedules.isOverridden(j.name);
        edit = `<details style="margin-top:.35rem"><summary class="adm-muted" style="cursor:pointer">${esc(l.schedEdit)}</summary><form method="post" action="${href}/schedule" style="display:flex;flex-wrap:wrap;gap:.4rem;align-items:center;margin:.4rem 0"><input class="adm-input" name="cron" value="${esc(j.expression)}" aria-label="${esc(l.schedCron)}" style="width:10rem"><span class="adm-muted">${esc(l.schedOrDaily)}</span><input class="adm-input" type="time" name="time" style="width:7rem"><button class="adm-btn" type="submit">${esc(l.schedSave)}</button></form>${changed ? `<form method="post" action="${href}/schedule-reset" style="margin:0 0 .4rem"><span class="adm-muted">${esc(l.schedDefault)}: <code>${esc(j.defaultExpression)}</code></span> <button class="adm-btn" type="submit">${esc(l.schedReset)}</button></form>` : ''}</details>`;
      }
      const sched = `<code title="${esc(reading)}">${esc(j.expression)}</code><div class="adm-muted">${esc(reading)}${taskSchedules?.isOverridden(j.name) ? ` · ${esc(l.schedChanged)}` : ''}</div>${edit}`;
      return `<tr><td><strong>${esc(j.name)}</strong></td><td>${sched}</td><td>${state}</td><td>${j.lastRunAt ? timeHtml(j.lastRunAt, locale) : `<span class="adm-muted">${esc(l.never)}</span>`}</td><td>${j.lastError ? esc(j.lastError) : ''}</td><td><form method="post" action="${p}/${encodeURIComponent(j.name)}/run" style="margin:0"><button class="adm-btn" type="submit"${j.running ? ' disabled' : ''}>${esc(l.run)}</button></form></td></tr>`;
    }).join('') || emptyRow(6, l.emptyTasks);
    render(req, res, { active: p, title: l.tasks, bodyHtml: `${msg}<p class="adm-muted">${esc(l.tasksHint)}</p>${taskSchedules ? `<p class="adm-muted">${esc(l.cronHelp)}</p>` : ''}<div class="adm-card"><table class="adm-table"><thead><tr><th>${esc(l.taskName)}</th><th>${esc(l.schedule)}</th><th>${esc(l.state)}</th><th>${esc(l.lastRun)}</th><th>${esc(l.lastError)}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` });
  });

  app.post(`${p}/:name/run`, ...guard, ...stepUp, async (req, res) => {
    const name = String(req.params.name ?? '');
    const known = scheduler.listJobs().some((j) => j.name === name);
    if (!known) return res.redirect(303, `${p}?msg=bad&e=UNKNOWN`);
    let ok = true;
    try { await scheduler.runNow(name); } catch { ok = false; }
    log(db, { ...contextFromRequest(req), action: 'admin.task.run', entity: 'task', meta: { name }, result: ok ? 'success' : 'failure' });
    res.redirect(303, ok ? `${p}?msg=ok` : `${p}?msg=bad&e=FAILED`);
  });

  if (taskSchedules) {
    const change = (action, fn) => async (req, res) => {
      const name = String(req.params.name ?? '');
      if (managedTasks[name]) return res.redirect(303, `${p}?msg=bad&e=UNKNOWN`);
      try {
        const form = await readForm(req);
        const schedule = fn(name, form);
        log(db, { ...contextFromRequest(req), action, entity: 'task', meta: { name, schedule }, result: 'success' });
        res.redirect(303, `${p}?msg=ok&e=SCHED`);
      } catch (err) {
        res.redirect(303, `${p}?msg=bad&e=${err?.code === 'UNKNOWN' ? 'UNKNOWN' : 'CRON_INVALID'}`);
      }
    };
    app.post(`${p}/:name/schedule`, ...guard, ...stepUp, change('admin.task.schedule', (name, f) => taskSchedules.set(name, { cron: f.cron, time: String(f.time ?? '').trim() || undefined })));
    app.post(`${p}/:name/schedule-reset`, ...guard, ...stepUp, change('admin.task.schedule_reset', (name) => taskSchedules.reset(name)));
  }
}

/** "Mail" section: queue counters and the newest rows (shortened addresses, no bodies). */
export function mountMailSection({ app, db, guard, page: render, basePath, localeOf, texts = {}, stepUp = [], mail }) {
  const p = `${basePath}/mail`;
  app.get(p, ...guard, (req, res) => {
    const l = tx(texts, req, localeOf);
    const locale = localeOf(req);
    const stats = mail.queue?.stats?.() ?? { pending: 0, sending: 0, sent: 0, failed: 0 };
    const enabled = Boolean(mail.service?.enabled);
    const tiles = [[l.pending, stats.pending], [l.sending, stats.sending], [l.sent, stats.sent], [l.failedN, stats.failed]]
      .map(([k, v]) => `<div class="adm-card"><h2>${esc(k)}</h2><div class="adm-stat">${esc(v)}</div></div>`).join('');
    const statusBadge = (s) => `<span class="adm-badge ${s === 'sent' ? 'ok' : s === 'failed' ? 'danger' : 'info'}">${esc({ pending: l.pending, sending: l.sending, sent: l.sent, failed: l.failedN }[s] ?? s)}</span>`;
    const pg = pageParams(req);
    const queueItems = mail.queue?.list?.({ limit: pg.size, offset: pg.offset }) ?? [];
    const queueTotal = (stats.pending ?? 0) + (stats.sending ?? 0) + (stats.sent ?? 0) + (stats.failed ?? 0);
    const canAct = Boolean(mail.queue?.cancel);
    const rows = queueItems.map((r) => `<tr><td>${esc(r.scenario)}</td><td>${esc(r.recipients.join(', '))}</td><td>${statusBadge(r.status)}</td><td>${esc(r.attempts)}</td><td>${r.status === 'pending' ? timeHtml(r.nextAttemptAt, locale) : ''}</td><td>${esc(r.lastError ?? '')}</td><td>${timeHtml(r.createdAt, locale)}</td>${canAct ? `<td>${r.status === 'pending' ? `<form method="post" action="${p}/cancel"><input type="hidden" name="id" value="${esc(r.id)}"><button class="adm-btn" type="submit">${esc(l.cancelBtn)}</button></form>` : ''}</td>` : ''}</tr>`).join('') || emptyRow(canAct ? 8 : 7, l.emptyMail);
    const q = req.query ?? {};
    const toast = q.msg === 'cancelled' ? `<div class="adm-toast">${esc(l.cancelled)}</div>` : q.msg === 'purged' ? `<div class="adm-toast">${esc(l.purged)} ${esc(Number(q.n) || 0)}</div>` : q.msg === 'ok' ? `<div class="adm-toast">${esc(l.testOk)}</div>` : q.msg === 'off' ? `<div class="adm-toast">${esc(l.testOff)}</div>` : q.msg === 'bad' ? `<div class="adm-toast" style="border-left-color:var(--adm-danger)">${esc(q.e === 'ADDR' ? l.testBadAddr : `${l.testBad}${/^[A-Z_]{3,40}$/.test(String(q.e ?? '')) ? ` (${q.e})` : ''}`)}</div>` : '';
    const purgeForm = canAct ? `<div class="adm-card" style="margin-bottom:1rem"><p class="adm-muted">${esc(l.purgeHint)} ${esc(l.retryNote)}</p><form method="post" action="${p}/purge"><button class="adm-btn" type="submit">${esc(l.purgeBtn)}</button></form></div>` : '';
    const testForm = mail.service?.sendTest ? `<div class="adm-card" style="margin-bottom:1rem"><h2>${esc(l.testTitle)}</h2><p class="adm-muted">${esc(l.testHint)}</p><form method="post" action="${p}/test" style="display:flex;flex-wrap:wrap;gap:.5rem;align-items:end"><label class="adm-field">${esc(l.testTo)}<input class="adm-input" type="email" name="to" value="${esc(req.user?.email ?? '')}" maxlength="254" required autocomplete="off"></label><button class="adm-btn primary" type="submit"${enabled ? '' : ' disabled'}>${esc(l.testSend)}</button></form></div>` : '';
    render(req, res, { active: p, title: l.mail, bodyHtml: `${toast}<p class="adm-muted">${esc(l.mailHint)}</p><p><span class="adm-badge ${enabled ? 'ok' : 'warn'}">${esc(enabled ? l.mailOn : l.mailOff)}</span></p>${testForm}${purgeForm}<div class="adm-grid" style="margin-bottom:1rem">${tiles}</div><div class="adm-card"><table class="adm-table"><thead><tr><th>${esc(l.scenario)}</th><th>${esc(l.recipients)}</th><th>${esc(l.status)}</th><th>${esc(l.attempts)}</th><th>${esc(l.next)}</th><th>${esc(l.error)}</th><th>${esc(l.created)}</th>${canAct ? `<th>${esc(l.actions)}</th>` : ''}</tr></thead><tbody data-paged="mail">${rows}</tbody></table>${pagerFor({ req, res, path: p, name: 'mail', ...pg, count: queueItems.length, total: queueTotal, locale })}</div>` });
  });

  if (mail.queue?.cancel) {
    app.post(`${p}/cancel`, ...guard, ...stepUp, async (req, res) => {
      const form = await readForm(req);
      const id = Number(form.id);
      const done = mail.queue.cancel(id);
      if (done && db) log(db, { ...contextFromRequest(req), action: 'admin.mail.cancel', entity: 'mail', entityId: String(id), result: 'success' });
      res.redirect(303, done ? `${p}?msg=cancelled` : p);
    });
    app.post(`${p}/purge`, ...guard, ...stepUp, (req, res) => {
      const n = mail.queue.purgeFinished({ olderThanDays: 1 });
      if (db) log(db, { ...contextFromRequest(req), action: 'admin.mail.purge', entity: 'mail', meta: { removed: n }, result: 'success' });
      res.redirect(303, `${p}?msg=purged&n=${n}`);
    });
  }

  if (mail.service?.sendTest) {
    app.post(`${p}/test`, ...guard, ...stepUp, async (req, res) => {
      const form = await readForm(req);
      const to = String(form.to ?? '').trim();
      if (!/^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(to) || to.length > 254) return res.redirect(303, `${p}?msg=bad&e=ADDR`);
      const [local, domain] = to.split('@');
      const masked = `${local.slice(0, 1)}***@${domain}`;
      try {
        const r = await mail.service.sendTest({ to, locale: localeOf(req) });
        if (r.skipped === 'disabled') return res.redirect(303, `${p}?msg=off`);
        if (db) log(db, { ...contextFromRequest(req), action: 'admin.mail.test', entity: 'mail', meta: { to: masked }, result: 'success' });
        res.redirect(303, `${p}?msg=ok`);
      } catch (err) {
        if (db) log(db, { ...contextFromRequest(req), action: 'admin.mail.test', entity: 'mail', meta: { to: masked, code: err?.code ?? 'FAILED' }, result: 'failure' });
        res.redirect(303, `${p}?msg=bad&e=${/^[A-Z_]{3,40}$/.test(String(err?.code ?? '')) ? err.code : 'FAILED'}`);
      }
    });
  }
}

/** "Configuration" section: the effective settings, read only, secrets hidden. */
export function mountConfigSection({ app, guard, page: render, basePath, localeOf, texts = {}, config, configSources = null, env = process.env }) {
  const p = `${basePath}/config`;
  let defaults;
  const defaultsOnce = () => (defaults === undefined ? (defaults = schemaDefaults()) : defaults);
  app.get(p, ...guard, (req, res) => {
    const l = tx(texts, req, localeOf);
    const q = String(req.query?.q ?? '').slice(0, 64).toLowerCase();
    const shown = (v) => {
      if (v === null) return `<span class="adm-badge">${esc(l.hidden)}</span>`;
      if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0) || (v && typeof v === 'object' && Object.keys(v).length === 0)) return `<span class="adm-muted">${esc(l.empty)}</span>`;
      return `<code>${esc(typeof v === 'string' ? v : JSON.stringify(v))}</code>`;
    };
    const onlyChanged = Boolean(configSources) && req.query?.changed === '1';
    const flat = config ? flattenConfig(config).filter(([k]) => !q || configKeyMatches(k, q)) : [];
    // With the report of the loader: where each value comes from and whether it differs from the default.
    const withSource = configSources ? describeSources(flat, { fileConfig: configSources.fileConfig, envPaths: configSources.envPaths, defaults: defaultsOnce() }) : null;
    const lines = (withSource ?? flat.map(([path, value]) => ({ path, value, source: null, changed: null }))).filter((r) => !onlyChanged || (r.source !== 'default' && r.changed !== false));
    const srcLabel = { env: l.srcEnv, file: l.srcFile, default: l.srcDefault };
    const cols = withSource ? 3 : 2;
    const rows = lines.map((r) => `<tr><td>${esc(r.path)}</td><td>${shown(r.value)}</td>${withSource ? `<td><span class="adm-muted">${esc(srcLabel[r.source] ?? '')}</span>${r.changed ? ` <span class="adm-badge">${esc(l.changed)}</span>` : ''}</td>` : ''}</tr>`).join('') || emptyRow(cols, l.emptyConfig);
    const changedBox = withSource ? `<label class="adm-field"><span><input type="checkbox" name="changed" value="1"${onlyChanged ? ' checked' : ''}> ${esc(l.onlyChanged)}</span></label>` : '';
    render(req, res, { active: p, title: l.config, bodyHtml: `<p class="adm-muted">${esc(l.configHint)}</p><form method="get" class="adm-card adm-filters"><label class="adm-field">${esc(l.search)}<input class="adm-input" name="q" value="${esc(q)}" maxlength="64"></label>${changedBox}<button class="adm-btn primary" type="submit">${esc(l.find)}</button></form><div class="adm-card"><table class="adm-table"><thead><tr><th>${esc(l.path)}</th><th>${esc(l.value)}</th>${withSource ? `<th>${esc(l.source)}</th>` : ''}</tr></thead><tbody>${rows}</tbody></table></div>${envCard(l, env, q)}` });
  });
}

/** Which environment variables affect the configuration (names and origin only, never values). */
function envCard(l, env, q = '') {
  const all = describeEnv(env);
  const known = all.known.filter((k) => !q || k.name.toLowerCase().includes(q) || configKeyMatches(k.path, q)); // the page search applies here too
  const unknown = all.unknown.filter((u) => !q || u.name.toLowerCase().includes(q));
  const label = (k) => (k.source === 'env' ? (k.note === 'both' ? l.envBoth : l.envSet) : k.source === 'file' ? l.envFile : l.envUnset);
  const rows = known.map((k) => `<tr><td><code>${esc(k.name)}</code></td><td>${esc(k.path)}</td><td><span class="adm-badge ${k.source === 'unset' ? '' : 'ok'}">${esc(label(k))}</span></td></tr>`).join('');
  const stray = unknown.length
    ? `<div class="adm-card" style="margin-top:1rem"><h2>${esc(l.envUnknown)}</h2><p class="adm-muted">${esc(l.envUnknownHint)}</p><ul>${unknown.map((u) => `<li><code>${esc(u.name)}</code>${u.didYouMean ? ` - ${esc(l.envDidYouMean)} <code>${esc(u.didYouMean)}</code>` : ''}</li>`).join('')}</ul></div>`
    : '';
  return `<div class="adm-card" style="margin-top:1rem"><h2>${esc(l.envTitle)}</h2><p class="adm-muted">${esc(l.envHint)}</p><table class="adm-table"><thead><tr><th>${esc(l.envName)}</th><th>${esc(l.path)}</th><th>${esc(l.envSource)}</th></tr></thead><tbody>${rows}</tbody></table></div>${stray}`;
}
