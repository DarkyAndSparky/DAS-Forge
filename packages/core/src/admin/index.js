import { bellHtml } from '../notifications/page.js';
import { searchSections, configKeyMatches } from './search.js';
import { flattenConfig as flattenCfg } from './sections-system.js';
import { statSync, statfsSync } from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { pickTexts } from '../i18n/overrides.js';
import { renderAppShell } from '../ui/shell.js';
import { svgBarChart, svgLineChart } from './charts.js';
import { mountAuditSection, mountSecuritySection } from './sections.js';
import { mountAppearanceSection } from './sections-appearance.js';
import { themeWithBranding, brandingHtml, brandBlockHtml, mountLogoRoute } from '../branding/appearance.js';
import { mountAlertsSection } from './sections-alerts.js';
import { mountUsersSection } from './sections-users.js';
import { mountMaintenanceSection, mountAnnouncementSection } from './sections-maintenance.js';
import { mountPasswordPolicySection } from './sections-password.js';
import { mountIncidentsSection } from './sections-incidents.js';
import { mountRegistrySection } from './sections-registry.js';
import { mountBroadcastSection } from './sections-broadcast.js';
import { mountTasksSection, mountMailSection, mountConfigSection, failedTasks, mailProblems, SYSTEM_TEXTS } from './sections-system.js';
import { mountBackupsSection, mountLogsSection, mountAboutSection } from './sections-ops.js';
export { createMetrics, ensureMetricsTable, hourBucket } from './metrics.js';
export { svgBarChart, svgLineChart } from './charts.js';
export { readForm } from './sections.js';
export { createStepUp, safeNext } from './step-up.js';
export { ALERT_TEXTS } from './sections-alerts.js';
export { SYSTEM_TEXTS, flattenConfig } from './sections-system.js';
export { compareVersions, readDependencies, checkLatest } from './sections-ops.js';

const T = {
  ru: {
    overview: 'Обзор', maintenanceOn: 'Включён режим обслуживания: посетители видят страницу «Ведутся технические работы»', uptime: 'Время работы', memory: 'Память (RSS)', db: 'Размер базы', users: 'Пользователи',
    sessions: 'Сессии', audit: 'Записей аудита', node: 'Node.js', requests: 'Запросы по часам (24 ч, UTC)',
    errors: 'Ошибки 5xx по часам (24 ч, UTC)', na: 'нет данных', title: 'Администрирование', controlTitle: 'Управление приложением', searchTitle: 'Поиск по разделам', searchPlaceholder: 'Найти раздел…', searchLabel: 'Поиск по разделам', searchGo: 'Найти', searchNone: 'Ничего не найдено. Попробуйте другое слово: «пароль», «копия», «логотип».', searchHint: 'Введите название раздела или слово, например «пароль», «копия», «логотип».', controlHint: 'Работа приложения: резервные копии, режим обслуживания, объявление, рассылка, задачи, почта.', 
    pid: 'PID процесса', heap: 'Куча Node', load: 'Нагрузка CPU (1 мин)', ramFree: 'Свободно ОЗУ', diskFree: 'Свободно на диске', migrations: 'Миграции', migPending: 'ожидают применения', migApplied: 'применено',
    period: 'Период', p24h: '24 часа', p7d: '7 дней', p30d: '30 дней', utc: 'время UTC',
    chartExpand: 'Развернуть график', limitOf: 'из', alertLimitOver: 'Лимит превышен', alertLimitNear: 'Близко к лимиту', alertIncidents: 'Открытые инциденты безопасности', alertHigh: 'высокой важности', alertLate: 'просрочено уведомление', cRequests: 'Запросы', cClient: 'Ошибки клиента (4xx)', cServer: 'Ошибки сервера (5xx)', cLatency: 'Среднее время ответа', msUnit: ' мс',
    cLoginOk: 'Входы: успешные', cLoginFail: 'Входы: неудачные', cSessions: 'Активные сессии', cDb: 'Размер базы', mbUnit: ' МБ', cMail: 'Очередь почты: ожидают отправки',
  },
  en: {
    overview: 'Overview', maintenanceOn: 'Maintenance mode is on: visitors see the "Maintenance in progress" page', uptime: 'Uptime', memory: 'Memory (RSS)', db: 'Database size', users: 'Users',
    sessions: 'Sessions', audit: 'Audit entries', node: 'Node.js', requests: 'Requests per hour (24 h, UTC)',
    errors: '5xx errors per hour (24 h, UTC)', na: 'no data', title: 'Administration', controlTitle: 'Application control', searchTitle: 'Search sections', searchPlaceholder: 'Find a section…', searchLabel: 'Search sections', searchGo: 'Search', searchNone: 'Nothing found. Try another word: "password", "backup", "logo".', searchHint: 'Type a section name or a word, for example "password", "backup", "logo".', controlHint: 'Running the application: backups, maintenance mode, announcement, broadcast, tasks, mail.', 
    pid: 'Process PID', heap: 'Node heap', load: 'CPU load (1 min)', ramFree: 'Free RAM', diskFree: 'Free disk space', migrations: 'Migrations', migPending: 'pending', migApplied: 'applied',
    period: 'Period', p24h: '24 hours', p7d: '7 days', p30d: '30 days', utc: 'UTC time',
    chartExpand: 'Expand chart', limitOf: 'of', alertLimitOver: 'Limit exceeded', alertLimitNear: 'Close to the limit', alertIncidents: 'Open security incidents', alertHigh: 'high severity', alertLate: 'notice overdue', cRequests: 'Requests', cClient: 'Client errors (4xx)', cServer: 'Server errors (5xx)', cLatency: 'Average response time', msUnit: ' ms',
    cLoginOk: 'Sign-ins: successful', cLoginFail: 'Sign-ins: failed', cSessions: 'Active sessions', cDb: 'Database size', mbUnit: ' MB', cMail: 'Mail queue: waiting to be sent',
  },
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function human(bytes) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
function duration(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

/**
 * Admin section (`/admin`): reachable only after login AND with the `admin.access` permission.
 * Framework-free: `mount()` only needs the app's own requireAuth / requirePermission factories
 * (core/http provides both). Further sections (audit, security, ...) plug in through `sections`.
 *
 * @param {object} o
 * @param {object} o.db - database adapter
 * @param {object} [o.metrics] - createMetrics() instance; without it the charts are omitted
 * @param {string} [o.dbFilePath] - for the "database size" tile
 * @param {object} [o.theme] - {tokens, darkTokens, cssUrl}
 * @param {string} [o.brandHtml]
 * @param {string} [o.permission='admin.access']
 * @param {{read: string, export: string, sensitive?: string}|null} [o.auditAccess] - e.g. `{ read: 'audit.read', export: 'audit.export' }`: a user with `read` (and no `admin.access`) sees only the Audit section; the CSV/JSON export needs `export`. Optional `sensitive` (e.g. 'audit.sensitive'): without it the reader sees the journal without addresses (IP), details (`meta`, "what changed") and the top-IP list, and the export leaves those columns out; if `sensitive` is not set everyone with access sees all. Holders of `permission` keep everything. Default null: the audit is for `permission` only
 * @param {Array<{path:string,label:string,permission?:string}>} [o.sections] - extra nav entries
 * @param {object} [o.vendorIdentity] - the app's `branding.defineVendorIdentity()`: the menu header shows the administrator's name and logo, else this identity's own
 * @param {string} [o.basePath='/admin']
 * @param {object} [o.bans] - createBans() instance; enables the "Security" section (bans + sessions)
 * @param {boolean} [o.users=true] - "Users" section (list, disable/enable)
 * @param {object} [o.userManagement] - turns the section into full account administration: `{ authProvider, roles, adminRole?, email?, allowDelete?, onPasswordReset? }` (see mountUsersSection)
 * @param {{list:Function, run?:Function}} [o.backups] - "Backups" section: list() -> rows, run() -> starts a backup
 * @param {object} [o.announcement] - `announcement.createAnnouncement()` result; adds the "Announcement" section and shows the banner above every admin page
 * @param {() => {entries: object[], gaps: string[]}} [o.processingRegistry] - e.g. `() => privacy.buildProcessingRegistry({ moduleRegistry, config })`; adds the "Processing register" section (table and md/csv/json downloads)
 * @param {object} [o.incidents] - `privacy.createIncidentRegister()` result; adds the "Incidents" section (register of security incidents with notice deadlines)
 * @param {object} [o.passwordPolicy] - `auth.createPasswordPolicy()` result; adds the "Password policy" section (profile, lengths, character classes, "require a new password")
 * @param {object} [o.maintenance] - `maintenance.createMaintenance()` result; adds the "Maintenance mode" section and a notice on the overview while it is on
 * @param {object} [o.scheduler] - `scheduler.createScheduler()` result; adds the "Tasks" section (state of every job, run now) and a warning on the overview for jobs whose last run failed
 * @param {() => Array<{name: string, applied: boolean}>} [o.migrations] - database migrations (e.g. `cli.migrationStatus(db, dir)`); the overview shows how many are applied and lists the pending ones
 * @param {object} [o.taskSchedules] - `scheduler.createTaskSchedules()` result; the "Tasks" section then lets the administrator change a task's schedule
 * @param {Record<string,'backups'|'about'>} [o.managedTasks] - tasks that have their own switch in another section (e.g. `{ backup: 'backups', 'alerts-doctor': 'about' }`); the row links there instead of offering a schedule form
 * @param {{queue?: object, service?: object}} [o.mail] - `{ queue: email.createEmailQueue(), service: email.createEmailService() }`; adds the "Mail" section (queue counters and newest rows)
 * @param {object} [o.config] - the application's loaded configuration; adds the read-only "Configuration" section (secrets hidden)
 * @param {object} [o.alerts] - `alerts.createAlerts()` result; adds the "Alerts" section
 * @param {boolean} [o.alertsMail=false] - whether alert e-mails can be sent (only changes the hint on the page)
 * @param {object} [o.logDestination] - createLogDestination() result; the "Logs" section shows its sink counters
 * @param {{packageJsonPath:string, nodeModulesDir?:string, appName?:string, appVersion?:string, coreVersion?:string, fetchFn?:Function}} [o.about] - "About" section
 * @param {{uploadsDir:string, fallbackName?:string, maxBytes?:number}} [o.appearance] - "Appearance" section: company name, logos (light/dark), accent colors; also applied to every admin page
 * @param {Record<string, {ru?: object, en?: object}>} [o.texts] - overrides of core admin texts by namespace (see i18n.coreNamespaces())
 * @param {object} [o.policy] - createPolicy() instance; enables the "Policies" section (texts, cookie notice)
 * @param {string} [o.accountUrl='/ui/account'] - the administrator's name in the page header links to the account settings; empty = plain text
 * @param {object|null} [o.limits] - `{ users, sessions, audit, db, memory }`, each `{ max }` (db and memory in bytes): the overview shows "value of limit" with a bar, amber from 80 %, red from 100 %, and a notice on top
 * @param {string|null} [o.controlPath=null] - e.g. '/control': application operation (backups, maintenance mode, announcement, broadcast, tasks, mail) moves to its own area with its own menu and page, apart from the administration area; null = everything stays under basePath
 * @param {string} [o.appUrl='/ui'] - where the "back to the app" link at the top of the menu goes
 * @param {(req, res, locale) => string} [o.bodyEnd] - trusted markup at the end of every admin page (default: policy.pageEnd)
 * @param {Function[]} [o.stepUp] - extra middleware for dangerous POST actions (e.g. a fresh-MFA check)
 */
export function createAdmin({ texts = {}, incidents = null, processingRegistry = null, db, metrics, dbFilePath, theme = {}, brandHtml = '', permission = 'admin.access', sections = [], basePath = '/admin', startedAt = Date.now(), bans = null, stepUp = [], vendorIdentity = null, users = true, userManagement = null, maintenance = null, announcement = null, scheduler = null, mail = null, config = null, configSources = null, auditAccess = null, backups = null, logDestination = null, alerts = null, alertsMail = false, about = null, appearance = null, policy = null, bodyEnd = null, appUrl = '/ui', taskSchedules = null, managedTasks = {}, migrations = null, accountUrl = '/ui/account', passwordPolicy = null, controlPath = null, limits = null, notifications = null, notificationsUrl = '/ui/notifications' } = {}) {
  const tt = (locale) => pickTexts(T, texts['admin-overview'], locale, 'admin-overview');
  const localeOf = (req) => (req.query?.lang === 'en' ? 'en' : req.query?.lang === 'ru' ? 'ru' : (req.locale === 'en' ? 'en' : 'ru'));

  const ctl = controlPath || basePath; // where the operation sections live
  const split = Boolean(controlPath) && controlPath !== basePath;
  const GROUPS = {
    security: { ru: 'Безопасность', en: 'Security' }, system: { ru: 'Система', en: 'System' },
    operation: { ru: 'Обслуживание', en: 'Operation' }, other: { ru: 'Прочее', en: 'Other' },
  };
  const group = (heading, items) => { const on = items.flat().filter(Boolean); return on.length ? [{ heading }, ...on] : []; };
  const item = (cond, path, label) => (cond ? { path, label } : null);

  function nav(locale, area = 'admin') {
    const operation = [
      item(backups, `${ctl}/backups`, 'backups'), item(maintenance, `${ctl}/maintenance`, 'maintenance'), item(announcement, `${ctl}/announcement`, 'announcement'),
      item(scheduler, `${ctl}/tasks`, 'tasks'), item(mail, `${ctl}/mail`, 'mail'), item(mail?.service, `${ctl}/broadcast`, 'broadcast'),
    ];
    const toApp = { path: appUrl, label: { ru: '← В приложение', en: '← Back to app' } };
    const items = area === 'control'
      ? [toApp, { path: controlPath, label: { ru: 'Управление', en: 'Control' } }, ...group(GROUPS.operation, operation), { path: basePath, label: { ru: 'Администрирование →', en: 'Administration →' } }]
      : [
        toApp,
        { path: basePath, label: 'overview' },
        ...(users ? [{ path: `${basePath}/users`, label: 'users' }] : []),
        ...group(GROUPS.security, [
          item(true, `${basePath}/audit`, 'audit'), item(bans, `${basePath}/security`, 'security'), item(passwordPolicy, `${basePath}/password-policy`, 'passwordPolicy'),
          item(incidents, `${basePath}/incidents`, 'incidents'), item(processingRegistry, `${basePath}/registry`, 'registry'), item(policy, `${basePath}/policy`, 'policy'),
        ]),
        ...group(GROUPS.system, [item(alerts, `${basePath}/alerts`, 'alerts'), item(logDestination, `${basePath}/logs`, 'logs'), item(config, `${basePath}/config`, 'config'), item(about, `${basePath}/about`, 'about')]),
        ...(split ? [] : group(GROUPS.operation, operation)),
        ...group(GROUPS.other, [item(appearance, `${basePath}/appearance`, 'appearance'), ...sections]),
        ...(split && operation.some(Boolean) ? [{ heading: { ru: 'Управление', en: 'Control' } }, { path: controlPath, label: { ru: 'Управление приложением →', en: 'Application control →' } }] : []),
      ];
    return {
      getNavigation: () => items,
      getTranslations: () => ({
        ru: { overview: tt('ru').overview, audit: 'Аудит', security: 'Безопасность', users: 'Пользователи', passwordPolicy: 'Парольная политика', incidents: 'Инциденты', registry: 'Реестр обработки', broadcast: 'Рассылка', backups: 'Резервные копии', maintenance: 'Режим обслуживания', announcement: 'Объявление', tasks: 'Задачи', mail: 'Почта', config: 'Конфигурация', alerts: 'Алерты', logs: 'Логи', about: 'О системе', appearance: 'Оформление', policy: 'Политики' },
        en: { overview: tt('en').overview, audit: 'Audit', security: 'Security', users: 'Users', passwordPolicy: 'Password policy', incidents: 'Incidents', registry: 'Processing register', broadcast: 'Broadcast', backups: 'Backups', maintenance: 'Maintenance', announcement: 'Announcement', tasks: 'Tasks', mail: 'Mail', config: 'Configuration', alerts: 'Alerts', logs: 'Logs', about: 'About', appearance: 'Appearance', policy: 'Policies' },
      }),
      locale,
    };
  }

  function count(sql) {
    try { return db.get(sql).n; } catch { return null; }
  }

  /**
   * `limits` = `{ users: {max}, sessions: {max}, audit: {max}, db: {max}, memory: {max} }` (db and memory in bytes).
   * A figure with a limit shows "value of limit" and a bar: amber from 80 %, red from 100 %.
   */
  function limitOfTile(key, value, fmt) {
    const max = Number(limits?.[key]?.max);
    if (!Number.isFinite(max) || max <= 0) return null;
    const ratio = value / max;
    return { max, text: fmt(max), ratio, level: ratio >= 1 ? 'over' : ratio >= 0.8 ? 'near' : 'ok' };
  }

  function tiles(t) {
    const out = [];
    out.push([t.uptime, duration((Date.now() - startedAt) / 1000)]);
    out.push([t.memory, human(process.memoryUsage().rss), limitOfTile('memory', process.memoryUsage().rss, human)]);
    if (dbFilePath) {
      try { const sz = statSync(dbFilePath).size; out.push([t.db, human(sz), limitOfTile('db', sz, human)]); } catch { out.push([t.db, t.na]); }
    }
    for (const [label, sql] of [[t.users, 'SELECT COUNT(*) AS n FROM users'], [t.sessions, 'SELECT COUNT(*) AS n FROM sessions'], [t.audit, 'SELECT COUNT(*) AS n FROM audit_log']]) {
      const n = count(sql);
      out.push([label, n === null ? t.na : String(n), n === null ? null : limitOfTile(sql.includes('users') ? 'users' : sql.includes('sessions') ? 'sessions' : 'audit', n, String)]);
    }
    out.push([t.node, process.version]);
    out.push([t.pid, String(process.pid)]);
    out.push([t.heap, human(process.memoryUsage().heapUsed)]);
    // load average does not exist on Windows (it reads 0 there), so the tile is left out instead of showing a false zero
    if (process.platform !== 'win32') out.push([t.load, `${os.loadavg()[0].toFixed(2)} / ${os.availableParallelism?.() ?? os.cpus().length}`]);
    out.push([t.ramFree, `${human(os.freemem())} / ${human(os.totalmem())}`]);
    if (dbFilePath) {
      try { const s = statfsSync(nodePath.dirname(dbFilePath)); out.push([t.diskFree, human(Number(s.bavail) * Number(s.bsize))]); } catch { /* the volume cannot be read: no tile */ }
    }
    // migrations are only worth a tile when something waits to be applied
    if (migrations) {
      try {
        const pending = migrations().filter((x) => !x.applied).length;
        if (pending) out.push([t.migrations, `${pending} ${t.migPending}`]);
      } catch { /* unknown: no tile */ }
    }
    return out;
  }

  /** Levels for the charts (sessions, database size, mail queue), sampled every few minutes and once at start. */
  function sampleGauges() {
    try {
      const sessions = count('SELECT COUNT(*) AS n FROM sessions');
      if (sessions !== null) metrics.set('sessions.active', sessions);
      if (dbFilePath) metrics.set('db.bytes', statSync(dbFilePath).size);
      const pending = mail?.queue?.stats?.()?.pending;
      if (Number.isFinite(pending)) metrics.set('mail.pending', pending);
    } catch { /* a missing table or file just leaves a gap */ }
  }
  if (metrics?.set) {
    sampleGauges();
    setInterval(sampleGauges, 300_000).unref?.();
  }

  const periodOf = (v) => (['24h', '7d', '30d'].includes(v) ? v : '24h');
  const labelOf = (bucket, period) => (period === '24h' ? `${bucket.slice(11)}:00` : period === '7d' ? `${bucket.slice(5, 10)} ${bucket.slice(11)}h` : bucket.slice(5, 10));
  const pointsOf = (series, period, f = (v) => v) => series.map((p) => ({ label: labelOf(p.bucket, period), value: p.value === null ? null : f(p.value) }));

  /** Sign-ins per point from the audit log (no extra counters): success or failure of `auth.login`. */
  function loginSeries(period, result) {
    const hours = { '24h': 24, '7d': 168, '30d': 720 }[period];
    const step = { '24h': 1, '7d': 6, '30d': 24 }[period];
    const end = new Date(); end.setUTCMinutes(0, 0, 0);
    const buckets = [];
    for (let i = hours - 1; i >= 0; i--) buckets.push(new Date(end.getTime() - i * 3600_000).toISOString().slice(0, 13));
    let rows = [];
    try {
      rows = db.all(`SELECT substr(replace(created_at, ' ', 'T'), 1, 13) AS b, COUNT(*) AS n FROM audit_log WHERE action = 'auth.login' AND result = ? AND replace(created_at, ' ', 'T') >= ? GROUP BY b`, [result, buckets[0]]);
    } catch { /* no audit table */ }
    const by = new Map(rows.map((r) => [r.b, r.n]));
    const out = [];
    for (let i = 0; i < buckets.length; i += step) out.push({ bucket: buckets[i], value: buckets.slice(i, i + step).reduce((a, k) => a + (by.get(k) ?? 0), 0) });
    return out;
  }

  /** Alerts about the running application (maintenance mode, failed tasks, stuck mail): on the overview and on the control page. */
  function opsAlerts(locale) {
    const t = tt(locale);
    const mState = maintenance?.get();
    let html = mState?.enabled ? `<a class="adm-card" href="${ctl}/maintenance" style="display:block;margin-bottom:1rem;border-left:4px solid var(--adm-danger);text-decoration:none;color:inherit"><strong>${esc(t.maintenanceOn)}</strong></a>` : '';
    const sys = pickTexts(SYSTEM_TEXTS, texts['admin-system'], locale, 'admin-system');
    const warn = (href, text) => `<a class="adm-card" href="${href}" style="display:block;margin-bottom:1rem;border-left:4px solid var(--adm-warn);text-decoration:none;color:inherit"><strong>${esc(text)}</strong></a>`;
    if (scheduler) { const bad = failedTasks(scheduler); if (bad.length) html += warn(`${ctl}/tasks`, `${sys.alertTasks}: ${bad.map((j) => j.name).join(', ')}`); }
    if (mail?.queue && mailProblems(mail.queue)) html += warn(`${ctl}/mail`, sys.alertMail);
    return html;
  }

  function overviewHtml(locale, periodRaw) {
    const t = tt(locale);
    let html = opsAlerts(locale);
    if (incidents) {
      // open incidents: red when one is of high severity or has a notice deadline passed, amber otherwise
      const open = incidents.list({ limit: 1000 }).filter((i) => i.status !== 'closed');
      const high = open.filter((i) => i.severity === 'high').length;
      const late = open.filter((i) => i.firstNoticeDue?.overdue || i.detailsDue?.overdue).length;
      if (open.length) {
        const colour = high || late ? 'var(--adm-danger)' : 'var(--adm-warn)';
        const detail = [high ? `${t.alertHigh}: ${high}` : '', late ? `${t.alertLate}: ${late}` : ''].filter(Boolean).join(', ');
        html += `<a class="adm-card" href="${basePath}/incidents" style="display:block;margin-bottom:1rem;border-left:4px solid ${colour};text-decoration:none;color:inherit"><strong>${esc(t.alertIncidents)}: ${open.length}</strong>${detail ? `<div class="adm-muted">${esc(detail)}</div>` : ''}</a>`;
      }
    }
    const tileList = tiles(t);
    const hot = tileList.filter((x) => x[2] && x[2].level !== 'ok');
    if (hot.length) {
      const over = hot.some((x) => x[2].level === 'over');
      html += `<div class="adm-card" role="alert" style="margin-bottom:1rem;border-left:4px solid ${over ? 'var(--adm-danger)' : 'var(--adm-warn)'}"><strong>${esc(over ? t.alertLimitOver : t.alertLimitNear)}</strong> <span class="adm-muted">${hot.map((x) => `${esc(x[0])}: ${esc(x[1])} ${esc(t.limitOf)} ${esc(x[2].text)}`).join('; ')}</span></div>`;
    }
    html += `<div class="adm-grid">${tileList.map(([k, v, lim]) => `<div class="adm-card"><h2>${esc(k)}</h2><div class="adm-stat">${esc(v)}${lim ? ` <span class="adm-muted" style="font-size:.9rem;font-weight:400">${esc(t.limitOf)} ${esc(lim.text)}</span>` : ''}</div>${lim ? `<div class="adm-bar ${lim.level}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100, Math.round(lim.ratio * 100))}"><span style="width:${Math.min(100, Math.round(lim.ratio * 100))}%"></span></div>` : ''}</div>`).join('')}</div>`;
    if (metrics) {
      const period = periodOf(periodRaw);
      const tabs = ['24h', '7d', '30d'].map((k) => `<a class="adm-btn${k === period ? ' primary' : ''}" href="${basePath}?period=${k}"${k === period ? ' aria-current="page"' : ''}>${esc(t[`p${k}`])}</a>`).join(' ');
      const card = (title, svg) => `<div class="adm-card" data-chart><h2>${esc(title)}<button type="button" class="adm-chart-open" data-chart-open aria-label="${esc(t.chartExpand)}" title="${esc(t.chartExpand)}">⤢</button></h2>${svg}</div>`;
      const bar = (title, series, o = {}) => card(title, svgBarChart(pointsOf(series, period), { title, ...o }));
      const line = (title, series, o = {}) => card(title, svgLineChart(pointsOf(series, period, o.map), { title, ...o }));
      const charts = [
        bar(t.cRequests, metrics.periodSeries('http.requests', period)),
        bar(t.cClient, metrics.periodSeries('http.4xx', period), { color: 'var(--adm-warn)' }),
        bar(t.cServer, metrics.periodSeries('http.5xx', period), { color: 'var(--adm-danger)' }),
        line(t.cLatency, metrics.periodAverage('http.ms', 'http.requests', period), { unit: t.msUnit, map: (v) => Math.round(v * 10) / 10 }),
        bar(t.cLoginOk, loginSeries(period, 'success')),
        bar(t.cLoginFail, loginSeries(period, 'failure'), { color: 'var(--adm-danger)' }),
      ];
      for (const [name, title, o] of [['sessions.active', t.cSessions, {}], ['db.bytes', t.cDb, { unit: t.mbUnit, map: (v) => Math.round((v / 1048576) * 10) / 10 }], ['mail.pending', t.cMail, {}]]) {
        const s = metrics.periodSeries(name, period, { mode: 'last' });
        if (s.some((p) => p.value !== null)) charts.push(line(title, s, o));
      }
      html += `<div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-top:1rem"><strong>${esc(t.period)}:</strong> ${tabs} <span class="adm-muted">${esc(t.utc)}</span></div><div class="adm-grid" style="margin-top:1rem">${charts.join('')}</div>`;
    }
    return html;
  }

  const has = (user, perm) => Boolean(perm) && (user?.permissions instanceof Set ? user.permissions.has(perm) : (user?.permissions ?? []).includes(perm));
  /** Lets through whoever holds ANY of the permissions; everyone else gets the usual 401/403 of the main permission. */
  const anyOf = (requirePermission, perms) => { const deny = requirePermission(permission); return (req, res, next) => (perms.some((p) => has(req.user, p)) ? next() : deny(req, res, next)); };
  /** An auditor (audit access without `permission`) sees the way back to the app and the Audit section, nothing else. */
  const navFor = (req, locale, area) => {
    const reg = nav(locale, area);
    if (!auditAccess || has(req.user, permission)) return reg;
    const keep = reg.getNavigation().filter((i, idx) => idx === 0 || i.path === `${basePath}/audit`);
    return { ...reg, getNavigation: () => keep };
  };

  function page(req, res, { active, title, bodyHtml }, area = 'admin') {
    const locale = localeOf(req);
    // Wide tables scroll inside their card on a narrow screen instead of stretching the page.
    bodyHtml = String(bodyHtml ?? '').replace(/<table class="adm-table"/g, '<div class="adm-scroll"><table class="adm-table"').replace(/<\/table>/g, '</table></div>');
    res.set('Cache-Control', 'no-store');
    res.type('html').send(renderAppShell({
      moduleRegistry: navFor(req, locale, area), viewerPermissions: req.user?.permissions ?? [], locale, activePath: active,
      title, bodyHtml, theme: appearance ? themeWithBranding(db, theme) : theme, user: req.user, brandHtml: vendorIdentity ? brandBlockHtml(db, vendorIdentity) : appearance ? brandingHtml(db, { fallbackName: appearance.fallbackName ?? '' }) || brandHtml : brandHtml, nonce: res.locals?.cspNonce,
      bellHtml: notifications && req.user?.id ? bellHtml({ url: notificationsUrl, count: notifications.unreadCount(req.user.id), locale }) : '',
      userBadge: req.user?.role ?? '',
      homeUrl: appUrl, accountUrl, showLogout: true, badge: area === 'control' ? tt(locale).controlTitle : tt(locale).title,
      bodyEndHtml: (bodyEnd ?? policy?.pageEnd)?.(req, res, locale) ?? '',
      bannerHtml: announcement?.bannerHtml(locale, { nonce: res.locals?.cspNonce }) ?? '',
      navTopHtml: `<form class="adm-search" role="search" action="${basePath}/search" method="get"><input type="search" name="q" maxlength="80" placeholder="${esc(tt(locale).searchPlaceholder)}" aria-label="${esc(tt(locale).searchLabel)}"></form>`,
    }));
  }

  /** Guard chain for any admin route: login, then the permission. */
  function guard({ requireAuth, requirePermission }) {
    return [requireAuth(), requirePermission(permission)];
  }

  function mount(app, { requireAuth, requirePermission }) {
    const g = guard({ requireAuth, requirePermission });
    // search over the sections of both areas (by name and by the words a person would look for)
    app.get(`${basePath}/search`, ...g, (req, res) => {
      const locale = localeOf(req);
      const t = tt(locale);
      const q = String(req.query?.q ?? '').slice(0, 80);
      const index = [];
      for (const area of ['admin', 'control']) {
        if (area === 'control' && !split) continue;
        const n = nav(locale, area);
        const names = n.getTranslations()[locale] ?? {};
        let groupName = '';
        for (const it of n.getNavigation()) {
          if (it.heading) { groupName = typeof it.heading === 'object' ? (it.heading[locale] ?? it.heading.ru) : String(it.heading); continue; }
          if (!it.path || it.path === appUrl || index.some((e) => e.path === it.path)) continue;
          const label = typeof it.label === 'object' ? (it.label[locale] ?? it.label.ru) : (names[it.label] ?? it.label);
          const lab = typeof it.label === 'object' ? it.label : null;
          const tr = n.getTranslations();
          index.push({ key: typeof it.label === 'string' ? it.label : null, label, labels: lab ?? { ru: tr.ru?.[it.label], en: tr.en?.[it.label] }, group: groupName, path: it.path });
        }
      }
      const found = searchSections(index, q, locale);
      // settings are found by their parameters too (in either language): each matching key links to the configuration page filtered by it
      if (config && q.trim()) {
        const cfgPath = `${basePath}/config`;
        for (const [k] of flattenCfg(config)) {
          if (found.length >= 30) break;
          if (configKeyMatches(k, q)) found.push({ key: null, label: k, group: t.configGroup ?? 'Configuration', path: `${cfgPath}?q=${encodeURIComponent(k)}` });
        }
      }
      const body = `<form action="${basePath}/search" method="get" style="margin-bottom:1rem"><input type="search" name="q" value="${esc(q)}" maxlength="80" autofocus placeholder="${esc(t.searchPlaceholder)}" aria-label="${esc(t.searchLabel)}" style="width:min(28rem,100%);padding:.5rem .7rem"> <button class="adm-btn primary" type="submit">${esc(t.searchGo)}</button></form>`
        + (found.length
          ? `<div class="adm-grid">${found.map((e) => `<a class="adm-card" href="${esc(e.path)}" style="display:block;text-decoration:none;color:inherit"><h2>${esc(e.label)}</h2>${e.group ? `<div class="adm-muted">${esc(e.group)}</div>` : ''}</a>`).join('')}</div>`
          : `<p class="adm-muted">${esc(q ? t.searchNone : t.searchHint)}</p>`);
      page(req, res, { active: `${basePath}/search`, title: t.searchTitle, bodyHtml: body });
    });
    app.get(basePath, ...g, (req, res) => {
      const locale = localeOf(req);
      page(req, res, { active: basePath, title: tt(locale).overview, bodyHtml: overviewHtml(locale, req.query?.period) });
    });
    const ctx = { app, db, guard: g, page, basePath, localeOf, stepUp, texts };
    // the operation sections live under controlPath when it is set (own menu, own badge), else next to the rest
    const ctxOps = split ? { ...ctx, basePath: controlPath, page: (req, res, o) => page(req, res, o, 'control') } : ctx;
    if (split) {
      app.get(controlPath, ...g, (req, res) => {
        const locale = localeOf(req);
        const t = tt(locale);
        const cards = nav(locale, 'control').getNavigation().filter((i) => i.path && i.path.startsWith(`${controlPath}/`) && typeof i.label === 'string');
        const names = nav(locale, 'control').getTranslations()[locale] ?? {};
        const links = cards.map((i) => `<a class="adm-card" href="${esc(i.path)}" style="display:block;text-decoration:none;color:inherit"><h2>${esc(names[i.label] ?? i.label)}</h2></a>`).join('');
        page(req, res, { active: controlPath, title: t.controlTitle, bodyHtml: `${opsAlerts(locale)}<p class="adm-muted">${esc(t.controlHint)}</p><div class="adm-grid">${links}</div>` }, 'control');
      });
    }
    mountAuditSection(auditAccess
      ? { ...ctx, guard: [requireAuth(), anyOf(requirePermission, [permission, auditAccess.read])], exportGuard: [requireAuth(), anyOf(requirePermission, [permission, auditAccess.export])], canExport: (req) => has(req.user, permission) || has(req.user, auditAccess.export), canSeeSensitive: (req) => !auditAccess.sensitive || has(req.user, permission) || has(req.user, auditAccess.sensitive) }
      : ctx);
    if (bans) mountSecuritySection({ ...ctx, bans });
    if (users) mountUsersSection({ ...ctx, manage: userManagement });
    if (passwordPolicy) mountPasswordPolicySection({ ...ctx, passwordPolicy, adminRoles: userManagement?.adminRole ? [userManagement.adminRole] : [] });
    if (incidents) mountIncidentsSection({ ...ctx, incidents });
    if (processingRegistry) mountRegistrySection({ ...ctx, build: processingRegistry });
    if (backups) mountBackupsSection({ ...ctxOps, backups });
    if (maintenance) mountMaintenanceSection({ ...ctxOps, maintenance });
    if (announcement) mountAnnouncementSection({ ...ctxOps, announcement });
    if (scheduler) mountTasksSection({ ...ctxOps, scheduler, taskSchedules, managedTasks });
    if (mail) mountMailSection({ ...ctxOps, mail });
    if (mail?.service) mountBroadcastSection({ ...ctxOps, mail, roles: userManagement?.roles ?? [] });
    if (config) mountConfigSection({ ...ctx, config, configSources });
    if (alerts) mountAlertsSection({ ...ctx, stepUp, alerts, mailConfigured: Boolean(alertsMail) });
    if (logDestination) mountLogsSection({ ...ctx, stepUp, logDestination });
    if (appearance) {
      mountLogoRoute(app, { db, uploadsDir: appearance.uploadsDir }); // public: the login page shows the logo too
      mountAppearanceSection({ ...ctx, appearance });
    }
    if (about) mountAboutSection({ ...ctx, about });
    if (policy) policy.mountAdmin(ctx);
    return { guard: g, page };
  }

  return { mount, guard, page, overviewHtml, tiles };
}

export { T as OVERVIEW_TEXTS };
