import { readFileSync, existsSync } from 'node:fs';
import { readCoreDependencies, DEPENDENCY_PURPOSE } from './dependencies.js';
import { fetchErrorText } from '../health/checks/dependencies.js';
import { localizeDoctor } from '../health/localize.js';
import { pickTexts } from '../i18n/overrides.js';
import { timeHtml } from '../ui/time.js';
import path from 'node:path';
import { log } from '../audit/log.js';
import { contextFromRequest } from '../audit/context.js';
import { readForm, emptyRow } from './sections.js';

const CORE_VERSION = (() => { try { return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version; } catch { return null; } })();

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const L = {
  ru: {
    emptyBackups: 'Копий пока нет. Нажмите «Запустить копию сейчас».', emptyUsers: 'Никого не найдено. Измените запрос или создайте пользователя выше.',
    maintenance: 'Режим обслуживания', mOn: 'включён', mOff: 'выключен', mMessage: 'Сообщение для посетителей (необязательно)', mUntil: 'Ожидаемое окончание, UTC (необязательно)',
    mEnable: 'Включить режим обслуживания', mDisable: 'Выключить', mHint: 'Пока режим включён, все, кроме администраторов, видят страницу «Ведутся технические работы» (код 503). Вход, проверка состояния и логотип остаются доступными. Время окончания только показывается посетителям, само режим не выключается.', mSince: 'Включён', mBy: 'Кем',
    announcement: 'Объявление', aMessage: 'Текст объявления (до 300 символов)', aLevel: 'Важность', aInfo: 'Информация', aWarning: 'Предупреждение', aCritical: 'Важно (нельзя скрыть)', aUntil: 'Показывать до, UTC (необязательно)', aPublish: 'Опубликовать', aClear: 'Снять объявление', aNone: 'Объявления нет', aOn: 'показывается', aExpired: 'срок вышел', aHint: 'Короткая строка вверху страниц приложения: например, о плановых работах. Читатель может скрыть её крестиком (кроме «Важно»); после смены текста она появится снова. По окончании срока пропадает сама.', aPreview: 'Сейчас', a_MESSAGE_REQUIRED: 'Введите текст объявления', a_MESSAGE_TOO_LONG: 'Текст длиннее 300 символов', a_CONFLICT: 'Объявление уже изменил другой администратор. Страница обновлена, повторите правку', a_LEVEL_INVALID: 'Неизвестная важность', a_UNTIL_INVALID: 'Некорректная дата окончания',
    e_MESSAGE_TOO_LONG: 'Сообщение длиннее 500 символов', e_UNTIL_INVALID: 'Некорректная дата окончания',
    users: 'Пользователи', backups: 'Резервные копии', logs: 'Логи', about: 'О системе', username: 'Логин', email: 'E-mail', role: 'Роль',
    status: 'Статус', active: 'активен', disabled: 'отключён', mfa: 'MFA', disable: 'Отключить', enable: 'Включить', search: 'Поиск',
    find: 'Найти', total: 'Всего', created: 'Создан', done: 'Готово', bad: 'Не удалось', file: 'Файл', size: 'Размер', dest: 'Хранилище',
    date: 'Дата', run: 'Запустить копию сейчас', none: 'нет данных', sink: 'Приёмник', sent: 'Отправлено', dropped: 'Потеряно',
    spilled: 'В резервный файл', queued: 'В очереди', failures: 'Сбоев', lastError: 'Последняя ошибка', lastOk: 'Последний успех',
    noSinks: 'Приёмники логов не настроены (вывод идёт только в stdout).', app: 'Приложение', core: 'Ядро', node: 'Node.js',
    platform: 'Платформа', deps: 'Зависимости', pkg: 'Пакет', range: 'Требуется', installed: 'Установлена', depState: 'Состояние', latest: 'Последняя',
    groupApp: 'Зависимости приложения', groupCore: 'Зависимости ядра (@das-forge/core)', purpose: 'Назначение', peerTag: 'peer', optTag: 'необязательна', notInstalled: 'не установлена', coreUpdHint: 'Зависимости ядра обновляются вместе с ним: обновите @das-forge/core.',
    schedEvery: 'Запускать автоматически каждый день', schedAt: 'в', schedSave: 'Сохранить расписание', schedNext: 'Следующий запуск', schedOffNow: 'автоматический запуск выключен', schedCron: 'расписание из настроек', schedTz: 'время сервера', e_TIME_INVALID: 'Время нужно указать как ЧЧ:ММ',
    verify: 'Проверить', verified: 'Копия цела: архив открывается, база проходит проверку', e_VERIFY_FAILED: 'Проверка не пройдена: копия повреждена или ключ шифрования не подходит', eb_NOT_FOUND: 'Такой копии в списке нет',
    backupAuto: 'Автоматическое резервное копирование', backupRetention: 'Хранить копии, дней', backupDest: 'Места хранения', backupAutoHint: 'Копия делается по расписанию; пропущенная из-за остановки сервера копия наверстывается при запуске. Срок хранения и места хранения задаются в настройках приложения.',
    license: 'Лицензия', check: 'Проверить обновления (запрос к npm)', checked: 'Проверено', upd: 'есть обновление', ok: 'актуально',
    unknown: '—', localPkg: 'локальный пакет', offline: 'не удалось связаться с реестром',
    anonymized: 'обезличен', cancel: 'Отмена', confirmRemove: 'Подтвердить',
    warnAnon: 'Учётная запись «{u}» будет обезличена: войти под ней и вернуть данные будет нельзя. Запись останется в системе только для журнала аудита.',
    warnDelete: 'Учётная запись «{u}» будет удалена навсегда. Отменить это нельзя.', editProfile: 'Логин и e-mail', newUser: 'Новый пользователь', create: 'Создать', actions: 'Действия', changeRole: 'Сменить роль', save: 'Сохранить',
    resetPwd: 'Сбросить пароль', modeTemp: 'Временный пароль (показать один раз)', modeMail: 'Ссылка на e-mail пользователя',
    unlockLogin: 'Снять блокировку входа', unlockHint: 'Сбрасывает счётчик неудачных попыток входа этой учётной записи в работающем приложении (после слишком многих ошибок вход временно закрывается).', unlockBtn: 'Снять блокировку',
    resetMfa: 'Сбросить второй фактор', resetMfaHint: 'Удаляет приложение-аутентификатор и коды восстановления и завершает все сессии. Пользователь настроит второй фактор заново при входе. Выполняйте, только убедившись, что это действительно он.', newCodes: 'Выпустить новые коды восстановления', newCodesHint: 'Прежние коды перестанут действовать. Новые будут показаны один раз.', codesTitle: 'Новые коды восстановления', codesShown: 'Передайте коды пользователю безопасным способом. Они показаны один раз и нигде не сохранены в открытом виде.', e_NO_MFA: 'У пользователя нет второго фактора', e_NO_ACTIVE_MFA: 'Нет подтверждённого приложения-аутентификатора: коды восстановления не нужны',
    mailBanReason: 'Учётная запись отключена администратором.', mailRoleSubject: 'Изменена ваша роль', mailRoleBody: 'Администратор изменил вашу роль: {from} → {to}. Если вы этого не ожидали, свяжитесь с администратором.', mailResetSubject: 'Пароль сброшен администратором', mailResetBody: 'Администратор выдал вам временный пароль. Войдите с ним и задайте свой. Если вы этого не просили, сообщите администратору.', mailLogoutSubject: 'Вас вышли из системы', mailLogoutBody: 'Администратор завершил все ваши сессии. Войдите заново. Если вы этого не ожидали, сообщите администратору.', mailMfaSubject: 'Второй фактор сброшен', mailMfaBody: 'Администратор сбросил ваш второй фактор (приложение-аутентификатор и коды восстановления). Настройте его заново при следующем входе. Если вы этого не просили, сообщите администратору.', mailCodesSubject: 'Выпущены новые коды восстановления', mailCodesBody: 'Прежние коды восстановления больше не действуют. Новые вам передаст администратор.',
    cardTitle: 'Карточка пользователя', lastLogin: 'Последний вход', lastActivity: 'Последняя активность', pwdChanged: 'Пароль сменён', never: 'не было', factorsLbl: 'Второй фактор', factorsOn: 'включён', factorsOff: 'нет', cardSessions: 'Сессии', cardDevices: 'Устройства', cardEvents: 'Последние события', firstSeen: 'Впервые', lastSeenLbl: 'Последний раз', expiresLbl: 'Истекает', deviceLbl: 'Устройство', ipLbl: 'IP', actionLbl: 'Событие', resultLbl: 'Результат', noRows: 'нет записей', inactiveLink: 'Не входили давно', inactiveTitle: 'Давно не входили', inactiveHint: 'Активные учётные записи без входов и активности за выбранный срок (или ни разу не входившие и созданные раньше). Отключение закрывает сессии; включить обратно можно в списке пользователей.', daysLbl: 'Дней', idleLbl: 'Бездействует, дн.', disableAll: 'Отключить всех из списка', inactiveNone: 'Таких учётных записей нет', disabledN: 'Отключено учётных записей:', skippedN: 'пропущено (последний администратор или вы):', toList: 'К списку', card: 'Карточка',
    lockoutsLink: 'Блокировки входа', lockoutsTitle: 'Блокировки входа', lockoutsHint: 'Счётчики держатся в памяти работающего приложения: перезапуск их обнуляет. Здесь видны только действующие блокировки.', lockKind: 'Тип', lockKey: 'Ключ', lockFails: 'Попыток', lockLeft: 'Осталось, с', lockNone: 'Действующих блокировок нет', lockLift: 'Снять', lockKinds: { pair: 'имя + адрес', user: 'имя', ip: 'адрес', mfa: 'второй фактор' }, lockLifted: 'Блокировка снята',
    forceOut: 'Завершить все сессии', requireChange: 'Потребовать смену пароля при следующем входе', removeUser: 'Удалить учётную запись',
    modeAnon: 'Обезличить (запись остаётся для аудита)', modeDel: 'Удалить полностью', confirmBox: 'Подтверждаю', back: 'К списку',
    tempTitle: 'Временный пароль', tempShown: 'Показан один раз и нигде не хранится. Передайте его пользователю безопасным способом: при входе потребуется выбрать новый.',
    accountCreated: 'Учётная запись создана', sessionsClosed: 'Завершено сессий', mailSent: 'Ссылка для сброса отправлена на', password: 'Пароль',
    e_NOT_FOUND: 'Пользователь не найден', e_CONFLICT: 'Запись уже изменил другой администратор. Страница обновлена, повторите правку', e_USERNAME_INVALID: 'Логин: 3–64 символа, буквы, цифры и . _ @ -', e_USERNAME_TAKEN: 'Такой логин уже занят',
    e_EMAIL_INVALID: 'Некорректный адрес e-mail', e_EMAIL_TAKEN: 'Этот e-mail принадлежит другой учётной записи', e_ROLE_INVALID: 'Недопустимая роль',
    e_LAST_ADMIN: 'Это последний активный администратор', e_SELF: 'Это действие нельзя применить к своей учётной записи',
    e_EMAIL_UNAVAILABLE: 'Почта не настроена', e_NO_EMAIL: 'У пользователя нет адреса e-mail', e_EMAIL_FAILED: 'Письмо не удалось отправить',
    e_ACCOUNT_DISABLED: 'Учётная запись отключена', e_CONFIRM: 'Нужно подтверждение', e_FORBIDDEN: 'Действие отключено',
    health: 'Состояние', hStatus: 'Статус', hDb: 'База данных', hUptime: 'Работает', hOk: 'исправно', hBad: 'есть проблема', doctor: 'Диагностика (doctor)',
    runDoctor: 'Запустить диагностику', doctorNever: 'Диагностика ещё не запускалась: проверяет окружение, базу, хранилища, безопасность, сертификат и почту.', doctorAt: 'Запущена',
    sOk: 'норма', sWarn: 'предупреждение', sFail: 'ошибка', category: 'Раздел', check1: 'Проверка', result: 'Результат', updCount: 'Можно обновить пакетов', updHint: 'Команда для обновления (выполняется вручную на сервере, затем перезапуск):', updNone: 'Все пакеты актуальны.', copy: 'Копировать',
  },
  en: {
    emptyBackups: 'No backups yet. Press “Run a backup now”.', emptyUsers: 'No one found. Change the search or create a user above.',
    maintenance: 'Maintenance mode', mOn: 'on', mOff: 'off', mMessage: 'Message for visitors (optional)', mUntil: 'Expected end, UTC (optional)',
    mEnable: 'Switch maintenance mode on', mDisable: 'Switch off', mHint: 'While it is on, everyone except administrators sees the "Maintenance in progress" page (status 503). Sign-in, the health check and the logo stay available. The end time is only shown to visitors; it does not switch the mode off.', mSince: 'Switched on', mBy: 'By',
    announcement: 'Announcement', aMessage: 'Announcement text (up to 300 characters)', aLevel: 'Level', aInfo: 'Information', aWarning: 'Warning', aCritical: 'Important (cannot be dismissed)', aUntil: 'Show until, UTC (optional)', aPublish: 'Publish', aClear: 'Remove the announcement', aNone: 'No announcement', aOn: 'shown', aExpired: 'expired', aHint: 'A short line at the top of the application pages, e.g. about planned work. Readers can dismiss it with the cross (except "Important"); it comes back when the text changes. It disappears by itself when the time is up.', aPreview: 'Now', a_MESSAGE_REQUIRED: 'Enter the announcement text', a_MESSAGE_TOO_LONG: 'The text is longer than 300 characters', a_CONFLICT: 'Another administrator has changed the announcement. The page is reloaded, please repeat the change', a_LEVEL_INVALID: 'Unknown level', a_UNTIL_INVALID: 'Not a valid end date',
    e_MESSAGE_TOO_LONG: 'The message is longer than 500 characters', e_UNTIL_INVALID: 'Not a valid end date',
    users: 'Users', backups: 'Backups', logs: 'Logs', about: 'About', username: 'Username', email: 'E-mail', role: 'Role',
    status: 'Status', active: 'active', disabled: 'disabled', mfa: 'MFA', disable: 'Disable', enable: 'Enable', search: 'Search',
    find: 'Find', total: 'Total', created: 'Created', done: 'Done', bad: 'Failed', file: 'File', size: 'Size', dest: 'Destination',
    date: 'Date', run: 'Run a backup now', none: 'no data', sink: 'Sink', sent: 'Sent', dropped: 'Dropped', spilled: 'Spilled to file',
    queued: 'Queued', failures: 'Failures', lastError: 'Last error', lastOk: 'Last success',
    noSinks: 'No log sinks configured (output goes to stdout only).', app: 'Application', core: 'Core', node: 'Node.js',
    platform: 'Platform', deps: 'Dependencies', pkg: 'Package', range: 'Required', installed: 'Installed', depState: 'Status', latest: 'Latest',
    groupApp: 'Application dependencies', groupCore: 'Core dependencies (@das-forge/core)', purpose: 'Purpose', peerTag: 'peer', optTag: 'optional', notInstalled: 'not installed', coreUpdHint: 'Core dependencies are updated with the core: update @das-forge/core.',
    schedEvery: 'Run automatically every day', schedAt: 'at', schedSave: 'Save schedule', schedNext: 'Next run', schedOffNow: 'automatic run is off', schedCron: 'schedule from the configuration', schedTz: 'server time', e_TIME_INVALID: 'Enter the time as HH:MM',
    verify: 'Verify', verified: 'The backup is intact: the archive opens and the database passes the check', e_VERIFY_FAILED: 'Verification failed: the backup is damaged or the encryption key does not match', eb_NOT_FOUND: 'No such backup in the list',
    backupAuto: 'Automatic backups', backupRetention: 'Keep backups, days', backupDest: 'Destinations', backupAutoHint: 'A backup is made on schedule; one missed while the server was down is made up at start. Retention and destinations are set in the application configuration.',
    license: 'License', check: 'Check for updates (queries npm)', checked: 'Checked', upd: 'update available', ok: 'up to date',
    unknown: '—', localPkg: 'local package', offline: 'registry unreachable',
    anonymized: 'anonymized', cancel: 'Cancel', confirmRemove: 'Confirm',
    warnAnon: 'The account "{u}" will be anonymized: nobody can sign in with it and the data cannot be restored. The record stays only for the audit trail.',
    warnDelete: 'The account "{u}" will be deleted permanently. This cannot be undone.', editProfile: 'Username and e-mail', newUser: 'New user', create: 'Create', actions: 'Actions', changeRole: 'Change role', save: 'Save',
    resetPwd: 'Reset password', modeTemp: 'Temporary password (shown once)', modeMail: 'Link sent to the user\'s e-mail',
    unlockLogin: 'Lift the sign-in lock', unlockHint: 'Clears the failed sign-in counter of this account in the running application (after too many mistakes sign-in is closed for a while).', unlockBtn: 'Lift the lock',
    resetMfa: 'Reset the second factor', resetMfaHint: 'Removes the authenticator app and the recovery codes and ends every session. The user sets the second factor up again at sign-in. Do it only after making sure it really is them.', newCodes: 'Issue new recovery codes', newCodesHint: 'The old codes stop working. The new ones are shown once.', codesTitle: 'New recovery codes', codesShown: 'Hand the codes to the user in a safe way. They are shown once and are not stored in plain text.', e_NO_MFA: 'The user has no second factor', e_NO_ACTIVE_MFA: 'There is no confirmed authenticator app: recovery codes are not needed',
    mailBanReason: 'The account was disabled by an administrator.', mailRoleSubject: 'Your role was changed', mailRoleBody: 'An administrator changed your role: {from} → {to}. If you did not expect this, contact the administrator.', mailResetSubject: 'Password reset by an administrator', mailResetBody: 'An administrator issued you a temporary password. Sign in with it and choose your own. If you did not ask for this, tell the administrator.', mailLogoutSubject: 'You were signed out', mailLogoutBody: 'An administrator ended all your sessions. Sign in again. If you did not expect this, tell the administrator.', mailMfaSubject: 'Second factor reset', mailMfaBody: 'An administrator reset your second factor (authenticator app and recovery codes). Set it up again at your next sign-in. If you did not ask for this, tell the administrator.', mailCodesSubject: 'New recovery codes issued', mailCodesBody: 'Your old recovery codes no longer work. The administrator will hand you the new ones.',
    cardTitle: 'User card', lastLogin: 'Last sign-in', lastActivity: 'Last activity', pwdChanged: 'Password changed', never: 'never', factorsLbl: 'Second factor', factorsOn: 'on', factorsOff: 'none', cardSessions: 'Sessions', cardDevices: 'Devices', cardEvents: 'Recent events', firstSeen: 'First seen', lastSeenLbl: 'Last seen', expiresLbl: 'Expires', deviceLbl: 'Device', ipLbl: 'IP', actionLbl: 'Event', resultLbl: 'Result', noRows: 'no records', inactiveLink: 'Not signed in for long', inactiveTitle: 'Not signed in for long', inactiveHint: 'Active accounts with no sign-in or activity for the chosen period (or never signed in and created earlier). Disabling ends their sessions; they can be enabled again in the users list.', daysLbl: 'Days', idleLbl: 'Idle, days', disableAll: 'Disable everyone in the list', inactiveNone: 'No such accounts', disabledN: 'Accounts disabled:', skippedN: 'skipped (the last administrator or yourself):', toList: 'To the list', card: 'Card',
    lockoutsLink: 'Sign-in lockouts', lockoutsTitle: 'Sign-in lockouts', lockoutsHint: 'The counters live in the memory of the running application: a restart clears them. Only active lockouts are listed.', lockKind: 'Kind', lockKey: 'Key', lockFails: 'Attempts', lockLeft: 'Left, s', lockNone: 'No active lockouts', lockLift: 'Lift', lockKinds: { pair: 'name + address', user: 'name', ip: 'address', mfa: 'second factor' }, lockLifted: 'Lockout lifted',
    forceOut: 'Sign out of all sessions', requireChange: 'Require a new password at the next sign-in', removeUser: 'Remove account',
    modeAnon: 'Anonymize (the record stays for the audit trail)', modeDel: 'Delete completely', confirmBox: 'I confirm', back: 'Back to the list',
    tempTitle: 'Temporary password', tempShown: 'Shown once and stored nowhere. Hand it to the user in a safe way: they must choose a new one when signing in.',
    accountCreated: 'Account created', sessionsClosed: 'Sessions closed', mailSent: 'A reset link was sent to', password: 'Password',
    e_NOT_FOUND: 'User not found', e_CONFLICT: 'Another administrator has changed this account. The page is reloaded, please repeat the change', e_USERNAME_INVALID: 'Username: 3-64 characters, letters, digits and . _ @ -', e_USERNAME_TAKEN: 'That username is taken',
    e_EMAIL_INVALID: 'Not a valid e-mail address', e_EMAIL_TAKEN: 'That e-mail belongs to another account', e_ROLE_INVALID: 'Role not allowed',
    e_LAST_ADMIN: 'This is the last active administrator', e_SELF: 'This cannot be done to your own account',
    e_EMAIL_UNAVAILABLE: 'E-mail is not configured', e_NO_EMAIL: 'This user has no e-mail address', e_EMAIL_FAILED: 'The message could not be sent',
    e_ACCOUNT_DISABLED: 'The account is disabled', e_CONFIRM: 'Confirmation required', e_FORBIDDEN: 'This action is switched off',
    health: 'Health', hStatus: 'Status', hDb: 'Database', hUptime: 'Uptime', hOk: 'ok', hBad: 'problem', doctor: 'Diagnostics (doctor)',
    runDoctor: 'Run diagnostics', doctorNever: 'Diagnostics have not run yet: they check the environment, database, storage, security, certificate and mail.', doctorAt: 'Ran at',
    sOk: 'ok', sWarn: 'warning', sFail: 'failed', category: 'Section', check1: 'Check', result: 'Result', updCount: 'Packages that can be updated', updHint: 'Update command (run it by hand on the server, then restart):', updNone: 'All packages are up to date.', copy: 'Copy',
  },
};

const human = (n) => { const u = ['B', 'KB', 'MB', 'GB']; let i = 0; let v = Number(n) || 0; while (v >= 1024 && i < 3) { v /= 1024; i++; } return `${i ? v.toFixed(1) : v} ${u[i]}`; };

/** x.y.z compare on the numeric part only: >0 when a is newer than b. */
export function compareVersions(a, b) {
  const p = (v) => String(v).replace(/^[^\d]*/, '').split(/[.+-]/).slice(0, 3).map((x) => Number(x) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

export function readDependencies({ packageJsonPath, nodeModulesDir }) {
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const bases = [].concat(nodeModulesDir ?? path.join(path.dirname(packageJsonPath), 'node_modules'));
  return Object.entries(pkg.dependencies ?? {}).map(([name, range]) => {
    let installed = null;
    let license = null;
    const f = bases.map((b) => path.join(b, name, 'package.json')).find((x) => existsSync(x));
    if (f) {
      try { const j = JSON.parse(readFileSync(f, 'utf8')); installed = j.version ?? null; license = typeof j.license === 'string' ? j.license : j.license?.type ?? null; } catch { /* unreadable */ }
    }
    return { name, range, installed, license };
  });
}

const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export async function checkLatest(names, { fetchFn = globalThis.fetch, timeoutMs = 10000, concurrency = 5, errors = {} } = {}) {
  const out = {};
  const queue = [...names];
  async function worker() {
    while (queue.length) {
      const name = queue.shift();
      try {
        const r = await fetchFn(`https://registry.npmjs.org/${name.replace('/', '%2F')}/latest`, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
        if (!r.ok) errors[name] = `HTTP ${r.status}`;
        const v = r.ok ? (await r.json()).version : null;
        out[name] = typeof v === 'string' && VERSION_RE.test(v) ? v : null; // only a plain semver is shown and offered in the copy-paste command
      } catch (err) { out[name] = null; errors[name] = fetchErrorText(err); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, worker));
  return out;
}

/** The "every day at HH:MM" switch shared by the sections that run a job on a schedule (`createScheduleSetting`). */
export function scheduleFormHtml({ l, st, action, locale }) {
  const cron = st.schedule && !st.time ? ` <span class="adm-muted">(${esc(l.schedCron)}: <code>${esc(st.schedule)}</code>)</span>` : '';
  const next = st.nextRun ? `<p class="adm-muted">${esc(l.schedNext)}: ${timeHtml(st.nextRun, locale)}</p>` : `<p class="adm-muted">${esc(l.schedOffNow)}</p>`;
  return `<form method="post" action="${action}" style="display:flex;flex-wrap:wrap;align-items:center;gap:.5rem .75rem;margin:.75rem 0"><label><input type="checkbox" name="enabled" value="1"${st.enabled ? ' checked' : ''}> ${esc(l.schedEvery)}</label><label>${esc(l.schedAt)} <input class="adm-input" type="time" name="time" value="${esc(st.time ?? '')}" style="height:2.2rem;box-sizing:border-box"></label><span class="adm-muted">${esc(l.schedTz)}</span>${cron}<button class="adm-btn" type="submit">${esc(l.schedSave)}</button></form>${next}`;
}

export function mountBackupsSection({ app, db, guard, page: render, basePath, localeOf, texts = {}, backups, stepUp = [] }) {
  const p = `${basePath}/backups`;
  app.get(p, ...guard, async (req, res) => {
    const l = pickTexts(L, texts['admin-ops'], localeOf(req), 'admin-ops');
    let list = [];
    try { list = await backups.list(); } catch { list = []; }
    const msg = req.query?.msg === 'ok' ? `<div class="adm-toast">${esc(req.query.e === 'VERIFIED' ? l.verified : l.done)}</div>` : req.query?.msg === 'bad' ? `<div class="adm-toast" style="border-left-color:var(--adm-danger)">${esc((l[`eb_${String(req.query.e ?? '')}`] ?? l[`e_${String(req.query.e ?? '')}`] ?? l.bad))}</div>` : '';
    const rows = list.filter((b) => b.file).map((b) => `<tr><td>${esc(b.destinationId ?? '')}</td><td>${esc(b.file)}</td><td>${esc(human(b.sizeBytes))}</td><td>${timeHtml(b.createdAt, localeOf(req))}</td>${backups.verify ? `<td>${b.path && b.supported !== false ? `<form method="post" action="${p}/verify" style="margin:0"><input type="hidden" name="file" value="${esc(b.path)}"><button class="adm-btn" type="submit">${esc(l.verify)}</button></form>` : ''}</td>` : ''}</tr>`).join('') || emptyRow(backups.verify ? 5 : 4, l.emptyBackups);
    const auto = backups.schedule ? `<div class="adm-card" style="margin-bottom:1rem"><h2>${esc(l.backupAuto)}</h2><p class="adm-muted">${esc(l.backupAutoHint)}</p>${scheduleFormHtml({ l, st: backups.schedule.get(), action: `${p}/schedule`, locale: localeOf(req) })}${backups.info ? `<p class="adm-muted">${esc(l.backupRetention)}: <strong>${esc(backups.info.retentionDays ?? '—')}</strong>${backups.info.destinations?.length ? ` · ${esc(l.backupDest)}: ${esc(backups.info.destinations.join(', '))}` : ''}</p>` : ''}</div>` : '';
    render(req, res, { active: p, title: l.backups, bodyHtml: `${msg}${auto}${backups.run ? `<form method="post" action="${p}/run" style="margin-bottom:1rem"><button class="adm-btn primary" type="submit">${esc(l.run)}</button></form>` : ''}<div class="adm-card"><table class="adm-table"><thead><tr><th>${esc(l.dest)}</th><th>${esc(l.file)}</th><th>${esc(l.size)}</th><th>${esc(l.date)}</th>${backups.verify ? '<th></th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>` });
  });
  if (backups.schedule) {
    app.post(`${p}/schedule`, ...guard, ...stepUp, async (req, res, next) => {
      try {
        const form = await readForm(req);
        const state = backups.schedule.set({ enabled: form.enabled === '1', time: String(form.time ?? '').trim() || undefined });
        log(db, { ...contextFromRequest(req), action: 'admin.backup.schedule', entity: 'backup', meta: { enabled: state.enabled, schedule: state.schedule } });
        res.redirect(303, `${p}?msg=ok`);
      } catch (err) {
        if (err?.code === 'TIME_INVALID') return res.redirect(303, `${p}?msg=bad&e=TIME_INVALID`);
        return next(err);
      }
    });
  }
  if (backups.verify) {
    app.post(`${p}/verify`, ...guard, ...stepUp, async (req, res) => {
      const form = await readForm(req);
      const file = String(form.file ?? '');
      let known = false;
      try { known = (await backups.list()).some((b) => b.supported !== false && b.path === file); } catch { known = false; }
      if (!known) return res.redirect(303, `${p}?msg=bad&e=NOT_FOUND`); // never open a path the list did not hand out
      let result;
      try { result = await backups.verify(file); } catch (err) { result = { ok: false, message: String(err?.message ?? err) }; }
      log(db, { ...contextFromRequest(req), action: 'admin.backup.verify', entity: 'backup', meta: { file: file.split(/[\\/]/).pop(), message: String(result?.message ?? '').slice(0, 200) }, result: result?.ok ? 'success' : 'failure' });
      res.redirect(303, result?.ok ? `${p}?msg=ok&e=VERIFIED` : `${p}?msg=bad&e=VERIFY_FAILED`);
    });
  }
  if (backups.run) {
    app.post(`${p}/run`, ...guard, ...stepUp, async (req, res) => {
      try {
        await backups.run();
        log(db, { ...contextFromRequest(req), action: 'admin.backup.run', entity: 'backup' });
        res.redirect(303, `${p}?msg=ok`);
      } catch { res.redirect(303, `${p}?msg=bad`); }
    });
  }
}

export function mountLogsSection({ app, guard, page: render, basePath, localeOf, texts = {}, logDestination }) {
  const p = `${basePath}/logs`;
  app.get(p, ...guard, (req, res) => {
    const l = pickTexts(L, texts['admin-ops'], localeOf(req), 'admin-ops');
    const stats = logDestination?.stats?.() ?? [];
    const rows = stats.map((s) => `<tr><td>${esc(s.type)}</td><td>${esc(s.sent)}</td><td>${esc(s.dropped)}</td><td>${esc(s.spilled)}</td><td>${esc(s.queued)}</td><td>${esc(s.failures)}</td><td>${s.lastSuccessAt ? timeHtml(s.lastSuccessAt, localeOf(req)) : esc(l.unknown)}</td><td>${esc(s.lastError ?? '')}</td></tr>`).join('');
    render(req, res, { active: p, title: l.logs, bodyHtml: stats.length ? `<div class="adm-card"><table class="adm-table"><thead><tr><th>${esc(l.sink)}</th><th>${esc(l.sent)}</th><th>${esc(l.dropped)}</th><th>${esc(l.spilled)}</th><th>${esc(l.queued)}</th><th>${esc(l.failures)}</th><th>${esc(l.lastOk)}</th><th>${esc(l.lastError)}</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="adm-card"><p class="adm-muted">${esc(l.noSinks)}</p></div>` });
  });
}

export function mountAboutSection({ app, db, guard, page: render, basePath, localeOf, texts = {}, about, stepUp = [] }) {
  const p = `${basePath}/about`;
  let deps = [];
  try { deps = readDependencies(about).map((d) => ({ ...d, group: 'app' })); } catch { deps = []; }
  if (about.coreDependencies !== false) {
    try { deps = deps.concat(readCoreDependencies({ nodeModulesDir: about.nodeModulesDir })); } catch { /* the core's own package.json is optional here */ }
  }
  let latest = null; // { at, versions, errors }
  let doctorReport = null; // { at, report }
  const fetchFn = about.fetchFn;

  const badgeOf = (st, l) => `<span class="adm-badge ${st === 'ok' ? 'ok' : st === 'warn' ? 'warn' : 'danger'}">${esc(st === 'ok' ? l.sOk : st === 'warn' ? l.sWarn : l.sFail)}</span>`;

  function healthCard(l) {
    let h = null;
    try { h = about.health?.() ?? null; } catch { h = null; }
    if (!h) return '';
    const ok = h.status === 'ok';
    const up = Number.isFinite(h.uptime) ? `${Math.floor(h.uptime / 3600)}h ${Math.floor((h.uptime % 3600) / 60)}m` : l.unknown;
    return `<div class="adm-card" style="margin-top:1rem"><h2>${esc(l.health)}</h2><p><span class="adm-badge ${ok ? 'ok' : 'danger'}">${esc(ok ? l.hOk : l.hBad)}</span> &nbsp; ${esc(l.hDb)}: ${esc(h.database ?? l.unknown)} &nbsp; ${esc(l.hUptime)}: ${esc(up)}</p></div>`;
  }

  function doctorCard(l, locale) {
    if (!about.doctor) return '';
    let body = `<p class="adm-muted">${esc(l.doctorNever)}</p>`;
    if (doctorReport) {
      const rows = localizeDoctor(doctorReport.report, locale).categories.flatMap((c) => c.checks.map((k) => `<tr><td>${esc(c.name)}</td><td>${esc(k.name)}</td><td>${badgeOf(k.status, l)}</td><td>${esc(k.message)}</td></tr>`)).join('');
      const sum = doctorReport.report.summary;
      body = `<p class="adm-muted">${esc(l.doctorAt)}: ${timeHtml(doctorReport.at, locale)} — ${esc(l.sOk)}: ${sum.ok}, ${esc(l.sWarn)}: ${sum.warn}, ${esc(l.sFail)}: ${sum.fail}</p><table class="adm-table"><thead><tr><th>${esc(l.category)}</th><th>${esc(l.check1)}</th><th>${esc(l.status)}</th><th>${esc(l.result)}</th></tr></thead><tbody>${rows}</tbody></table>`;
    }
    const sched = about.doctorSchedule ? scheduleFormHtml({ l, st: about.doctorSchedule.get(), action: `${p}/doctor-schedule`, locale }) : '';
    return `<div class="adm-card" style="margin-top:1rem"><h2>${esc(l.doctor)}</h2><form method="post" action="${p}/doctor" style="margin-bottom:.75rem"><button class="adm-btn primary" type="submit">${esc(l.runDoctor)}</button></form>${sched}${body}</div>`;
  }

  app.get(p, ...guard, (req, res) => {
    const l = pickTexts(L, texts['admin-ops'], localeOf(req), 'admin-ops');
    const outdated = [];
    let coreOutdated = 0;
    const rowOf = (d) => {
      const lv = latest?.versions?.[d.name];
      const newer = lv && d.installed && compareVersions(lv, d.installed) > 0;
      if (newer && d.group === 'app') outdated.push(`${d.name}@${lv}`);
      if (newer && d.group === 'core') coreOutdated += 1;
      const badge = lv === undefined ? '' : (lv === null && /^(file|link|workspace):/.test(String(d.range ?? d.required ?? ''))) ? `<span class="adm-badge">${esc(l.localPkg)}</span>` : lv === null ? `<span class="adm-badge warn" title="${esc(latest?.errors?.[d.name] ?? '')}">${esc(l.offline)}</span>` : newer ? `<span class="adm-badge warn">${esc(l.upd)}</span>` : `<span class="adm-badge ok">${esc(l.ok)}</span>`;
      const tags = `${d.peer ? ` <span class="adm-muted">${esc(l.peerTag)}</span>` : ''}${d.optional ? ` <span class="adm-muted">${esc(l.optTag)}</span>` : ''}`;
      const inst = d.installed ?? (d.optional ? l.unknown : `<span class="adm-badge warn">${esc(l.notInstalled)}</span>`);
      const why = d.group === 'core' ? `<td>${esc(DEPENDENCY_PURPOSE[d.name]?.[locale === 'en' ? 'en' : 'ru'] ?? '')}</td>` : '';
      return `<tr><td>${esc(d.name)}${tags}</td>${why}<td>${esc(d.range)}</td><td>${d.installed ? esc(d.installed) : inst}</td><td>${esc(lv ?? '')}</td><td>${badge}</td><td>${esc(d.license ?? l.unknown)}</td></tr>`;
    };
    const table = (group, title) => {
      const list = deps.filter((d) => d.group === group);
      if (!list.length) return '';
      const rows = list.map(rowOf).join('');
      return `<h3 style="margin:1rem 0 .5rem">${esc(title)}</h3><table class="adm-table"><thead><tr><th>${esc(l.pkg)}</th>${group === 'core' ? `<th>${esc(l.purpose)}</th>` : ''}<th>${esc(l.range)}</th><th>${esc(l.installed)}</th><th>${esc(l.latest)}</th><th>${esc(l.depState)}</th><th>${esc(l.license)}</th></tr></thead><tbody>${rows}</tbody></table>`;
    };
    const locale = localeOf(req);
    const tables = `${table('app', l.groupApp)}${table('core', l.groupCore)}`;
    const upd = latest
      ? ((outdated.length || coreOutdated)
        ? `${outdated.length ? `<p>${esc(l.updCount)}: <strong>${outdated.length}</strong></p><p class="adm-muted">${esc(l.updHint)}</p><pre>npm install ${esc(outdated.join(' '))}</pre>` : ''}${coreOutdated ? `<p>${esc(l.updCount)} (${esc(l.groupCore)}): <strong>${coreOutdated}</strong></p><p class="adm-muted">${esc(l.coreUpdHint)}</p>` : ''}`
        : `<p class="adm-muted">${esc(l.updNone)}</p>`)
      : '';
    const info = [[l.app, `${about.appName ?? ''} ${about.appVersion ?? ''}`.trim() || l.unknown], [l.core, about.coreVersion ?? CORE_VERSION ?? l.unknown], [l.node, process.version], [l.platform, `${process.platform} ${process.arch}`]]
      .map(([k, v]) => `<div class="adm-card"><h2>${esc(k)}</h2><div class="adm-stat" style="font-size:1.2rem">${esc(v)}</div></div>`).join('');
    const toast = req.query?.msg === 'ok' ? `<div class="adm-toast">${esc(l.done)}</div>` : req.query?.msg === 'bad' ? `<div class="adm-toast" style="border-left-color:var(--adm-danger)">${esc(l[`e_${String(req.query.e ?? '')}`] ?? l.bad)}</div>` : '';
    render(req, res, { active: p, title: l.about, bodyHtml: `${toast}<div class="adm-grid">${info}</div>${healthCard(l)}${doctorCard(l, localeOf(req))}<div class="adm-card" style="margin-top:1rem"><h2>${esc(l.deps)}</h2><form method="post" action="${p}/check" style="margin-bottom:.75rem"><button class="adm-btn primary" type="submit">${esc(l.check)}</button>${latest ? ` <span class="adm-muted">${esc(l.checked)}: ${timeHtml(latest.at, localeOf(req))}</span>` : ''}</form>${upd}${tables}</div>` });
  });

  app.post(`${p}/check`, ...guard, ...stepUp, async (req, res) => {
    await readForm(req); // drain
    const errors = {};
    latest = { at: new Date().toISOString(), versions: await checkLatest([...new Set(deps.map((d) => d.name))], { fetchFn, errors }), errors };
    log(db, { ...contextFromRequest(req), action: 'admin.about.check-updates', entity: 'system' });
    res.redirect(303, p);
  });

  if (about.doctorSchedule) {
    app.post(`${p}/doctor-schedule`, ...guard, ...stepUp, async (req, res, next) => {
      try {
        const form = await readForm(req);
        const state = about.doctorSchedule.set({ enabled: form.enabled === '1', time: String(form.time ?? '').trim() || undefined });
        log(db, { ...contextFromRequest(req), action: 'admin.doctor.schedule', entity: 'system', meta: { enabled: state.enabled, schedule: state.schedule } });
        res.redirect(303, `${p}?msg=ok`);
      } catch (err) {
        if (err?.code === 'TIME_INVALID') return res.redirect(303, `${p}?msg=bad&e=TIME_INVALID`);
        return next(err);
      }
    });
  }

  if (about.doctor) {
    app.post(`${p}/doctor`, ...guard, ...stepUp, async (req, res) => {
      await readForm(req);
      let report;
      try { report = await about.doctor(); } catch (err) { report = { categories: [{ name: 'doctor', checks: [{ name: 'run', status: 'fail', message: String(err?.message ?? err) }] }], summary: { ok: 0, warn: 0, fail: 1 } }; }
      doctorReport = { at: new Date().toISOString(), report };
      log(db, { ...contextFromRequest(req), action: 'admin.about.doctor', entity: 'system' });
      res.redirect(303, p);
    });
  }
}

export { L as OPS_TEXTS };
