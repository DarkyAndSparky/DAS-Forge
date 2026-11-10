import { writeCsv } from '../csv/index.js';
/**
 * Register of personal-data processing: one line per place where the platform or a module keeps data about people:
 * what for, which data, on what basis, how long, how it is erased. Built from what the code and the configuration
 * really say (modules declare `dataSubject.purpose / legalBasis / retentionDays`), so it cannot drift from the system.
 * The legal basis of the platform's own data is the application owner's decision and is left to fill in.
 */
const FILL = { ru: 'определяет владелец приложения', en: 'to be set by the application owner' };
const NOT_DECLARED = { ru: 'не указано модулем', en: 'not declared by the module' };

const days = (n, lang) => (n === 0 || n == null ? (lang === 'ru' ? 'без срока' : 'unlimited') : lang === 'ru' ? `${n} дн.` : `${n} days`);
const hours = (ms, lang) => `${Math.round(ms / 3600000)} ${lang === 'ru' ? 'ч' : 'h'}`;

/** The platform's own entries, in both languages; retention comes from the configuration. */
function coreEntries(cfg = {}) {
  const audit = cfg.audit?.retentionDays;
  const session = cfg.auth?.sessionTtlMs ?? cfg.auth?.sessionTtl;
  return [
    { id: 'core.accounts', ru: { name: 'Учётные записи', purpose: 'Вход в систему и разграничение прав', data: 'логин, e-mail, роль, хеш пароля, признаки блокировки', retention: 'пока запись существует', erasure: 'обезличивание или удаление (privacy erase, админка)' },
      en: { name: 'Accounts', purpose: 'Signing in and access rights', data: 'login, e-mail, role, password hash, lock flags', retention: 'while the account exists', erasure: 'anonymise or delete (privacy erase, admin panel)' } },
    { id: 'core.password_history', ru: { name: 'История паролей', purpose: 'Запрет повторного использования паролей', data: 'только хеши прошлых паролей и дата смены', retention: 'пока запись существует (не более 24 хешей)', erasure: 'вместе с учётной записью' },
      en: { name: 'Password history', purpose: 'Banning reuse of old passwords', data: 'hashes of past passwords and the change date only', retention: 'while the account exists (at most 24 hashes)', erasure: 'with the account' } },
    { id: 'core.sessions', ru: { name: 'Сессии', purpose: 'Поддержание входа', data: 'время создания и последнего запроса, срок действия', retention: session ? hours(session, 'ru') : 'срок сессии из настроек', erasure: 'удаляются при выходе, истечении и обезличивании' },
      en: { name: 'Sessions', purpose: 'Keeping the sign-in', data: 'creation and last-request time, expiry', retention: session ? hours(session, 'en') : 'the configured session lifetime', erasure: 'removed on sign-out, expiry and anonymisation' } },
    { id: 'core.authenticators', ru: { name: 'Способы входа (MFA)', purpose: 'Многофакторная защита входа', data: 'тип, название, статус; секреты хранятся зашифрованными', retention: 'пока запись существует', erasure: 'вместе с учётной записью' },
      en: { name: 'Sign-in factors (MFA)', purpose: 'Multi-factor protection of sign-in', data: 'type, label, status; secrets are stored encrypted', retention: 'while the account exists', erasure: 'with the account' } },
    { id: 'core.audit', ru: { name: 'Журнал аудита', purpose: 'Расследование событий безопасности, подотчётность действий', data: 'действия пользователей; логин и IP-адрес в виде псевдонимов', retention: days(audit, 'ru'), erasure: 'при обезличивании удаляется соответствие псевдонима; записи стареют по сроку хранения' },
      en: { name: 'Audit log', purpose: 'Investigating security events, accountability of actions', data: 'user actions; login and IP address as pseudonyms', retention: days(audit, 'en'), erasure: 'anonymisation deletes the pseudonym mapping; rows age out by the retention period' } },
    { id: 'core.backups', ru: { name: 'Резервные копии', purpose: 'Восстановление после сбоя', data: 'копия базы данных и файлов целиком', retention: days(cfg.backup?.retentionDays, 'ru'), erasure: 'удаление данных повторяется после восстановления (privacy reapply-erasures); копии стареют по сроку' },
      en: { name: 'Backups', purpose: 'Recovery after a failure', data: 'a copy of the whole database and files', retention: days(cfg.backup?.retentionDays, 'en'), erasure: 'erasures are re-applied after a restore (privacy reapply-erasures); copies age out' } },
    { id: 'core.mail', ru: { name: 'Очередь почты', purpose: 'Отправка служебных писем', data: 'адреса получателей в сокращённом виде, сценарий, статус', retention: 'пока письмо в очереди и после отправки до очистки', erasure: 'письма на адрес удаляются при обезличивании' },
      en: { name: 'Mail queue', purpose: 'Sending service e-mail', data: 'shortened recipient addresses, scenario, status', retention: 'while queued and after sending until cleanup', erasure: 'mails to the address are removed on anonymisation' } },
    { id: 'core.bans', ru: { name: 'Блокировки', purpose: 'Защита от злоупотреблений', data: 'IP-адрес или логин, причина, срок', retention: 'до снятия или истечения', erasure: 'снимаются администратором' },
      en: { name: 'Bans', purpose: 'Protection against abuse', data: 'IP address or login, reason, term', retention: 'until lifted or expired', erasure: 'lifted by an administrator' } },
    { id: 'core.incidents', ru: { name: 'Реестр инцидентов', purpose: 'Учёт инцидентов безопасности и сроков уведомления', data: 'описание инцидента, даты, принятые меры', retention: 'без срока (решает владелец)', erasure: 'вручную; персональные данные в описания вносить не следует' },
      en: { name: 'Incident register', purpose: 'Recording security incidents and notice deadlines', data: 'incident description, dates, measures taken', retention: 'unlimited (owner decides)', erasure: 'by hand; do not put personal data into descriptions' } },
  ].map((e) => ({ id: e.id, source: 'core', ru: { ...e.ru, legalBasis: FILL.ru }, en: { ...e.en, legalBasis: FILL.en } }));
}

/**
 * @param {object} o
 * @param {{getDataSubjectHandlers: () => Array}} [o.moduleRegistry]
 * @param {object} [o.config] - the application's configuration (audit, backup, auth sections are read)
 * @returns {{entries: object[], gaps: string[]}} `gaps`: ids of module entries without a declared purpose or legal basis
 */
export function buildProcessingRegistry({ moduleRegistry, config } = {}) {
  const entries = coreEntries(config);
  const gaps = [];
  for (const h of moduleRegistry?.getDataSubjectHandlers?.() ?? []) {
    const id = `module.${h.moduleId}`;
    if (!h.purpose || !h.legalBasis) gaps.push(id);
    const one = (lang) => ({
      name: h.moduleId, purpose: h.purpose ?? NOT_DECLARED[lang], data: lang === 'ru' ? 'определяет модуль (см. выгрузку данных человека)' : 'defined by the module (see the person data export)',
      legalBasis: h.legalBasis ?? NOT_DECLARED[lang], retention: days(h.retentionDays, lang),
      erasure: lang === 'ru' ? 'обработчик удаления модуля (privacy erase)' : "the module's erase handler (privacy erase)",
    });
    entries.push({ id, source: 'module', ru: one('ru'), en: one('en') });
  }
  return { entries, gaps };
}

const COLS = ['name', 'purpose', 'data', 'legalBasis', 'retention', 'erasure'];
const HEAD = {
  ru: { name: 'Что', purpose: 'Цель', data: 'Какие данные', legalBasis: 'Основание', retention: 'Срок хранения', erasure: 'Удаление' },
  en: { name: 'What', purpose: 'Purpose', data: 'Data', legalBasis: 'Legal basis', retention: 'Retention', erasure: 'Erasure' },
};

/** @param {'md'|'csv'|'json'} format @param {'ru'|'en'} lang */
export function formatProcessingRegistry(registry, { format = 'md', lang = 'ru' } = {}) {
  const L = lang === 'en' ? 'en' : 'ru';
  const rows = registry.entries.map((e) => ({ id: e.id, ...e[L] }));
  if (format === 'json') return JSON.stringify({ lang: L, entries: rows, gaps: registry.gaps }, null, 2);
  if (format === 'csv') {
    return writeCsv([['id', ...COLS.map((c) => HEAD[L][c])], ...rows.map((r) => [r.id, ...COLS.map((c) => r[c])])], { excel: L, quoteAll: true });
  }
  const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const title = L === 'ru' ? '# Реестр обработки персональных данных' : '# Register of personal-data processing';
  return [title, '', `| ID | ${COLS.map((c) => HEAD[L][c]).join(' | ')} |`, `|${'---|'.repeat(COLS.length + 1)}`, ...rows.map((r) => `| ${cell(r.id)} | ${COLS.map((c) => cell(r[c])).join(' | ')} |`)].join('\n');
}
