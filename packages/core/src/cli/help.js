/**
 * Detailed help for every CLI command, in Russian and English: the
 * description (Russian only: the English text lives next to the command),
 * usage, flags and examples. `createCli` overlays this on what a command
 * registers, so a command can still bring its own text; the entry here
 * fills the rest. Flags are [name, English, Russian].
 */
const H = {};
const c = (path, ru, { usage, flags = [], examples = [] } = {}) => { H[path] = { ru, usage, flags, examples }; };

const JSON_F = ['--json', 'Print JSON instead of text', 'Вывести JSON вместо текста'];
const YES_F = ['--yes', 'Confirm the action', 'Подтвердить действие'];

c('migrate', 'Применить все ожидающие миграции базы данных');
c('migrate status', 'Показать миграции и признак применения каждой');
c('version', 'Показать установленную версию', { usage: '[--json]', flags: [JSON_F], examples: ['version', 'version --json'] });
c('health', 'Быстрая проверка «процесс жив»: процесс и база', { usage: '[--json]', flags: [JSON_F], examples: ['health', 'health --json'] });
c('doctor', 'Полная диагностика установки (код выхода 3 при проблемах)', {
  usage: '[--json] [--fix] [--lang ru|en]',
  flags: [JSON_F, ['--fix', 'Run the fix of every failing check that has one, then check again', 'Выполнить исправление у каждой упавшей проверки, где оно есть, и проверить заново'], ['--lang ru|en', 'Language of the text output (default: the system language)', 'Язык текстового вывода (по умолчанию язык системы)']],
  examples: ['doctor', 'doctor --lang ru', 'doctor --json'],
});
c('config check', 'Проверить app.config.js, не запуская приложение', { usage: '[--cwd dir]', flags: [['--cwd dir', 'Directory with the configuration (default: the current one)', 'Каталог с настройками (по умолчанию текущий)']], examples: ['config check'] });
c('config show', 'Показать действующую конфигурацию: откуда каждое значение (файл, переменная окружения, умолчание) и чем оно отличается от умолчания. Секреты скрыты', { usage: '[text] [--changed] [--json]', flags: [JSON_F, ['--changed', 'Only what is set and differs from the default', 'Только заданное и отличающееся от умолчания']], examples: ['config show server', 'config show --changed'] });

c('backup run', 'Сделать резервную копию базы сейчас', { usage: '[--json]', flags: [JSON_F], examples: ['backup run'] });
c('backup list', 'Список известных файлов копий', { usage: '[--json]', flags: [JSON_F], examples: ['backup list', 'backup list --json'] });
c('backup verify', 'Проверить целостность файла копии', { usage: '<file> [--json]', flags: [JSON_F], examples: ['backup verify data/backups/app-2026-11-01.zip'] });
c('backup restore', 'Восстановить базу из копии поверх текущей (только при остановленном сервере)', { usage: '<file> --yes [--json]', flags: [['--yes', 'Required: the live database is replaced', 'Обязательно: текущая база будет заменена'], JSON_F], examples: ['backup restore data/backups/app-2026-11-01.zip --yes'] });

c('cert info', 'Показать срок действия, SAN и признак самоподписанного сертификата', { usage: '[--json]', flags: [JSON_F], examples: ['cert info'] });
c('cert generate', 'Создать новый самоподписанный сертификат', {
  usage: '[--force] [--common-name cn] [--alt-names a,b] [--days n]',
  flags: [['--force', 'Overwrite an existing certificate', 'Перезаписать существующий сертификат'], ['--common-name cn', 'Common name (default: the host)', 'Общее имя (по умолчанию имя хоста)'], ['--alt-names a,b', 'Extra names and addresses, comma-separated', 'Дополнительные имена и адреса через запятую'], ['--days n', 'Validity in days', 'Срок действия в днях']],
  examples: ['cert generate', 'cert generate --force --alt-names app.local,192.168.1.10 --days 365'],
});
c('cert renew', 'Выпустить сертификат заново с теми же именами (subjectAltName)', { usage: '', examples: ['cert renew'] });
c('cert trust', 'Показать, как добавить этот самоподписанный сертификат в доверенные на вашей ОС', { usage: '', examples: ['cert trust'] });

c('audit tail', 'Показать последние записи журнала аудита', { usage: '[--limit n] [--json]', flags: [['--limit n', 'How many entries (default 20)', 'Сколько записей (по умолчанию 20)'], JSON_F], examples: ['audit tail', 'audit tail --limit 100 --json'] });
c('audit export', 'Выгрузить записи аудита в файл', { usage: '<file> [--format json|csv] [--limit n] [--force]', flags: [['--format json|csv', 'File format (default json)', 'Формат файла (по умолчанию json)'], ['--limit n', 'At most n entries', 'Не больше n записей'], ['--force', 'Overwrite the file if it exists', 'Перезаписать файл, если он есть']], examples: ['audit export audit.json', 'audit export audit.csv --format csv --limit 5000'] });
c('audit verify', 'Проверить цепочку хешей аудита (записывает результат для диагностики)', { usage: '[--anchor-id n --anchor-hash hash] [--json]', flags: [['--anchor-id n', 'Entry id of a saved anchor', 'Номер записи сохранённого якоря'], ['--anchor-hash hash', 'Hash of that entry; a mismatch means the log was rewritten', 'Хеш этой записи; расхождение означает, что журнал переписан'], JSON_F], examples: ['audit verify', 'audit verify --anchor-id 120 --anchor-hash 9f2c…'] });
c('audit anchor', 'Напечатать голову цепочки аудита (номер и хеш): храните её там, куда сервер не достанет', { usage: '[--json]', flags: [JSON_F], examples: ['audit anchor'] });

c('ban add', 'Заблокировать адрес или логин', { usage: '<ip|user> <value> [--reason text] [--duration 2h]', flags: [['--reason text', 'Why (shown to administrators)', 'Причина (видна администраторам)'], ['--duration 2h', 'How long (e.g. 30m, 2h, 7d); without it the ban is permanent', 'На какое время (30m, 2h, 7d); без параметра блокировка бессрочная']], examples: ['ban add ip 203.0.113.7 --reason scan --duration 24h', 'ban add user mallory'] });
c('ban lift', 'Снять блокировку', { usage: '<ip|user> <value>', examples: ['ban lift ip 203.0.113.7'] });
c('ban list', 'Список блокировок', { usage: '[--all] [--json]', flags: [['--all', 'Include expired and lifted bans', 'Включая истёкшие и снятые'], JSON_F], examples: ['ban list', 'ban list --all --json'] });

c('maintenance status', 'Показать, включён ли режим обслуживания', { usage: '[--json]', flags: [JSON_F], examples: ['maintenance status'] });
c('maintenance on', 'Включить режим обслуживания', { usage: '[--message text] [--until 2030-01-01T10:00:00Z]', flags: [['--message text', 'Text shown to visitors', 'Текст для посетителей'], ['--until date', 'Expected end (ISO date)', 'Ожидаемое окончание (дата ISO)']], examples: ['maintenance on --message "Обновление"'] });
c('maintenance off', 'Выключить режим обслуживания', { usage: '', examples: ['maintenance off'] });

c('sessions list', 'Кто вошёл: по строке на пользователя, без идентификаторов сессий', { usage: '[--json]', flags: [JSON_F], examples: ['sessions list'] });
c('sessions revoke', 'Завершить все сессии пользователя', { usage: '<username>', examples: ['sessions revoke ann'] });
c('announcement show', 'Показать объявление вверху страниц', { usage: '[--json]', flags: [JSON_F], examples: ['announcement show'] });
c('announcement set', 'Опубликовать объявление', { usage: '"text" [--level info|warning|critical] [--until 2030-01-01T10:00:00Z]', flags: [['--level name', 'info, warning or critical', 'info, warning или critical'], ['--until date', 'Show until (ISO date)', 'Показывать до (дата ISO)']], examples: ['announcement set "Плановые работы в 22:00" --level warning'] });
c('announcement clear', 'Снять объявление', { usage: '', examples: ['announcement clear'] });
c('mail queue', 'Очередь писем: счётчики и последние строки, без текста писем', { usage: '[--status pending|sending|sent|failed] [--limit n] [--json]', flags: [JSON_F, ['--status name', 'Only this status', 'Только этот статус'], ['--limit n', 'How many rows (1-200)', 'Сколько строк (1-200)']], examples: ['mail queue --status failed'] });
c('mail purge', 'Удалить завершённые письма из очереди старше N дней', { usage: '[--days 7]', flags: [['--days n', 'Age in days (default 7)', 'Возраст в днях (по умолчанию 7)']], examples: ['mail purge --days 30'] });
c('audit purge', 'Удалить записи аудита старше даты (цепочка остаётся целой)', { usage: '--before <date> --yes [--archive-dir <dir>]', flags: [['--before date', 'Delete entries older than this', 'Удалить записи старше этой даты'], ['--yes', 'Confirm the deletion', 'Подтвердить удаление'], ['--archive-dir dir', 'Keep a checked copy here first', 'Сначала сохранить проверенную копию сюда']], examples: ['audit purge --before 2026-01-01 --yes --archive-dir ./audit-archive'] });

c('db status', 'Сводка по базе: соединение, миграции, размер файла', { usage: '[--json]', flags: [JSON_F], examples: ['db status'] });
c('db integrity', 'Проверка PRAGMA integrity_check', { usage: '[--repair]', flags: [['--repair', 'Also run VACUUM (does not fix structural corruption)', 'Дополнительно выполнить VACUUM (структурные повреждения не исправляет)']], examples: ['db integrity'] });

c('deps list', 'Список установленных пакетов по lock-файлу', { usage: '[--dev] [--json]', flags: [['--dev', 'Include development packages', 'Включая пакеты для разработки'], JSON_F], examples: ['deps list'] });
c('deps licenses', 'Проверить лицензии зависимостей (код 3, если что-то требует внимания)', { usage: '[--allow MPL-2.0,...] [--dev] [--json]', flags: [['--allow list', 'Extra licenses to accept, comma-separated', 'Дополнительно допустимые лицензии через запятую'], ['--dev', 'Include development packages', 'Включая пакеты для разработки'], JSON_F], examples: ['deps licenses', 'deps licenses --allow MPL-2.0'] });
c('deps audit', 'Найти известные уязвимости в зависимостях (код 3, если есть открытые)', { usage: '[--dev] [--json]', flags: [['--dev', 'Include development packages', 'Включая пакеты для разработки'], JSON_F], examples: ['deps audit'] });
c('deps outdated', 'Показать прямые зависимости, у которых есть более новая версия', { usage: '[--dev] [--fail] [--json]', flags: [['--dev', 'Include development packages', 'Включая пакеты для разработки'], ['--fail', 'Exit with code 3 when something is outdated', 'Вернуть код 3, если что-то устарело'], JSON_F], examples: ['deps outdated', 'deps outdated --fail'] });
c('deps check', 'Лицензии и уязвимости за один проход, для CI (код 3 при любой проблеме)', { usage: '[--allow ...] [--dev] [--json]', flags: [['--allow list', 'Extra licenses to accept', 'Дополнительно допустимые лицензии'], ['--dev', 'Include development packages', 'Включая пакеты для разработки'], JSON_F], examples: ['deps check'] });

c('privacy registry', 'Реестр обработки персональных данных', { usage: '[--format md|csv|json] [--lang ru|en] [--out file] [--force]', flags: [['--format md|csv|json', 'Output format (default md)', 'Формат (по умолчанию md)'], ['--lang ru|en', 'Language of the register', 'Язык реестра'], ['--out file', 'Write to a file instead of the screen', 'Записать в файл вместо экрана'], ['--force', 'Overwrite the file', 'Перезаписать файл']], examples: ['privacy registry', 'privacy registry --format csv --out registry.csv'] });
c('privacy reapply-erasures', 'Повторно стереть тех, кого стёрли до восстановления из копии', { usage: '', examples: ['privacy reapply-erasures'] });
c('privacy export', 'Выгрузить данные пользователя по всем модулям', { usage: '--user <username> [--out file] [--force]', flags: [['--user username', 'Whose data', 'Чьи данные'], ['--out file', 'Write to a file instead of the screen', 'Записать в файл'], ['--force', 'Overwrite the file', 'Перезаписать файл']], examples: ['privacy export --user ivan --out ivan.json'] });
c('privacy erase', 'Стереть данные пользователя: обезличить (по умолчанию) или удалить', { usage: '--user <username> --yes [--mode anonymize|delete]', flags: [['--user username', 'Whose data', 'Чьи данные'], ['--mode anonymize|delete', 'anonymize keeps the rows without personal data (default); delete removes them', 'anonymize оставляет записи без персональных данных (по умолчанию); delete удаляет их'], YES_F], examples: ['privacy erase --user ivan --yes', 'privacy erase --user ivan --mode delete --yes'] });
c('privacy incident declare', 'Записать инцидент безопасности', { usage: '--title <text> [--description text] [--severity low|medium|high] [--personal-data] [--detected ISO-date]', flags: [['--title text', 'Short title', 'Краткое название'], ['--description text', 'What happened', 'Что произошло'], ['--severity level', 'low, medium or high (default medium)', 'low, medium или high (по умолчанию medium)'], ['--personal-data', 'Personal data is involved: notice deadlines start', 'Затронуты персональные данные: начинают идти сроки уведомления'], ['--detected date', 'When it was detected (default: now)', 'Когда обнаружен (по умолчанию сейчас)']], examples: ['privacy incident declare --title "Утечка списка" --personal-data'] });
c('privacy incident list', 'Список инцидентов', { usage: '[--status open|notified|closed]', flags: [['--status value', 'Only this status', 'Только с этим статусом']], examples: ['privacy incident list', 'privacy incident list --status open'] });
c('privacy incident show', 'Показать один инцидент', { usage: '--id <n>', flags: [['--id n', 'Incident number', 'Номер инцидента']], examples: ['privacy incident show --id 1'] });
c('privacy incident update', 'Записать ход работ по инциденту', { usage: '--id <n> [--status ...] [--severity ...] [--first-notice date] [--details-notice date] [--measures text]', flags: [['--id n', 'Incident number', 'Номер инцидента'], ['--status value', 'open, notified or closed', 'open, notified или closed'], ['--severity level', 'low, medium or high', 'low, medium или high'], ['--first-notice date', 'When the regulator was first notified', 'Когда впервые уведомлён регулятор'], ['--details-notice date', 'When the details were sent', 'Когда отправлены подробности'], ['--measures text', 'Measures taken', 'Принятые меры']], examples: ['privacy incident update --id 1 --status notified --first-notice 2026-11-02'] });

// The user commands carry their English help themselves; here only the Russian.
const U = {
  'user create-admin': ['Создать (или сбросить) администратора; --force нужен, если пользователи уже есть', ['Имя создаваемого пользователя (по умолчанию «admin»)', 'Обязательно, если пользователи уже есть: без него команда не выполнится']],
  'user reset-password': ['Сбросить пароль существующего пользователя на случайный временный'],
  'user list': ['Список учётных записей (хеши и секреты не выводятся)', ['Совпадение с логином или e-mail (обычный текст, без учёта регистра)', 'Только эта роль', 'Только отключённые', 'Не больше n строк (по умолчанию 50, максимум 200)', 'JSON вместо таблицы']],
  'user create': ['Создать учётную запись со случайным временным паролем (при первом входе его придётся сменить)', ['Роль (по умолчанию operator)', 'Адрес e-mail (нужен для сброса пароля письмом)']],
  'user rename': ['Изменить логин пользователя (его сессии завершаются)'],
  'user set-role': ['Изменить роль пользователя (его сессии завершаются; последнего администратора понизить нельзя)'],
  'user set-email': ['Задать или убрать (--clear) адрес e-mail пользователя', ['Убрать адрес']],
  'user delete': ['Удалить учётную запись: по умолчанию обезличивание (строка остаётся, вход невозможен); --hard удаляет совсем', ['Обязательно: подтверждает удаление', 'Удалить строку вместо обезличивания (только если этого требует закон)']],
  'user authenticators': ['Список способов входа (аутентификаторов) пользователя', ['JSON вместо таблицы']],
  'user authenticators-remove': ['Принудительно удалить аутентификатор; по умолчанию последний способ входа удалить нельзя', ['Снять защиту «последнего фактора»']],
  'user recovery-codes': ['Создать (заново) коды восстановления; прежний набор перестаёт действовать', ['Сколько кодов создать (по умолчанию 8)']],
};
for (const [path, [ru, flagsRu]] of Object.entries(U)) H[path] = { ru, usage: undefined, flags: [], examples: [], flagsRu: flagsRu ?? [] };

export const CLI_HELP = H;

/** The language for command help and messages: --lang, else the system language. */
export function resolveCliLang(flags = {}, env = process.env) {
  if (flags.lang === 'ru' || flags.lang === 'en') return flags.lang;
  const sys = String(env.LC_ALL || env.LANGUAGE || env.LANG || '').toLowerCase();
  return sys.startsWith('ru') ? 'ru' : 'en';
}

export const CLI_TEXT = {
  en: { usage: 'Usage', commands: 'Commands', flags: 'Flags', examples: 'Examples', more: (n) => `Run "${n} help <command>" (or "${n} <command> --help") for details on one command.`, unknown: (p) => `Unknown command: ${p}`, unknownFlag: (n, f, p) => `[${n}] warning: unknown flag --${f} for "${p}" (see "${n} help ${p}")`, noDetail: '(No detailed flag/example reference yet for this command.)' },
  ru: { usage: 'Использование', commands: 'Команды', flags: 'Параметры', examples: 'Примеры', more: (n) => `«${n} help <команда>» (или «${n} <команда> --help») покажет подробности по одной команде.`, unknown: (p) => `Неизвестная команда: ${p}`, unknownFlag: (n, f, p) => `[${n}] предупреждение: неизвестный параметр --${f} у команды «${p}» (см. «${n} help ${p}»)`, noDetail: '(Подробного описания параметров и примеров для этой команды пока нет.)' },
};

/** The help of one command in a language: the registered text overlaid with the catalog. */
export function helpFor(path, meta, lang) {
  const h = CLI_HELP[path];
  if (!h) return meta;
  const out = { ...meta };
  if (lang === 'ru') {
    out.description = h.ru ?? meta.description;
    if (meta.flags?.length && h.flagsRu?.length) out.flags = meta.flags.map((f, i) => ({ ...f, description: h.flagsRu[i] ?? f.description }));
  }
  if (out.usage === undefined && h.usage !== undefined) out.usage = h.usage;
  if (!out.flags?.length && h.flags.length) out.flags = h.flags.map(([name, en, ru]) => ({ name, description: lang === 'ru' ? ru : en }));
  if (!out.examples?.length && h.examples.length) out.examples = h.examples;
  return out;
}
