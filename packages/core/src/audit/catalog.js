/**
 * Event catalogue (audit chapter 3, stage B): a readable name, a category, a severity and a sentence for every audit
 * action code. It is applied when READING the log, so old entries and the hash chain are not touched; an action that
 * is not in the catalogue is shown by its code, as before.
 *
 *   registerEvents({ 'asset.create': { ru: 'Создан актив', en: 'Asset created', category: 'data', severity: 'info',
 *                    phrase: { ru: '{actor} создал актив {target}', en: '{actor} created asset {target}' } } });
 *   describeEvent(entry, 'ru') // { code, title, category, severity, phrase }
 *
 * Phrases take `{actor}`, `{target}` (entity#id) and `{meta.<key>}` (a value from the entry's details).
 */

export const CATEGORIES = {
  auth: { ru: 'Вход и учётные записи', en: 'Sign-in and accounts' },
  users: { ru: 'Пользователи', en: 'Users' },
  security: { ru: 'Безопасность', en: 'Security' },
  settings: { ru: 'Настройки', en: 'Settings' },
  system: { ru: 'Система', en: 'System' },
  backup: { ru: 'Резервные копии', en: 'Backups' },
  mail: { ru: 'Почта', en: 'Mail' },
  privacy: { ru: 'Персональные данные', en: 'Personal data' },
  data: { ru: 'Данные приложения', en: 'Application data' },
};

export const SEVERITIES = ['info', 'notice', 'warning', 'critical'];

const E = (ru, en, category, severity = 'info', pRu = null, pEn = null) => ({ ru, en, category, severity, phrase: { ru: pRu ?? `{actor}: ${ru.toLowerCase()} {target}`, en: pEn ?? `{actor}: ${en.toLowerCase()} {target}` } });

const catalog = new Map(Object.entries({
  'auth.login': E('Вход выполнен', 'Signed in', 'auth', 'info', '{actor} вошёл в систему', '{actor} signed in'),
  'auth.login.pending': E('Вход: ждёт второго фактора', 'Sign-in: waiting for second factor', 'auth'),
  'auth.login.totp': E('Вход: код подтверждения', 'Sign-in: one-time code', 'auth'),
  'auth.login.recovery': E('Вход: резервный код', 'Sign-in: recovery code', 'auth', 'notice', '{actor} вошёл по резервному коду', '{actor} signed in with a recovery code'),
  'auth.login.new_device': E('Вход с нового устройства', 'Sign-in from a new device', 'auth', 'notice', '{actor} вошёл с нового устройства', '{actor} signed in from a new device'),
  'auth.logout': E('Выход', 'Signed out', 'auth', 'info', '{actor} вышел из системы', '{actor} signed out'),
  'auth.lockout': E('Блокировка входа', 'Sign-in lockout', 'security', 'warning', 'Заблокирован вход: {target}', 'Sign-in locked: {target}'),
  'auth.password_change': E('Пароль изменён', 'Password changed', 'auth', 'notice', '{actor} сменил пароль', '{actor} changed the password'),
  'auth.password_expired': E('Пароль истёк', 'Password expired', 'auth', 'notice'),
  'auth.password_reset': E('Пароль сброшен по ссылке', 'Password reset by link', 'auth', 'notice'),
  'auth.password_reset_requested': E('Запрошен сброс пароля', 'Password reset requested', 'auth'),
  'auth.recovery_codes_generate': E('Выданы резервные коды', 'Recovery codes issued', 'auth', 'notice'),
  'auth.totp_enroll': E('Подключён второй фактор', 'Second factor enabled', 'auth', 'notice', '{actor} подключил второй фактор', '{actor} enabled a second factor'),
  'auth.totp_remove': E('Второй фактор отключён', 'Second factor removed', 'auth', 'warning', '{actor} отключил второй фактор', '{actor} removed a second factor'),
  'auth.registered': E('Регистрация завершена', 'Registration completed', 'auth'),
  'auth.registration_requested': E('Запрошена регистрация', 'Registration requested', 'auth'),
  'auth.registration_refused': E('Регистрация отклонена', 'Registration refused', 'auth', 'notice'),
  'auth.registration_bot': E('Регистрация: подозрение на бота', 'Registration: suspected bot', 'security', 'warning'),
  'auth.directory.provision': E('Учётная запись создана из каталога', 'Account created from the directory', 'auth'),
  'account.email_change': E('Изменён e-mail', 'E-mail changed', 'auth', 'notice'),

  'admin.user.create': E('Создана учётная запись', 'Account created', 'users', 'notice', '{actor} создал учётную запись {target}', '{actor} created account {target}'),
  'admin.user.update': E('Изменён профиль', 'Profile changed', 'users'),
  'admin.user.delete': E('Учётная запись удалена', 'Account deleted', 'users', 'warning', '{actor} удалил учётную запись {target}', '{actor} deleted account {target}'),
  'admin.user.disable': E('Учётная запись отключена', 'Account disabled', 'users', 'warning', '{actor} отключил учётную запись {target}', '{actor} disabled account {target}'),
  'admin.user.disable_inactive': E('Отключены неактивные', 'Inactive accounts disabled', 'users', 'warning', '{actor} отключил неактивных: {meta.disabled}', '{actor} disabled inactive accounts: {meta.disabled}'),
  'admin.user.force_logout': E('Завершены все сессии', 'All sessions ended', 'users', 'notice', '{actor} завершил все сессии пользователя {target}; завершено: {meta.revokedSessions}', '{actor} ended all sessions of {target}; ended: {meta.revokedSessions}'),
  'admin.user.recovery_codes': E('Выданы новые резервные коды', 'New recovery codes issued', 'users', 'notice'),
  'admin.user.reset_mfa': E('Сброшен второй фактор', 'Second factor reset', 'users', 'warning', '{actor} сбросил второй фактор пользователя {target}', '{actor} reset the second factor of {target}'),
  'admin.user.reset_password': E('Сброшен пароль', 'Password reset', 'users', 'warning', '{actor} сбросил пароль пользователя {target}', '{actor} reset the password of {target}'),
  'admin.user.unlock': E('Снята блокировка входа', 'Sign-in lock lifted', 'users', 'notice', '{actor} снял блокировку входа {target}', '{actor} lifted a sign-in lock {target}'),
  'admin.session.revoke': E('Сессия завершена', 'Session ended', 'users', 'notice'),
  'admin.stepup': E('Подтверждение пароля для действия', 'Password confirmation for an action', 'security'),

  'security.ban': E('Адрес или логин заблокирован', 'Address or login banned', 'security', 'warning', '{actor} заблокировал {target}', '{actor} banned {target}'),
  'security.unban': E('Блокировка снята', 'Ban lifted', 'security', 'notice'),
  'security.csp_violation': E('Нарушение политики содержимого', 'Content policy violation', 'security', 'notice'),
  'admin.passwordpolicy.set': E('Изменена парольная политика', 'Password policy changed', 'settings', 'warning'),
  'admin.passwordpolicy.reset': E('Парольная политика сброшена', 'Password policy reset', 'settings', 'warning'),
  'admin.passwordpolicy.require_change': E('Требована смена паролей', 'Password change required', 'settings', 'warning'),
  'admin.policy.save': E('Изменён текст политики', 'Policy text changed', 'settings', 'notice'),
  'admin.policy.reset': E('Текст политики сброшен', 'Policy text reset', 'settings', 'notice'),

  'admin.maintenance.enable': E('Включён режим обслуживания', 'Maintenance mode on', 'settings', 'warning', '{actor} включил режим обслуживания', '{actor} turned maintenance mode on'),
  'admin.maintenance.disable': E('Выключен режим обслуживания', 'Maintenance mode off', 'settings', 'notice', '{actor} выключил режим обслуживания', '{actor} turned maintenance mode off'),
  'admin.announcement.set': E('Объявление опубликовано', 'Announcement published', 'settings', 'notice'),
  'admin.announcement.clear': E('Объявление снято', 'Announcement cleared', 'settings', 'notice'),
  'admin.task.run': E('Задача запущена вручную', 'Task run manually', 'system', 'notice', '{actor} запустил задачу {meta.task}', '{actor} ran task {meta.task}'),
  'admin.about.doctor': E('Запущена диагностика', 'Diagnostics run', 'system'),
  'admin.doctor.schedule': E('Изменено расписание диагностики', 'Diagnostics schedule changed', 'settings'),
  'tls.reload': E('Сертификат перечитан', 'Certificate reloaded', 'system', 'notice'),
  'audit.purge': E('Журнал очищен', 'Audit log purged', 'system', 'warning'),
  'admin.audit.export': E('Выгрузка журнала', 'Audit log exported', 'security', 'notice', '{actor} выгрузил журнал аудита', '{actor} exported the audit log'),
  'alert.raised': E('Сработал алерт', 'Alert raised', 'system', 'warning', 'Алерт: {meta.key}', 'Alert: {meta.key}'),
  'alert.acked': E('Алерт квитирован', 'Alert acknowledged', 'system'),
  'alert.muted': E('Алерт заглушён', 'Alert muted', 'system', 'notice'),

  'admin.backup.run': E('Резервная копия запущена вручную', 'Backup run manually', 'backup', 'notice'),
  'admin.backup.schedule': E('Изменено расписание копий', 'Backup schedule changed', 'backup'),
  'admin.backup.verify': E('Проверка копии', 'Backup verified', 'backup'),
  'system.backup_run': E('Резервная копия по расписанию', 'Scheduled backup', 'backup'),
  'system.backup_verify': E('Проверка копии по расписанию', 'Scheduled backup check', 'backup'),
  'backup.restore': E('Восстановление из копии', 'Restore from backup', 'backup', 'critical', '{actor} восстановил базу из копии', '{actor} restored the database from a backup'),

  'admin.mail.cancel': E('Письмо отменено', 'Mail cancelled', 'mail'),
  'admin.mail.purge': E('Очередь писем очищена', 'Mail queue purged', 'mail', 'notice'),
  'admin.mail.test': E('Тестовое письмо', 'Test mail', 'mail'),
  'admin.broadcast.send': E('Рассылка отправлена', 'Broadcast sent', 'mail', 'notice'),
  'admin.broadcast.test': E('Тест рассылки', 'Broadcast test', 'mail'),

  'privacy.erase': E('Данные субъекта стёрты', 'Subject data erased', 'privacy', 'warning'),
  'privacy.export': E('Выгрузка данных субъекта', 'Subject data exported', 'privacy', 'notice'),
  'admin.registry.export': E('Выгрузка реестра обработки', 'Processing register exported', 'privacy'),
}));

/** Adds or replaces catalogue entries (an application registers its own actions the same way). */
export function registerEvents(events) {
  for (const [code, e] of Object.entries(events ?? {})) {
    if (!/^[a-z][a-z0-9_.]*$/.test(code)) throw new TypeError(`registerEvents: bad action code "${code}"`);
    if (!e?.ru || !e?.en || !e.category) throw new TypeError(`registerEvents: "${code}" needs ru, en and category`);
    catalog.set(code, { severity: 'info', phrase: null, ...e });
  }
}

const clip = (v) => String(v ?? '').slice(0, 120);

/** Name, category, severity and sentence for an entry; unknown actions come back as their code. */
export function describeEvent(entry, locale = 'ru') {
  const lang = locale === 'en' ? 'en' : 'ru';
  const e = catalog.get(entry?.action);
  if (!e) return { code: entry?.action ?? '', known: false, title: entry?.action ?? '', category: null, categoryTitle: '', severity: 'info', phrase: null };
  const target = entry.entity ? `${entry.entity}${entry.entityId != null ? `#${entry.entityId}` : ''}` : '';
  const phrase = (e.phrase?.[lang] ?? null)?.replace(/\{(actor|target|meta\.[A-Za-z0-9_]+)\}/g, (_, k) => {
    if (k === 'actor') return clip(entry.actor ?? '—');
    if (k === 'target') return clip(target || '—');
    const v = entry.meta && typeof entry.meta === 'object' ? entry.meta[k.slice(5)] : undefined;
    return v === undefined || v === null ? '—' : clip(typeof v === 'object' ? JSON.stringify(v) : v);
  });
  return { code: entry.action, known: true, title: e[lang], category: e.category, categoryTitle: CATEGORIES[e.category]?.[lang] ?? e.category, severity: e.severity, phrase: phrase ?? null };
}

/** All catalogue entries, for a filter or a documentation page. */
export function listEvents() {
  return [...catalog].map(([code, e]) => ({ code, ...e }));
}
