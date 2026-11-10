# Командная строка

## Назначение

Ядро даёт набор команд администрирования, которые приложение подключает к своему `bin/app.js`. Всё, что можно сделать в админке, можно сделать и из консоли — на сервере без браузера, в скриптах и cron.

```js
import { cli as cliModule } from '@das-forge/core';
const cli = cliModule.createCli({ name: 'workshop' });
cliModule.registerBackupCommands(cli, { /* … */ });
await cli.run(process.argv.slice(2));
```

Полный пример подключения — `examples/workshop/bin/app.js`. Запуск в примере: `npm run cli -- <команда>` из `examples/workshop` либо `node bin/app.js <команда>`.

## Живая консоль сервера

Если сервер запущен в обычном окне консоли (`npm start`), внизу окна закреплена полоса: надпись DAS FORGE, линия «=», несколько строк для ответа команды и строка ввода `>`. Журнал работы идёт выше, прокручиваясь сам. В строке ввода работают команды (с косой чертой):

| Команда | Что делает |
|---|---|
| `/health` | живость процесса и базы: статус, версия, время работы |
| `/status` | адреса, память, версия Node |
| `/help` | список команд |
| `/clear` | очистить область ответа |
| `/stop` | остановить сервер так же, как Ctrl+C (с корректным завершением) |

Полоса включается только в настоящем окне консоли достаточного размера (от 100 столбцов и 24 строк). В Docker, службе, при перенаправлении вывода в файл и при `DAS_CONSOLE=plain` сервер пишет в консоль как раньше, без полосы. Для своего приложения: `liveConsole.liveConsoleSupported()` и `liveConsole.startLiveConsole({ commands })`; ответ команды — строка или массив строк.

## Как вызвать команды, когда сервер уже запущен

Окно консоли, где идёт `npm start`, занято сервером: пока он работает, команды в него не вводятся. Так и задумано, закрывать его не нужно.

1. Оставьте окно с сервером как есть.
2. Откройте **второе** окно консоли (Windows: Win+R, `cmd`, Enter).
3. Перейдите в папку приложения: `cd C:\путь\до\das-forge-core\examples\workshop`.
4. Запускайте команды: `npm run cli -- help`, `npm run cli -- maintenance status`, `npm run cli -- sessions list`.

Два дефиса `--` обязательны: они отделяют параметры npm от параметров приложения (без них `--status` и подобные флаги перехватывает сам npm). Без npm то же самое: `node bin/app.js <команда>`.

Оба окна работают с одной базой, поэтому изменения вроде `maintenance on` или `announcement set` запущенный сервер подхватывает сам через пару секунд. Исключение — `backup restore`: он подменяет файл базы, перед ним сервер остановите (Ctrl+C в его окне).

## Справка по командам

`<приложение> help` печатает список команд, `help <команда>` (или `<команда> --help`) — описание, использование, параметры и примеры одной команды. Справка есть у каждой команды, на русском и английском: язык задаёт `--lang ru|en`, без него берётся язык системы (переменные `LC_ALL`, `LANGUAGE`, `LANG`; в Windows они обычно не заданы, поэтому там нужен `--lang ru`). Тексты справки лежат в `packages/core/src/cli/help.js`; тест `cli-help` не пропустит команду без справки. Сообщения самих команд (результаты, ошибки) пока английские, кроме `doctor` и `privacy registry`.

## Коды завершения

| Код | Смысл |
|---|---|
| 0 | успех |
| 1 | команда выполнена и отказала (не найдено, нет `--yes`/`--force`, ошибка) |
| 2 | неверный вызов (не хватает аргумента или флага) |
| 3 | проверка выполнена и нашла проблемы (`doctor`) |

## Команды

Подключаются функциями `register…Commands`; приложение выбирает, какие нужны.

| Группа | Команды | Что делает |
|---|---|---|
| зависимости | `deps list`, `deps licenses [--allow ...]`, `deps audit`, `deps outdated [--fail]`, `deps check` (у всех `--dev`, `--json`) | читают `package-lock.json` и `package.json` приложения; `licenses` сверяет лицензии со списком допустимых (MIT, ISC, BSD, Apache-2.0 и др.; выражения вроде `(MIT OR GPL-3.0)` разбираются, копилефт и отсутствие лицензии — «нужно посмотреть»), `audit` спрашивает известные уязвимости у реестра (принятые `security.dependencyAudit.ignore` не считаются), `outdated` показывает новые версии прямых зависимостей (major помечен), `check` — `licenses` и `audit` разом для CI; код 3 при проблемах, код 1, если реестр недоступен (недоступность не выдаётся за «всё чисто») |
| конфигурация | `config check`, `config show [текст] [--changed] [--json]` | `check` проверяет конфигурацию схемой без запуска; `show` печатает действующую конфигурацию: у каждого значения источник (`file` — app.config.js, `env` — переменная окружения, `default` — умолчание) и пометка «отличается от умолчания»; секреты скрыты (`(hidden)`), `--changed` оставляет только заданное и изменённое |
| версия, состояние | `version`, `health [--json]`, `doctor [--json] [--fix] [--lang ru|en]` | `health` — быстрая проверка (процесс и база); `doctor` — полная диагностика, код 3 при проблемах; текст выводится на языке `--lang` (по умолчанию язык системы), JSON всегда английский |
| база | `migrate [--no-backup]`, `migrate status`, `db status`, `db integrity [--repair]` | миграции (перед первой ожидающей делается копия базы в `pre-migrate/`, `--no-backup` отказывается от неё, и это пишется в журнал); сводка и `PRAGMA integrity_check` (`--repair` делает `VACUUM`, структурные повреждения не лечит) |
| копии | `backup run`, `backup list`, `backup verify <файл>`, `backup restore <файл> [--yes]` | немедленная копия; список; проверка целостности; восстановление поверх живой базы |
| пользователи | `user create-admin`, `user create`, `user list`, `user rename`, `user set-role`, `user set-email`, `user reset-password`, `user disable`, `user enable`, `user delete`, `user authenticators`, `user authenticators-remove`, `user recovery-codes` | управление учётными записями |
| блокировки | `ban add <ip\|user> <значение> [--reason] [--duration 2h]`, `ban lift`, `ban list [--all] [--json]` | блокировка адресов и имён |
| задачи | `tasks list [--json]`, `tasks run <имя>` | список задач с расписанием и последним запуском; ручной запуск (тот же замок, что у сервера; в журнал `cli.tasks.run` от имени `cli/<пользователь ОС>`). Приложение передаёт планировщик с зарегистрированными, но не запущенными задачами: `cli.registerTasksCommands(cli, { scheduler, auditLog })` (в шаблоне и workshop подключены стандартные задачи уборки; задачи, которым нужен работающий сервер, и резервная копия — через `backup`) |
| эксплуатация | `maintenance status [--json]`, `maintenance on [--message] [--until]`, `maintenance off`, `sessions list [--json]`, `sessions revoke <имя>` | режим работ и выход пользователя везде |
| аудит | `audit tail [--limit n]`, `audit export <файл> [--format json\|csv]`, `audit verify [--anchor-id n --anchor-hash h]`, `audit anchor` | журнал и проверка цепочки |
| реестр обработки | `privacy registry [--format md\|csv\|json] [--lang ru\|en] [--out файл]` | реестр обработки персональных данных из кода и настроек; предупреждает о модулях без цели или основания |
| инциденты безопасности | `privacy incident declare --title <текст> [--description] [--severity low\|medium\|high] [--personal-data] [--detected <дата>]`, `privacy incident list [--status]`, `privacy incident show --id <n>`, `privacy incident update --id <n> [--status] [--severity] [--first-notice <дата>] [--details-notice <дата>] [--measures <текст>]` | реестр инцидентов; `list` помечает просроченные сроки уведомления |
| персональные данные | `privacy export --user <имя> [--out файл]`, `privacy erase`, `privacy reapply-erasures` | выгрузка и удаление данных человека; повторное удаление после восстановления копии |
| сертификаты | `cert info`, `cert generate [--force] [--common-name] [--alt-names a,b] [--days n]`, `cert renew` (запущенный процесс подхватит сертификат сам; копия прежней пары `*.bak-<время>`, срок как у прежнего), `cert trust` | самоподписанный сертификат; `trust` печатает инструкцию для ОС |

Опасные команды требуют явного подтверждения: `backup restore --yes`, `user delete --yes` (`--hard` — физическое удаление вместо обезличивания, только если этого требует закон), `user create-admin --force`, если пользователи уже есть, `user authenticators-remove --force` для последнего фактора.

## Примеры

Действия команд записываются в журнал от имени `cli/<пользователь операционной системы>` (например `cli/deploy`): так видно, кто открыл терминал. Имя хранится как псевдоним, который можно стереть, как любое имя человека.


```
app deps check            # лицензии и уязвимости, код 3 при проблемах (для CI)
app deps outdated --fail  # код 3, если есть новые версии
```

```bash
# первый администратор (пароль 24 символа выводится один раз)
npm run cli -- user create-admin --username admin

# сброс пароля с принудительной сменой при входе
npm run cli -- user reset-password ivan

# ночная проверка для мониторинга: код 3 — есть проблемы
npm run cli -- doctor --json

# проверка копии перед восстановлением
npm run cli -- backup verify data/backups/workshop-2026-10-24.zip
npm run cli -- backup restore data/backups/workshop-2026-10-24.zip --yes

# якорь цепочки аудита хранить вне сервера, затем сверять
npm run cli -- audit anchor
npm run cli -- audit verify --anchor-id 1042 --anchor-hash <хеш>
```

## Свои команды

Команда — путь из слов, `description` и `handler({ positionals, flags })`, который возвращает код завершения. Образец с настоящими данными — `examples/workshop/src/alerts-commands.js` (`alerts test`, `alerts list`).

```js
cli.command('assets recount', {
  description: 'Пересчитать остатки',
  usage: '[--dry-run]',
  flags: [{ name: '--dry-run', description: 'Только показать' }],
  examples: ['assets recount --dry-run'],
  async handler({ positionals, flags }) { /* … */ return 0; },   // возвращает код завершения
});
```

## Внимание

- Команды, меняющие данные, пишут в аудит так же, как админка.
- После `backup restore` выполните `privacy reapply-erasures`: люди, удалённые после создания копии, иначе вернутся.
- Пароли и ключи не передавайте аргументами командной строки — они остаются в истории оболочки; используйте переменные окружения или `*_FILE`.
- Соответствие команд и разделов админки — в разделе «Администрирование».

## Тесты

`packages/core/test/cli*.test.js`, `user-admin.test.js`.

**См. также:** [Эксплуатация](10-operations.md), [Безопасность](04-security.md), [Зависимости](12-dependencies.md).
