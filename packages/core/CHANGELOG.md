# Changelog — @das-forge/core

Формат по [Keep a Changelog](https://keepachangelog.com/), версии —
[SemVer](https://semver.org/). Правило бампа и полная шкала версий —
`docs/roadmap.md` §0.4 в корне репозитория.

## [Unreleased]
### Planned
- Workshop Stage F (портирование IT Assets в `apps/`).
- CLI help: `usage`/`flags`/`examples` заполнены пока для `migrate`,
  `migrate status` и всех `user *` команд (0.1.18) — остальные ~18
  команд (`backup *`, `cert *`, `audit *`, `privacy *`, `db *`,
  `config check`, `health`, `doctor`, `version`) показывают честную
  заглушку "(No detailed flag/example reference yet…)" вместо пустого
  экрана, но сам текст ещё не написан.

## [0.1.283]
### Added
- G-13: команды `tasks list [--json]` и `tasks run <имя>`
  (`cli.registerTasksCommands(cli, { scheduler, auditLog })`). Список не
  запускает ничего; `run` исполняет задачу в процессе консоли с тем же
  замком и защитой от наложения, что у сервера, и пишет `cli.tasks.run`
  (результат, время) от имени `cli/<пользователь ОС>`. Неизвестное имя —
  код 2 и перечень известных задач, сбой задачи — код 1.
- В `examples/workshop/bin/app.js` и `templates/app/bin/app.js` подключены
  стандартные задачи уборки (сессии, аудит, стирание персональных данных,
  баны, почта, токены); задачи, которым нужен работающий сервер (метрики,
  оповещения), и резервная копия — не вошли (для копии есть `backup`).
### Tests
- `cli-tasks.test.js` (5).

## [0.1.282]
### Added
- G-13: страница «Логи» стала страницей приёмников: куда пишет каждый
  (файл, адрес без параметров и ключей, syslog `протокол://хост:порт`), какие
  потоки и минимальный уровень принимает, состояние («работает» /
  «сбой, копится очередь» / «теряет строки»), счётчики и последняя ошибка;
  список выводится стандартным постраничным блоком. Кнопка «Проверить
  приёмники» (`POST /admin/logs/test`, через step-up, запись `admin.logs.test`):
  тестовая строка уходит в каждый приёмник напрямую, в обход фильтров, и
  результат показан по каждому (доставлено / не доставлено и причина).
- `createLogDestination()` получил `describe()` и `test({ timeoutMs })`.
- Менять приёмники из интерфейса не стали сознательно: адреса и ключи
  остаются в конфигурации (`logs.sinks`), изменение требует перезапуска.
### Tests
- `admin-ops.test.js`: страница показывает адрес и фильтры и не показывает
  ключи; кнопка проверки доходит до файла, мёртвый адрес отмечен сбоем,
  запись в журнале.

## [0.1.281]
### Dependencies
- `vitest` ^5.0.5 → ^5.1.0 (ядро, workshop, шаблон). Проверено по реестру
  npm: `latest` = 5.1.0, выпущена 2 ноября, `engines.node`
  `^22.12 || ^24 || >=26`, vite-peer `^6.4 || ^7 || ^8` (в lock уже
  подходящий). В заметках релиза breaking changes нет; изменения по
  умолчанию касаются только browser-режима (порт 23315, трассировка при
  сбое), он у нас не используется.
- `eslint` остаётся на 10.x (решение владельца: проектов на ядре пока нет,
  откат на 9.x не нужен). `npm audit`: 3 умеренные находки в `minimatch`
  (DoS при разборе шаблонов) через `eslint` — только инструмент
  разработки, в приложение не попадает; исправление есть только через
  откат на eslint 9, поэтому принято как известный риск до выхода
  патча в eslint 10.
- Lock-файл в архиве отстаёт от `package.json` (генерируется на машине с
  доступом к реестру): после `npm install` нужно прислать обновлённый
  `package-lock.json`.

## [0.1.280]
### Added
- G-13: раздельные сроки хранения аудита. Настройка `audit.personalDataDays`
  (0 = выключено) и задача `audit-personal-gc` (03:55): настоящие логины и IP
  за псевдонимами, не встречавшиеся N дней, стираются; строка остаётся,
  поля читаются «[erased]», цепочка хешей остаётся валидной. Срок самих
  строк — прежний `audit.retentionDays`. Функция `audit.purgePersonalData`,
  запись `audit.personal_data.purge` в журнале. Параметр
  `auditPersonalDataDays` у `registerStandardJobs` (подключён в шаблоне и в
  workshop).
- ADR 0009 с обоснованием (требования 152-ФЗ, GDPR, рекомендация CNIL,
  PCI DSS, приказы ФСТЭК №21/№239; что не проверено — перечислено в ADR).
### Fixed
- Тест G-03 в `admin-ops.test.js` (0.1.270) стоял вне блока, где определены
  `manage`/`byName`/`actor`: падал `ReferenceError` и давал 8 ошибок ESLint
  `no-undef`. Перенесён внутрь блока.
- Живая консоль: нижняя часть теперь имеет собственную верхнюю линию «=»
  (раньше за верхнюю принималась линия из вывода журнала, которая уезжала
  вверх вместе с логами и оставляла две пустые строки). Порядок: «=», одна
  пустая строка, надпись, одна пустая строка, «=», строки ответа, приглашение.
  Высота закреплённой части +3 строки. Тест раскладки в `live-console.test.js`.
### Limits
- Срок считается от последнего появления значения; свободный текст в `meta`
  не псевдонимизируется; старые строки до псевдонимов уходят по
  `retentionDays`.
### Tests
- `audit-personal-data.test.js` (4): стирание, цепочка цела, свежее остаётся,
  запись в журнале, проверка параметра, задача включается только при сроке.

## [0.1.279]
### Added
- G-13: отдельное право на чувствительные поля аудита —
  `createAdmin({ auditAccess: { read, export, sensitive } })`. Без `sensitive`
  читатель не видит IP, `meta` и «что изменилось» (список, карточка события,
  живая лента), список IP в сводке; выгрузка без колонок `ip` и `meta`, в
  журнале выгрузки пометка `withoutSensitive`. Администраторы видят всё; если
  `sensitive` не задан — поведение прежнее (обратная совместимость).
### Tests
- `audit-auditor.test.js`: 4 новых случая (скрытие во всех представлениях,
  показ с правом и администратору, выгрузка, обратная совместимость).

## [0.1.278]
### Changed
- G-13 (контакты): `SECURITY.md` и `CODE_OF_CONDUCT.md` — вместо заглушек
  адрес проекта DAS-Forge (по решению автора), приватная форма GitHub
  остаётся основной. `LICENSE` без изменений («DAS-Forge contributors»).
- `templates/app/SECURITY.md`: отдельное место для контакта автора
  приложения (`<SECURITY_CONTACT>`, `<APP_NAME>`), `release:check` ядра его не
  проверяет (проверяет только корень репозитория).

## [0.1.277]
### Tests / Docs
- G-12: замер фильтров аудита на 1 000 000 строк: все ≤ 162 мс
  (`docs/performance-budget.md`, там же бюджет «до 0,5 с на страницу» и
  не измеренное). `requestId` и `result` идут полным сканом (55–63 мс) —
  индексы не добавлялись сознательно (цена записи каждой строки аудита).
- `scripts/audit-bench.mjs` — повторяемый замер.
- `test/audit-query-plan.test.js`: `actor`, `action`, `entity+entityId`,
  `since/until` обязаны использовать индекс (EXPLAIN QUERY PLAN).

## [0.1.276]
### Changed (CI, по PR от Dependabot #1–#5)
- `actions/checkout` v4 → v7, `actions/setup-node` v4 → v7,
  `github/codeql-action` v3 → v4, `gitleaks/gitleaks-action` v2 → v3,
  `aquasecurity/trivy-action` 0.28.0 → v0.36.0 (теги теперь с `v`).
  Релизы прочитаны: v7 checkout блокирует checkout форков в
  `pull_request_target`/`workflow_run` (мы их не используем); setup-node v6+
  кэширует только npm (у нас `cache: npm` явно); gitleaks v3 — только Node 24,
  входы те же; Node 20 на GitHub-раннерах убирают 16.09.2026, v2/v3-старые
  действия перестали бы работать; trivy 0.36.0 без breaking changes.
- Не проверено запуском: результат первого прогона CI на GitHub.
### Process
- Правило обновлений: свежие версии берём сразу (чтение changelog — шаг
  работы, а не повод отложить); осторожность — только когда changelog
  показывает несовместимость с нашим кодом.

## [0.1.275]
### Fixed
- Регрессия 0.1.272: в `health/checks/dependencies.js` импорт
  `../http/outbound.js` вместо `../../http/outbound.js` — ядро не
  загружалось целиком (37 файлов тестов, 3 теста lazy-imports). Причина
  моей ошибки: после правки проверил только `node --check` (синтаксис), а не
  загрузку модуля. Исправлено.
### Tests
- `imports-resolve.test.js`: каждый относительный импорт в `src/` и `test/`
  указывает на существующий файл.
### Process
- Правило проверки изменения: после правки файла — реальный импорт модуля,
  а не только `node --check`.

## [0.1.274]
### Fixed
- G-11: кнопка «Выйти» (`ui/shell.js`) молча глотала сбой запроса `/logout` и
  всё равно уходила на `/login`, хотя сессия могла остаться живой. Теперь при
  ошибке сети или ответе не-2xx кнопка снова активна и показывается
  сообщение (`ui.signOutFailed`, ru/en); редирект — только при успехе.
  Пустые `catch` вокруг `localStorage` оставлены осознанно.
### Tests
- `ui-locale-theme.test.js`: скрипт выхода не содержит пустого catch,
  сообщает об ошибке и является корректным JS (обе локали).

## [0.1.273]
### Tests
- G-10: `test/audit-chain-property.test.js` — свойства цепочки аудита на
  случайных последовательностях (5 фиксированных зёрен, воспроизводимо, без
  новой зависимости): любая последовательность проверяется; изменение любого
  поля любой строки находится именно на ней; удаление средней строки
  находится на следующей; обрезка хвоста видна только через `anchor`;
  retention старых строк не ломает проверку. Объёмный тест: 4300 строк
  через границу страницы 2000, поломка на второй странице, грубый порог
  времени против квадратичного обхода.
- Нагрузочные тесты HTTP и property-based библиотека (`fast-check`) не
  добавлялись: библиотека — новая зависимость, нужно согласие.

## [0.1.272]
### Security
- G-08: адреса из конфигурации проверяются перед исходящим запросом
  (`src/http/outbound.js`: `assertOutboundUrl`, `isBlockedHost`).
  Запрещены link-local (169.254.0.0/16, fe80::/10, в т.ч. десятичная/hex/
  octal записи и IPv4 внутри IPv6) и имена метаданных облака
  (`metadata.google.internal`, `fd00:ec2::254`). Подключено к `webhookChannel`
  (только https), HTTP-приёмнику логов (https/http, `redirect:'error'`) и
  адресу реестра в `findVulnerabilities`.
- Решение: loopback и частные сети (10.x, 192.168.x) разрешены намеренно —
  сборщики логов внутри сети компании. DNS-имена не резолвятся и не
  проверяются (остаточный риск, DNS rebinding).

## [0.1.271]

### Added
- CI now runs the licence check of the production dependencies (`app deps licenses`, already in the core CLI) on every build; before, nobody ran it. The first read of the lock file found 284 packages: 270 on the allowed list, the LGPL families `sharp`/libvips and `libheif-js` reviewed and allowed explicitly, a few packages without a licence field in the lock (their real licence is read from `node_modules` in CI). The result and the rule for new copyleft packages are in `docs/guide/12-dependencies.md`. (G-07)

### Changed
- `deps licenses` marks copyleft licences in its output (the long-unused `COPYLEFT` pattern is used now).

## [0.1.270]

### Added
- `docs/adr/`: template and eight decision records restored from the development log (core = mechanism / app = meaning, audit pseudonyms, erase = anonymize, single-zip backup, polling live feed, i18next, password policy defaults, ports and HTTPS only). (G-06)
- `CLAUDE.md` in the repository root: working rules for an AI agent (language, checks, report labels, release steps, code rules). (G-09)

## [0.1.269]

### Added
- A form is sent once (G-05): in the shared page script (`ui/modal.js`, loaded by every admin and app page) a POST form swallows a second submit within 8 seconds and keeps its buttons disabled meanwhile. The buttons are disabled only after the browser has collected the form, so the pressed button's value is still sent; they unlock after 8 s or when the page is restored from the back/forward cache. Forms that handle their own submit (`fetch`), GET forms and forms marked `data-multi` are left alone. Tests: stand-in page in `ui-modal.test.js`, browser scenario "double click on Create" in `admin-users.e2e.js`.

### Changed
- `privacy/incidents.update` reads the incident, changes it and writes it back whole: now one transaction (rest of G-04). The other places the first pass left open turned out to be safe (see `docs/gaps-core.md`).

## [0.1.268]

### Changed
- "Read, decide, write" sequences are now single transactions that take the write lock first (new helper `database/atomic.js`, `atomic(db, fn)`; G-04). Two processes on one database file (the server and a CLI command) can no longer both pass a check and both write: demoting, disabling or removing the last administrator, removing the last required second factor, banning the same address twice. Also all-or-nothing now: role change together with ending the user's sessions, "require a password change for everyone", a ban together with its ended sessions and audit line, lifting bans with their audit lines, a registration request together with cancelling the older one for the same address.
- Pseudonyms in the audit log: if another process added the same value between our check and our insert, its pseudonym is used instead of failing the audit write on the UNIQUE constraint.
- One-time tokens (password reset, recovery codes, registration, TOTP step) were already safe: the UPDATE is the check. Verified by reading, left as they are.

## [0.1.267]

### Added
- The protection against a lost update (G-03) now covers the settings pages too: password policy, appearance (the name form and the colour form each have their own fingerprint) and announcement. A form saved after someone else changed the same values is refused with "another administrator has changed this ..." and nothing is applied. Generic helper `admin/edit-version.js` (`fingerprint`, `versionField`, `isStale`); forms without the fingerprint are not checked. Maintenance mode needs nothing: it only switches on/off.

## [0.1.266]

### Added
- Two administrators no longer overwrite each other's edits of an account (G-03). The "edit login/e-mail" and "change role" forms carry a fingerprint of the account (`_v`, `userVersion()`); if the account was changed after the form was opened, saving is refused with the message "another administrator has changed this account" and nothing is applied. A form without the fingerprint is not checked, so old pages and scripts keep working. No database change.

### Changed
- ESLint: `no-control-regex` is off (the core strips control characters from input with such expressions on purpose; the first run reported 19 false errors); `no-console` is off in tests and scripts; one misplaced `eslint-disable` in `cli/cli.js` moved to the line it was meant for; four now-needless `no-control-regex` directives removed.

## [0.1.265]

### Added
- Guide "Проверка новой версии" (`docs/guide/13-new-version.md`): step by step what to do with a new archive opened in a clean folder (install, approve install scripts, lock check, lint, tests), with a full section on the browser (e2e) scenarios: one-time browser install, run, what each scenario checks, how to read a failure.

## [0.1.264]

### Fixed
- First real ESLint run found two duplicate-key bugs: on the backups page a missing backup was reported as "User not found" (the users text overwrote the backup text; now `eb_NOT_FOUND`); on the public policy pages the footer link "Licence agreement" was labelled just "Licence" (the table column header overwrote it; the column now has its own `licenseCol`).

### Changed
- ESLint config: `no-console` and `no-control-regex` switched on (the code already carried directives for them, which ESLint reported as unused); `new Function` allowed in tests only; one stale directive removed from `auth/auth-provider.js`. A duplicate key now fails CI, which is the regression guard for both bugs. (G-01)

## [0.1.263]

### Added
- ESLint 10 as the only new (dev) dependency: `eslint.config.js` at the repository root, `npm run lint`, and a lint step in CI. Real mistakes (undefined names, duplicate keys, unreachable code, `eval`) fail the build; unused values and empty blocks only warn. Run `npm install` once to update `package-lock.json` (until then `npm run lock:check` and `npm ci` will refuse the lock file). (G-01, audit 2.4)

## [0.1.262]

### Changed
- Pauses before retries now have a random half ("equal jitter"): mail queue, direct mail sending and log sinks. After a shared outage the clients no longer retry at the same instant. New helper `util/backoff.js` (`backoffDelay`); `createEmailQueue` and `createEmailService` accept `random` for tests. (G-02, audit 2.4)

## [0.1.261]

- Аудит, этап D: подпись объекта на момент события. `audit.log` для `entity: 'user'` сам находит логин по номеру и кладёт его в `meta.username` (псевдоним, стирается вместе с остальными данными человека); для остального есть параметр `entityLabel` (`meta.target`). В таблице и карточке рядом с номером объекта показано его имя, запись читается после переименования и удаления.

## [0.1.260]

- Роль «аудитор» (аудит, этап D): параметр `auditAccess` в `createAdmin` (`{ read, export }`). Пользователь с правом чтения без `admin.access` видит только раздел «Аудит» (журнал, сводка, карточка, живая лента) и урезанное меню; выгрузка CSV/JSON требует отдельного права `export`, кнопки без него скрыты. В workshop: роль `auditor` (права `audit.read`, `audit.export`). Отдельное право на чувствительные поля (IP, `meta`) не сделано.

## [0.1.259]

- Админка, «Конфигурация» (аудит R-17): колонка «Источник» (файл настроек, переменная окружения, умолчание), пометка «отличается от умолчания» и галочка «Только заданные и изменённые». Включается, когда приложение передаёт в `createAdmin` отчёт загрузчика (`configSources`, его заполняет `loadConfig({ report })`); без него страница как прежде. Секреты по-прежнему скрыты.

## [0.1.258]

- Живая консоль сервера (`liveConsole`): в окне консоли журнал идёт выше, а внизу закреплены надпись DAS FORGE, линия «=», область ответа и строка ввода с командами `/health`, `/status`, `/help`, `/clear`, `/stop`. Включается только в настоящем терминале достаточного размера; `DAS_CONSOLE=plain` выключает. Журнал в виде pino-pretty теперь пишется через `process.stdout.write`, чтобы полоса оставалась на месте. Стартовый баннер при живой консоли без надписи (она уже закреплена внизу).

## [0.1.257]

- Баннер при старте по замечаниям: верхняя линия «=» убрана, «=» стоит между логотипом и надписью, после надписи и после строк; вокруг каждого блока по одной пустой строке.

## [0.1.256]

- Баннер при старте: сверху линия из «=», под ней логотип (наковальня), под ним надпись «DAS FORGE» (оба по центру), снова «=», затем адреса и вход, внизу «=». Все строки с отступом в два пробела. `ui.renderBanner(rows, { logo: false })` убирает высокий логотип.

## [0.1.255]

- Живая лента аудита больше не использует `insertAdjacentHTML`: строки разбираются через `DOMParser` и добавляются как узлы (тест `security-invariants` разрешает разметку в страницах только для QR-кода).

## [0.1.254]

- CLI `config show [текст] [--changed] [--json]` (аудит R-09 и R-17): действующая конфигурация с источником каждого значения (файл, переменная окружения, умолчание) и пометкой «отличается от умолчания»; секреты скрыты. В ядре: `config.describeSources`, `config.schemaDefaults`; `loadConfig` принимает `report` и заполняет его (что пришло из файла, какие настройки задала переменная окружения, без значений).

## [0.1.253]

- Баннер при старте: сверху ASCII-надпись «DAS FORGE», под ней линия из «=», затем адреса, вход и (при первом запуске) логин и временный пароль, внизу снова «=». Вместо прежней рамки ╔═╗. В ядре: `ui.DAS_FORGE_WORDMARK`, `ui.DAS_FORGE_LOGO` (круглый логотип, пока нигде не показывается) и `ui.renderBanner(rows)` для своих приложений.

## [0.1.252]

- Аудит, этап C: «Живая лента» в журнале. Галочка под таблицей; пока включена, новые события подгружаются сверху раз в 5 секунд с учётом фильтра (`GET /admin/audit/live?after=<номер>`, нужно то же право, что и для журнала). Не на страницах «Дальше →».

## [0.1.251]

- Документация: как вызывать CLI при запущенном сервере (второе окно консоли, `npm run cli -- …`) — в главах «Командная строка», «Быстрый старт» и README примера.
- Доктор: у проверки «Audit archive» появилось русское название (падал тест health-localize).

## [0.1.250]

- CLI (аудит R-09, продолжение): `announcement show|set|clear`, `mail queue` (счётчики и последние строки без текста писем), `mail purge --days N`, `audit purge --before <дата> --yes [--archive-dir <папка>]`. Всё записывается в аудит; удаление аудита требует `--yes`.

## [0.1.249]
### Added
- Журнал аудита, этап E (R-14): архив перед очисткой. `audit.archiveBefore(db, before, {dir})` пишет строки старше срока в `audit-<от>-<до>.ndjson.gz` (все столбцы с хешами, в конце строка-итог с числом записей и хешем последней) и рядом `.sha256`; `audit.verifyArchive(file)` проверяет контрольную сумму и итог; `audit.archiveAndPurge(...)` удаляет строки только после того, как архив записан и проверен (иначе ошибка и ничего не удалено), а запись `audit.purge` называет файл, число строк и хеш. Новая настройка `audit.archiveDir` (пусто = без архива) подхвачена задачей `audit-gc` (`registerStandardJobs({ auditArchiveDir })`), в workshop подключена.
- Доктор («Безопасность»): предупреждение «Audit archive», если в production старые записи удаляются, архива нет, а зеркало журнала не `full` — история пропадёт безвозвратно.
### Decision
- Раздельные сроки хранения («входы и отказы дольше остального») внутри одной цепочки хешей не сделаны: удаление записей из середины ломает проверку цепочки (`verifyChain` покажет «строка удалена»). Варианты: поставить общий срок по самой долгой категории, а остальное уносить в архив; либо отдельная таблица/цепочка для безопасности — это отдельное решение.
- Не сделано в этапе E: управление приёмниками журналов из админки (добавление, тестовая строка, статус).

## [0.1.248]
### Added
- Журнал аудита, этап D (часть): стандарт `meta.changes = { поле: { from, to } }` и помощник `audit.diffChanges(before, after, {fields, secret})` — в записи попадает только то, что изменилось; значения полей с именами `password`, `secret`, `token`, `key`, `hash`, `totp`, `recovery`, `cookie` и т. п. (и перечисленные в `secret`) заменяются на «••••», длинные обрезаются. Карточка события показывает таблицу «Было → Стало». Парольная политика теперь пишет изменения в этом виде.
- Результат записи `denied` («Отказано» — запрещено правилами доступа, а не сбой) наряду с `success` и `failure`; в таблице и сводке он считается не-успехом.
- Остаётся от этапа D: подпись цели на момент события (логин после удаления пользователя), разделение прав просмотра/выгрузки/чувствительных полей и роль «аудитор».

## [0.1.247]
### Added
- Журнал аудита, этап C (часть): вкладка «Сводка» (`/admin/audit/summary`, период 24 часа / 7 / 30 суток): события, входы, неудачные входы, блокировки, новые устройства, действия админов, сколько человек вошло; столбчатый график неудачных входов по дням; списки «адреса» и «имена» с наибольшим числом неудачных входов и частые действия (по названиям из каталога). Расчёт — `audit.summarizeAudit(db, {since, until})`. Адреса показаны так, как записаны в журнале (по умолчанию обезличены).
- Остаётся от этапа C: живая лента событий.

## [0.1.246]
### Fixed
- Workshop: доктор «Application» писал «health.applicationChecks is not a function or its return value is not iterable» — функция асинхронная, её результат разворачивали как массив без `await`.
- «О системе → Зависимости»: локальный пакет (`file:`, `link:`, `workspace:`) показывается как «локальный пакет», а не как «не удалось связаться с реестром».

## [0.1.245]
### Changed
- `otplib` ^13.6.0 и `docx` ^9.15.3. Прочитано. otplib 13.6: `hooks` передаются в `generateSync`; секреты не попадают в тексты ошибок разбора URI, параметры генерации проверяются; ключи в base64/latin1/ascii читаются как заявлено. Строгая проверка алгоритма (sha1/sha256/sha512, иначе ошибка) введена ещё в 13.5, мы используем стандартный sha1 — ничего не меняется. docx 9.14–9.15: новые возможности (подписи, защита документа, ImagePatch, `readTheme`) нам не нужны; исправления: символы, недопустимые в XML 1.0, вырезаются, строка таблицы без ячеек не пишется, картинки в пакете именуются `image1.png`, как в Word (раньше — по хешу, Word для веба показывал пустой квадрат), типы больше не меняют глобальные объявления, `patchDocument` быстрее на больших файлах. Ломающих изменений нет.

## [0.1.244]
### Changed
- `jsdom` ^31.0.0 и `i18next` ^27.0.1 (в ядре, workshop и шаблоне). Прочитано: jsdom 31 — другой backend картинок (`@napi-rs/canvas`), новый разбор CSS, разбор страницы останавливается на блокирующих скриптах; очистка SVG делает `new JSDOM('')` без скриптов и картинок, поэтому код не менялся. i18next 27 — `fallbackLng` по умолчанию `false`, пустой перевод считается отсутствующим, `/` больше не экранируется, объект без `returnObjects` считается отсутствующим ключом, нужен Node 22+; ядро задаёт `fallbackLng` явно и теперь так же явно `returnEmptyString: false`. После обновления выполните `npm install`, затем `npm test`: особенно `svg-external`, `serve-upload`, `files`, `i18n*`.

## [0.1.243]
### Added
- Журнал аудита, этап B — каталог событий (`audit/catalog.js`): для каждого кода действия — название на двух языках, категория, важность и фраза («{актор} завершил все сессии пользователя {цель}»). В ядре описано около 70 действий; приложения добавляют свои через `audit.registerEvents({...})`. Неизвестное действие показывается кодом, как раньше. Каталог применяется только при чтении, цепочка хешей и старые записи не затронуты.
- Таблица аудита показывает название действия (код — мелко под ним) и метку «!» у важных; карточка события — фразу и категорию. Тест следит, чтобы каждый код действия в исходниках ядра был в каталоге.

## [0.1.242]
### Fixed
- Workshop: страница «Блокировки входа» давала 500 — `routes.js` не отдавал `lockouts`/`unlockLockout` приложению (аудит R-08, моя ошибка при подключении).
- Workshop: доктор в «О системе» писал «jobScheduler is not defined» — планировщик берётся из `schedulerHolder`.
- Админка: общий лимит запросов по умолчанию 100 → 300 в минуту на адрес: страницы админки и фоновые запросы считались, и при быстрой работе приходила 429.
- «О системе → Зависимости»: значок «актуально / есть обновление» вынесен в отдельный столбец «Состояние», больше не липнет к номеру версии.
### Changed
- Поиск по разделам админки: ищет сразу на двух языках (имена разделов и слова-подсказки), терпим к окончаниям («входил» находит «входили»), находит параметры конфигурации по русским и английским словам («порт», «лимит запросов») и ведёт на страницу конфигурации с фильтром; тот же поиск работает в самой таблице конфигурации. Найдены также страницы «Не входили давно» и «Блокировки входа».
- Аудит: поле «Действие» ищет по части текста (`task` находит все действия с `task`); «Кто» остаётся точным.
- Минимальные версии: `argon2` ^0.45.2 (исправлен порядок параметров в PHC-строке хеша), `nodemailer` ^10.4.0 (в 10.2–10.4 нет ломающих изменений; добавлено `close({ force: true })` для пула).
### Not changed (ждёт решения)
- `jsdom` 30 → 31 и `i18next` 26 → 27 — крупные версии с ломающими изменениями; `otplib` 13.6 и `docx` 9.15 — списки изменений не удалось прочитать.

## [0.1.241]
### Fixed
- Справка CLI: описания команд `maintenance *` и `sessions *` (из 0.1.238) добавлены в каталог; два теста `cli-help` падали из-за их отсутствия.

## [0.1.240]
### Added
- Алерты (аудит R-11, R-12): квитирование (`ack`), заглушение ключа на срок (`mute`/`unmute`, до 30 суток), тишина на время режима обслуживания (опция `maintenance`) — заглушённый алерт записывается и считается, но не рассылается; кнопки на странице «Алерты».
- Второй канал: опция `channels` и `webhookChannel({url})` (только https, без переходов по редиректам, тайм-аут); достаточно одного сработавшего канала, ошибки каждого пишутся в `notify_error`.
- Эскалация `escalate({afterMs})`: критичные алерты без квитирования повторно уходят по всем каналам; пульс `heartbeat(url)` на внешний монитор; оба включаются в `alerts.watch(scheduler, { escalateAfterMs, heartbeatUrl })`.
- Новые колонки таблицы `alerts` добавляются сами при старте.

## [0.1.239]
### Added
- Блокировки входа (аудит R-08): `createFailureTracker().list()`; `accounts` отдаёт `lockouts()` и `unlockLockout(kind, key)`; в разделе «Пользователи» новая страница «Блокировки входа» со списком действующих блокировок (имя+адрес, имя, адрес, второй фактор) и кнопкой «Снять» (подтверждение пароля, запись `admin.user.unlock`). Включается опцией `userManagement.lockouts: { list, unlock }`, в workshop подключено.
### Decision
- Счётчики остаются в памяти процесса: перезапуск их обнуляет, это сказано на странице. В БД не пишем — иначе записью в базу можно было бы забивать диск неверными входами; долговременные запреты уже есть в `ban`. Из CLI блокировки не снять (это другой процесс, у него своя память) — для этого есть страница админки или перезапуск.

## [0.1.238]
### Added
- CLI (аудит R-09, часть): `maintenance status|on|off` (режим хранится в БД, работающий сервер подхватывает его за пару секунд; пишется в журнал) и `sessions list|revoke <имя>` (кто вошёл — числом сессий, без идентификаторов; выход пользователя везде, запись `admin.user.force_logout` с `via: cli`). Подключено в шаблон и в workshop. Остальные команды R-09 (tasks, config, mail, alerts, audit purge, объявления) — следующими версиями.

## [0.1.237]
### Added
- R-07: карточка пользователя в админке (`GET /admin/users/:id`: даты входа, активности и смены пароля, второй фактор, сессии без идентификаторов, устройства, последние события) и отчёт «давно не входили» (`/admin/users/inactive?days=N`) с массовым отключением (`stepUp`, письмо, журнал, пропуск последнего администратора и себя). `admin/user-activity.js`. Тесты в `admin-ops.test.js` (3).

## [0.1.236]
### Added
- R-06: действия «Сбросить второй фактор» и «Выпустить новые коды восстановления» в карточке пользователя (`stepUp`, журнал, не на себя); `auth.resetUserMfa`.
- R-22: пользователю уходит письмо о действиях администратора над его учётной записью: отключение/включение (готовые шаблоны `accountBanned`/`accountUnbanned`), смена роли, временный пароль, завершение сессий, сброс второго фактора, новые коды (`systemNotice`). В письмах нет паролей и кодов; сбой письма не мешает действию; в журнале `notified`. Тесты в `admin-ops.test.js` (3).

## [0.1.235]
### Added
- R-05: перед применением ожидающих миграций делается согласованная копия базы (`pre-migrate-<время>-v<версия>.db`, `VACUUM INTO` + `integrity_check`), хранятся `keep` (5) последних; не удалась копия — не применяется ничего. `runMigrations(db, dir, { backupDir, keep, skipBackup, onBackup })`, `migrate --no-backup` (отказ явный и пишется в журнал `db.premigrate.*`). Включено в workshop (при старте и в CLI) и шаблоне. Тесты: `migrator.test.js` (5).

## [0.1.234]
### Added
- R-04: `http.createTlsReloader` — горячая замена сертификата без перезапуска: сигнал SIGHUP (не Windows) и проверка времени изменения файлов раз в минуту. Новая пара сначала проверяется (`tls.createSecureContext`), неподходящая отклоняется, прежняя продолжает работать; журнал `tls.reload`. Подключено в workshop (основной и административный listener). Тест: `tls-reload.test.js` (3).

## [0.1.233]
### Added
- R-01: `admin.createStepUp` — готовое повторное подтверждение для опасных действий администратора (пароль + код TOTP, срок `maxAgeMs`, страница `/admin/confirm`, блокировка после 5 ошибок, возврат только на путь своего сайта, журнал `admin.stepup`). `security.stepUp.{enabled,maxAgeMinutes}`; doctor в production предупреждает, если выключено. Подключено в workshop (выключено по умолчанию). Тесты: `admin-step-up.test.js` (6), `security-checks.test.js`.

## [0.1.232]
### Added
- R-10: раздел «Почта» админки — кнопка «Отменить» у ожидающего письма (`queue.cancel(id)`, содержимое стирается) и «Очистить завершённые» (старше суток); оба действия идут через `stepUp` и пишутся в журнал (`admin.mail.cancel`, `admin.mail.purge`). Повтор неудавшихся не добавлен намеренно: содержимое письма стирается сразу после отправки или отказа. Тест в `admin-system.test.js`.

## [0.1.231]
### Added
- R-19: `security.secretsRotation` (`maxAgeDays`, `sessionSecretCreatedAt`, `totpKeyCreatedAt`, `backupKeyCreatedAt`); doctor проверяет возраст заданных ключей и предупреждает о старых. Без даты — «не записана» (ok), старые конфигурации не меняются. Тесты: `security-checks.test.js` (3).

## [0.1.230]
### Added
- R-18: на странице «Конфигурация» админки — список переменных окружения: какие заданы и откуда (`env`, `_FILE`, обе), без значений; переменные `DAS_*`, которые ничто не читает (опечатка), с подсказкой «возможно, имелась в виду …». `config.describeEnv`. Поиск страницы действует и на этот список. Тесты в `admin-system.test.js` (2).

## [0.1.229]
### Added
- R-02: `scheduler.registerStandardJobs(scheduler, {...})` — уборка сессий, журнала, банов, метрик, токенов/регистраций и отправленной почты одним вызовом; `standardJobsChecks` — проверка в doctor «Задачи очистки» (предупреждение, если не подключено). workshop и шаблон приложения переведены на него. Тесты: `standard-jobs.test.js` (5).

## [0.1.228]
### Fixed
- R-03 (внешний аудит): место копий `s3`/`webdav` отклоняется схемой с понятной ошибкой уже в `config check` (раньше принималось и падало при каждой копии).
- R-16: `cert renew` оставляет `*.bak-<время>` рядом с заменённой парой и сохраняет срок действия прежнего сертификата (раньше всегда 365 дней, без копии).

## [0.1.227]
### Added
- Вход через LDAP/AD в приложении: `accounts.mountAccountRoutes({ directory })`, привязка `directory_links`, создание записи при первом входе, аудит `auth.directory.provision`. Локальные аккаунты не затрагиваются, сбой каталога не блокирует пользователей.
- workshop: необязательный блок `ldap` в `app.config.js` (схема ядра `LdapConfigSchema`). Тесты: `accounts-directory.test.js` (5).

## [0.1.226]
### Added
- Prometheus: выгрузка состояния — `das_bans_active`, `das_security_incidents_open`, `das_alerts_24h`, `das_maintenance_mode`
  (`registerCoreGauges` принимает `maintenance`; workshop подключает). Тест в `metrics.test.js`.

## [0.1.225]
### Fixed
- Тесты после 0.1.222/0.1.224: выгрузка журнала (потоковая) — фейковый `res` получил `write`;
  плитка миграций показывается только при ожидающих — тест обновлён;
  `security-invariants`: две проверенные интерполяции (ряд `?` по числу id, константный фрагмент WHERE) внесены в список.

## [0.1.224]
### Changed
- Обзор админки: плитка «Миграции» показывается только пока есть неприменённые; вместо неё PID процесса, куча Node, нагрузка CPU за минуту (не на Windows), свободная и общая память системы, свободное место на диске с базой.

## [0.1.223]
### Added
- Публичная страница «О платформе» (`about.mountAboutPage`, `/about`): описание, версии ядра и приложений с их логотипами и ссылками на репозитории, лицензия MIT и держатель прав, автор, исходный код. Строка «Powered by DAS-Forge <версия>» на всех страницах ведёт на неё.
- `examples/workshop` подключает страницу (автор взят из владельца репозитория, замените при необходимости).

## [0.1.222]
### Added
- Журнал аудита: карточка события (`/admin/audit/event/<номер>`) со всеми полями, подробностями (`meta`) таблицей, хешами и переходами «все события запроса», «история объекта», «действия пользователя»; новые фильтры по объекту, номеру объекта и запросу (`audit.query({ requestId })`); кнопки периода «Сегодня» и «7 дней».
### Changed
- Выгрузка журнала (CSV и JSON) идёт потоком по частям и больше не обрезается на 5000 строках; в неё добавлены `meta`, `hash`, `prevHash`; в журнал пишется одна запись `admin.audit.export` с числом строк и форматом.

## [0.1.221]
### Changed
- Формы фильтров и создания (раздел «Пользователи» и остальные `adm-filters`): поля растягиваются в ряд, кнопки «Найти» и «Создать» стоят на одной линии с полями и той же высоты, а не падают на вторую строку.

## [0.1.220]
### Added
- Самостоятельная регистрация (`auth.registration`, по умолчанию выключена): страницы `/register` и `/register/confirm`, ссылка «Регистрация» на странице входа. Учётная запись создаётся только после перехода по ссылке из письма (переключатель `requireEmailConfirmation`). Фильтры от ботов: скрытое поле, минимальное время заполнения, лимиты на адрес и на e-mail; занятый логин или e-mail не раскрывается. Всё пишется в аудит (`auth.registration_requested`, `auth.registration_bot`, `auth.registered`).
### Changed
- Подсказка у курсора на графиках показывает только значение (без подписи оси).

## [0.1.219]
### Changed
- Графики: у указателя мыши появляется компактная подпись со значением под курсором (метка и число), она следует за мышью и работает и в развёрнутом графике. Раньше значение показывала только медленная подсказка браузера.

## [0.1.218]
### Added
- Обзор админки: у счётчиков (пользователи, сессии, записи аудита, база, память) можно задать лимит (`createAdmin({ limits })`): показывается «значение из лимита» и полоса, жёлтая с 80 %, красная со 100 %, сверху заметка «Близко к лимиту» или «Лимит превышен».
- `examples/workshop` задаёт демонстрационные лимиты (база 1 ГБ, аудит 5 млн записей, сессии 10 000).

## [0.1.217]
### Changed
- Блокировка входа жёстче: пятая неудача блокирует на 5 минут (было 30 с), каждая следующая удваивает до 24 часов (было 15 минут); счётчик обнуляется после суток тишины (`security.lockout.resetAfterMs`). Общий бюджет по одному логину ограничен часом, чтобы блокировку нельзя было использовать против владельца.
- Шапка страницы переносится на узком экране: переключатели языка и темы больше не обрезаются; кнопка «Выйти» той же высоты, что соседние.
- Внешний аудит ядра лежит в `docs/audit-core-external.md`.

## [0.1.216]
### Added
- Модуль `notifications`: общий приёмник уведомлений людям (`notify`, `notifyRole`, чтение и отметка только владельцем, безопасные ссылки, очистка), личный выбор категорий и минимальной важности (`setPref`), страница `mountNotificationsPage`, колокольчик `bellHtml` с числом непрочитанных.
- Шапка: `renderAppShell({ bellHtml, userBadge })` — колокольчик и значок типа учётной записи; `createAdmin({ notifications })` показывает их и в админке.
- `createAlerts({ onRaised })`: хук на каждый новый алерт.
- `examples/workshop`: колокольчик, страница `/ui/notifications` с настройкой «Безопасность» и «Работа системы»; новые алерты уходят администраторам.
### Fixed
- e2e мастерской: общий лимит запросов отвечал 429 на частые переходы; сервер e2e его поднимает (`DAS_E2E=1`, только `e2e/start.js`).

## [0.1.215]
### Added
- Поиск по разделам админки: поле над меню на каждой странице и страница `/admin/search?q=`; по названию и по словам, под которыми раздел ищут (RU/EN, `src/admin/search.js`), в обеих областях при `controlPath`. `renderAppShell({ navTopHtml })` — слот над меню.

## [0.1.214]
### Added
- Меню администрирования разбито на группы (Безопасность, Система, Обслуживание, Прочее; «Пользователи» сразу под «Обзором»); `renderAppShell`: пункт навигации `{ heading }` — заголовок группы, не ссылка.
- `createAdmin({ controlPath })`: область «Управление приложением» (по умолчанию выключена). Резервные копии, режим обслуживания, объявление, задачи, почта и рассылка переезжают под `controlPath` со своим меню, меткой и начальной страницей; оповещения о них остаются на «Обзоре» и ведут в новую область.
### Changed
- `examples/workshop` включает `controlPath: '/control'`; ссылки и e2e обновлены.

## [0.1.213]
### Added
- Раздел «Инциденты»: важность цветным значком (высокая красный, средняя янтарный, низкая синий).
- «Обзор» админки: оповещение об открытых инцидентах безопасности со ссылкой в раздел; красное, если есть инцидент высокой важности или просрочен срок уведомления, янтарное в остальных случаях; нет открытых — оповещения нет.

## [0.1.212]
### Added
- Графики на обзоре админки: клик по графику (или кнопка ⤢ в заголовке, с клавиатуры Enter) открывает его крупно в диалоге; Esc, клик мимо и «Закрыть» закрывают. График в диалоге — копия SVG, не разбор текста.
- Значение при наведении теперь легко поймать: у столбцов область наведения на всю высоту графика (короткий столбец так же доступен, как высокий), у точек линии круг радиусом 9, под курсором лёгкая подсветка. Подпись `<title>` с меткой и значением осталась.
- Тексты: `chartExpand` (админка), `dialogClose` (RU/EN).

## [0.1.211]
### Changed
- Страница `/policy/license` состоит из двух частей: неизменяемая часть платформы (пояснение и оригинальный текст MIT, держатель прав — `createPolicy({ platformCopyright })`, по умолчанию `DAS-Forge contributors`) и под ней редактируемое соглашение владельца приложения. Правка соглашения часть платформы не убирает. Экспорт `PLATFORM_LICENSE`, `MIT_TEXT`.

## [0.1.210]
### Fixed
- Workshop: на страницах приложения имя пользователя в шапке было простым текстом, а название приложения не вело на главную. Теперь имя ведёт в настройки учётной записи (`/ui/account`), название приложения — на главную (`/ui`), как уже было в админке. Тест в `examples/workshop`.

## [0.1.209]
### Added
- `audit.logSpreadsheetImport(db, ctx, { buffer, fileName, read, mapped, error })`: запись об импорте таблицы в журнал аудита (SHA-256 и размер файла, число прочитанных, принятых и отклонённых строк, счётчики кодов ошибок; без значений ячеек).

## [0.1.208]
### Added
- `mapRows(..., { schema })`: второй шаг проверки схемой Zod (или любым объектом с `safeParse`); ошибки `SCHEMA` (по столбцу замечания) и `SCHEMA_ERROR`; результат разбора возвращается как данные строки.
### Changed
- `mapRows`: ключи `unique` запоминаются только у принятой строки (раньше запоминались и у отклонённой по другому столбцу).

## [0.1.207]
### Added
- `skipHiddenColumns` для `.xlsx` (`readWorkbook`, `streamSheet`): значения скрытых столбцов не читаются, столбцы остаются на местах пустыми. Для `.ods`, `.xlsb`, `.xls` — `BAD_OPTION`.

## [0.1.206]
### Added
- `dates: 'serial'` у чтения `.xlsx`, `.xlsb`, `.xls` и `streamSheet`: номер дня вместо даты (для `.ods` — `BAD_OPTION`).
- `xlsx.WRITE_LIMITS` и `xlsx.LIMIT_NOTES`.
### Changed
- Все пределы вынесены в `src/xlsx/limits.js`; `DEFAULT_LIMITS` и `STREAM_LIMITS` теперь заморожены (значения не менялись).

## [0.1.205]
### Added
- Писатель: гиперссылки. Ячейка `{ value, link }`, внешняя ссылка только `https:`, `http:`, `mailto:`; остальное, адрес с логином и паролем, пробелы, длиннее 2000 знаков, больше 65 530 ссылок на лист — `BAD_LINK`. Часть связей листа пишется в обычной и потоковой сборке.

## [0.1.204]
### Fixed
- Число в ячейке с форматом «Текст» (`@`) в `display` показывалось пустой строкой; теперь как «Общий».
- Формат с годом эры `e` (например `[$-404]e/m/d`, Тайвань) показывал букву `e`; теперь год эры (113 для 2024).
### Changed
- Писатель отказывает (`BAD_SHEET`), если `merges` задевает строку заголовка при включённом автофильтре: Excel показывает такие заголовки пустыми. Нужен `autoFilter: false` или объединение ниже заголовка.

## [0.1.203]
### Added
- `xlsx.streamSheet(buffer, opts)`: построчное чтение одного листа `.xlsx`; лист распаковывается по ходу, строки не копятся (на 300 тысячах строк пик памяти около 100 МБ вместо около 600 МБ). Те же отказы и проверки архива, `limits.maxSheetBytes`, `STREAM_LIMITS`, `NO_SUCH_SHEET`, CDATA в потоковом листе не принимается.
- `xlsx.buildWorkbookStream(book)`: потоковая запись книги из итерируемых и асинхронно итерируемых `rows`; ошибка посреди выгрузки обрывает поток.
- Зип-слой: `stream` и `writeStream` (yauzl/yazl), `maxPartBytes` у `read`; в XML — построчная порционная подача `streamTokens`.
### Changed
- Разбор строк листа вынесен в отдельный автомат (`RowParser`), общий для обычного и потокового чтения; результат `readWorkbook` не изменился (сверено на ~98 700 ячеек).

## [0.1.202]
### Added
- `buildWorkbook`: `conditional` — цвет ячеек по правилу (условное форматирование): `equals`, `notEquals`, больше/меньше, `between`, `contains`, стиль из `bold`, `italic`, `color`, `fill`, `border`. Статус сохраняет цвет по значению и после правки человеком. Неясное правило — `BAD_SHEET`/`BAD_STYLE`.

## [0.1.201]
### Added
- `buildWorkbook`: стили из безопасного набора (`style`/`headerStyle` столбца и `style` ячейки: жирный, курсив, перенос, цвет и заливка из палитры или `#RRGGBB`, рамка, выравнивание), `merges` (объединение ячеек), `freezeColumns`, `tabColor`, `print` (ориентация, бумага, по ширине страницы, повтор заголовка). Недопустимый стиль — `BAD_STYLE`; пересекающиеся объединения — `BAD_SHEET`.
- Формулы: префикс `_xlfn.` для функций новее Excel 2007 (вне кавычек); функции, возвращающие массив, отклоняются (`BAD_FORMULA`).

## [0.1.200]
### Added
- `readWorkbook` отдаёт для каждого листа `tables` (таблицы Excel: имя, диапазон, есть ли строка заголовков и итогов, имена столбцов). `mapRows(rows, spec, { table })` берёт первую строку таблицы за заголовок, читает только её ячейки без итоговой строки; номера строк в ошибках остаются листовыми.
- `mapRows`: `index` у столбца (номер с 0 или буквы), `header: false` и `firstRow` для листов без заголовка, `headerRow` (номер строки заголовка прямо), `validate(значение, запись)` (код ошибки или `false`), `hint` в `NOT_ALLOWED` с ближайшим допустимым значением («Используеться» → «Используется»).
### Docs
- Полная сверка документации: таблица «читаем / пишем / отказываем» в руководстве, описание таблиц Excel и новых опций `mapRows`, зависимости, раздел 0 аудита открытых таблиц, `doc-audit.md`, `roadmap-gaps.md`.

## [0.1.199]
### Added
- Чтение «как показано»: опции `display: true` и `locale: 'en'|'ru'` у `readWorkbook`, `readOds`, `readXlsb`, `readXls`, `readSpreadsheet`, `readSpreadsheetIsolated` добавляют к листу матрицу `shown` (текст ячейки, как её видит человек) рядом с типизированными `rows`.
- Движок числовых форматов `xlsx/numfmt.js` (`createFormatter`): разделы и условия, `0 # ?`, тысячи и масштаб запятыми, проценты, `E+`, дроби, даты/время (`m` — минута или месяц по соседям, `[h]`, доли секунд, AM/PM), системные `[$-F800]`/`[$-F400]`, русские месяцы и разделители, ошибки Excel по коду (`#N/A`).
- Сверка с LibreOffice на ~98 700 ячеек реальных файлов (xlsx против ods, xls и xlsb против xlsx): расхождения только там, где LibreOffice сам иной (случайные числа, пересчёт ошибок, 1900-й год, нулевой результат строковых формул в его xls).

## [0.1.198]
### Added
- `xlsx.readSpreadsheetIsolated` — чтение файла в отдельном потоке: потолок памяти (`RESOURCE_LIMIT`), время (`TIMEOUT`), пустое окружение, остановка по `signal`; для файлов от посторонних.
- `readSpreadsheet`: `timeoutMs` (`TIMEOUT`) и `hiddenSheets: 'include'|'skip'` с предупреждениями `HIDDEN_SHEETS_READ` / `HIDDEN_SHEETS_SKIPPED`.
### Fixed
- `mapRows`: `pattern` запускался на тексте любой длины (риск ReDoS на ячейке до 32 767 знаков) — теперь сначала проверка длины (`max` столбца, иначе 1000); `pattern` с флагом `g`/`y` на разных строках давал разные ответы — флаги отбрасываются.
### Tests
- Вспомогательные заглушки для потоковых тестов вынесены в `test/helpers/` (`fake-zip.js`, `hang-zip.js`, `oom-zip.js`).

## [0.1.197]
### Fixed
- **CSV для Excel.** Выгрузки реестра обработки и журнала аудита из админки открывались в русском Excel кракозябрами и в одной колонке: файл был без метки UTF-8 и с запятой вместо `;`. Теперь `writeCsv(rows, { excel: 'ru' })` пишет метку UTF-8 и `;` (для `en` — запятую); админка берёт язык интерфейса, `privacy registry --format csv` — язык реестра. `delimiter` и `bom` по‑прежнему главнее. Читатель `parseCsv` понимает такой файл без настроек.

## [0.1.196]
### Added
- `xlsx.readXls` — чтение `.xls` (Excel 97–2003, BIFF8): собственный разбор контейнера OLE2 (`cfb.js`: проверка каждого сектора и цепочки, петли, выход за файл, ложные размеры, малые потоки) и записей с проверкой границ; общие строки с `CONTINUE` и сменой 8/16 бит, даты по формату, RK/MULRK, результаты формул (число, строка, логическое), объединения, скрытые листы и строки; отказ для зашифрованных, с макросами, с внешними ссылками (опция `externalLinks`), Excel 5 и старше.
- `readSpreadsheet` узнаёт `.xls` (`format: 'xls'`); зашифрованный `.xlsx` (тот же контейнер) отклоняется как `ENCRYPTED`.
### Fixed
- `readXlsb`: число RK с дробной частью и старшим битом (отрицательные и большие) приводило к исключению `ERR_OUT_OF_RANGE` вместо значения.
### Verified
- 8 `.xls` из набора hucre (юникод, даты, разреженные листы, общие строки, формулы): значения совпали с xlsx, который из них сделал LibreOffice; ваши реальные таблицы (заявки, «Титова», объекты), сохранённые в `.xls`, читаются идентично исходным `.xlsx`, включая скрытые листы; 6000 уникальных строк с кириллицей и юникодом (продолжения `CONTINUE`).
- Фаззинг `.xls` (400 случаев по контейнеру и записям): только `XlsxError`.

## [0.1.195]
### Added
- `xlsx.readOds` — чтение `.ods` (OpenDocument): типы значений, даты и время, повторы строк и ячеек без раскрытия пустых, объединения, скрытые листы (по стилю), заметки/рисунки/вложенные таблицы не попадают в текст; отказ для зашифрованных, с макросами (Basic/Scripts), с внешними таблицами, с типом документа.
- `xlsx.readXlsb` — чтение `.xlsb` (двоичный Excel): запись за записью с проверкой границ, числа RK, общие строки, даты по формату, 1904, скрытые листы/строки, объединения; повреждённый файл — `BAD_BINARY`.
- `xlsx.readSpreadsheet` — один вход для `.xlsx/.xlsm`, `.xlsb`, `.ods` по содержимому файла; результат того же вида + `format`.
- Параметр `externalLinks: 'refuse'|'ignore'` у всех читателей (по умолчанию отказ; `ignore` читает сохранённые значения и добавляет `EXTERNAL_LINKS_IGNORED`).
### Verified
- На присланных файлах: пять `.ods` и три `.xlsb` читаются; `sample_1.ods` дал те же значения, что и xlsx, который из него сделал LibreOffice; `.xlsb` совпал с LibreOffice во всём, что тот вычислил (результаты динамических массивов LibreOffice не выдаёт, Excel их хранит — мы читаем сохранённые).
- Фаззинг (по 300 случаев) для `.xlsb` и `.ods`: любая порча даёт `XlsxError`, ни падений, ни зависаний.

## [0.1.194]
### Fixed
- **`xlsx`: порча текста на записи.** Текст вида `_x0041_` Excel читает как букву «A» (так же читал и наш читатель), поэтому при записи и чтении текст менялся. Теперь начало такой последовательности экранируется (`_x005F_`); проверено круговым чтением и в LibreOffice. Касается текста ячеек, заголовков и строковых результатов формул.
### Added
- `xlsx`: имя листа «History» (без учёта регистра) зарезервировано в Excel — теперь `BAD_SHEET`.
### Documentation
- `docs/spreadsheet-audit.md`: проверки при записи (имена листов, экранирование XML, пределы) и устройство zip‑читателя в hucre, ExcelJS и excelize разобраны по присланному коду; «по памяти» осталось только про сторонние библиотеки без исходников.

## [0.1.193]
### Changed
- `xlsx`: словарь атрибутов XML строится без прототипа (`Object.create(null)`): имена приходят из файла.
### Documentation
- `docs/spreadsheet-audit.md`: SheetJS 0.20.3 разобран по коду (размеры из заголовка zip, отсутствие пределов, проглатывание ошибок, `sanitizeLinks` только против `javascript:`), таблица сравнения дополнена.

## [0.1.192]
### Fixed
- Тест `sendTest` проверял выключенную почту, передав готовый транспорт, а сервис с транспортом считается включённым (так задумано для тестов). Теперь выключенный сервис создаётся без транспорта. Код не менялся.
### Проверено
- Прогон 0.1.190 у владельца: ядро 1149 из 1150 (единственное падение — этот тест), workshop 133 из 133; блок xlsx с настоящими yauzl/yazl выполнился и прошёл.

## [0.1.191]
### Added
- Модуль `csv` (`@das-forge/core/csv`): `writeCsv` с защитой от формул по умолчанию, BOM, разделитель `;`; `parseCsv` с разбором кодировки (BOM, UTF-8, запасная windows-1251), автоопределением разделителя и пределами; `escapeFormula`/`unescapeFormula`.
- `docs/spreadsheet-audit.md`: аудит hucre, ExcelJS, excelize и SheetJS (по коду; SheetJS — только каркас) и список переносимого в ядро.
- `xlsx`: предел текста ячейки при чтении (32 767, `CELL_TOO_LONG`), ошибка на часть, не помещающуюся в строку; фаззинг читателя (400 случаев с зерном); тест `__proto__` в заголовке.
### Fixed
- **Безопасность:** `audit export --format csv` в CLI не защищал от формул (имя `actor` задают пользователи). Теперь все три CSV-экспорта (аудит в админке, реестр обработки, CLI) идут через `csv.writeCsv`.
- Писатель xlsx: начало текста с перевода строки или `|` тоже получает стиль «текст».
### Не проверено
- Реальные yauzl/yazl, открытие файлов в Excel; SheetJS по коду.

## [0.1.190]
### Changed
- `xlsx`: имена частей архива приводятся к одному виду (регистр, `\\`, ведущий `/`) — по образцу excelize; макрос и внешние ссылки нельзя спрятать необычным написанием пути.
### Documentation
- Раздел «xlsx» в `docs/guide/02-modules.md` описывает всё из 0.1.188–0.1.190.
### Сверка с открытыми проектами (исходники пересмотрены)
- excelize (Go): лимиты распаковки, нормализация имён частей, ошибка 1900 года, набор встроенных форматов дат — совпадает с нашим; временные файлы для больших листов у нас не нужны (лимит 20 000 строк).
- ExcelJS: лимитов на размер нет вовсе, `_xHHHH_` не декодируются, формат `[h]:mm` читается как дата — у нас это исправлено.
- hucre: предел степени сжатия 1032:1 (потолок deflate) вместо нашего 500 — меньше ложных отказов; длина формата числа ограничена 255 знаками; границы по ячейкам при редком заполнении (A1 и XFD1048576) у нас закрыты пределами строк и столбцов.
- SheetJS: на GitHub остался только каркас (исходники переехали на git.sheetjs.com), не разобран.

## [0.1.189]
### Changed
- `xlsx`: разбор XML заменён линейным сканером (без регулярок: нет задержек на специально составленном входе); невалидный XML — `BAD_XML`; любые префиксы пространств имён (`x:row`), ячейки без адреса, книга ищется через `_rels/.rels`, листы-диаграммы пропускаются (`NON_WORKSHEET_SKIPPED`).
- Архив проверяется до распаковки: дубли имён (`DUPLICATE_ENTRY`), заявленный размер, степень сжатия (`ZIP_BOMB`).
- `readWorkbook`: опции `skipHiddenRows`, `signal` (отмена; чтение уступает циклу событий).
- `mapRows`: десятичная запятая/точка и разделители тысяч, номер дня Excel в столбце-дате, `default`, `unique` (`DUPLICATE`), `normalize`, `duplicateColumns`.
- `buildWorkbook`: выпадающие списки (`list`), свойства документа (`title`, `creator`, `created`), пересчёт формул при открытии, кэш текстовых и логических значений формул.
### Не проверено
- Реальные yauzl/yazl, `checkArchive` на настоящем архиве, открытие файлов в самом Excel.

## [0.1.188]
### Fixed
- `xlsx.readWorkbook`: ложный отказ «MACROS» для обычных файлов procure-it (в шаблоне Excel есть тип по умолчанию для `.bin` с `macroEnabled`). Теперь решает тип главной части и реальные части с макросами.
- Время без даты читалось как `null` (теперь `Date` на 1899-12-30), длительность `[ч]:мм` читалась как дата (теперь число), сутки 1–60 в системе 1900 сдвигались на день.
### Added
- `readWorkbook`: опция `macros: 'ignore'` для `.xlsm` (макросы не открываются и не запускаются), `merges` в листе и `fillMergedCells`.
- Тесты на файлах из openpyxl, xlsxwriter, LibreOffice, Excel (.xlsm таблица оборудования IT Assets: 3 листа, 345/383/97 записей; 15 файлов procure-it).
### Не проверено
- Реальные yauzl/yazl и открытие сгенерированных файлов в самом Excel.

## [0.1.187] — текущая версия
### Добавлено
- Модуль `xlsx`: выгрузка и загрузка Excel без внешней библиотеки (на yauzl/yazl). `buildWorkbook` (форматы столбцов, формулы только в виде `{ formula, value }` с проверкой, текст всегда как текст, одинаковые данные дают одинаковый файл), `readWorkbook` (строгие лимиты, отказ для макросов, внешних ссылок, зашифрованных и старых файлов, XML с DOCTYPE и сущностями; формулы не вычисляются), `mapRows` (сопоставление строк с полями для импорта с ошибками по строкам и столбцам). Экспорт `@das-forge/core/xlsx`.
- Тест `xlsx` (17 проверок): на подставном архиве проходит в любой среде, блок с настоящими yauzl/yazl работает там, где они установлены.
- Не проверено: блок теста с настоящими yauzl/yazl и открытие созданного файла в Excel и LibreOffice (в песочнице их нет).

## [0.1.186]
### Добавлено
- «Обзор» админки: выбор периода (24 часа, 7 дней, 30 дней) и больше графиков: запросы, ошибки 4xx, ошибки 5xx, среднее время ответа, успешные и неудачные входы (по журналу аудита), активные сессии, размер базы, очередь почты. Часы без данных остаются пустыми (линия прерывается), а не падают в ноль.
- `createMetrics`: `set(имя, значение)` для уровней (последнее значение за час), `periodSeries(имя, период, { mode })`, `periodAverage(суммы, число, период)`; middleware пишет время запроса `http.ms` и ошибки 4xx. Панель замеряет сессии, размер базы и очередь почты раз в 5 минут.
- Workshop: главная страница стала витриной (живые показатели, группы возможностей со ссылками по правам, «Что попробовать»), тест `home.test.js`.
- Не проверено: вид графиков и главной в браузере; тесты `admin`, `admin-ops`, `i18n-core-catalog` и тесты workshop (`home`, `messages`, `no-english-in-ru`) проходят в песочнице.

## [0.1.185]
### Добавлено
- Раздел админки «Реестр обработки» (опция `processingRegistry`): таблица реестра на языке интерфейса, список модулей без цели или основания, скачивание md/csv/json (аудит `admin.registry.export`). Подключено в workshop и шаблоне; пространство имён `admin-registry` в каталоге переводов.
- e2e `admin-paging.e2e.js`: постраничный список и кнопка «Развернуть» на 27 инцидентах, раздел «Реестр обработки» и его CSV.
- Не проверено: e2e не запускались (возможен лимит запросов при 27 подряд созданных инцидентах); e2e рассылки не сделан, потому что в e2e-сервере почта выключена.

## [0.1.184]
### Добавлено
- Раздел «Почта»: форма «Проверка отправки». `email.service.sendTest({ to, locale })` отправляет одно письмо сразу, минуя очередь, и возвращает настоящий результат; в админке видно «отправлено» или код ошибки (без текста ответа сервера). Нужно повторное подтверждение пароля; аудит `admin.mail.test` с сокращённым адресом. Тесты в `admin-ops` и `email`.
- В `docs/roadmap-gaps.md` раздел «Очередь работ» со всеми запланированными и не доведёнными пунктами.
- Не проверено: письмо через настоящий SMTP-сервер.

## [0.1.183]
### Добавлено
- Справка по всем командам CLI (`help`, `<команда> --help`): описание, использование, параметры и примеры, на русском и английском (`packages/core/src/cli/help.js`). Язык: `--lang ru|en`, иначе язык системы. Заголовки списка, предупреждение о неизвестном параметре и сообщение о неизвестной команде тоже двуязычны. Тест `cli-help`: у каждой команды есть справка.
- Не сделано: сообщения, которые команды печатают при работе (результаты, ошибки), остаются английскими, кроме `doctor` и `privacy registry`.
- Не проверено: вывод справки в консоли Windows (кодировка кириллицы).

## [0.1.182]
### Добавлено
- Диагностика на русском: `health.localizeDoctor(отчёт, locale)` переводит категории, названия и сообщения всех проверок ядра (среда, база, хранилища, безопасность, защита, приложение, зависимости, сертификат, почта). Раздел «О системе» показывает отчёт на языке интерфейса; `doctor --lang ru|en` (по умолчанию язык системы) для текста, `--json` остаётся английским. Названия проверок в данных не меняются.
- Тест `health-localize`: каждое название проверки, написанное в ядре, имеет русский перевод.
- Не проверено: вид раздела «О системе» в браузере, `doctor` на Windows.

## [0.1.181]
### Исправлено
- «Политики»: переключатель RU/EN над текстами менял язык всего интерфейса (параметр `?lang=` обрабатывается общим механизмом языка). Теперь он использует отдельный параметр `?textlang=` и только выбирает, на каком языке редактируется текст; язык интерфейса остаётся прежним. Тест добавлен.
- Не проверено: поведение в браузере.

## [0.1.180]
### Документация
- Сверка кода и руководств скриптом (действия аудита, команды CLI, опции `createAdmin`, пространства имён, разделы настроек, ссылки): добавлен модуль `observability` в «Модули ядра», описаны вкладки языков и текст лицензии в `policy`.
- `docs/maturity-audit.md` приведён к 0.1.180 (инциденты, реестр обработки, метрики, рассылка, постраничные списки, отдельный порт админки); в `docs/doc-audit.md` раздел «Сверка 0.1.180».
- Не проверено: сборка страниц `docs/pages` и переходы по ссылкам в браузере.

## [0.1.179]
### Добавлено
- Метрики Prometheus: модуль `observability` (`createPrometheusMetrics`, `registerCoreGauges`), `GET /metrics` за настройкой `observability.metrics.enabled` (выключено). Счётчик и длительность запросов по шаблону маршрута, метрики процесса, сессии, очередь почты, возраст последней копии. Эндпоинт открыт только адресам из `allowIps` (по умолчанию эта машина) или владельцу токена (`observability.metrics.token`), остальным 404. Подключено в workshop и шаблоне.
- Зависимость `@prometheus-io/client` `0.16.0` (точная версия, подгружается только при включённых метриках).
### Исправлено
- Окно смены пароля и страница учётной записи показывали «минимум 8 символов»: длина берётся из действующей парольной политики (для администраторов — их длина), в тексте и в ограничении поля.
- Диагностика («Последняя копия», «Проверка цепочки аудита») не видела того, что сделано руками: время последней копии теперь берётся как позднейшее из записи задачи и самого свежего файла копии; успешная «Проверить цепочку» на странице «Аудит» записывается как проверка. Сама диагностика по-прежнему только читает.
- e2e: раздел «Почта» существует только при включённой почте, сценарий больше не требует его без неё; добавлены «Инциденты», «Парольная политика», «Политики».
### Не проверено
- Версия `0.16.0` и совместимость API с настоящим пакетом: в моей среде нет доступа к реестру npm, тесты идут на заглушке клиента. После `npm install` обновится `package-lock.json` (без этого `check-lock` и `npm ci` будут жаловаться). Работа `/metrics` на настоящем сервере и в Prometheus. Полный `npm test`.

## [0.1.178]
### Добавлено
- Реестр обработки персональных данных: `privacy.buildProcessingRegistry({ moduleRegistry, config })` и `privacy.formatProcessingRegistry(..., { format, lang })`; записи платформы со сроками из настроек и записи модулей из `dataSubject.purpose|legalBasis|retentionDays`; пробелы перечисляются.
- Команда `privacy registry [--format md|csv|json] [--lang ru|en] [--out файл]` (опции `registryFn`, `formatRegistryFn` в `registerPrivacyCommands`); подключено в workshop и шаблоне.
### Не проверено
- Полный `npm test`. Тексты записей платформы (цели, основания, сроки) нужно сверить с юристом.

## [0.1.177]
### Добавлено
- Админка: раздел «Рассылка» (`/admin/broadcast`): служебное письмо всем действующим пользователям с адресом или одной роли, отдельное письмо каждому через очередь почты; «Отправить тест мне»; подтверждение перед отправкой; в аудит `admin.broadcast.send|test` (без текста письма). Тексты ru и en.
### Не проверено
- Отправка настоящим SMTP-сервером, вид раздела в браузере, полный `npm test`.

## [0.1.176]
### Добавлено
- Пагинация во всех длинных списках админки (пользователи, аудит, баны, сессии, инциденты, алерты, очередь почты): по 25 строк, «Назад/Вперёд», «Показано N из M» и кнопка «Развернуть» с подгрузкой при прокрутке (`admin/paging.js`). Источники получили `offset` и счётчики (`bans.count`, `alerts.count`, `incidents.count`, `queue.list({ offset })`).
- «Политики»: третий текст «Лицензионное соглашение» (заглушка ru/en, страница `/policy/license`, ссылка в подвале); старая таблица текстов перестраивается при первом запуске без потери записей.
- «Политики»: один язык за раз с переключателем RU/EN вместо четырёх блоков.
- Админский слушатель (`server.admin.port`) при адресе по умолчанию слушает и `127.0.0.1`, и `::1` (`http.listenAdmin`), так что `localhost` работает при любом разрешении имени.
- Стартовая шапка показывает адрес админки на её порту (и `localhost`), а не на основном.
### Изменено
- Окна «Действия» в списке пользователей обрабатывают нажатия через общий обработчик, поэтому работают и в строках, подгруженных при прокрутке.
### Не проверено
- Работа «Развернуть» и подгрузки в настоящем браузере (в том числе окна «Действия» в подгруженных строках), два слушателя админки на настоящем сервере, перестройка таблицы политик на существующей базе. Полный `npm test`.

## [0.1.175]
### Добавлено
- Реестр инцидентов безопасности: `privacy.createIncidentRegister(db, { firstNoticeHours, detailsHours })`: заведение, обновление, список, просроченные сроки; в аудит `privacy.incident.declare|update`.
- Админка: раздел «Инциденты» (опция `createAdmin({ incidents })`), тексты ru и en.
- Команды `privacy incident declare|list|show|update` (опция `incidents` в `registerPrivacyCommands`). Подключено в workshop и шаблоне.
### Не проверено
- Полный `npm test`, вид раздела в браузере. Сроки 24/72 часа нужно сверить с юристом.

## [0.1.174]
### Добавлено
- Админка, «Пользователи»: действие «Снять блокировку входа» (`POST /admin/users/:id/unlock`) при наличии `userManagement.onUnlock`; в аудит `admin.user.unlock`. Тексты ru и en. В примере workshop хук сбрасывает счётчики неудачных входов.
### Исправлено
- Тест `release-check`: пока в `SECURITY.md` и `CODE_OF_CONDUCT.md` не подставлены контакты, допустимы только замечания про заглушки; любые другие замечания по-прежнему проваливают тест.
### Не проверено
- Полный `npm test`, вид окна «Действия» в браузере, снятие реальной блокировки после серии неверных паролей.

## [0.1.173]
### Добавлено
- Отдельный слушатель администрирования: `server.admin.port` (и `server.admin.host`, по умолчанию `127.0.0.1`). Панель отвечает только там, на адресе приложения пути `/admin` дают 404. `http.resolveAdminListener`, `http.adminGate`; подключено в workshop и шаблоне, закрывается при остановке. Раньше параметры `server.admin.*` числились в схеме, но ничего не делали.
- Проверка диагностики «Administration address» (категория Hardening): предупреждение, если приложение слушает не только loopback, а панель не вынесена.
- Действия консольных команд пишутся от имени `cli/<пользователь ОС>` (`cli.cliActor`), раньше просто `cli`.
### Не проверено
- Работа двух слушателей на настоящем сервере (запуск, 404 на основном порту, вход на порту админки, остановка), туннель SSH, Docker с закрытым портом; полный `npm test`.

## [0.1.172]
### Добавлено
- `docs/roadmap-gaps.md`: сверка первоначальной дорожной карты с кодом: что сделано (в том числе иначе), что не сделано и стоит решить, что ждёт приложений платформы, предлагаемая очередь.
### Удалено
- Параметр конфигурации `security.adminMtls`: в схеме и документации он числился, но поведения за ним не было (параметр без действия создаёт ложное чувство защиты). Конфигурация с этим ключом теперь отвергается как опечатка.
### Не проверено
- Сверка выполнена чтением плана и поиском по коду, без запуска; пункт «нет» значит «в коде нет ни реализации, ни упоминания». Тест `config-strict` после удаления ключа в среде разработки не прогонялся (`toBeInstanceOf` в моей заглушке не работает): проверьте на вашем `npm test`.

## [0.1.171]
### Добавлено
- Файлы для публичного репозитория: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SUPPORT.md`, шаблоны issue (ошибка, предложение; пустые issue выключены, уязвимости ведут на приватную форму), шаблон pull request, `.github/CODEOWNERS` (закомментирован). Ссылки на них в README.
- `release:check` теперь требует наличия этих файлов и отсутствия заглушек `<SECURITY_CONTACT>` и `<CONDUCT_CONTACT>`.
- В «Эксплуатации» раздел «Подготовка репозитория к публикации»: что уже лежит и что остаётся сделать в настройках GitHub.
### Не проверено
- Шаблоны issue и pull request GitHub не отрисовывались (проверьте на своём репозитории: форма «Ошибка» и меню «New issue»); `release:check` с заглушками в действии. Тексты кодекса поведения и правил участия — на ваше чтение: они от лица проекта.

## [0.1.170]
### Изменено
- Сверка и расширение документации (каждая 10-я сборка): справочник событий журнала в «Безопасности» (все события ядра), таймауты SMTP в «Конфигурации», разделы о парольной политике, известных устройствах и `deps` в «Модулях ядра», строка «См. также» со ссылками в конце каждого руководства, запись о сверке в `docs/doc-audit.md`. Сверка выполнена сценарием: события журнала, команды CLI, ключи конфигурации и опции `createAdmin` теперь все упомянуты в руководствах; битых ссылок между Markdown-файлами нет.
### Не проверено
- Текст читался и сопоставлялся с кодом, но не запускался; описания страниц админки (внешний вид) — по коду, не по браузеру.

## [0.1.169]
### Добавлено
- CLI `deps`: `list`, `licenses [--allow]`, `audit`, `outdated [--fail]`, `check` (флаги `--dev`, `--json`). Лицензии берутся из lock-файла (при отсутствии — из `package.json` пакета), SPDX-выражения (`OR`, `AND`, скобки) разбираются; уязвимости — от того же сервиса советов реестра, что и диагностика; принятые `security.dependencyAudit.ignore` не считаются. Код 3 при проблемах, код 1, если реестр недоступен. `cli.registerDepsCommands`, `cli.judgeLicense`, `cli.lockLicenses`; подключено в workshop и в шаблоне.
### Не проверено
- Настоящий реестр (в среде разработки недоступен): ответы подставлены тестами; запуск `app deps check` в вашей сети (прокси, `NODE_USE_ENV_PROXY`); полный `npm test`.

## [0.1.168]
### Изменено
- `docs/maturity-audit.md` приведён в соответствие с кодом: парольная политика, CSP в режиме отчёта и `Clear-Site-Data` перенесены в «Что есть», в списке до 0.2.0 остаётся только онлайн-проверка паролей (ждёт решения владельца).
### Не проверено
- Только текст документа; код не менялся.

## [0.1.167]
### Добавлено
- CSP в режиме отчёта: `security.csp.reportOnly`, `securityHeaders({ reportOnly })` отправляет `Content-Security-Policy-Report-Only` без `'unsafe-inline'` для стилей; приёмник `http.cspReports` (204 всегда, тело до 8 КБ, дедупликация раз в час, не больше 60 в минуту), аудит `security.csp_violation`. Оба приложения (workshop и шаблон) подключены, путь исключён из проверки CSRF.
- `auth.clearSiteDataOnLogout` (по умолчанию выключено): `Clear-Site-Data: "cache", "storage"` при выходе по HTTPS.
### Не проверено
- Заголовок отчётного режима и приём отчётов в настоящем браузере (в среде разработки `helmet` заглушён, поэтому один тест заголовка проверяется только на вашем `npm test`); реальное поведение `Clear-Site-Data` в браузерах.

## [0.1.166]
### Добавлено
- Срок действия пароля (`maxAgeDays`, в разделе «Парольная политика» и в `auth.passwordPolicy`): по умолчанию 0 — без ограничения. При включении просроченный пароль при входе превращается в принудительную смену (аудит `auth.password_expired`); часы стартуют с первого входа после включения. Колонка `users.password_changed_at`.
- Запрет повторов (`historyCount`, 0–24): новый пароль не должен совпадать с текущим и последними паролями; хранятся только хеши (таблица `password_history`). Коды `REUSED`.
- Список утёкших паролей из локального файла (`auth.passwordBlocklistFile`, формат «Pwned Passwords», двоичный поиск по диску, ничего не отправляется): код `LEAKED`. `auth.createPasswordBlocklist`.
- Профиль «ФСТЭК» включает срок 90 дней и запрет повтора последних 12 паролей.
- Онлайн-проверка по внешнему сервису не добавлена (требует вашего решения: исходящий запрос).
### Не проверено
- Вход с просроченным паролем через настоящее приложение и форма смены после него; список утёкших паролей на реальном файле в гигабайты (в тесте — файлы до 500 строк); полный `npm test`.

## [0.1.165]
### Добавлено
- Раздел админки «Парольная политика» (`/admin/password-policy`, опция `createAdmin({ passwordPolicy })`): профили «NIST» и «ФСТЭК» (ориентир), минимальная длина, длина для администраторов, число обязательных классов символов; сохраняется в `app_settings` и действует сразу. Кнопки «Потребовать смену пароля» у всех или только у администраторов (разлогин плюс принудительная смена). Аудит `admin.passwordpolicy.*`.
- `auth.createPasswordPolicy({ db, config, appName })`: `get`, `set`, `reset`, `check`; `auth.PASSWORD_PROFILES`, `auth.PasswordPolicyError`, `auth.characterClasses`.
- Новые проверки пароля: `TOO_FEW_CLASSES`, `CONTAINS_CONTEXT` (логин, часть e-mail до «@», название приложения). Страницы смены и сброса пароля показывают причину; страница аккаунта больше не пишет «неверный текущий пароль» на слабый новый.
- `requirePasswordChangeForAll(db, { roles, exceptId })`.
### Изменено
- Минимальная длина пароля по умолчанию 12 (было 8) для всех; `auth.passwordPolicy` получила `adminMinLength` и `requireClasses`. Существующие пароли не проверяются задним числом.
### Не проверено
- Страница раздела в браузере (вид формы, подтверждение кнопок); сквозная смена пароля по новым правилам через настоящее приложение; полный `npm test`. В среде разработки прогнаны новые тесты (12) и соседние наборы.

## [0.1.164]
### Добавлено
- `auth.hostCookiePrefix`: cookie сессии `__Host-das_session` (только HTTPS, `Secure` принудительно, очистка при выходе тоже с `Secure`). `http.sessionCookieName({ hostPrefix })`.
- `/.well-known/security.txt` (RFC 9116): `security.securityTxt`, `http.securityTxt()`; отдаётся только при заданном контакте.
- Письмо о входе с нового устройства: cookie `das_device` (в базе хеш, таблица `login_devices`), сценарий `newDeviceLogin`, `emailService.sendNewDeviceLogin`, аудит `auth.login.new_device`, опция `auth.newDeviceNotice`. Первый браузер учётной записи запоминается без письма.
- Cookie `das_device` добавлена в текст политики cookie.
### Не проверено
- Весь вход через настоящее приложение (создание cookie `das_device` и письмо) в среде разработки не прогонялся: модульные тесты есть, сквозной сценарий — на вашем `npm test`/в браузере; `__Host-` cookie в реальном браузере по HTTPS; письмо через настоящий SMTP.

## [0.1.163]
### Добавлено
- `docs/maturity-audit.md`: аудит зрелости ядра перед первым релизом: вывод, что есть по областям, что закрыть до 0.2.0 (префикс `__Host-`, `security.txt`, уведомление о новом устройстве, проверка пароля по базе утёкших, CSP в режиме отчёта, `Clear-Site-Data`), что после (пароль-ключи, CSP без `unsafe-inline` для стилей, Trusted Types), таблица защиты от подделки, сверка с планом.
### Не проверено
- Выводы сделаны чтением кода; на живом сервере не проверялись. Состояние уязвимостей зависимостей и статус Node 26 как LTS из среды разработки не проверить (нет сети): перед релизом `npm audit --omit=dev`, `npm audit signatures` и сверка с `nodejs.org`.

## [0.1.162]
### Добавлено
- `SECURITY.md`: порядок сообщения об уязвимости, сроки, область, безопасная гавань (контакт — `<SECURITY_CONTACT>`, заменить перед публикацией).
- `.github/dependabot.yml`: еженедельные обновления npm, GitHub Actions, Docker.
- `.github/workflows/security.yml`: `npm audit`, `npm audit signatures`, `lockfile-lint`, CodeQL, gitleaks, Trivy по образу Docker; на push, pull request и раз в неделю.
- `release.yml`: SBOM CycloneDX, прикладывается к GitHub Release.
- Документация: «Безопасность репозитория и релиза» со списком шагов вне репозитория.
### Не проверено
- Ни один из новых файлов не запускался (нет GitHub и сети): версии действий (`codeql-action@v3`, `gitleaks-action@v2`, `trivy-action@0.28.0`) и параметры `cyclonedx-npm` с `--workspace` и `--package-lock-only` нужно подтвердить первым запуском; действия не закреплены на хеши (команда в документации).

## [0.1.161]
### Добавлено
- Диагностика, категория «Hardening» (`health.hardeningChecks`): запуск от root, права файла базы, ключа сертификата и каталога данных, администраторы без второго фактора, возраст последней копии и проверки цепочки аудита, широкое или несогласованное доверие прокси, куча, задержка цикла событий.
- `security-invariants.test.js`: запрет опасных конструкций в исходниках ядра с перечнем проверенных исключений.
- Причина сбоя сети теперь видна: `health.fetchErrorText` показывает код (`ENOTFOUND`, `ETIMEDOUT`, ошибка сертификата) вместо «fetch failed» и подсказывает про прокси (`NODE_USE_ENV_PROXY`, `NODE_EXTRA_CA_CERTS`). Работает в диагностике зависимостей, проверке версии Node и «О системе».
### Изменено
- `VACUUM INTO` принимает путь параметром (снимок базы, рабочий поток снимка, восстановление).
- Имена файлов приёмников `mount` и `sftp` проходят `assertPlainName`.
- Вставка QR (`innerHTML`) помечена как доверенная.
### Не проверено
- Реальная работа за прокси (`NODE_USE_ENV_PROXY`): в среде разработки нет прокси; проверки прав файлов на Windows пропускаются, на POSIX проверены только в среде разработки; запрос к себе за заголовками не реализован.

## [0.1.160]
### Добавлено
- «Задачи»: расписание словами (`scheduler.describeCron`), форма смены расписания из админки (`scheduler.createTaskSchedules`, `scheduler.reschedule`), «Вернуть исходное», аудит `admin.task.schedule` и `admin.task.schedule_reset`. Опции `taskSchedules`, `managedTasks`.
- «Резервные копии»: кнопка «Проверить» у каждой копии (`backups.verify`, `POST /admin/backups/verify`, аудит `admin.backup.verify`).
- «Обзор»: плитка «Миграции» (опция `migrations`).
- В документации закреплён принцип: приложение расширяет админку ядра, а не пишет свою (`05-administration.md`, `11-development.md`).
### Изменено
- Workshop: страницы «Система» и «Журнал аудита» и пункты «Пользователи», «Журнал аудита», «Система» убраны из меню приложения и главной; всё это только в администрировании. Маршруты `/audit` и `/system/*` (JSON) остались.
### Не проверено
- Форма расписания, кнопка «Проверить» и плитка «Миграции» в браузере; полный `npm test`; проверка настоящей копии (в среде разработки нет `yazl`, тест использует подмену).

## [0.1.159]
### Добавлено
- Админка, «Резервные копии»: карточка автобэкапа (вкл/выкл, время суток, следующий запуск, срок хранения, места назначения), `POST /admin/backups/schedule`, аудит `admin.backup.schedule`. Опции `backups.schedule` и `backups.info`.
- Шапка админки: кнопка «Выйти», имя пользователя ведёт в настройки учётной записи (`accountUrl`), логотип и название ведут в приложение, метка «Администрирование» под логотипом. `renderAppShell`: `homeUrl`, `accountUrl`, `showLogout`, `badge`.
- Кнопка выхода на странице учётной записи выделена акцентом.
- «О системе»: причина недоступности реестра во всплывающей подсказке значка; таймаут проверки обновлений 10 с.
- `health.findLockFile`; `storageChecks` принимает `{ path, optional }`.
### Изменено
- Проверка уязвимостей ищет `package-lock.json` и в родительских каталогах (приложение внутри workspace).
- Отсутствующий каталог локального приёмника бэкапа — предупреждение, а не ошибка.
### Не проверено
- Новые элементы шапки и карточка автобэкапа в браузере; полный `npm test`; ссылка на аккаунт и выход при `appUrl`/`accountUrl`, отличных от значений по умолчанию.

## [0.1.158]
### Добавлено
- Диагностика: категория «Dependencies». `health.dependencyChecks` сверяет `package-lock.json` с базой советов реестра npm (критические и высокие дают ошибку, средние предупреждение, принятые в `security.dependencyAudit.ignore` не учитываются до даты); без сети показывает последний успешный результат с датой или «не проверено» и пишет причину в журнал. `health.nodeVersionChecks` предупреждает, если для ветки Node.js вышла версия с исправлениями безопасности. Новая зависимость ядра `semver` для сравнения версий с диапазонами.
- Конфигурация `security.dependencyAudit` (`enabled`, `ignore`, `checkNode`).
- `scheduler.createScheduleSetting`: задача, которую администратор включает и переносит на другое время суток; выбор хранится в базе. Раздел «О системе»: переключатель автоматической диагностики (аудит `admin.doctor.schedule`).
### Изменено
- `alerts.doctorSchedule` по умолчанию раз в сутки (`5 3 * * *`), раньше раз в час. Workshop и шаблон регистрируют задачу `alerts-doctor` через `createScheduleSetting`.
### Не проверено
- Запрос к настоящему реестру npm и `nodejs.org` (в среде разработки нет сети: тесты используют подменённый `fetchFn`); формат ответа bulk-эндпоинта сверен по документации и по памяти.
- Раздел «О системе» с переключателем в браузере, полный `npm test`.

## [0.1.157]
### Изменено
- Админка, «О системе»: две таблицы зависимостей, приложения и ядра. У зависимостей ядра (включая peer) показаны назначение, требуемая и установленная версия, лицензия, пометки «peer» и «необязательна», «не установлена». Проверка обновлений охватывает обе таблицы; для зависимостей ядра предлагается обновить ядро, а не ставить пакеты по одному. Отключается `about.coreDependencies: false`.
- Новый файл `admin/dependencies.js`: описание назначения каждой зависимости ядра (`DEPENDENCY_PURPOSE`) и `readCoreDependencies()`.
### Добавлено
- Руководство «Зависимости» (`docs/guide/12-dependencies.md`): таблицы ядра, шаблона, разработки и `overrides` собираются из `package.json` командой `npm run docs` (`scripts/deps-table.mjs`).
- Тест `dependencies.test.js`: у каждой зависимости ядра есть описание на двух языках, лишних описаний нет, документация перечисляет все пакеты. В `lazy-imports.test.js` добавлены `nodemailer`, `multer`, `express-session`, `pino-pretty`.
### Не проверено
- Страница «О системе» с двумя таблицами в браузере и проверка обновлений с настоящим реестром npm; полный `npm test`, `lazy-imports` (в среде разработки не запускался).

## [0.1.156]
### Добавлено
- Модуль `announcement` (`@das-forge/core/announcement`): объявление над страницами приложения; текст, важность (`info`, `warning`, `critical`), срок показа; читатель скрывает баннер крестиком (кроме `critical`).
- Админка: раздел «Объявление» (`/admin/announcement`, опция `announcement`), аудит `admin.announcement.set` и `admin.announcement.clear`; баннер над страницами админки.
- `ui.renderAppShell`: параметр `bannerHtml`. Workshop и шаблон выводят баннер на своих страницах.
### Не проверено
- Вид баннера внутри страниц workshop и переключение «скрыть» в браузере; полный `npm test`, `npm run test:template`.

## [0.1.155]
### Исправлено
- Диагностика «Port availability» внутри работающего сервера (раздел «О системе», плановая диагностика) больше не даёт предупреждения: занятый порт там — норма. Параметр `inProcess` у `health.applicationChecks`; workshop и шаблон передают его.
### Не проверено
- Раздел «О системе» в запущенном приложении; полный `npm test`.

## [0.1.154]
### Изменено
- Кнопка темы в шапке переключает только светлая ↔ тёмная (пока выбора нет, показывает системную тему); режим «как в системе» выбирается на странице «Аккаунт».
- Страница «Аккаунт»: мини-меню из четырёх частей (пароль, e-mail, интерфейс, двухфакторная аутентификация); без скрипта видны все части.
### Не проверено
- Вид мини-меню и переключение частей, кнопка темы в браузере; полный `npm test`.

## [0.1.153]
### Добавлено
- Страница «Аккаунт»: блок «Интерфейс» с выбором языка и темы (хранится в браузере, согласован с переключателями в шапке).
### Не проверено
- Вид блока и переключение темы и языка в браузере; полный `npm test`.

## [0.1.152]
### Добавлено
- Сценарии в браузере `examples/workshop/e2e/admin-sections.e2e.js`: страницы входа, новые разделы админки, журнал входов и экспорт JSON, режим обслуживания.
- Шаг e2e в CI (Ubuntu, Chromium) и команда `npm run test:e2e` в корне.
- Руководство по разработке описывает e2e.
### Не проверено
- Новые сценарии не запускались (в среде разработки нет express и реестра npm): селекторы сверены с разметкой, но первый прогон — ваш.
- Шаг CI не выполнялся.

## [0.1.151]
### Добавлено
- Аудит в админке: вкладка «Входы» (события `auth.login*`) и экспорт в JSON (`/admin/audit.json`) рядом с CSV; оба учитывают фильтр.
- `audit.query/page/count`: фильтр `actionPrefix`.
### Не проверено
- Полный `npm test` и вид вкладки «Входы» в браузере.

## [0.1.150]
### Добавлено
- Админка: разделы «Задачи» (`/admin/tasks`, запуск вручную, аудит `admin.task.run`), «Почта» (`/admin/mail`, счётчики и последние письма с маскировкой адресов), «Конфигурация» (`/admin/config`, только чтение, секреты скрыты). Опции `scheduler`, `mail`, `config`.
- Предупреждения на «Обзоре» о сбойных задачах и неотправленных письмах.
- `queue.list()` в очереди писем.
- Документация: страницы `docs/pages/*.html` для CHANGELOG, аудитов, roadmap и README; ссылки на `.md` кликабельны. Руководства дополнены и сверены с кодом, исправлен значок лицензии (MIT).
- Шаблон и workshop подключают задачи, почту и конфигурацию.
### Не проверено
- Полный `npm test` (в среде разработки нет реестра npm; выполнены тесты на заглушках), `npm run test:template`, e2e.
- Новые разделы и ссылки в документации в браузере владельца.

## [0.1.149]
### Added
- Страницы учётной записи в ядре (`accounts`): вход в два шага, «Забыли пароль», новый пароль по ссылке, обязательная смена временного пароля и «Аккаунт» (пароль, e-mail, аутентификаторы, коды восстановления). Тексты ru/en в `ACCOUNT_TEXTS`, пространство имён `accounts` для `i18n.setTextOverrides` и опция `texts`; свою страницу можно подставить через `pages` или выключить значением `false`; бренд приложения и строка «Powered by DAS-Forge» стоят на всех страницах.
- Опции `appName`, `vendorIdentity`, `theme`, `brand`, `accountShell`, `accountPath`.

### Changed
- Workshop и шаблон приложения больше не хранят свои страницы входа, сброса и аккаунта и их тексты. Workshop передаёт `accountShell`, шаблон получил вход, «Забыли пароль» и смену пароля из ядра.

### Не проверено
- В песочнице проходят `accounts` (6), `accounts-pages` (8), каталог текстов, `messages` и `no-english-in-ru` workshop; 69 из 82 тестов `routes.test.js` workshop (остальные 13 — TOTP и лимитер, заглушки песочницы). Страницу входа я смотрел в Chromium. `templates/app` тесты в песочнице не запускались. Полный `npm test`, `npm run test:template`, e2e и вход в браузере не проверялись.

## [0.1.148]
### Added
- Модуль `accounts` (`@das-forge/core/accounts`): `mountAccountRoutes()` даёт приложению вход (пароль, TOTP, код восстановления), выход, `/me`, смену и сброс пароля, свою почту, подключение TOTP и коды восстановления вместе с лимитами, блокировками и обязательной сменой временного пароля. Страницы остаются за приложением (`pages`).

### Changed
- Workshop и шаблон приложения подключают эти маршруты из ядра вместо своей копии. Шаблон получил двухшаговый вход, сброс пароля по почте, TOTP и коды восстановления; вход возвращает `mfaRequired`.

### Не проверено
- Новый `accounts.test.js` (6) и 69 из 82 тестов `routes.test.js` workshop проходят в песочнице; остальные 13 используют TOTP и лимитер запросов, которые в песочнице заменены заглушками. `templates/app/test/app.test.js` в песочнице не запускался (нет `cookie-parser`). Полный `npm test`, `npm run test:template` и e2e не запускались.

## [0.1.147]
### Changed
- Даты в админке: `<time>` и скрипт, который показывает их в часовом поясе браузера в порядке языка (`27.10.2026 20:57:40`); без JavaScript остаётся UTC. Помощники `ui.timeHtml`, `ui.TIME_SCRIPT`.
- Пустые таблицы (аудит, баны, сессии, копии, пользователи) объясняют, что делать, например «Банов нет. Добавьте адрес или логин выше.»
- Широкие таблицы прокручиваются внутри карточки на телефоне; заголовки таблиц без верхнего регистра.
- Аудит: результат «Успех»/«Ошибка» на русском; фильтр выровнен; «Повторов» показывает «—» вместо 0.
- Графики: целочисленные данные получают целые отметки оси.
- Кнопка языка и кнопка темы одной высоты; кнопка выбора файла в «Оформлении» оформлена как остальные кнопки; кнопки-ссылки без подчёркивания.
- Заголовок «Обзора» совпадает с названием пункта меню.

### Fixed
- Тест планировщика зависел от секунд реальных часов (при старте на 59-й секунде срабатывали два тика за 61 с); время теперь задано.

### Не проверено
- Тесты `admin-ops`, `admin`, `alerts`, `ui*` и новый `ui-time-tables` проходят в песочнице; страницу аудита смотрел в Chromium (ПК и 390 px). Исправленный тест планировщика в песочнице не запускался (нет настоящего vitest). Полный `npm test`, e2e и преобразование дат в разных часовых поясах не проверялись.

## [0.1.146]
### Added
- Единый блок бренда «логотип приложения + название» на всех страницах: оболочка, меню админки (опция `vendorIdentity`), страницы входа, ошибок и обслуживания. `branding.brandBlockHtml(db, vendorIdentity)`.
- Маленькая строка «Powered by DAS-Forge» с логотипом ядра на каждой странице (`ui.poweredByHtml`).
- Страницы всех статусов 4xx и 5xx из списка MDN (ru/en) в `ERROR_CATALOG`; страницы ошибок принимают `brand`.
- Режим обслуживания: модуль `maintenance` (`@das-forge/core/maintenance`), раздел админки «Режим обслуживания», страница-заглушка 503 с `Retry-After`, администраторы и `/health`, `/login*` остаются доступны; заметка на «Обзоре».

### Changed
- Workshop и шаблон приложения подключают бренд, «Powered by» и режим обслуживания; собственные `brandHtml` из их `createAdmin` убраны.

### Не проверено
- Тесты `maintenance`, `ui*`, `admin*`, каталог ошибок и тексты workshop проходят в песочнице; страницы ошибок и обслуживания я смотрел в Chromium на статической отрисовке. Полный `npm test`, e2e и режим обслуживания в живом браузере не запускались.

## [0.1.145]
### Changed
- «Пользователи» (админка): «Действия» открываются окном поверх страницы (формы разделены линиями, опасное действие выделено), форма создания и поиск выровнены. Удаление и обезличивание подтверждаются предупреждающим окном с кнопкой, которая активируется через 5 секунд. Workshop включает `allowDelete`: есть выбор между «обезличить» и «удалить полностью». E2E-сценарий обновлён.

### Не проверено
- Тесты `admin-ops` проходят в песочнице; отрисовку и таймер окна я проверил в Chromium на статической странице, e2e-сценарий в песочнице не запускался.

## [0.1.144]
### Fixed
- «Пользователи» (админка): обезличенная запись (`deleted-user-N`) показывается как «обезличен» без кнопок, действия над ней отклоняются; меню «Действия» открывается панелью поверх таблицы и больше не растягивает колонки; заголовок формы создания на своей строке. Добавлен `auth.isAnonymizedUser`.

### Не проверено
- Тесты `admin-ops`, `user-admin`, `i18n-core-catalog` проходят в песочнице; внешний вид панели в браузере не проверялся.

## [0.1.143]
### Added
- Раздел «Пользователи» админки ядра управляет учётными записями (опция `userManagement`): создание, логин и e-mail, роль, сброс пароля (временный или ссылкой на почту), выход из всех сессий (`forceUserLogout`, с требованием сменить пароль), обезличивание или удаление. Без JavaScript, с аудитом, защитой последнего администратора и собственной записи.

### Changed
- Workshop использует этот раздел: собственные `/admin/users` API, страница `/ui/users`, их тексты и тесты удалены (правила проверяются тестами ядра `admin-ops`, `user-admin`); `registerRoutes` возвращает `forgetLoginFailures(username)`. E2E-сценарий `admin-users` переписан под раздел ядра.

### Не проверено
- Тесты ядра `admin-ops`, `admin`, `user-admin`, `i18n-core-catalog` и workshop `messages`, `no-english-in-ru` проходят в песочнице. Полный `npm test` (в том числе `routes.test.js` после удаления блоков), `server.smoke.test.js`, e2e и вид раздела в браузере не запускались.

## [0.1.142]
### Added
- Шаблон приложения `templates/app`: сборка `context.js`, `server.js` с описанным порядком обработчиков, вход с блокировками, ровным временем ответа и сменой временного пароля, роли и права, пример данных (заметки: SQL, миграция, API с проверкой прав, страница), админ-панель, политики, оформление, копии, алерты, переводы ru/en на i18next, CLI, `doctor`, `Dockerfile` и `docker-compose.yml` для отдельного приложения, README (как переименовать, как убрать пример, как обновлять ядро), тесты (по настоящему HTTP-стеку и текстов). Не рабочее пространство: зависимость `@das-forge/core` указывает диапазон выпущенной версии.
- `npm run test:template` (`scripts/test-template.mjs`): копирует шаблон, подставляет `file:`-путь к `packages/core`, ставит зависимости, гоняет его тесты; шаг добавлен в CI.
- `npm run docker:test` (`scripts/docker-test.mjs`, `--core`, `--image`) — тесты в чистом Linux-контейнере из любой оболочки; `npm run docker:start|docker:logs|docker:stop` (`scripts/docker-start.mjs`) — запуск workshop в Docker одной командой: создаёт секрет сессии, собирает, ждёт `/health`, печатает адрес и что делать дальше.
- Документация: раздел «Доступ из локальной сети» («Эксплуатация»): адрес и `allowedHosts`, брандмауэр Windows, ufw и firewalld, сертификат на адрес сервера, Docker напрямую и через TLS-прокси, проверка и таблица неполадок; раздел «Шаблон приложения» («Workshop»); Docker-команды в «Эксплуатации», скрипты в «Разработке».
- Не проверено: тесты шаблона `app.test.js` (нужны настоящие express и argon2; прошли `messages.test.js` шаблона 6/6 и тесты скриптов core на заглушках), `npm run test:template` и шаг CI целиком, запуск `docker:start` и `docker:test` (в песочнице нет Docker), `Dockerfile` шаблона, команды раздела «Доступ из локальной сети» (проверены чтением кода, не запуском).

## [0.1.141]
### Changed
- Workshop: последние тексты переведены на каталог i18next (главная страница, «Отчёты», заголовки окон страниц входа и приложения). Старый словарь `src/i18n.js` и его тесты (`i18n.test.js`, `i18n-coverage.test.js`) удалены; вместо них `no-english-in-ru.test.js`: в русских страницах нет английских слов в видимом тексте, и ни один файл не подключает старый словарь. Заголовок окна «Аудит» теперь «Журнал аудита».
- Playwright: `locale: 'en-US'` в конфигурации, сценарии нажимают кнопки по английским названиям.
### Added
- Workshop: команды `alerts test [--severity] [--key] [--message]` и `alerts list [--limit] [--json]` (`src/alerts-commands.js`) — рабочий пример алертов: настоящий алерт проходит путь сервера (запись, лог, письмо в очередь), команда сообщает, ушло ли письмо. Тест `alerts-commands.test.js`.
- Ядро: путь импорта `@das-forge/core/alerts` (раньше модуль был доступен только из корня пакета).
### Fixed
- Документация сверена с кодом: в «Модулях» появился раздел `alerts`, упомянуты `scheduler onError`, `createFailureTracker({ onLock })`, `createI18nSync`; «Переводы» и «Workshop» описывают единственный механизм переводов; пример «Свои команды» в «CLI» показывал несуществующий интерфейс (`run({ args, flags, out })`), теперь настоящий `handler({ positionals, flags })`; в «Эксплуатации» добавлена пошаговая проверка алертов. Автоматически сверены: ссылки на файлы, переменные окружения, разделы конфигурации, команды CLI, маршруты админки, npm-скрипты.
- Не проверено: полный `npm test` (в песочнице прошли `messages` 11/11, `no-english-in-ru`, `alerts-commands` 5/5 на заглушках), вид главной и «Отчётов» в браузере, `alerts test` против настоящей почты и работающего сервера, сценарии Playwright.

## [0.1.140]
### Changed
- Workshop: страница «Пользователи» переведена на каталог i18next (группа `users`): заголовки, поля, таблица, кнопки, диалоги и сообщения скрипта; подстановки в тексты (`{u}`, `{to}`, `{n}`, `{total}`) делает функция `fmt` в браузере, имя пользователя в текст не вклеивается. На старом словаре `i18n.js` остались главная страница, «Отчёты», заголовки окон и пункты меню в `routes.js`.
### Fixed
- `renderUsersBody`: список ролей попадал в inline-скрипт через `JSON.stringify` без экранирования `<`; теперь через `scriptTexts`.
- Не проверено: полный `npm test` workshop, вид страницы в браузере на обоих языках. Сообщения об ошибках, которые возвращает API (`data.message`), остаются на языке сервера: перевод ответов API не делался.

## [0.1.139]
### Changed
- Workshop: страницы «Аудит», «Система и обслуживание» и «Лаборатория реального времени» переведены на каталог i18next (группы `audit`, `system`, `realtime`). Тексты браузерных скриптов передаются JSON, результат аудита (`success`/`failure`) показывается словом на языке страницы, счётчики без склонений («Записей по фильтру: N»), значения из данных экранируются. `renderAuditBody`, `renderSystemBody`, `renderRealtimeBody` принимают `locale`. На старом словаре осталась страница «Пользователи».
- Не проверено: полный `npm test` workshop и вид трёх страниц в браузере на обоих языках; в песочнице прошли `messages` (9/9), `i18n-coverage` (3/3), `i18n` (4/4).

## [0.1.138]
### Changed
- Документация («Эксплуатация» → Docker): команда запуска тестов в контейнере дана в виде для PowerShell (`${PWD}`; запись `$PWD:` там ломает путь) и с вариантами для bash и cmd; объяснено, почему копия делается без `node_modules`.
- Не проверено: сама команда в этой версии не запускалась (в песочнице нет Docker), она совпадает с той, что вы используете.

## [0.1.137]
### Changed
- Workshop: страница «Аккаунт» (смена пароля, e-mail, аутентификаторы, коды восстановления) переведена на каталог i18next (группа `account` в `messages.js`); тексты браузерного скрипта передаются JSON, статус аутентификатора переведён, имя и неизвестный статус экранируются. `renderAccountBody` принимает `locale`. Тест каталога проверяет ключи `account.*`, рендер на двух языках и отсутствие английских фраз в русском скрипте.
- Не проверено: полный прогон `npm test` workshop, вид страницы в браузере на обоих языках.

## [0.1.136]
### Added
- Выпуск релизов на npm: workflow `.github/workflows/release.yml` (тег `v*` → проверки, тесты, `npm publish`, GitHub Release с записью из CHANGELOG), `scripts/release-check.mjs` и `npm run release:check` (версия x.y.z, тег = версия, запись в CHANGELOG, MIT, `publishConfig`), `publishConfig.access: public` у пакета ядра. Правила в документации («Эксплуатация» → «Релизы и обновление ядра»): промежуточные сборки не публикуются, релизы — по тегам, приложения обновляются `npm update`.
- Не проверено: сам workflow (ни разу не запускался: нужны аккаунт npm, организация `@das-forge`, секрет `NPM_TOKEN` и первый тег), публикация и проверка provenance.

## [0.1.135]
### Fixed
- QR-код для TOTP не показывался (белая область в любой теме): `qrcode` отдаёт SVG только с `viewBox`, без ширины и высоты, и вставленный в блок `width: fit-content` он схлопывался. `qr.generateQrSvg` теперь пишет `width`/`height` в корневой `<svg>` (параметр `size`, по умолчанию 256; `0` — не добавлять); экспортирована `qr.withSize`.
- Не проверено: тесты `qr.test.js` (нужны настоящие `qrcode` и `sharp`), вид QR на странице «Аккаунт» → «Добавить аутентификатор».

## [0.1.134]
### Added
- `i18n.createI18nSync({ i18next, namespaces })`: тот же каталог, но создаётся синхронно (для страниц, которые строятся в синхронных фабриках); i18next передаётся модулем, `initAsync: false`.
### Changed
- workshop: страницы входа, принудительной смены пароля, «Забыли пароль» и сброса пароля переведены на каталог текстов (`src/messages.js`, пространство `workshop`); тексты для их браузерных скриптов встраиваются как JSON (`scriptTexts`). Остальные страницы пока идут через словарь `i18n.js`. Workshop теперь объявляет зависимость `i18next ^26.5.10`.
- Не проверено: работа с настоящим i18next (в песочнице он подменён; проверяет ваш `npm test`: `messages.test.js`, `i18n.test.js`), синхронная инициализация `initAsync: false` на реальном пакете, вид страниц в браузере.

## [0.1.133]
### Added
- Алерты: модуль `alerts` (`createAlerts`: запись в таблицу `alerts`, строка лога, письмо на `security.incidentContacts`, защита от повторов `cooldownMinutes`, `raise` не бросает исключений). Источники: `onJobError` для `createScheduler({ onError })` (упавшая копия — критично), `lockoutWatcher` для `createFailureTracker({ onLock })` (волна блокировок входа), `checkAuditChain`, `checkDoctor`, `watch` (периодические проверки и очистка). Раздел админки «Алерты» (`createAdmin({ alerts })`), конфигурация `alerts`, подключено в workshop. `security.incidentContacts` теперь действительно используется (раньше только лежал в схеме).
- `createScheduler({ onError })` и `createFailureTracker({ onLock })` — новые необязательные обратные вызовы.
- «Оформление»: предпросмотр двух макетов меню внутри карточки «Цвет акцента», над выбором цвета (шапка, вкладки, карточки с акцентной полосой, кнопка); обновляется при вводе названия, выборе цвета и файла до сохранения.
- Не проверено: полный `npm test`; тест планировщика с таймерами (`onError`) и запуск workshop; вид предпросмотра и страницы «Алерты» в браузере. В песочнице прошли `alerts` (11), `admin-ops`, `admin`, `admin-appearance`, `i18n-core-catalog`.

## [0.1.132]
### Added
- «Оформление»: живой предпросмотр двух макетов меню (светлая и тёмная тема) — логотип, название, активный пункт, ссылка, кнопка; обновляется при вводе названия, выборе цвета и выборе файла до сохранения.
- Не проверено: вид и работа скрипта в браузере (серверная часть и разметка проверены тестом `admin-appearance`); полный `npm test`.

## [0.1.131]
### Fixed
- Лицензия: в `package.json` ядра было `UNLICENSED` и не было файла лицензии, из-за чего «О системе» показывала «UNLICENSED». Теперь везде `MIT`, в корне и в пакете ядра лежит `LICENSE` (правообладатель указан как «DAS-Forge contributors» — замените на нужное имя), в README раздел «Лицензия».
- workshop: `/admin/users` отдавал голый JSON, потому что API приложения лежит на том же пути, что и раздел «Пользователи» ядра. Раздел ядра у workshop выключен (`users: false`), в меню админки ссылка ведёт на страницу `/ui/users`. Правило добавлено в документацию.
- Не проверено: запуск workshop и его тесты (в песочнице нет express; проверен только синтаксис). Пункт «Пользователи» в меню админки нужно открыть в браузере.

## [0.1.130]
### Changed
- Перенос на каталог текстов: оболочка (`renderAppShell`), переключатель языка, кнопка темы, кнопки диалогов и ссылка «Назад» на публичных страницах берут тексты из пространства `ui` (`ui.UI_TEXTS`, `ui.uiTexts(locale)`), которое входит в `i18n.coreNamespaces()` и переопределяется через `setTextOverrides`. Скрипт диалогов собирается функцией `ui.modalScript()` (тексты обоих языков внутри, язык выбирает `<html lang>`); `MODAL_SCRIPT` оставлен для совместимости.
- Пустая навигация в русской оболочке теперь показывает «(навигация не задана)».
- Не проверено: полный `npm test` (в песочнице прогнаны `ui-texts`, `ui`, `ui-modal`, `ui-lang-login`, `ui-locale-theme`, `ui-theme-errors`, `i18n-core-catalog`).

## [0.1.129]
### Security
- Минимальные версии подняты до проверенных `npm audit` (0 уязвимостей, 873 + 137 тестов): express ^5.3.0 (в peer и в workshop), zod ^4.6.7, dompurify ^3.4.17, jsdom ^30.1.3, express-rate-limit ^8.7.1, uuid ^14.0.3, libheif-js ^1.23.5, docx ^9.13.0, i18next ^26.5.10, pino-pretty ^13.2.0, vitest ^5.0.5, supertest ^7.3.1, Playwright ^1.64.1.
- Корневой `overrides`: `body-parser ^2.4.0` (GHSA-27r3-jxmh-p828, отказ в обслуживании) и `proxy-addr ^2.0.8`.
- `package-lock.json` — тот, что собран и проверен на машине владельца (`lock:check` проходит).
- Не проверено: тесты на точных новых минимумах не гонялись (версии совпадают с теми, что стояли в проверенном lock).

## [0.1.128]
### Security
- Минимальные версии зависимостей подняты: sharp ^0.35.5, multer ^2.5.0, nodemailer ^10.1.7, zod ^4.6.5, argon2 ^0.45.1, dompurify ^3.4.16, jsdom ^30.1.1; корневой `overrides` задаёт `proxy-addr ^2.0.8` (транзитивная зависимость Express, подмена IP через IPv4-mapped IPv6).
- Не проверено: реестр npm из песочницы недоступен, версии взяты из публичных отчётов и `docs/dependencies-target.md`. `package-lock.json` нужно пересобрать (`npm install`), затем `npm audit` и `npm test`.

## [0.1.127]
### Security
- Тема: токены с `url()`, `image-set()`, `expression()` и `@import` отклоняются (раньше `url(//хост/…)` проходил проверку и мог подгружать ресурс с чужого хоста); `cssUrl` — только путь или `https://`.
- Аудит 0.1.91–0.1.97 завершён: раздача логотипов (nosniff, sandbox-CSP, SVG не исполняется) в порядке.
- Не проверено: полный `npm test` (в песочнице прогнан `ui-theme-errors.test.js`, 11/11).

## [0.1.126]
### Security
- Раздел «О системе»: версия из ответа реестра npm принимается только в виде обычного semver (иначе «нет данных»), чтобы в готовую команду `npm install` не попадала произвольная строка.
- Аудит разделов users/backups и `errorResponder` — замечаний нет.
- Не проверено: полный `npm test` (в песочнице прогнан `admin-ops.test.js`, 8/8).

## [0.1.125]

Аудит функций 0.1.91–0.1.97 (LDAP, баны):
- LDAP: `allowPlaintext` (по умолчанию `false`); конфигурация с `ldap://` без `startTls` отклоняется схемой (пароли шли бы открытым текстом); имя пользователя подставляется в фильтр функцией — `$&`, `$'` в имени больше не искажают фильтр; остановка выдачи на лимите (`SizeLimitExceeded`, код 4) — `AMBIGUOUS`, а не `UNAVAILABLE`; незавершённое STARTTLS-соединение закрывается. Тесты в `ldap.test.js` (11, проходят).
- Баны: `/login` в workshop не создаёт сессию забаненному имени (`bans.check`, аудит `auth.login` / `banned`, ответ 403 `BANNED`); `registerRoutes` принимает `bans`. Тест в `routes.test.js`.
- Документация «Безопасность»: раздел «Баны и LDAP: что учтено при аудите» (в том числе: бан IPv6 — по точному адресу, кэш банов до `cacheMs`).
- Не проверено: `routes.test.js` и сервер workshop здесь не запускались (нет express и др.), только проверка синтаксиса; прошу `npm test`.

## [0.1.124]

- I11: `npm run lock:check` (`scripts/check-lock.mjs`) — каждая зависимость каждого рабочего пространства есть в `package-lock.json` и её версия удовлетворяет диапазону (`^`, `~`, точная, `>=`, `x`, `||`); шаг CI до `npm ci`. Тест `check-lock.test.js` (3, проходят). Скрипт сейчас сообщает, что `i18next@^26.5.7` нет в lock (его нельзя установить в среде разработки): закоммитьте `package-lock.json` после своего `npm install`.
- Workshop: тест полноты охватывает и заголовки/подписи в `routes.js` (`i18n-coverage.test.js`, 3 проверки, проходят).
- Документация «Разработка ядра»: раздел «Lock-файл».
- Не проверено: CI не запускался; проверка версий упрощённая (теги и git-адреса не оцениваются).

## [0.1.123]

- Тест `data-durability.test.js` («never leaves a backup-*.zip…»): сломанный адаптер подменял только `snapshotTo`, а плановая копия с 0.1.116 использует `snapshotToAsync` — тест не ломал копию. Теперь подменяются оба метода. Ошибка в тесте, не в коде.
- Ваш прогон 0.1.122: ядро 864 passed / 3 skipped (один упавший — этот), workshop 135/135.

## [0.1.122]

- Workshop: словарь дополнен («Backups», «Running...», «Verifying...»); тест `i18n-coverage.test.js` сканирует `pages.js` и падает, если у английского текста (текстовый узел, диалог, заголовок, placeholder, `aria-label`) нет русской записи (2 проверки, проходят). Одинаковые на обоих языках названия (`E-mail`, `MFA`, `Workshop`, `Realtime Lab`) перечислены в тесте явно.
- Документация «Переводы» описывает проверку.
- Не проверено: сканирование `routes.js` (сообщения API) не добавлялось; перевод вызовов на `t()` и словаря оболочки ещё впереди; тесты целиком не запускались.

## [0.1.121]

- Защита от захода по HTTP: слушатель редиректа отвечает `426` на запросы не GET/HEAD (не обрабатывает и не перенаправляет; `redirectUnsafeMethods: true` возвращает 308); `onRedirect({ ip, method, path, host, count, refused })` — не чаще раза в `notifyEveryMs` на адрес, без query-строки; workshop пишет обращения в поток `security` с сокращённым адресом.
- `http.securityHeaders({ hsts: { preload } })`: токен `preload` только вместе с `includeSubDomains` и сроком не меньше года, иначе ошибка.
- doctor: проверка «HTTP to HTTPS» (перенаправление есть / выключено — предупреждение / совпадает с портом HTTPS — ошибка / за прокси).
- Документация: «Безопасность» → «Заход по HTTP» (все слои, вариант с закрытым портом на межсетевом экране, `upgrade-insecure-requests` не включён), «Конфигурация».
- Тесты: `http-redirect.test.js` (8, проходят), `http-hsts-doctor.test.js` (не запускался: нужен helmet; проверка doctor вручную дала ok/warn/fail/ok).
- Не проверено: журнал безопасности workshop на реальном pino, `http-hsts-doctor.test.js`; прошу `npm test`.

## [0.1.120]

- Схема портов платформы: HTTPS `9N02`, HTTP `9N01` только с перенаправлением на HTTPS, следующее приложение +100 (workshop 9002/9001, IT Assets 9102/9101). `http.createHttpRedirectServer` (308 на тот же путь, Host верят только для `allowedHosts`, `localhost` и loopback — не открытый редирект), `http.resolveRedirectPort`; конфигурация `server.httpRedirectPort` (по умолчанию `port − 1` при собственном TLS, `false` — выключить) и `server.allowedHosts`.
- Workshop: порт 9002, слушатель редиректа на 9001, закрывается при остановке; Dockerfile и `docker-compose.yml` на 9002; документация («Конфигурация», «Быстрый старт», «Разработка») и README обновлены.
- Тест `http-redirect.test.js` (5, проходят): порт редиректа, 308 для GET и POST, подделанный Host, порт 443.
- Не проверено: запуск workshop на 9002/9001 целиком, e2e (Playwright использует 4399, редирект на 4398); `config-strict.test.js` в моей среде частично падает из-за нехватки `toBeInstanceOf` в заглушке vitest, не из-за изменений.

## [0.1.119]

- `i18n.setTextOverrides(map)`, `getTextOverrides`, `pickTexts`: замена отдельных текстов ядра для всего процесса — админка, страницы ошибок (по полям кода), интерфейс страниц политик, письма (сценарием). `createAdmin({ texts })` сильнее. `errorText`/`renderErrorPage` читают каталог через `catalogFor`.
- Тесты в `i18n-core-catalog.test.js` (11, проходят); `policy`, `admin*`, `ui-*`, `email`, `i18n` проходят.
- Не проверено: `http.test.js` (страницы ошибок) здесь не запускался (нет express); тесты целиком не запускались.

## [0.1.118]

- `adapter.pageByExample(table, example, { pageSize, cursor, orderBy, direction, withTotal })` и экспорт `database.pageByExample`: keyset-пагинация, устойчивая к вставкам и удалениям, непрозрачный курсор (подделка отклоняется, значения параметризованы). Тест `page-by-example.test.js` (4, проходят). B17 закрыт.
- Не проверено: остальные тесты базы не запускались целиком; прошу `npm test`.

## [0.1.117]

- Оболочка: ссылка «К содержимому» (`.adm-skip`, видна при фокусе), `<main id="adm-main" tabindex="-1">`; подпись меню и `translate()` ищут перевод только среди собственных ключей (ключи вроде `constructor`, `toString` больше не дают функции прототипа) — E04, E07.
- Страницы ошибок: название приложения в `alt` логотипа экранируется (E06).
- Тест в `ui-locale-theme.test.js` (7 проверок, проходят).
- Не проверено: `http.test.js` (страницы ошибок) здесь не запускался (нет express); прошу `npm test`.

## [0.1.116]

- I03: `adapter.snapshotToAsync(file, { check })` — `VACUUM INTO` и `integrity_check` копии в рабочем потоке (`database/snapshot-worker.js`); плановое резервное копирование его использует, event loop не блокируется на время копии. В памяти — прежняя синхронная копия. Тест `snapshot-async.test.js` (3, проходят).
- Не проверено: тесты резервных копий (`backup-*`, `scheduler`, `cli-operational`) здесь не запускались — нет пакетов в среде; прошу `npm test`. Рабочий поток читает файл базы отдельным соединением только для чтения (WAL).

## [0.1.115]

- CI: `permissions: contents: read`, `concurrency`, `timeout-minutes`, одобрение `argon2 cpu-features ssh2`, шаг `version:check` (J04 частично).
- «Эксплуатация»: сбой восстановления `uploads` (L05), закрепление образа и действий CI, лицензия `libheif-js` (J03, J05 — действия на вашей стороне).
- Не проверено: CI не запускался; SHA-пины и digest образа получить нельзя (нет доступа к GitHub и Docker Hub).

## [0.1.114]

- F10: `logs.accessLog(logger, { ipMode })` — `full` (по умолчанию), `truncate` (IPv4 /24, IPv6 /48), `none`; `logs.anonymizeIp`. Workshop пишет access-log с `truncate`, полный адрес остаётся в аудите. SSE-канал `lab` в workshop отдаёт псевдоним `user #<id>`, а не логин. Тест `logs-ip.test.js` (4 проверки, проходят).
- Документация и статусы аудита обновлены.
- Не проверено: передача `ipMode` через pino-http и обновлённый тест `lab` в workshop здесь не выполнялись (нет pino, express); прошу `npm test`.

## [0.1.113]

- K03: блокировка входа в workshop по паре (логин, адрес) — посторонний блокирует только свой адрес; общий бюджет по логину ×6 и запись в аудит `auth.lockout`; `createFailureTracker().resetPrefix(prefix)` (сброс пароля снимает блокировки логина). Тест «a stranger cannot lock the real user out» и `resetPrefix` в `http-failure-tracker.test.js`.
- K06: `csrfProtection({ strictPaths })` — на указанных путях запрос без Origin, Referer и Sec-Fetch-Site отклоняется и без cookie. Тест в `http-hardening.test.js`. В workshop не включено (тесты и API-вход идут без заголовков).
- Документация «Безопасность» обновлена.
- Не проверено: новые тесты здесь не выполнялись (в среде нет `express-rate-limit`, `express`), только проверка синтаксиса; прошу `npm test`.

## [0.1.112]

- `createAdmin({ texts })`: приложение заменяет отдельные тексты админки по пространствам каталога (`admin-overview`, `admin-audit`, `admin-ops`, `admin-appearance`) на любом языке, остальные остаются встроенными (`src/i18n/overrides.js`, `pickTexts`). Тест в `admin-ops.test.js`.
- Документация: «Переводы» и «Администрирование» описывают `texts`.
- Не проверено: тексты оболочки, политик, страниц ошибок и писем пока без такого переопределения; вызовы `t()` на i18next в админке не вводились (админка собирается синхронно, i18next асинхронный — выбрано переопределение без него); тесты целиком не запускались.

## [0.1.111]

- `i18n.coreNamespaces()` (`src/i18n/catalog.js`): все тексты ядра (обзор, аудит и безопасность, операции и оформление админки, интерфейс и тексты политик, страницы ошибок, письма) как пространства имён i18next. Словари экспортированы из своих модулей (`OVERVIEW_TEXTS`, `AUDIT_SECURITY_TEXTS`, `OPS_TEXTS`, `APPEARANCE_TEXTS`, `POLICY_UI_TEXTS`, `EMAIL_TEXTS`), сами тексты не менялись.
- Тест `i18n-core-catalog.test.js`: в каждом пространстве ключи `ru` и `en` совпадают, пустых текстов нет (9 проверок, проходят).
- Документация: раздел «Переводы» описывает каталог и проверку полноты.
- Не проверено: тексты на местах пока читаются по-старому (`L[locale]`), перевод на вызовы `t()` и словарей оболочки/workshop ещё впереди; `lazy-imports.test.js` в среде разработки падает и без этих изменений (заглушки нативных пакетов), у вас должен проходить; тесты целиком не запускались.

## [0.1.110]

- Единый источник версии: `packages/core/package.json`; `CORE_VERSION` (`src/version.js`, экспорт ядра); `scripts/version.mjs` (`get|set|stamp|check`) обновляет `package-lock.json` и метки `<!--core-version-->` в документации. Workshop берёт версию из `CORE_VERSION`.
- Документация переписана: `docs/guide/` (11 разделов: быстрый старт, модули, конфигурация, безопасность, администрирование, переводы, темы и оформление, CLI, workshop, эксплуатация, разработка), без «когда добавлено». `docs/index.html` собирается `npm run docs` (`scripts/build-docs.mjs`) с шапкой: логотип, версия ядра, значки shields.io и skill-icons.
- README — короткая главная; `docs/admin-panel.md`, `docs/app-theme-guide.md`, `docs/docker-desktop.md` влиты в руководства и удалены; `docs/doc-audit.md` — пробелы и места, требующие внимания; статусы в `docs/audit-findings.md` обновлены (K04, K05, F05, F07, F09 закрыты).
- README workshop очищен от истории этапов.
- Не проверено: сборщик документации использует собственный конвертер Markdown (не `marked`); значки и skill-icons требуют интернета и не просматривались; тесты ядра и workshop не запускались целиком (нет express, pino, sharp, jsdom, otplib); в `package-lock.json` нет i18next до `npm install`.

## [0.1.109]

- Админка → «Оформление» (`createAdmin({ appearance: { uploadsDir, fallbackName } })`): название, логотип для светлой и тёмной темы (PNG/JPG/SVG через `files.acceptUpload`, файлы в `uploads/branding/`), цвет акцента отдельно для светлой и тёмной темы (проверка `#rrggbb`, цвет текста на кнопках считается по контрасту), сброс. Всё пишется в аудит (`admin.appearance.*`).
- `branding`: поля `logoFile`, `logoFileDark`, `accent`, `accentDark`; `themeWithBranding(db, baseTheme)`, `brandingHtml(db, {fallbackName})`, `mountLogoRoute` (публичный `GET /branding/logo/:theme`, нужен странице входа), `readableOn`, `brandingUploadDir`.
- Выбранные название, логотип и акцент применяются ко всем страницам админки; в workshop — к меню приложения и страницам входа/смены пароля.
- Не проверено: загрузка логотипа с настоящим sharp/SVG-санитайзером (в песочнице тест с подменой перекодировки), страницы workshop (нужен express), вид в браузере.

## [0.1.108]

- Новый модуль `@das-forge/core/i18n` (`createI18n`) на i18next ^26.5.7: ru/en, пространства имён, экранирование подстановок, `translator(locale)`, `addNamespace`, `missingKeys()` (ключи, которых нет в одном из языков), Express-middleware `req.t` / `res.locals.t`. Библиотека подгружается лениво.
- `docs/dependencies-target.md`: i18next добавлен.
- Это первый этап: словари админки/политики/ошибок и страницы workshop ещё НЕ перенесены на i18next (следующие сборки).
- Не проверено: работа с настоящим i18next (в песочнице нет реестра npm; тесты идут с заглушкой), `package-lock.json` не содержит i18next - его обновит `npm install`.

## [0.1.107]

- Все автоматически генерируемые пароли (первый админ, временные из админки и CLI, сброс) теперь 24 символа.
- Не проверено: тесты workshop (нужен express); в песочнице проверено только `user-admin`.

## [0.1.106]

- Исправлено (регрессия 0.1.105): кэш `attachUser({revalidate})` был по пользователю и отдавал старый снимок сессии (с `mustChangePassword`), из-за чего после смены пароля любой раздел снова вёл на `/ui/password`. Теперь кэш по сессии и сверяется со снимком.
- Пароль первого администратора — 24 символа (временные пароли из админки по-прежнему 16).
- Тесты workshop: ожидания под русский интерфейс; проверка редиректа браузера идёт через `/assets`.
- Не проверено: тесты workshop (нужен express), браузер.

## [0.1.105]

- K04: `createSessionStore({ isUserActive })` — `set` не записывает сессию удалённого/отключённого пользователя, поздний запрос не «воскресит» отозванную сессию.
- K05: `http.attachUser({ revalidate(id, snapshot), cacheMs=30000 })` — роль и блокировка перечитываются из источника истины (кэш 30 с); `null` = пользователь не авторизован.
- Workshop подключает оба механизма.
- Не проверено: тесты workshop (нужен express); `session-revocation` падает в моей песочнице только из-за заглушки otplib. K03 и K06 не тронуты.

## [0.1.104]

- Консоль: одна компактная строка на запрос/аудит (`GET /admin 401 15ms`), без многострочных trace.
- Тема: одна глобальная иконка (авто/светлая/тёмная) на всех страницах, включая ошибки, политику и страницы входа; выбор хранится в браузере.
- Язык: единый выбор, запоминается в cookie `das_lang` (`ui.localeMiddleware()`), применяется везде; страницы workshop переведены (`src/i18n.js`).
- Меню приложения со ссылками Админ-панель/Система; в админке «← В приложение», «Назад» на странице политики.
- Админка → «О системе»: Health + диагностика (doctor) + проверка зависимостей с последними версиями и готовой командой `npm install`.
- Workshop: раздел E-mail в аккаунте; принудительная смена временного пароля на `/ui/password` без ввода текущего.
- Баннер запуска: версии приложения и ядра, двуязычные «логин / login», «пароль / password», текст про смену пароля RU, пропуск строки, EN.
- Не проверено: тесты workshop (routes/smoke, нужен express), вид pino-pretty в терминале, отрисовка в браузере, doctor в реальном окружении.

## [0.1.103]
Оформление и модальные окна (по замечанию «странно с дизайном»).
- `ui.MODAL_SCRIPT`: `admDialog.alert/confirm/prompt` (Promise) на `<dialog>` вместо браузерных alert/confirm/prompt; `data-confirm="текст"` на кнопке спрашивает перед действием. Фокус, Esc и клик по фону, анимация (отключается при `prefers-reduced-motion`), текст только через `textContent`. Подключается в `renderAppShell` (с nonce).
- Стиль: обычные поля, кнопки, таблицы, списки и код внутри `.adm-content` оформляются без классов, так что старые страницы выглядят единообразно; главная кнопка формы акцентная; карточки и таблицы с рамкой и тенью; шапка и боковая панель прилипают при прокрутке.
- Светлая тема: боковая панель светлая (раньше оставалась тёмной); активный пункт подсвечен цветом акцента. Приложения по-прежнему меняют токены `--adm-nav*` у себя.
- Подвал (ссылки политики) в колонке `.adm-foot`.
- Подтверждения через модалку: «Снять бан»/отзыв сессий в «Безопасности», сброс текста политики; в workshop переименование, e-mail, временный пароль, ссылка сброса, удаление пользователя, ошибка «нужен хотя бы один аутентификатор».
- Тесты: `ui-modal.test.js` (4).
- Не проверено: вид в браузере (светлая и тёмная темы, модалки), работа `showModal` в Chrome/Firefox, смоук workshop. Перевод страницы аккаунта (E01–E07) не сделан.

## [0.1.102]
По скриншотам браузера после 0.1.101.
- workshop: пока пароль временный, браузер при открытии любой страницы переходит на `/ui/account` (смена пароля), а не видит JSON `PASSWORD_CHANGE_REQUIRED`; скрипты и fetch() получают прежний 403 JSON.
- `renderAppShell`: нижние ссылки политики и баннер внутри `.adm-main`, а не рядом с шапкой (раньше уезжали вправо); в шапке кнопка языка.
- Не сделано: страница аккаунта и формы остаются на английском, оформление кнопок в светлой/тёмной теме неровное — это пункты E01–E07.
- Не проверено: смоук/routes workshop здесь не запускались (нет express); вид в браузере.

## [0.1.101]
По замечаниям первого запуска workshop в браузере.
- Логи: ответы 4xx пишутся как `info` (429 — `warn`), а не `warn`; `GET /favicon.ico` отвечает 204. Раньше каждый 404 давал длинный WARN в консоли.
- workshop: `GET /` ведёт на `/ui` (есть сессия) или на `/login`, поэтому «На главную» больше не 404; корень и favicon разрешены и при обязательной смене пароля.
- Страница 401: кнопка «Войти / Sign in» на `/login` (опция `loginUrl` у `errorResponder`, `notFoundHandler`, `errorPageHandler`).
- Язык: вместо двух ссылок «RU · EN» одна кнопка с флагом текущего языка (`ui.langSwitchHtml`, SVG без шрифтов и картинок), на страницах политики и на страницах ошибок.
- Старт workshop: баннер в консоли с адресом, входом, `/admin` и, при первом запуске, логином и временным паролем (файл `first-run-admin.txt` по-прежнему пишется). `DAS_BOOTSTRAP_PRINT=false` скрывает пароль. Это сознательное изменение решения A16 по вашей просьбе.
- Тесты: `ui-lang-login.test.js` (4), `banner.test.js` (3), смоук корня/favicon, правка теста уровня логов.
- Не проверено: `ops-hardening.test.js` и смоук workshop здесь не запускались (нет pino/express); вид кнопки и баннера в браузере и консоли Windows.

## [0.1.100]
Только документация, код не менялся.
- README: модули `admin/ security/ policy/ ldap/`, команды `ban add|lift|list` и `privacy reapply-erasures` (сверено со всеми 37 командами), раздел «Доработки 0.1.91–0.1.99», новый «Дальше», таблица актуальных документов (`docs/roadmap.md` — исторический).
- `docs/index.html`: версия, 0.1.91–0.1.100, итоги последнего прогона (0.1.98).
- `docs/audit-findings.md`: «Статус на 0.1.100»; закрыты F06, F08, L04, B16, I08–I10.
- `docs/admin-panel.md`, `docs/dependencies-target.md` приведены в соответствие.
- Не проверено: ничего не запускалось (документация); решение по D04/D05/D11 ждёт подтверждения владельца.

## [0.1.99]
### Fixed
- `http.errorResponder`: страницу ошибки получает только клиент, явно просящий `text/html` (браузер всегда просит);
  curl, скрипты и `fetch()` без `Accept` по-прежнему получают JSON (в 0.1.97 они получали HTML — это ловил smoke-тест workshop
  «protected route without a session is 401 JSON»).
### Added (аудит I08, I09, I10)
- **I08** `sanitizeSvg(svg, {maxBytes})`: SVG больше 1 МиБ (по умолчанию) отклоняется ДО построения DOM (`code: 'SVG_TOO_LARGE'`);
  `validateUpload`/`acceptUpload` принимают `svgMaxBytes`. JSDOM по-прежнему создаётся на каждый вызов — осознанно (нет общего
  состояния между загрузками); нагрузку ограничивают размер файла и лимиты параллелизма.
- **I09** квота загрузок: использование каталога кэшируется на 2 с (`quota.cacheMs`, `0` = каждый раз сканировать), `acceptUpload`
  добавляет сохранённый файл к кэшу (`files.noteUploadStored`), `files.invalidateUploadUsage(dir)` и `removeOrphanUploads`
  сбрасывают кэш. Побочный эффект: запись из другого процесса видна не позднее чем через TTL.
- **I10** SSE: `createSseHandler({reauthorize, reauthorizeMs = 60000})` — открытый поток периодически перепроверяется; при `false`
  или ошибке отправляется `event: unauthorized` и поток закрывается (слот освобождается). Workshop проверяет по базе, что сессия жива и
  пользователь не отключён. Лимит потоков на пользователя уже был (C06).
- I11 (устаревание lock-файла) — организационный пункт, кодом не закрывается; I03 остаётся открытым.
### Not verified
- `audit-wave-o.test.js` (4 проверки) — в песочнице; `reauthorize` в живом workshop (SSE через сокет) — ваш `npm test`.
- Ваш прогон 0.1.98: ядро 794 passed / 3 skipped; workshop 120 из 121 (единственный сбой — исправление выше).

## [0.1.98]
### Fixed / Added (аудит F06, F08, L04, B16)
- **F06** `privacy.exportUserData` теперь отдаёт и данные ядра о человеке (`core`): сессии (даты, без идентификаторов и cookie),
  способы входа (тип/статус, без секретов) и его записи аудита (по логину, с учётом псевдонимов; до 5000). Новые необязательные
  параметры `auditQueryFn`, `listAuthenticatorsFn`; workshop их передаёт. Записи аудита, где человек только объект (`entity user`),
  в выгрузку не входят.
- **F08** журнал стираний `privacy.createErasureLedger(file)`: маленький файл рядом с базой (`.erasures.jsonl`, права 0600),
  в нём id пользователя + солёный хэш логина (не сам логин) и режим. `eraseUserData({erasureLedger})` записывает туда стирание;
  после `backup restore` старой копии `reapply()` стирает этих людей заново (только если в восстановленной базе совпали и id, и хэш
  логина — чужая учётка не тронется; повтор безопасен). Workshop делает это при каждом старте сервера и командой
  `privacy reapply-erasures`. Файл журнала копируйте отдельно от копий базы.
- **L04** `server.trustProxy` принимает `false | true (один хоп) | число хопов (2–10, CDN + nginx) | список адресов/подсетей`
  (`'10.0.0.0/8'`, `'loopback'`…); `DAS_TRUST_PROXY=2` или `=10.0.0.0/8,loopback`. Express-овское `true` по-прежнему не
  используется. `1`/`yes` — один хоп, как раньше.
- **B16** `scheduler.resolveDestinations(destinations, baseDir)`: единый резолвер относительных путей `local`/`mount` и `privateKeyFile`
  sftp; workshop вызывает его один раз в контексте (раньше обрабатывался только `local`), дубль в админке убран.
### Not verified
- `privacy-wave-n.test.js` (8 проверок) — в песочнице; старт сервера с `reapplyErasures`, команда CLI и реальный `backup restore`
  с последующим стартом — на вашем `npm test` и ручной проверке.

## [0.1.97]
### Added — единая точка для ошибок 4xx/5xx и политика/cookie
- `http.errorResponder(vendorIdentity, {locale, theme, bodyEnd})` — middleware (ставится после `requestId()`): охранные слои
  (`requireAuth`, `requirePermission`, CSRF, лимитер запросов, `validateBody/validateQuery`, баны) отвечают через общий
  `http.sendError`: браузеру — брендированная страница из каталога ru/en, API-клиенту (Accept JSON, JSON-тело, путь `/api/`) —
  прежний JSON; для 429 сохраняется `Retry-After`. Без `errorResponder` поведение прежнее (чистый JSON). `renderErrorPage`,
  `notFoundHandler`, `errorPageHandler` принимают `bodyEnd`/`bodyEndHtml` (подвал и баннер).
- Модуль `policy` (`@das-forge/core/policy`): `createPolicy({db, appName, theme, dependencySources})`.
  - Публичные страницы `/policy` (политика использования), `/policy/cookies`, `/policy/components` (пакеты, версии, лицензии из
    установленных package.json; GPL/LGPL/AGPL помечены «копилефт», ссылки на тексты GNU и SPDX); язык `?lang=` / `Accept-Language`.
  - Тексты по умолчанию ru/en (шаблон платформы, со ссылками на компоненты и лицензии, в т.ч. GPL) — это шаблон, не юридически
    утверждённый текст; приложение заменяет его своим.
  - Баннер cookie «Принять / Отказаться» без JS (две формы), выбор в cookie `das_consent` (180 дней, SameSite=Lax, Secure по
    `req.secure`), `consentOf(req)` для приложений с необязательными cookie; возврат только на путь своего сайта (нет open redirect).
    Платформа сама необязательных cookie не ставит. `pageEnd(req,res)` = ссылки на политики + баннер для оболочки, страниц ошибок и админки.
  - Админ-раздел «Политики» (`/admin/policy`): правка текста политики использования и cookie отдельно для RU и EN (поле + загрузка
    из файла .md/.txt, до 100 000 знаков), «Вернуть шаблон»; разметка: заголовки, списки, **жирный**, ссылки http(s)/mailto/относительные,
    HTML не поддерживается (экранируется); каждое сохранение/сброс пишется в аудит.
- `renderAppShell(..., bodyEndHtml)`; `createAdmin({policy, bodyEnd})`. Workshop подключает ответчик, политику и баннер.
### Not verified
- `policy.test.js` (11 проверок) — в песочнице; `http-hardening`/`http`/workshop smoke там не запускаются (нет express и др.):
  нужен ваш `npm test` и просмотр `/policy`, баннера и страницы 401/403 в браузере. Юридический текст шаблона не проверялся.

## [0.1.96]
### Docs
- `docs/app-theme-guide.md`: как приложение подставляет свой вид в `/admin`, страницы ошибок и каркас — через
  `theme.tokens` / `darkTokens` / `cssUrl`, таблица сопоставления CSS-переменных четырёх приложений с токенами
  ядра. Палитры приложений в ядро **не** входят: это зона приложения (ядро даёт только механизм из 0.1.91).
- Код не менялся (пресеты тем, начатые и откатанные в этой сборке, в архив не попали).

## [0.1.95]
### Added — `core/ldap` (вход через LDAP / Active Directory)
- `ldap.createLdapAuthenticator(config, {env, bindPassword, ldapts, readFile})` → `authenticate(username, password)` и
  `testConnection()`. Поток search+bind как в it-assets и net-monitor, пакет `ldapts` ^9.2.0 (загружается только при
  первом входе; без него — понятная ошибка). Схема настроек `ldap.LdapConfigSchema`: url `ldap(s)://`, `startTls`,
  `bindDn`, `bindPassword` (только `env:NAME`), `baseDn`, `userFilter` (с одним `{{username}}`), атрибуты имени/почты/групп,
  `roleMapping` (первое совпадение по порядку списка), `defaultRole`, `tlsCaFile`, таймауты.
- Ужесточено по сравнению с приложениями: пустой пароль отклоняется до обращения к серверу (иначе bind с пустым
  паролем — анонимный и «успешный»); 0 или >1 найденных записей = отказ (net-monitor брал первую); имя
  экранируется по RFC 4515 (`Filter.escape`); TLS проверяется всегда, отключение только явным `insecureTls: true`.
- Результат: `{ok:true, dn, username, displayName, email, groups, role}` или `{ok:false, code}` с кодами
  `DISABLED | INVALID_INPUT | NOT_FOUND | AMBIGUOUS | BAD_PASSWORD | UNAVAILABLE` — пользователю показывать одно
  сообщение, различие нужно для журнала. Локальную учётку создаёт/находит приложение.
- Зависимость `ldapts` добавлена в package.json и вручную в package-lock.json (записи взяты из lock it-assets).
### Not verified
- `ldap.test.js` (8 проверок) идёт на подставном `ldapts`; настоящий сервер (AD/OpenLDAP), StartTLS и имя ошибки
  неверного пароля в реальном `ldapts` не проверялись — нужен ваш прогон против тестового каталога и `npm ci`.

## [0.1.94]
### Added — остальные разделы `/admin` (шаг 4)
- «Пользователи» (`/admin/users`): список с поиском, статус, MFA, кнопки «Отключить / Включить» поверх
  `auth.setUserDisabled` (себя отключить нельзя, последнего администратора — тоже, сессии отключённого
  завершаются); действия пишутся в аудит. Включается по умолчанию, `users: false` — выключить.
- «Резервные копии» (`/admin/backups`): список по всем хранилищам (`backups.list`) и кнопка «Запустить сейчас»
  (`backups.run`, пишется в аудит).
- «Логи» (`/admin/logs`): счётчики приёмников логов (отправлено, потеряно, в резервный файл, в очереди, сбои,
  последняя ошибка) из `logDestination.stats()`.
- «О системе» (`/admin/about`): приложение, ядро, Node, платформа; таблица зависимостей из package.json с
  установленной версией и лицензией; кнопка «Проверить обновления» — запрос к реестру npm только по нажатию
  (таймаут 5 с, 5 параллельных, ошибки показываются как «реестр недоступен»); сравнение версий —
  собственное `compareVersions` по x.y.z (без пакета semver, для сравнения «новее/нет» этого достаточно).
- Экспорт: `admin.compareVersions`, `readDependencies`, `checkLatest`. Workshop подключает все разделы.
### Not verified
- `admin-ops.test.js` (5 проверок) — в песочнице; живой сервер, реальный запрос к npm и список копий на
  реальных хранилищах — ваш `npm test` и ручной просмотр. Скачивание лицензий (как в atlas) не делал.

## [0.1.93]
### Added — баны, «Аудит» и «Безопасность» в `/admin` (шаг 3)
- Модуль `security` (`@das-forge/core/security`): таблица `security_bans(kind ip|user, value, reason, created_by,
  created_at, expires_at, lifted_at, lifted_by)`; `createBans(db)` → `ban / lift / list / check / middleware / purge`.
  Срок бана необязателен (`30m`, `2h`, `7d`), снятие не удаляет строку (история), IPv4-mapped IPv6 = тот же IPv4,
  бан пользователя завершает его сессии, каждый бан/снятие пишется в аудит (`security.ban`, `security.unban`).
  `bans.middleware()` ставится после `attachUser()` и отвечает 403 (`{error:'BANNED'}` / «Access denied.»);
  проверка кэшируется на 5 с, поэтому бан из CLI доходит до работающего сервера за несколько секунд.
- CLI: `ban add <ip|user> <значение> [--reason] [--duration]`, `ban lift <ip|user> <значение>`,
  `ban list [--all] [--json]` (`cli.registerBanCommands`).
- `/admin/audit`: фильтры (кто, действие, результат, период), постраничный просмотр (keyset), кнопка проверки
  цепочки, выгрузка CSV до 5000 строк (защита от формул в Excel; сама выгрузка пишется в аудит).
- `/admin/security`: активные баны с формой «Забанить» и «Снять», список сессий с «Завершить» (в адресе —
  хэш идентификатора, не сам cookie); защита от самоблокировки (нельзя забанить себя и свой IP);
  действия пишутся в аудит. Формы — обычный HTML (urlencoded читается встроенным разбором, лимит 16 КБ);
  CSRF — общий `csrfProtection`. Параметр `stepUp` — место для повторной проверки (например, свежий MFA).
- Workshop: баны подключены после `attachUser`, CLI `ban`, задание `bans-gc`.
### Not verified
- Тест `bans-admin.test.js` (9 проверок) пройден в песочнице; живой сервер, формы в браузере и CSRF на POST
  формах `/admin/security` — только ваш `npm test` и ручной просмотр. `stepUp` в workshop не подключён.
- Баны по IP работают за прокси только при верном `trust proxy` (иначе `req.ip` — адрес прокси).

## [0.1.92]
### Added — раздел `/admin`, шаг 2 (`docs/admin-panel.md`)
- Новый модуль `@das-forge/core/admin` (`admin.*`): `createAdmin({db, metrics, dbFilePath, theme, brandHtml, sections, permission})`
  и `mount(app, {requireAuth, requirePermission})` — `GET /admin` только после входа и с правом `admin.access`
  (401 без входа, 403 без права; CSRF для POST-действий даёт общий `csrfProtection`). Страница «Обзор»:
  время работы, память, размер базы, пользователи, сессии, записи аудита, версия Node и два графика
  (запросы и ошибки 5xx по часам за 24 ч, UTC). Тема и каркас — из 0.1.91; язык `?lang=` / `req.locale`.
  Дальнейшие разделы подключаются через `sections` (следующие сборки).
- `createMetrics(db)`: таблица `metrics_hourly(bucket, name, value)`, счётчики копятся в памяти и пишутся пачкой
  (по умолчанию раз в 10 с), `inc/flush/series/purge/middleware/close`; middleware считает `http.requests`,
  `http.4xx`, `http.5xx`. Хранение 35 дней, очистка — задание `metrics-gc` в workshop.
- `svgBarChart` / `svgLineChart`: серверные SVG без зависимостей, цвета из токенов темы (светлая/тёмная и палитра
  приложения), `role="img"`, `<title>` и текстовое резюме, всё экранируется.
- Workshop: право `admin.access` у роли admin, ссылка «Admin» на `/ui`, счётчики на всех запросах, остановка
  метрик при выключении сервера.
### Not verified
- Тест `admin.test.js` (5 проверок) пройден в песочнице; подключение в workshop (`server.js`) проверено только
  на синтаксис — нужен ваш `npm test` и взгляд на `/admin` в браузере.

## [0.1.91]
### Added — тема и каркас (проект: `docs/admin-panel.md`, шаг 1)
- `ui/theme.js`: одна лёгкая таблица стилей на семантических токенах `--adm-*` (светлая и тёмная схемы по
  `prefers-color-scheme`, принудительно через `data-theme`), компоненты: боковая панель, шапка, карточка, сетка,
  таблица, бейджи ok/warn/danger/info, кнопки, поля с ошибкой, `<dialog>`, уведомление; без внешних шрифтов и
  CDN. Приложение подтягивает свой вид без правки ядра: `theme.tokens` / `theme.darkTokens` (значение может быть
  `var(--своя-переменная)`) и `theme.cssUrl` (свой CSS после базового). Значения токенов проверяются — `;`, `}`,
  разметка отвергаются. Экспорт: `ui.themeHead`, `ui.tokenCss`, `ui.THEME_TOKENS`, `ui.BASE_CSS`, `ui.THEME_SCRIPT`.
- `ui.renderAppShell`: новые необязательные параметры `theme`, `user`, `brandHtml`, `nonce`; шапка с именем
  пользователя и кнопкой темы (auto → светлая → тёмная, выбор в localStorage, без него тоже работает),
  `aria-current` у активного пункта. Старые вызовы работают как раньше. Inline-скрипт получает nonce CSP —
  workshop передаёт `res.locals.cspNonce` и пользователя во всех страницах `/ui/*`.
- Каталог страниц ошибок `http/error-catalog.js` (ru/en): 400, 401, 403, 404, 405, 408, 409, 413, 415, 422, 429,
  500, 502, 503, 504 + общие «4xx»/«5xx», у каждой заголовок, пояснение и что делать. Язык: `req.locale`, затем
  `Accept-Language`, затем `opts.locale` (строка или функция). Экспорт: `http.ERROR_CATALOG`, `errorText`,
  `resolveLocale`.
### Changed
- `renderErrorPage({…, hint, locale, theme})`: подсказка, ссылка «На главную / Home», `lang` по языку, тема приложения;
  подпись «код запроса / request id».
- `notFoundHandler(vendor, {locale, theme})` и `errorPageHandler(vendor, {logger, locale, theme})` берут тексты из
  каталога; 404 теперь отвечает JSON `{error:'NOT_FOUND', message, fields, requestId}` API-клиентам (Accept JSON,
  тело JSON, путь `/api/…`), браузеру — страница. Для 429 и 503 в JSON-ответе добавлен `Retry-After`.
  Формат прежних JSON-ответов (`INTERNAL_ERROR`/`REQUEST_ERROR`) не менялся.
### Not verified
- Тесты `http` и `ops-hardening` в песочнице не запускались (нет express-rate-limit/helmet): ждём ваш `npm test`.
  Внешний вид в браузере не просматривался (нет скриншотов); проверены HTML и токены тестами.

## [0.1.90]
### Changed
- **D07** по результатам разбора приложений (этап H): `bcryptScheme` и пакет `bcryptjs` удалены (0.1.88 была
  ошибкой предположения — ни одно приложение не использует bcrypt; it-assets его уже убрал). Вместо этого
  `auth.scryptSaltColumnScheme()` — точный старый формат atlas и net-monitor: `crypto.scrypt(пароль, соль, 64)`
  с параметрами Node по умолчанию, соль — строка из колонки `users.salt`, хеш — 128 hex. Соль передаётся через новый
  параметр `verifyPassword(stored, plain, { legacySchemes, legacyContext: { salt } })`; схема асинхронная. Успешный
  вход помечается `needsRehash` (миграция на argon2id). Формат взят из кода приложений и проверен тестом на
  `crypto.scryptSync`; на реальных строках БД не проверялся. `package-lock.json` приведён в соответствие.
### Docs (сверка, каждый 10-й билд)
- README: раздел «Доработки 0.1.81–0.1.90», новый «Дальше»; `docs/index.html` (версия, статус запусков, новый блок);
  `docs/dependencies-target.md` (разбор приложений); `docs/audit-findings.md` («Этап H», статусы);
  новый `docs/admin-panel.md` — проект админ-раздела (доступ, разделы, бан/разбан, графики, тема приложения).

## [0.1.89]
### Added
- **J01** `package-lock.json` в корне репозитория (присланный владельцем, снят на
  0.1.87; запись `bcryptjs` 3.0.3 и поля `packages/core` добавлены вручную по
  данным реестра npm, `npm ls --package-lock-only` без ошибок). Dockerfile сам
  выберет `npm ci`. После вашего `npm install`/`npm ci` пришлите обновлённый
  файл, если npm что-то в нём поправит.
### Not verified
- `npm ci` на этом lock-файле не запускался (в песочнице нет сети): если он
  ругнётся на рассинхрон, `npm install` перепишет файл — пришлите результат.

## [0.1.88]
### Added
- **D07** `auth.bcryptScheme()` — legacy-схема для bcrypt-хешей (`$2a$`/`$2b$`/`$2y$`,
  it-assets): чистый JS `bcryptjs` ^3.0.3 (версия сверена по npm; optional peer,
  грузится при первом использовании, без нативной сборки). Подключается как любая
  другая схема: `verifyPassword(stored, plain, { legacySchemes: [auth.bcryptScheme()] })`;
  успешный вход помечается `needsRehash` и переезжает на argon2id. Строки длиннее
  72 байт отвергаются (bcrypt обрезает вход). `verifyPassword` теперь ждёт
  `scheme.verify` (схемы могут быть асинхронными).
- Единый формат: все старые хеши, независимо от схемы, мигрируют на argon2id при
  следующем успешном входе (массового сброса нет). Реальных образцов хешей
  четырёх приложений нет (решение владельца: унифицировать); `pbkdf2Scheme` и
  `scryptScheme` остаются шаблонами, параметры подставляются при порте по
  реальным данным.
### Not verified
- bcrypt проверен на подставном модуле `compare` (в песочнице нет `bcryptjs`);
  на реальном `bcryptjs` и настоящих хешах — только ваш `npm test` после
  `npm install`.

## [0.1.87]
### Fixed
- **I07** обработка изображений (`files.reencodeImage`, а значит и `acceptUpload`)
  идёт через шлюз: одновременно не больше `uploads.imageProcessing.maxConcurrent`
  (2), следующие ждут в очереди до `maxQueue` (16), дальше `ImageBusyError`
  (`code: 'IMAGE_BUSY'`, `status: 503`). Раньше десяток одновременных загрузок
  HEIC по 50 Мпикс мог исчерпать память. `acceptUpload` больше не превращает
  перегрузку в «плохую картинку» (400): ошибка проходит как есть; workshop
  отвечает 503 + `Retry-After`. Новые экспорты: `configureImageConcurrency`,
  `imageConcurrencyStats`, `withImageSlot`, `ImageBusyError`; workshop
  применяет конфиг на старте.

## [0.1.86]
### Fixed
- **I05** индекс `idx_audit_log_created_iso` по тому же выражению, по которому
  фильтры `since`/`until` приводят время к ISO (старые строки до 0.1.28 хранят
  `YYYY-MM-DD HH:MM:SS`). План запроса с условием по дате использует индекс
  (`count()` и выборки без сортировки). Ограничение: для `query/page` с
  `ORDER BY id DESC LIMIT n` SQLite на маленькой таблице всё равно может идти по
  первичному ключу — на больших таблицах решает планировщик; если станет
  медленно, помогает `ANALYZE`.

## [0.1.85]
### Fixed
- **I02/K07** `createFailureTracker`: при заполнении таблицы вытесняются только
  незаблокированные ключи (раньше флуд мусорными ключами снимал блокировку с
  атакующего); если заблокированы все — уходит блокировка, истекающая раньше
  всех, память остаётся ограниченной. Новый `http.clientKey(ip)` группирует IPv6
  по /56 (как общий лимитер); workshop использует его для `loginIpFailures`.
- **I04** `audit.verifyChain` читает журнал страницами по 2000 строк (раньше —
  весь `audit_log` в память); результат и обнаружение разрыва те же.
- Тест `backup-remote` «тот же диск» на Windows падал: проверка устройства там
  намеренно пропускается, тест теперь это учитывает.
### Verified by owner (прогон 0.1.84)
- Docker (node:26): core 732/732, workshop 121/121; Windows: всё зелёное, кроме
  теста выше. `ssh2` просит одобрить install-script — SFTP работает и без него
  (чистый JS), одобрять нужно только ради нативного ускорения шифрования.

## [0.1.84]
### Fixed — `backup restore` при работающем сервере (G02)
Восстановление подменяет файл базы: живой сервер продолжал писать в отвязанный
файл, а его `-wal` удалялся — данные терялись молча.
- Сервер держит замок `<каталог базы>/.server.lock` (pid) всю жизнь процесса;
  второй сервер на ту же базу не стартует.
- `scheduler.restoreBackup({ serverLockFile })`: при живом владельце замка
  возвращает `{ok:false, steps:[{name:'Check server', …}]}` и ничего не трогает;
  на время восстановления сам держит замок, поэтому сервер не запустится
  посреди восстановления. Замок мёртвого процесса (после падения) считается
  свободным; замок с собственным pid (контейнер перезапустился с тем же pid)
  сервер забирает (`takeOverSelf`).
- `acquireFileLock(file, {staleMs: Infinity, takeOverSelf})`, `readLockOwner(file)`.
- В workshop подключено (`ctx.serverLockFile`, `bin/app.js` restore, `server.js`);
  для `:memory:` замка нет.
### Not verified
- Реальный запуск `npm start` + `backup restore` рядом (нужен ваш прогон).
  Замок завязан на pid: при общем томе между разными хостами/контейнерами с
  разными pid-пространствами он не защищает.

## [0.1.83]
### Added — удалённые приёмники бэкапов (L01)
Копия рядом с базой гибнет вместе с машиной. Новые типы `backup.destinations`:
- `mount` — каталог на смонтированном сетевом диске (NFS/SMB). Корень **не
  создаётся** (иначе незамонтированный диск молча заполнит локальный), путь на
  том же устройстве, что каталог данных, отвергается (кроме
  `config.allowSameDevice` для тестов; на Windows эта проверка пропускается),
  `config.markerFile` требует файл-метку в корне шары.
- `sftp` — через пакет `ssh2` (^1.17.0, версия сверена по npm; грузится только
  при использовании). `config`: `host`, `port`(22), `username`, `hostKeySha256`
  (обязателен, формат `SHA256:…` из `ssh-keygen -lf` или hex — доверия «с первого
  раза» нет), `remotePath` (должен существовать), один из `privateKey`
  (`env:NAME`) / `privateKeyFile` / `password` (`env:NAME`), `passphrase`
  (`env:NAME`), `verify` (`hash`|`size`). Литералы паролей в конфиге схема отвергает.
- Общие правила: архив собирается один раз в приватной временной папке и уходит
  во все удалённые приёмники; загрузка идёт в `<имя>.tmp`, проверяется (размер и по
  умолчанию SHA-256, прочитанный обратно с приёмника) и только потом
  переименовывается — оборванная передача не оставляет «хорошего» файла;
  без `backup.encryptionKey` отправка за пределы машины отказывается
  (`allowUnencrypted: true` в `config` приёмника снимает запрет); срок хранения
  считается для каждого приёмника отдельно (новейшие `minKeep` не удаляются);
  сбой одного приёмника не мешает остальным (ошибка job содержит `results`).
- `backup list` показывает копии mount и SFTP (`scheduler.listRemoteBackups`);
  `backup verify`/`restore` для SFTP требуют сначала скачать файл (скачивание в CLI
  пока нет).
- Пример:
  ```js
  backup: { encryptionKey: undefined /* DAS_BACKUP_KEY */, retentionDays: 30, destinations: [
    { id: 'local', type: 'local', path: 'data/backups' },
    { id: 'nas', type: 'mount', path: '/mnt/nas/backups', config: { markerFile: '.mounted' } },
    { id: 'offsite', type: 'sftp', config: { host: 'bk.example.com', username: 'das',
        hostKeySha256: 'SHA256:...', remotePath: '/srv/backups', privateKeyFile: '/run/secrets/bk_key' } },
  ] }
  ```
### Not verified
- Реальный сервер SFTP не запускался: загрузка проверена на подставном модуле
  ssh2, который повторяет вызовы (`connect`, `sftp`, `fastPut`, `stat`, `rename`,
  `readdir`, `createReadStream`) поверх локальной папки. Проверку подписи
  host key (`hostHash`/`hostVerifier`) нужно подтвердить на реальном сервере.
- `npm install` нужен, чтобы подтянуть `ssh2`.

## [0.1.82]
### Changed — журнал аудита хранит псевдонимы, а не логины и IP (F03)
Раньше логин и IP в `audit_log` нельзя было стереть: таблица append-only и
защищена хеш-цепочкой. Теперь:
- в строку пишется случайный псевдоним (`~a:…` для логина, `~i:…` для IP), а
  настоящие значения лежат в новой таблице `audit_subjects`. Хеш цепочки
  считается от псевдонима, поэтому цепочка остаётся валидной.
- То же для `meta`: значения ключей `username`, `login`, `user`, `email`,
  `actor` и `ip`, `ipAddress`, `remoteAddress` (рекурсивно).
- `'system'` и `'cli'` — не персональные данные, пишутся как есть.
- `log/tail/query/page/count` по-прежнему принимают и возвращают настоящие
  значения (фильтр `actor: 'alice'` работает). Стёртый субъект читается как
  `[erased]`.
- `audit.eraseSubjects(db, {usernames, ips, exclusiveIps})` удаляет связи.
  `privacy.eraseUserData` вызывает её сама (параметр `eraseAuditSubjectsFn`,
  в workshop подключён), результат — в поле `auditSubjects`. IP стирается, только
  если встречается исключительно в строках этого пользователя (общий адрес
  других людей остаётся).
- Retention вместе со строками удаляет связи, не использованные с момента среза.
- Подписчики `audit.onEntry` и зеркало логов (`full`) получают сырую запись с
  псевдонимами: наружу персональные данные не уходят даже в режиме `full`.
### Ограничения (честно)
- Строки, записанные до 0.1.82, содержат логин и IP открытым текстом, стереть
  их нельзя (правка сломает цепочку); они уйдут по `audit.retentionDays`.
- После стирания значение может остаться в свободных страницах файла SQLite и
  в старых бэкапах; для базы — `VACUUM`, для бэкапов — их срок хранения.
- Не проверено вживую: `npm test` на вашей машине (здесь 6 новых тестов и
  прежние аудит-тесты зелёные в песочнице).

## [0.1.81]
### Added — приёмники логов за пределы машины
Логи теперь можно направлять не только в stdout, но и на другую машину
(при взломе хоста локальные файлы удаляют). Без нового пакета: `node:net`,
`node:tls`, `node:dgram`, `fetch`, `node:fs`.
- `logs.createLogDestination({sinks, buffer, localFallback, appName})` — объект,
  в который пишет pino; каждая строка идёт во все приёмники, чьи `streams`
  (`app`, `access`, `audit`, `security`) и `minLevel` её принимают. Поток строки
  определяется по полю `"stream"` (`logger.child({stream: 'audit'})`), строки
  `msg: "request"` — `access`, остальное — `app`.
- Приёмники: `stdout`; `file` (в т.ч. на сетевой диск; права 0600, ротация
  `maxBytes`/`keep`); `syslog` (RFC 5424, UDP / TCP с octet-counting / TLS с
  проверкой сертификата, `caFile`); `http` (форматы `ndjson`, `loki`,
  `elastic-bulk`, `splunk-hec`, заголовки вида `env:NAME`, https обязателен кроме
  localhost).
- Буфер: запись строки никогда не ждёт сеть и не бросает исключение; очередь до
  `buffer.maxLines` (10 000), повторы с нарастающей паузой, при переполнении —
  отбрасывание старых (`drop-oldest`) или новых строк со счётчиком и, если задан
  `logging.localFallback`, запись в локальный файл (0600, с лимитом). 5xx, 408, 429
  и сетевые сбои повторяются; прочий 4xx отбрасывает пачку (не повторять вечно).
  `destination.stats()` — sent/dropped/spilled/queued/failures/lastError;
  `/system/status` в workshop показывает `logSinks`; `close()` на остановке
  доставляет остаток.
- Конфиг `logging {sinks, buffer, localFallback, auditMirror, auditAnchorSchedule}`.
  Пример:
  ```js
  logging: {
    sinks: [
      { type: 'stdout' },
      { type: 'syslog', host: 'logs.example.com', protocol: 'tls', caFile: '/etc/ssl/log-ca.pem' },
      { type: 'http', url: 'https://loki.example.com/loki/api/v1/push', format: 'loki',
        labels: { app: 'workshop' }, headers: { Authorization: 'env:LOKI_TOKEN' }, streams: ['app', 'audit'] },
    ],
    localFallback: { path: 'data/logs/fallback.ndjson' },
  }
  ```
- Журнал аудита наружу: `audit.onEntry(fn)` и `logs.mirrorAuditToLogs`
  (`logging.auditMirror`: `minimal` по умолчанию — только id, hash, prevHash,
  action, result, время, без логина/IP/деталей; `full` — вся запись; `off`).
  Задача `audit-anchor` (по умолчанию каждый час в :05) пишет в поток `audit`
  «голову» цепочки; CLI `audit anchor` печатает её, `audit verify
  [--anchor-id N --anchor-hash H]` проверяет цепочку и сверку с якорем из
  удалённого лога (код 3 при нарушении — вырезанный хвост или переписанная
  история).
### Not verified
- TLS-вариант syslog и реальные Loki/Elastic/Splunk/rsyslog не запускались;
  TCP/UDP/HTTP проверены на локальных серверах в тестах.
### Not done
- F03 (стирание PII из журнала аудита задним числом): режим `minimal` не
  отправляет PII наружу, но локальные строки `audit_log` по-прежнему содержат
  логин/IP до срока `audit.retentionDays`; нужен ваш выбор модели (см. ответ).

## [0.1.80]
### Docs
- Синхронизация документов (раз в 10 сборок): `README.md` (раздел «Что добавилось
  в 0.1.71–0.1.79», честная проверка, «Дальше»), `docs/index.html`,
  `docs/dependencies-target.md` (yauzl единственный, сессии только express-session,
  решение по `ssh2` и приёмникам логов), `docs/audit-findings.md` (повторный аудит
  0.1.77, статусы, проект приёмников логов). Код не менялся.

## [0.1.79]
### Security / Fixed (повторный аудит 0.1.77)
- **F02**: срок хранения аудита подключён — `audit.retentionDays` (по
  умолчанию 365, 0 = бессрочно) и `audit.purgeBatchSize`; в workshop
  ежедневная задача `audit-gc` (03:50) с записью `audit.purge` в журнал.
- **I06**: `purgeOlderThan` удаляет пакетами (`batchSize`, 5000), а не одним
  `DELETE` на всю таблицу.
- **F09**: задача `password-resets-gc` чистит просроченные токены сброса.
- **F05**: очередь почты — `cancelForAddress(address)` (отмена ожидающих писем
  стираемого человека, тело стирается), TTL ожидания `pendingTtlHours`
  (72 ч, письмо снимается со статусом `EXPIRED`), хеши адресов хранятся только
  пока письмо ждёт. В workshop erase вызывает отмену.
- **I01**: общий лимит параллельных операций argon2
  (`auth.argon2.maxConcurrent`=2, `maxQueue`=64); сверх очереди —
  `PasswordBusyError` (HTTP 503). В Dockerfile `UV_THREADPOOL_SIZE=8`.
- **K02**: ключ шифрования TOTP — список (первый шифрует, все расшифровывают);
  `auth.totpEncryptionKey` (+ `DAS_TOTP_KEY`) и
  `auth.previousTotpEncryptionKeys`; workshop также читает
  `previousSessionSecrets`, поэтому ротация `sessionSecret` больше не блокирует
  TOTP; при старте секреты перешифровываются под текущий ключ. Секрет, который
  нечем расшифровать, делает фактор непроверяемым (предупреждение в консоли), а не
  500 при входе.

## [0.1.78]
### Security / Fixed (повторный аудит 0.1.77)
- CLI **G01**: `--yes=false` и другие булевы флаги со значением разбираются
  (true/1/yes/on, false/0/no/off), мусор — ошибка (код 2); `-y` = `--yes`;
  `--hard` больше не съедает следующее слово; деструктивные команды требуют
  `=== true`.
- CLI **G03**: `audit export` выгружает журнал постранично целиком (раньше
  молча обрезал до 1000 строк); `--limit` ограничивает общее число.
- CLI **G04/F07**: файлы `audit export` и `privacy export --out` создаются с
  правами 0600 и не перезаписывают существующие без `--force`.
- CLI **G05**: проверка типов значений флагов (`flagString`, `flagInt`);
  `--user` без значения и `--days abc` — ошибка использования, а не падение.
- CLI **G06**: `cert generate --force` сохраняет прежние `cert.pem`/`key.pem`
  как `*.bak-<время>`.
- CLI **G08**: ошибки команд печатают `code`, `--verbose` — стек; ошибка
  без `message` больше не роняет обработчик.
- **K01**: recovery-код нельзя использовать дважды при параллельных
  запросах (`UPDATE … AND used_at IS NULL`, успех только при `changes===1`).
- **K08**: перевыпуск recovery-кодов — одна транзакция.
- **F01**: `anonymizeUser` удаляет аутентификаторы, секреты TOTP, recovery-коды,
  токены сброса и сессии пользователя.
- **L02**: после `restore` удаляются восстановленные сессии и открытые токены
  сброса пароля (шаг «Revoke sessions»).
- **L03**: страховочная копия `*.pre-restore-*` создаётся с правами 0600.
- **F04**: поле логина в workshop ограничено 128 символами.
- **J02**: `secrets/` добавлен в `.gitignore` и `.dockerignore`.

## [0.1.77]
### Fixed
- workshop: переименование собственной учётной записи сохраняет сессию
  явно (`req.session.save`) — `/me` сразу показывает новый логин.
- test `db-normalize`: убрано ложное допущение, что без нормализации
  boolean не биндится (на Node 26 биндится).

## [0.1.76]
### Added
- Постоянная очередь писем (ваше решение «нужна»): `email.createEmailQueue({db,
  send, maxAttempts=6, baseDelayMs=60000, lockMs, maxPending, batchSize})`,
  таблица `email_queue` создаётся сама. Письмо сначала записывается в БД и уходит
  в фоне: вызывающий не ждёт SMTP, временный сбой или перезапуск письма не
  теряют. Повторы с удваивающимися паузами (60 с, 120 с, …) до `maxAttempts`;
  отказ, который позже не исправится (`EMAIL_REJECTED`, постоянный 5xx), —
  провал сразу; ошибки входа повторяются (оператор может поправить пароль в
  конфиге). Строка, взятая упавшим процессом (`sending` дольше `lockMs`),
  подхватывается снова; захват атомарный (несколько процессов не отправят
  дважды). Тело письма (в нём ссылка сброса) стирается сразу после отправки или
  окончательного провала — остаются сценарий, маскированные адреса, число
  попыток и код ошибки. `enqueue`, `processDue`, `start/stop` (таймер
  `unref`), `stats`, `purgeFinished`; переполнение — `EMAIL_QUEUE_FULL`.
- `createEmailService({queue})`: сценарии (`sendPasswordReset` и др.)
  возвращают `{sent: false, queued: true, queueId}` вместо отправки внутри
  вызова; очередь доставляет через новый `service.sendRaw(mail)` (с
  внутренними повторами 0.1.72). Без `queue` поведение прежнее.
- Конфиг `email.queue {enabled=true, maxAttempts, baseDelayMs, intervalMs=15000,
  keepFinishedDays=7}`. Workshop при включённой почте создаёт очередь
  (`ctx.emailQueue`), запускает цикл в `server.js`, чистит завершённые строки
  задачей `email-queue-gc` (04:40) и останавливает цикл при выключении.
- Тесты `email-queue.test.js` (8, на реальном SQLite с фальшивым временем и
  отправкой). Реальный SMTP по-прежнему не проверялся.
### Changed
- В workshop при включённой почте письма уходят асинхронно: ответ админ-API
  `reset-password` (mode `email`) означает «поставлено в очередь», а ошибка
  SMTP (прежний 502 `EMAIL_FAILED`) теперь видна в логе очереди и в
  `email_queue.last_error`, а не в ответе. Отключить: `email.queue.enabled: false`.
- 0.1.75 больше не текущая.

## [0.1.75]
### Added
- Нормализация значений в адаптере БД — включаемая опция (ваше решение), по
  умолчанию выключена: `createSqliteAdapter({normalizeValues: true})` или
  `database.normalizeValues: true` в конфиге (workshop передаёт её адаптеру).
  Запись: `Date` → ISO-8601 UTC строка, `boolean` → 1/0, невалидная `Date` —
  `RangeError`. Чтение: колонки с ОБЪЯВЛЕННЫМ типом BOOLEAN → `true/false`,
  DATE/DATETIME/TIMESTAMP → `Date` (текст `YYYY-MM-DD HH:MM:SS` без зоны —
  как пишет `datetime('now')` — читается как UTC; нераспознанное остаётся как
  есть). Выражения (`strftime(...)`, `id + 1`) типа не имеют и возвращаются
  без изменений. Чтение требует `StatementSync.columns()` (Node 23.11+; проект
  на 26). Затрагивает `run/get/all`, а значит и `queryByExample`/`countByExample`.
  Тест `db-normalize.test.js` (5), прогнан на реальном `node:sqlite`.
### Changed
- 0.1.74 больше не текущая.

## [0.1.74]
Свой читатель оглавления ZIP заменён на yauzl (ваше решение «только yauzl»).
### Changed (ломающее изменение API)
- Удалён `files/zip-reader.js` (свой разбор central directory, ZIP64 и т.д.).
  Заявленные размеры и имена теперь читает `yauzl` лениво, по одной записи,
  без распаковки: новый `files/zip-inspect.js` (`inspectZip`, `listZipEntries`,
  `detectOfficeType`).
- **Асинхронными стали** `files.checkZipSafety`, `files.assertSafeOfficeFile` и
  `files.validateUpload` (раньше синхронные) — вызывающим нужен `await`.
  `acceptUpload` уже был асинхронным и обновлён.
- Удалены экспорты `parseZipEntries` и `parseZipArchive` (вместо них
  `listZipEntries`, тоже асинхронная).
- Проверка числа записей теперь по объявленному в архиве количеству, без
  чтения оглавления целиком. Усечённое или противоречивое оглавление,
  небезопасные имена (`..`, абсолютные пути) и повреждённый архив отклоняются
  самим yauzl: причина читается как «archive cannot be read (…)» вместо прежних
  «truncated or inconsistent» / «unsafe entry name». Шифрованные записи,
  коэффициент сжатия и суммарный размер проверяются как раньше.
### Tests
- `files.test.js` и `zip-verify.test.js` переведены на async; в песочнице они
  идут на упрощённой заглушке yauzl, так что настоящую проверку даст ваш
  `npm test` (SVG-тесты там дополнительно требуют jsdom).
### Changed
- 0.1.73 больше не текущая.

## [0.1.73]
Переход на express-session, шаг 3 из 3: удалён старый самописный сессионный код.
### Removed (ломающее изменение API)
- `auth.createSession`, `auth.verifySession`, `auth.destroySession`, `auth.regenerateSession`.
- `http.sessionMiddleware`, `http.setSessionCookie`, `http.clearSessionCookie`.
- Методы `createSession / verifySession / destroySession / regenerateSession`
  у `AuthProvider`; контракт `assertAuthProvider` теперь требует только
  `hashPassword` и `verifyPassword`. `createAuthProvider` по-прежнему принимает
  `sessionTtlMs` / `sessionIdleTimeoutMs`, но игнорирует их (чтобы существующие
  вызовы не ломались).
- Остаётся: `createSessionStore` + `http.createSessionMiddleware / attachUser /
  establishSession / endSession`, а также общие `hashSessionId`,
  `destroyUserSessions`, `purgeExpiredSessions`; `requireAuth` и
  `requirePermission` не менялись.
- Приложениям, вызывавшим старые функции, нужно перейти на express-session
  (образец — workshop 0.1.66).
### Tests
- Удалены тесты старого механизма (`session-middleware-parser`, блоки в
  `auth.test.js`, `http.test.js`, `session-idle`, `session-hash`); idle-timeout,
  срок жизни и touch покрыты `session-store.test.js` и реальным HTTP в
  `server.smoke.test.js`. Остальным тестам нужны только «строка сессии есть /
  нет» — для этого `test/helpers/session-fixtures.js` пишет и читает те же
  строки (хэш id, те же колонки), что и настоящее хранилище.
### Changed
- 0.1.72 больше не текущая.

## [0.1.72]
### Added
- Почта: повтор отправки при временных сбоях. `email.retry {attempts=3,
  baseDelayMs=500}` — паузы удваиваются (500, 1000 мс). Повторяются только
  сетевые ошибки (`ECONNECTION`, `ETIMEDOUT`, `ESOCKET`, `ECONNREFUSED`, `EDNS`)
  и временные ответы SMTP 4xx; отказ входа (`EAUTH`), получателей
  (`EENVELOPE`) и постоянные 5xx не повторяются. После последней попытки —
  прежний `EmailError` с кодом. В лог пишутся сценарий и номер попытки, без
  адреса и ссылки. Опция `sleep` у `createEmailService` для тестов.
  Тесты в `email.test.js` (+3, всего 19, прогнаны на подставном транспорте).
### Not done
- Постоянная очередь писем (переживает перезапуск) не сделана: повтор идёт в
  памяти и блокирует вызывающего на время попыток. Нужна ли очередь в БД с
  фоновой отправкой — решение за вами. Реальный SMTP по-прежнему не проверялся.
### Changed
- 0.1.71 больше не текущая.

## [0.1.71]
Остатки аудита B17 (данные).
### Added
- `database.rebuildTable(db, table, createSql, {copy})` — перестройка таблицы
  по документированной процедуре SQLite (удалить/переименовать колонку, сменить
  тип, добавить ограничение): создаётся `<table>__new`, строки копируются
  (общие колонки по имени, `copy` — SQL-выражения для новых), старая таблица
  удаляется, индексы и триггеры пересоздаются, затем `foreign_key_check`;
  при нарушении всё откатывается. `foreign_keys` на время выключается и
  возвращается. Представления не пересоздаются (делать в той же миграции).
  Тест `db-rebuild.test.js` (3).
- Шифрование бэкапов: `backup.encryptionKey` (фраза от 16 символов; env
  `DAS_BACKUP_KEY` / `DAS_BACKUP_KEY_FILE`). Бэкап пишется как
  `backup-<ts>.zip.enc` (AES-256-GCM, ключ из scrypt, заголовок входит в
  аутентификацию, потоковая запись); незашифрованный zip рядом не остаётся.
  `verifyBackupFile(createAdapterFn, file, {encryptionKey})` и `restoreBackup({..., encryptionKey})`
  расшифровывают во временную папку и удаляют её; без ключа — понятный отказ;
  неверный ключ неотличим от повреждённого файла (GCM), открытый текст на
  диске не остаётся. `listBackups` показывает `encrypted`; retention и список
  понимают `.zip.enc`. Экспорт: `scheduler.encryptBackupFile / decryptBackupFile /
  isEncryptedBackup / BackupCryptoError`. Workshop передаёт ключ в job,
  `backup verify/restore` и `/system/backup/verify`. Тест `backup-encryption.test.js` (5).
### Not done
- Нормализация Date/boolean в адаптере не делалась: меняет типы значений,
  которые уже читают приложения, — нужно ваше решение.
### Changed
- 0.1.70 больше не текущая.

## [0.1.70]
### Added
- E2E на Playwright (`examples/workshop/e2e`, `playwright.config.js`, скрипт
  `test:e2e`, dev-зависимость `@playwright/test ^1.63.0`): сервер на
  одноразовой базе с известным админом (`e2e/start.js`), сценарии — аноним не
  открывает `/ui/users`; админ создаёт, переименовывает, сбрасывает пароль и
  удаляет учётку в браузере; свою учётку отключить/понизить нельзя. Файлы
  `*.e2e.js`, vitest их не подхватывает. **Не запускались** (нет пакетов в
  среде разработки): перед первым запуском `npx playwright install chromium`.
### Docs
- Синхронизация документов (каждый 10-й билд): `README.md`,
  `docs/index.html`, `docs/audit-findings.md` («Статус исправлений на 0.1.70»),
  `docs/dependencies-target.md`. `docs/roadmap.md` по решению заморожен.
### Changed
- 0.1.69 больше не текущая.

## [0.1.69]
### Added
- HEIC/HEIF-загрузки (iPhone): `libheif-js` (WASM, без нативного бинаря)
  декодирует в RGBA, дальше обязательный re-encode через sharp; по
  умолчанию результат — JPEG (`outputFormat` переопределяет). Определение
  по `ftyp`-бренду в `detectFileType` (`heic`), `acceptUpload` принимает
  `heic` в `allowedTypes`. Лимит пикселей проверяется ДО выделения буфера.
  Экспорт `decodeHeic`. Загрузка ленивая.
- `buildDocx(report)` (`@das-forge/core/files`): отчёт .docx на пакете
  `docx` из обычных данных (заголовок, абзацы, списки, таблицы); управляющие
  символы вычищаются, объекты в ячейках отклоняются. Загрузка ленивая.
- Зависимости: `libheif-js ^1.23.2`, `docx ^9.8.1`.
- Тесты `heic-docx.test.js` (8, на подставных модулях); `lazy-imports`
  теперь блокирует и `libheif-js`, `docx`.
### Changed
- 0.1.68 больше не текущая.

## [0.1.68]
### Added
- Управление учётными записями (ядро): `auth/user-admin.js` —
  `listUsers`, `createManagedUser`, `renameUser`, `setUserEmail`,
  `changeUserRole`, `setUserDisabled`, `resetUserPassword`, `removeUser`
  (anonymize|delete), `generateTempPassword`. Защита последнего активного
  админа, уникальность логина (без учёта регистра), префикс
  `deleted-user-` зарезервирован, сессии отзываются при
  rename/role/disable/reset. Хэши паролей наружу не отдаются.
- CLI: `user list|create|rename|set-role|set-email|disable|enable|delete`,
  `reset-password` через общий домен; аудит с актором `cli`.
- Workshop: админ-API `GET/POST /admin/users`, `PATCH/DELETE
  /admin/users/:id`, `POST /admin/users/:id/reset-password`
  (временный пароль или ссылка по e-mail, токен во фрагменте URL),
  страница `/ui/users`; запрет self-role/disable/reset/delete (409
  SELF_ACTION); аудит `admin.user.*` без секретов.
- Тесты: `user-admin.test.js` (11), `cli-user-admin.test.js` (7),
  workshop `routes.test.js` — блок «account administration API» и
  тест `/ui/users`.
### Changed
- `GET /admin/users` теперь возвращает `{items,total,limit,offset}`.

## [0.1.67]

Пакеты из общего списка проекта вместо самописного:
- **multer ^2.4.0**: `files.createMultipartUpload({maxBytes, field})` — один файл из multipart в память под жёстким лимитом, результат в `req.upload`; отказы JSON (415 / 413 / 400 UNEXPECTED_FIELD, NO_FILE, TOO_MANY_PARTS, MALFORMED_MULTIPART). Загружается лениво. Workshop: `POST /assets/:id/logo` теперь принимает multipart (поле `logo`) вместо сырого тела; прежний `requireContentType`/`express.raw` удалены. ВАЖНО для клиентов: загрузка логотипа — `multipart/form-data`.
- **uuid ^14.0.2**: `v4()` вместо `crypto.randomUUID()` (request id, имена загружаемых файлов, logger, workshop).
- **pino-pretty ^13.1.3** (optional peer + dev): `logs.createLogger({pretty: true})` — читаемый вывод для терминала; без пакета откат на JSON с предупреждением. Workshop включает его только вне production и в интерактивном терминале.
- **supertest ^7.3.0** (dev, workshop): загрузка логотипа проверяется по реальному HTTP (аутентификация, PNG принят, не multipart → 415, неверное поле, нет файла, «HTML под видом image/png», превышение 2 МБ → 413).
- **jsqr ^1.4.0** (dev, core): тест QR теперь рисует настоящий SVG через sharp и декодирует его обратно — совпадение с исходным текстом (URL, otpauth://, уровень H).
- Тест `multipart.test.js` (заглушка multer, маппинг ошибок).
- Не подключено пока: libheif-js и docx (появятся вместе с кодом, который их использует), playwright (e2e).

## [0.1.66]

Переход на express-session, шаг 2 из 3 — workshop:
- `server.js`: `http.createSessionMiddleware` (подписанная cookie, хранилище SQLite) + `http.attachUser()` вместо `http.sessionMiddleware({authProvider})`; ключ подписи из `auth.sessionSecret`, `auth.previousSessionSecrets` только проверяют; задача `sessions-gc` раз в час.
- `routes.js`: вход/выход/MFA/смена пароля работают через `req.session` (`establishSession` — новый id при каждом входе, `endSession`). Промежуточная MFA-сессия хранит `mfaPending` и `pendingUserId` (без `user`/`userId`, поэтому `requireAuth` её не пропускает). Cookie `Secure` определяется как `secure: 'auto'` (по `req.secure`; за прокси нужен `trustProxy`).
- Тесты: `test/helpers/fake-express-session.js` — заглушка модуля поверх настоящего хранилища ядра для быстрых тестов маршрутов; в `server.smoke.test.js` новая группа по реальному HTTP: подпись, подделка подписи, голый id, в БД только хеши, выход, повторный вход.
- ВАЖНО при обновлении: cookie прежнего формата недействительны, нужен повторный вход. Требуется `npm install` (express-session).
- Шаг 3 (0.1.67): удалить `createSession/verifySession/regenerateSession`, `http.sessionMiddleware`, `setSessionCookie/clearSessionCookie` и методы сессий в `AuthProvider`.

## [0.1.65]

Переход на express-session, шаг 1 из 3 (добавлено, существующий код не тронут):
- `auth.createSessionStore({db, ttlMs, idleTimeoutMs, touchIntervalMs})` — хранилище express-session в SQLite на той же таблице `sessions`: ключ — хеш id (A11), `user_id` берётся из `session.userId`/`pendingUserId` (отзыв всех сессий пользователя работает как раньше), абсолютный срок из cookie, idle-timeout, throttled `touch`, `purgeExpired()`.
- `http.createSessionMiddleware({store, secret, ttlMs})` — подписанная HttpOnly/SameSite=Lax cookie. Ключ подписи выводится из `auth.sessionSecret` через HKDF (тот же секрет шифрует TOTP — один ключ на две задачи не используем). Поддержана ротация: `auth.previousSessionSecrets`.
- `http.attachUser()`, `http.establishSession(req, {userId, user, data, maxAgeMs})` (новый id при входе), `http.endSession(req, res)`.
- `auth.purgeExpiredSessions(db, {idleTimeoutMs})`.
- Таблица `sessions`: `user_id` теперь допускает NULL (одноразовая перестройка таблицы при первом обращении).
- `express-session ^1.19.0` — optional peer-зависимость ядра, зависимость workshop; загружается лениво.
- Шаг 2 (0.1.66): workshop и его тесты переходят на `req.session`; шаг 3 (0.1.67): удаляются старые `createSession/verifySession/sessionMiddleware`.
- Тест `session-store.test.js`.

## [0.1.64]

Сессии (аудит A11):
- В БД хранится `h1:` + SHA-256 идентификатора сессии, а не сам идентификатор: утечка БД или бэкапа больше не даёт готовых cookie. Браузеру по-прежнему уходит исходный id (256 бит, хеш без соли достаточен). `createSession`/`verifySession`/`destroySession`/`destroyUserSessions`/`regenerateSession` принимают и возвращают исходный id; новый экспорт `auth.hashSessionId`.
- `verifySession` отбрасывает пустой, нестроковый и длиннее 256 символов id до запроса в БД; хеш из БД в роли cookie не работает.
- ВАЖНО при обновлении: сессии, созданные до 0.1.64 (лежали под сырым id), удаляются при первом обращении к БД — пользователям нужно войти заново.
- Подпись cookie через `sessionSecret` сознательно не добавлена: id случайный и проверяется по БД, HMAC ничего не добавил бы. `sessionSecret` используется для шифрования TOTP.
- Тест `session-hash.test.js`.

## [0.1.63]

Workshop (ядро не менялось):
- Страницы `/forgot-password` и `/reset-password`; ссылка «Forgot your password?» на странице входа. Токен читается только из фрагмента URL и сразу убирается из адресной строки; `/reset-password` отдаётся с `Referrer-Policy: no-referrer` и `Cache-Control: no-store`.
- Тесты: nonce и заголовки в `routes.test.js` и в `server.smoke.test.js` (реальный Express).

## [0.1.62]

База данных (аудит B17):
- Кэш prepared statements в адаптере (LRU, `statementCacheSize`, по умолчанию 128, 0 — выкл.); сбрасывается при любом DDL; `db.statementCacheStats()`.
- `queryByExample`: массив → `IN`; операторы `gt/gte/lt/lte/ne/eq/in/notIn/like/notLike/contains/startsWith/between`; `offset`, несколько `orderBy`; `deleted: 'exclude'|'only'`. Неизвестный оператор — ошибка. Новое: `countByExample`, `likeEscape`.
- Хелперы: `addUpdatedAtTrigger`, `addSoftDelete`, `softDelete`, `restoreDeleted`, `purgeDeleted`.
- Тест `db-b17.test.js`.

## [0.1.61] 
Исправления по вашему прогону 0.1.60 на Windows (core 591 passed / 2 failed, workshop 94 passed / 5 failed).
- **Конфиг (C07):** `.strictObject` не был применён к вложенным объектам, записанным в две строки
  (`z\n.object(`): `server.https`, `server.admin`, `security.rateLimit/loginRateLimit/lockout`,
  `auth.passwordPolicy/argon2`, `performance.budgets` по-прежнему молча принимали опечатки. Теперь все
  объекты схемы строгие (тест `config-strict` это и поймал).
- **workshop `routes.js`:** `appConfig.auth`/`email`/`uploads` читались без запасного значения — второй
  набор тестов с урезанным `appConfig` падал (5 тестов). Теперь срок сессии (8 ч), политика паролей и
  `baseUrl` берутся с безопасными значениями по умолчанию.
- **Тест SVG:** DOMPurify по SVG-профилю удаляет `<use>` целиком, поэтому проверка «`href="#a"` остаётся» была
  неверной; тест теперь проверяет главное — внешних ссылок в результате нет, обычные фигуры целы.
  (Выяснилось попутно: `<use>` для локальных ссылок в загруженных SVG недоступен.)

## [0.1.60]
### 0.1.60 — сброс пароля по почте, почта в `doctor`; исправлена упаковка архива
- **Упаковка:** в присылаемом `das-forge-core.zip` с 0.1.4x лежал вложенный старый
  `das-forge-core/das-forge-core.zip` (забытый файл в папке проекта попадал в каждую сборку).
  Файл удалён, сборка теперь исключает любые архивы (`*.zip`, `*.tar*`, `*.tgz`), `node_modules` и `.git`;
  проверено: во вложенном списке файлов архивов нет.
- Ядро: `auth.createPasswordResetToken / peekPasswordResetToken / consumePasswordResetToken /
  purgePasswordResetTokens` — одноразовые токены (в БД только SHA-256, срок жизни, новый токен
  отменяет прежние, погашение атомарно), таблица `password_resets`; `auth.findUserByEmail`
  (без учёта регистра; `null`, если адрес общий у нескольких учёток).
- Ядро: `email.emailChecks(config, service)` — проверки для `doctor`: «SMTP reachable», предупреждения
  про выключенную проверку сертификата и шифрование, SPF/DMARC домена отправителя. Не бросает исключений.
- Конфиг: `email.baseUrl` (обязателен при `email.enabled`) — из него строятся ссылки в письмах.
- workshop: `POST /password/forgot {login}` — всегда одинаковый 202 (логин или e-mail; не говорит,
  существует ли учётка), письмо отправляется ПОСЛЕ ответа (нет разницы по времени); токен в
  **фрагменте** ссылки (`…/reset-password#token=…`) — не попадает в логи и Referer; `POST /password/reset
  {token, newPassword}` — пароль проверяется политикой ДО погашения токена (слабый пароль не сжигает
  ссылку), затем смена пароля, выход со всех устройств, снятие блокировки, письмо «пароль изменён».
  Отключённая учётка и учётка без адреса письма не получают. Лимит `loginRateLimit` на оба маршрута.
  Категория `Integrations` в `app doctor`.
- Страницы `/reset-password` в workshop **нет**: ссылка ведёт на неё, страница (читает `#token` и шлёт
  `POST /password/reset`) — задача UI приложения.
- Тесты: `test/password-reset.test.js` (10, прогнаны на реальном SQLite) и 6 в
  `examples/workshop/test/routes.test.js` (forgot/reset) — **не прогонялись** (нет express/argon2/zod в
  песочнице). Реальная отправка письма по-прежнему не проверена.

## [0.1.59]
### 0.1.59 — системная почта (`core/email`, nodemailer)
- Новый подпуть `@das-forge/core/email` (и `core.email`), пакет `nodemailer` ^10.1.2 (сверено на npm;
  грузится лениво — приложения без почты его не требуют).
- `createEmailService({config, logger, transport?, overrides?, brandName?})`: именованные
  сценарии с обязательными полями — `sendAlert` (info/warning/critical), `sendPasswordReset`,
  `sendPasswordChanged`, `sendEmailVerification`, `sendAccountBanned/Unbanned`, `sendUserInvited`,
  `sendSystemNotice`; шаблоны ru/en (язык: `locale` вызова → `email.locale` → ru). Приложение
  может переопределить вид сценария (`overrides`), но не убрать сам сценарий.
- Безопасность: адреса — только «голые» (без `Name <a@b>`, без перевода строки/запятой, до 20),
  ссылки только http(s), всё в HTML экранируется, переводы строк из темы вырезаются; в лог
  попадают сценарий и маскированный адрес, но не тело/ссылка; лимит писем на получателя и
  сценарий (по умолчанию 5 в час; критичный alert не ограничивается); ошибки транспорта —
  `EmailError` с кодом (`EMAIL_AUTH`, `EMAIL_UNREACHABLE`, `EMAIL_REJECTED`, `EMAIL_SEND_FAILED`) без
  секретов в тексте; заголовки `Auto-Submitted`/`X-Auto-Response-Suppress`.
- SMTP: STARTTLS обязателен по умолчанию (`requireTLS`), проверка сертификата включена, DKIM из
  конфига (`privateKey` или `privateKeyFile`). `verify()` для doctor не бросает исключений.
- `email.checkMailDomainDns(domain)` — проверка SPF/DMARC (нет записи, `+all`/`?all`, `p=none`).
  **В `doctor` пока не подключена** — это отдельный шаг вместе с проверкой «SMTP reachable».
- Конфиг `email {enabled=false, from, replyTo, locale, smtp{host,port=587,secure,requireTLS,
  rejectUnauthorized,auth{user,pass},таймауты}, dkim, rateLimit}`; при `enabled` обязательны `from` и
  `smtp.host`; пароль SMTP из окружения: `DAS_SMTP_PASSWORD` (или `DAS_SMTP_PASSWORD_FILE`).
- Тесты: `test/email.test.js` (16, прогнаны на фейковом транспорте и фейковом DNS-резолвере),
  `test/config-strict.test.js` (+3 про email, **не прогонялись** — нет zod). Реальная отправка через
  nodemailer/SMTP **нигде не проверялась** (нет пакета и сети).
- Не сделано: очередь/повторы при временной недоступности SMTP, письма из workshop
  (сброс пароля и т.п. требуют маршрутов с токенами — отдельная задача), подключение к `doctor`.

## [0.1.58]
### 0.1.58 — compression и защита от забытого cookie-parser
- Новый пакет `compression` ^1.8.2 (в ядре): `http.createCompression({threshold=1024, level})`.
  SSE (`text/event-stream`, по заголовку ответа или по `Accept` запроса) не сжимается никогда —
  иначе gzip буферизовал бы события; ответ можно исключить заголовком `X-No-Compression`.
  Подключён в workshop после `securityHeaders`.
- `sessionMiddleware`: если пришёл заголовок `Cookie`, а `req.cookies` не заполнен (забыт
  `cookie-parser`), один раз пишет предупреждение — раньше это выглядело как «все аноним».
- Тесты: `test/session-middleware-parser.test.js` (2, прогнаны), `test/compression.test.js` (6) —
  **не прогонялись** (нет пакета `compression` в песочнице).
- Решения по списку пакетов: `express-session` и `uuid` в ядро не берём (свои сессии в SQLite;
  `crypto.randomUUID()`); `cookie-parser` остаётся peer-зависимостью.

## [0.1.57]
### 0.1.57 — serialize: режим allowlist (аудит A19)
- `serialize(entity, {viewerPermissions, fieldPermissions, strict: true})`: карта становится
  белым списком — не перечисленное поле отбрасывается (новая колонка в таблице остаётся
  приватной, пока её не открыли). Значение карты `true` = видно всем, строка = нужное право.
  Режим по умолчанию не изменился (неперечисленное — видно), поведение старых вызовов то же.
- `http.findUnmappedFields(rowOrRows, map)` — для теста покрытия: какие поля карта не
  упоминает (в strict они пропадут, в обычном режиме — утекут всем).
- Исправлено попутно: имена вроде `constructor`/`toString` в данных больше не принимались
  за записи карты прав (брался `Object.prototype`), ключ `__proto__` остаётся обычными данными.
- workshop: `/me` отдаёт данные пользователя через strict-allowlist
  (`id, username, role, permissions, mustChangePassword`).
- Тесты: `test/serialize-strict.test.js` (6, прогнаны). Тесты workshop `/me` не прогонялись.

## [0.1.56]
### 0.1.56 — строгий конфиг (аудит C07)
- Все объекты схемы конфига — `z.strictObject`: опечатка или устаревший ключ
  (`sever.port`, `server.prot`) — ошибка старта, а не молчаливое игнорирование.
  `ConfigValidationError.fields` содержит по одному полю на каждый неизвестный ключ с полным
  путём (`server.prot`) и сообщением «Unknown setting …».
- **Для приложений:** свои настройки добавляются расширением схемы:
  `ApplicationConfigSchema.extend({ mailer: z.strictObject({...}) })` и передаются как
  `loadConfig({schema})` / `validateConfig(obj, {schema})`. Конфиг с лишними ключами,
  который раньше молча проходил, теперь не запустится — это и есть цель.
- Тесты: `test/config-strict.test.js` (4) — **не прогонялись** (в песочнице нет zod); я сверил
  вручную, что все ключи из `env.js`, workshop-конфига, smoke-теста и `config.test.js` есть в схеме.
- Оставлено как есть: тип направления бэкапа `s3/sftp/webdav` схема по-прежнему принимает
  (сам бэкап для них падает с понятной ошибкой, остальные направления пишутся). Сузить до
  `local` — отдельное решение: нужны ли эти типы вашим приложениям.

## [0.1.55]
### 0.1.55 — отдача файлов и SVG (аудит B11)
- Новое: `files.sendUpload(res, storageDir, storedName, {downloadName, inline})` и
  `uploadResponseHeaders(...)`. Тип ответа берётся из расширения сохранённого имени (там
  определённый по содержимому тип), не от клиента. Всегда: `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`,
  `Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: private, no-cache`.
  Картинки (png/jpg/webp/gif/svg) — inline, остальное (pdf, zip, неизвестное) — всегда
  `attachment`, неизвестное как `application/octet-stream`. Имя для скачивания чистится
  (кавычки, переводы строк, пути), не-ASCII кодируется по RFC 5987. Неверное имя/нет файла → `false` (отвечайте 404).
- Определение SVG: допускаются BOM, `<?xml?>`, комментарии и `<!DOCTYPE>` перед `<svg`
  (Inkscape/Illustrator раньше отвергались).
- `sanitizeSvg`: ссылки `href`/`xlink:href` не на `#id` удаляются (`<use>`/`<image>` на внешние
  ресурсы), `@import` и внешние `url()` в `<style>` и `style=""` вычищаются, `url(#градиент)`
  остаётся; SVG с `<!ENTITY` отклоняется.
- Тесты: `test/serve-upload.test.js` (7, прогнаны на реальном HTTP-сервере);
  `test/svg-external.test.js` (5) **не прогонялись** — в песочнице нет jsdom/dompurify. Тест с
  `url(#g)` зависит от того, оставит ли DOMPurify атрибут `style` — если упадёт, это находка.

## [0.1.54]
### 0.1.54 — квоты и сборка сиротских файлов (аудит B13)
- `acceptUpload({quota: {maxTotalBytes, maxFiles}})`: при превышении — `Error` с
  `code: 'QUOTA_EXCEEDED'`, файл не пишется; проверка стоит прямо перед синхронной записью,
  поэтому две параллельные загрузки не проходят обе. `0`/не задано = без лимита.
- `files.getUploadUsage`, `assertUploadQuota`, `findOrphanUploads(dir, referencedNames,
  {minAgeMs=1ч})`, `removeOrphanUploads(..., {dryRun})`: считаются и удаляются только файлы вида
  `<uuid>.<ext>` (и просроченные `.tmp` от упавшей записи); чужие файлы и свежие (файл пишется
  раньше строки в БД) не трогаются.
- Конфиг `uploads {maxTotalBytes = 1 ГиБ, maxFiles = 20000}`. workshop: 507 `STORAGE_FULL`
  при переполнении; еженедельная задача `uploads-gc` (вс 04:30) удаляет неиспользуемые файлы.
  Тесты: `test/upload-quota.test.js` (7, прогнаны на реальной ФС).
- Замечание по B13: `POST /assets/:id/logo` требует только входа — как и `PATCH /assets/:id`
  в workshop (любой вошедший правит любой актив), поэтому отдельное право не добавлял; в
  реальных приложениях это решается их моделью прав.

## [0.1.53]
### 0.1.53 — полнотекстовый поиск (аудит B09)
- `createFtsIndex`: индекс, созданный над таблицей с данными, заполняется сразу (раньше
  искал пустоту до ручного `rebuild()`); триггер UPDATE срабатывает только при изменении
  индексируемых колонок (`AFTER UPDATE OF …`); опции `tokenize` (по умолчанию
  `unicode61 remove_diacritics 2`, значение проверяется на безопасность) и `prefixLengths`.
  Токенайзер фиксируется при создании индекса: смена = `DROP TABLE <table>_fts` и создать заново.
- `ftsEscape(text, {prefix})` / `index.escapeQuery(text, {prefix})`: поиск по началу слова
  (`"ноутбук"*` находит «ноутбуки», «ноутбуков») — у SQLite нет русского стеммера.
- `foldYo(text)` + `escapeQuery(text, {foldYo:true})`: ё/е взаимозаменяемы, если и индексируемый
  текст (теневая колонка), и запрос пропущены через `foldYo`. **Проверено на SQLite:** сам
  `remove_diacritics` ё не сводит («свекла» не находит «свёкла») — работает только с латиницей.
- Тесты: `test/fts-russian.test.js` (8, прогнаны на реальном `node:sqlite`) и правка
  `uploads-fts.test.js` под автозаполнение.
- Ошибка, найденная при прогоне: внутри `createFtsIndex` `db` — сырой `DatabaseSync`
  (нет `.get`), исправлено на `prepare().get()`.

## [0.1.52]
### 0.1.52 — вход и пароли (аудит A13, A15)
- `auth.checkPasswordPolicy(plain, {minLength, maxLength, username, currentPassword, forbidden})`
  → `{ok, problems[]}` (коды `TOO_SHORT`, `TOO_LONG`, `SAME_AS_USERNAME`, `SAME_AS_CURRENT`,
  `COMMON`, `NOT_A_STRING`). Длина в символах; правил состава («цифра+символ») нет сознательно.
  Конфиг `auth.passwordPolicy {minLength=8, maxLength=128}`.
- `hashPassword` бросает RangeError, `verifyPassword` возвращает `valid:false` для пароля длиннее
  1024 символов (`PASSWORD_ABSOLUTE_MAX`) — argon2 не получает мегабайтные строки.
- workshop: `/password/change` проверяет политику (400 `WEAK_PASSWORD` + `problems`); вход и
  смена пароля ограничены 1024 символами на уровне схемы; `/login` уничтожает сессию, пришедшую в
  cookie (A13); срок сессии берётся из `auth.sessionTtlMs` (раньше был зашит 8 ч).
  Тесты: `test/password-policy.test.js` (7) и 4 новых в `routes.test.js`.

## [0.1.51]
### 0.1.51 — сессии (аудит A05 «роль», A12)
- Idle-timeout: колонка `sessions.last_seen_at` (добавляется в существующие БД сама;
  у старых строк берётся `created_at`), `verifySession(db, id, {idleTimeoutMs, touchIntervalMs})`.
  Сессия без запросов дольше лимита удаляется, активная продлевается скользяще; запись в БД
  не чаще раза в минуту (и не реже половины окна). Абсолютный TTL по-прежнему действует.
- Конфиг `auth.sessionIdleTimeoutMs` (по умолчанию 1 час, `0` — выключено);
  `createAuthProvider({sessionIdleTimeoutMs})`; workshop передаёт значение из конфига.
  **Поведение по умолчанию изменилось**: неактивная сессия теперь живёт 1 час, а не 8.
- `auth.setUserRole(db, userId, role, {exceptSessionId})`: меняет роль и отзывает сессии
  пользователя (в сессии лежит снимок пользователя, понижение иначе не действовало бы до
  конца TTL). Тесты: `test/session-idle.test.js` (12).

## [0.1.50]
### 0.1.50 — cors
- Новый пакет `cors` ^2.8.6 (в ядре), `http.createCors({origins})`: точное сравнение
  origin (схема+хост+порт) со списком `security.cors.origins`; пустой список — заголовков
  нет вообще; `*`/маски и невалидные значения — ошибка конфигурации; `Origin: null` не
  разрешается никогда; чужой origin не получает CORS-заголовков; preflight → 204 с
  методами/заголовками/max-age; `Vary: Origin`. Подключён в workshop после
  `securityHeaders`, до CSRF. Тесты: `test/cors.test.js` (8).

## [0.1.49]
Исправления по вашим прогонам 0.1.48 (Windows: 5 падений, Docker: 3). Прогоны:
Windows core 486 passed / 5 failed / 3 skipped, workshop 89/89; Docker core 491
passed / 3 failed, workshop 89/89 — пакеты `pino`, `pino-http`, `yauzl`, `yazl`,
`express-rate-limit`, `otplib`, `helmet` впервые проверены реальным запуском;
бэкап-тесты, `http-hardening`, лимитер и workshop (89) прошли.

### 0.1.49 — исправления
- `logs`: поля, переданные в `log.info('msg', obj)`, копируются перед
  сериализацией — защита от циклических ссылок снова работает на уровне
  `obj.self` (как до pino).
- `accessLog`: статус ответа пишется полем `status` (из сырого ответа через
  `customProps`); ключ `res` убран — стандартный сериализатор pino отдавал
  в нём `statusCode: null`. **Формат строки:** `req {id, method, path, ip,
  userAgent}`, `status`, `responseTime`.
- Тест шифрованных записей архива допускает отказ `yauzl` раньше нашей
  проверки (флаг шифрования на stored-записи выглядит как несовпадение размеров).
- `vitest.config.js`: `testTimeout`/`hookTimeout` 30 с — на холодном Windows
  первый ленивый импорт `jsdom` (SVG-санитайзер) занимал ~8 с и валил 2 теста
  по таймауту 5 с.

## [0.1.48]
Замена собственного кода пакетами из целевого стека (`docs/dependencies-target.md`),
версии 0.1.41–0.1.48. Ваши прогоны: **0.1.40** (Windows) — core 462 passed /
3 skipped, workshop 88/88; **0.1.42** (Docker, Linux, `node:26-bookworm-slim`) —
core 469 passed / 8 failed (причины исправлены в 0.1.43), workshop 89/89.
Версии 0.1.43–0.1.48 вашим прогоном ещё не подтверждены; пакеты `adm-zip`-замены
(`yauzl`/`yazl`), `pino`, `pino-http`, `express-rate-limit` в среде разработки
не устанавливались — проверка на реальных пакетах только у вас.

### 0.1.48 — лимит запросов на `express-rate-limit`
- `http.createRateLimiter({windowMs, max, keyFn})` — обёртка над
  `express-rate-limit ^8.7.0`: ответ 429 `{error:'RATE_LIMITED', fields:[],
  retryAfterSec}` + `Retry-After`, заголовки `RateLimit`/`RateLimit-Policy`
  (draft-7), IPv6 группируется по /56, запрос без `ip` — общий ключ `unknown`.
  Лимитер асинхронный; `reset(key)` сохранён.
- Убраны опции `now`, `maxKeys` и метод `size()` (у MemoryStore пакета их нет).
- `createFailureTracker` (экспоненциальная блокировка после неудач) остаётся
  своим кодом. За прокси нужен корректный `trust proxy`.
### 0.1.47 — логи на `pino` / `pino-http`
- `logs.createLogger` построен на `pino ^10.4.0`; API прежний, redaction по имени
  ключа и сериализация ошибок остались сверху; у логгера появилось поле `pino`.
- `logs.accessLog` — на `pino-http ^11.0.0`. **Формат строки изменился:**
  `msg:'request'`, `req {id, method, path (без query), ip, userAgent}`,
  `status`, `responseTime` (с 0.1.49; в 0.1.47–0.1.48 был `res`); заголовки в лог не попадают. `req.log`
  — по-прежнему логгер модуля с привычным API.
### 0.1.46 — защита загружаемых архивов (B12)
- `files.verifyZipData(buffer, {maxEntries, maxUncompressedTotal})` (`yauzl`):
  потоковая распаковка, реальный бюджет размера, CRC-32, имена (zip-slip),
  шифрованные записи и методы кроме stored/deflate отвергаются.
- `acceptUpload` вызывает её для zip-типов (`verifyArchiveData: false` отключает
  для доверенных источников).
- `checkZipSafety` отвергает усечённый/несогласованный каталог, небезопасные
  имена и шифрование; `files.parseZipArchive` читает ZIP64.
### 0.1.45 — бэкап через `yazl` / `yauzl` (потоково)
- Запись и чтение `backup-<ts>.zip` — потоком (`yazl ^3.3.1`, `yauzl ^3.4.0`);
  `adm-zip` из ядра убран. CRC проверяется своим кодом (`yauzl` его не проверяет).
- **`verifyBackupFile` и `restoreBackup` теперь асинхронные** (возвращают Promise);
  `backup verify` и `backup restore` в CLI, `POST /system/backup/verify` и
  `bin/app.js` workshop переведены на `await`.
### 0.1.44 — бэкап одним zip-файлом (B17, остаток)
- `backup-<ts>.zip` = `database.db` + `uploads/…` + `manifest.json`
  `{format, createdAt, uploads}`; вместо `backup-<ts>.db` + `uploads-<ts>/`
  (формат 0.1.38 больше не читается — продакшена не было).
- Результат `createBackupJob`: `uploadsIncluded` вместо `uploadsPath`.
  `listBackups`/retention работают с `.zip`; `verifyBackupFile` проверяет
  структуру, CRC всех записей и `integrity_check` базы; restore извлекает
  записи с проверкой путей (не `extractAllTo`).
### 0.1.43 — исправление по вашему Docker-прогону 0.1.42
- Тестовые заглушки заголовков: `deleteProperty` возвращает `true`.
- `auth/totp.js`: `otplib` по умолчанию отвергает секреты короче 16 байт;
  минимум понижен до 10 байт (`createGuardrails({MIN_SECRET_BYTES: 10})`), чтобы
  уже выданные 16-символьные base32-секреты продолжили работать. Новые
  секреты по-прежнему 20 байт.
### 0.1.42 — TOTP на `otplib`
- `auth/totp.js` — тонкий адаптер над `otplib ^13.5.0` (HMAC, base32, сравнение —
  библиотечные); API прежний (`generateTotp`, `verifyTotp`, `matchTotpStep`,
  `buildTotpUri`, `generateTotpSecret`). `buildTotpUri` выдаёт более короткий URI.
  Проверено на векторах RFC 6238 (`test/totp-rfc6238.test.js`).
### 0.1.41 — заголовки безопасности на `helmet`
- `http.securityHeaders` построен на `helmet ^8.3.0`: CSP с nonce на запрос,
  Referrer-Policy, X-Frame-Options, COOP/CORP; HSTS отправляется только на
  `req.secure`; `Permissions-Policy` — свой. Набор заголовков проверен в
  `server.smoke.test.js` (прошёл в Docker).

## [0.1.40]
Сводная запись по волнам 2–4 аудита (`docs/audit-findings.md`), версии
0.1.26–0.1.40. Последний подтверждённый вашим `npm test`: **0.1.38 —
461 passed / 2 skipped / 1 failed** (падение `backup verify` — мой баг
0.1.34, исправлен в 0.1.39) + workshop 88/88. Версии 0.1.39 и 0.1.40
вашим прогоном ещё не подтверждены.

### 0.1.40 — права на файлы (B17, часть)
- `createSqliteAdapter({fileMode = 0o600})`: новая БД создаётся с этим
  режимом (SQLite даёт тот же `-wal`/`-shm`), существующая — `chmod`
  (best effort); `fileMode: null` отключает; на Windows не действует.
  Файлы бэкапа и подготовленный файл restore — 0600.
### 0.1.39 — исправление
- `cli/commands/backup.js`: `import { EXIT }` попал внутрь вводного
  комментария (`EXIT` не определён → `backup verify` без аргумента
  возвращал 1 вместо 2). Найдено вашим прогоном.
### 0.1.38 — бэкап `uploads/`, хелперы БД (B17, часть)
- `createBackupJob({uploadsDir})` копирует каталог рядом с каждой копией БД
  как `uploads-<timestamp>/` (tmp → атомарный rename); retention удаляет
  `uploads-*` без парной `backup-*.db`; в результате `uploadsPath`.
- `restoreBackup({uploadsDir})` подменяет каталог парной копией, старый
  остаётся как `<uploadsDir>.pre-restore-<ms>`.
- `database.upsert(db, table, row, conflictColumns, {updateColumns})`,
  `database.addColumnIfMissing(db, table, column, definition)`.
### 0.1.37 — аудит: даты, keyset, якорь (B14, остаток)
- `since`/`until` принимают Date/ISO/`YYYY-MM-DD`/SQLite-формат
  (`audit.normalizeTimestamp`); старые строки с пробелом сравниваются как ISO.
- `audit.page(db, filters)` → `{items, nextBeforeId}`; фильтры `beforeId`/`afterId`.
- `audit.anchor(db)` и `verifyChain(db, {anchor})` — внешний якорь головы
  цепочки (ловит усечение хвоста).
### 0.1.36 — планировщик (B15, остаток)
- `registerJob(name, expr, handler, {timezone, catchUp})`; `getNextRun(expr,
  from, {timezone})` (IANA-зона, DST: несуществующее локальное время
  пропускается).
- `createScheduler({lockDir, lastRunStore})`: lock-файл на задачу между
  процессами (`scheduler.acquireFileLock`), нагон одного пропущенного
  запуска при `start()` (`scheduler.createDbLastRunStore`, таблица
  `scheduler_state`).
### 0.1.35 — SSE (C06, остаток)
- `createSseHandler({authorize, maxClientsPerKey, clientKey, getReplay})`;
  кадры теперь `id: N\ndata: …` (поддержка `Last-Event-ID`).
### 0.1.34 — коды выхода CLI (C09, остаток)
- `cli.EXIT = {OK:0, FAILURE:1, USAGE:2, CHECK_FAILED:3}`; конвенция в
  `cli/exit-codes.js`. Неизвестная команда и отказ без `--yes`/`--force`
  остаются 1 (так закреплено тестами).
### 0.1.33 — временный пароль админа (A16)
- `auth.writeBootstrapCredentials(file, {username, tempPassword})` (0600,
  `wx`); workshop пишет `first-run-admin.txt` рядом с БД вместо stdout;
  `DAS_BOOTSTRAP_PRINT=true` возвращает вывод в консоль.
### 0.1.32 — TOTP-секреты шифруются (A10)
- `auth/secret-box.js`: AES-256-GCM, ключ HKDF-SHA256, формат
  `enc:v1:iv:tag:ct`; `auth.sealSecret/openSecret/isSealed/
  sealExistingTotpSecrets`; опция `encryptionKey` у `startTotpEnrollment`,
  `verifyTotpEnrollment`, `verifyTotpLogin`. Workshop берёт ключ из
  `auth.sessionSecret` (смена секрета = повторная настройка TOTP).
### 0.1.31 — упаковка и логотип (волна 4a: D03, D06 ч., D09, D10 ч., C10)
- Ленивая загрузка argon2/sharp/qrcode/selfsigned (динамический import) и
  jsdom/dompurify (`createRequire`): barrel больше не требует нативных пакетов.
- Subpath exports на 17 модулей; метаданные `package.json` (license
  `UNLICENSED` — заглушка, выбор за владельцем), `peerDependenciesMeta`.
- В корне: `.nvmrc`, `.editorconfig`, `.gitattributes`, `.gitignore`
  (`*.zip`), `.dockerignore`, `Dockerfile`, `docker-compose.yml`,
  `.github/workflows/ci.yml` (ubuntu + windows). **Docker и CI не запускались.**
- Логотип: `logo.*` — для СВЕТЛОЙ страницы (тёмный знак), `logo-dark.*` —
  для ТЁМНОЙ (светлый знак); PNG ядра были перепутаны; новая вёрстка
  страницы ошибки (`.app-logo-wrap` 112px, `.badge-logo` 32px).
### 0.1.30 — CLI и конфиг (волна 3b: C09 ч., C07 ч.)
- `parseArgs(argv, {booleanFlags})`, `--`, `-h`, одиночный `-`; предупреждение
  о неизвестном флаге у команд с `flags`; `cli.command(..., {booleanFlags})`.
- Конфиг: строгие булевы env (иначе ошибка), `<NAME>_FILE` для секретов,
  `DAS_HTTPS_MODE`, `DAS_LOG_LEVEL`, поле `logLevel`, `config/secrets.js`
  (`isPlaceholderSecret`); production отказывается стартовать с заглушкой секрета.
### 0.1.29 — эксплуатация (волна 3a: C01–C04, C06 ч., C08, A07)
- `core/logs`: `createLogger` (JSON-строки, уровни, редакция), `accessLog`.
- `errorPageHandler(vendor, {logger})` (headersSent, валидный статус, JSON/HTML,
  5xx логируются); `registerFatalHandlers`; `registerGracefulShutdown` →
  `{shutdown, isShuttingDown}`; `realtime.closeAllSseStreams`,
  `createSseHandler({maxClients, maxBufferedBytes})`;
  `healthHandler(db, {version, isShuttingDown, minimal})`.
- TOTP: защита от повторного использования шага (`matchTotpStep`,
  `totp_credentials.last_used_step`).
### 0.1.28 — аудит-лог и cron (волна 2c: B14 ч., B15 ч.)
- Хеш-цепочка `prev_hash/hash`, триггер запрета UPDATE, `audit.verifyChain`,
  `redactMeta`, `purgeOlderThan(db, iso, {record, actor})`, `audit.purge`.
- Cron: строгий разбор, шаг ≥ 1, 7 = воскресенье, таймер ≤ 24 ч,
  `scheduler.stop()` возвращает промис.
### 0.1.27 — загрузки и FTS (волна 2b: B08, B10, B11 ч., B12 ч., B13 ч.)
- `files.acceptUpload/removeUpload`, атомарная запись, `limitInputPixels`;
  `database.ftsEscape/normalizeLimit/assertSafeIdentifier`;
  `index.escapeQuery/rebuild`.
### 0.1.26 — данные (волна 2a: B01–B07)
- Бэкап через `VACUUM INTO` + `integrity_check` + rename; изоляция
  destination, `minKeep`; restore со staging и автооткатом; миграции с
  checksum и IMMEDIATE-транзакцией; `transaction()` с savepoint;
  `busy_timeout`/`synchronous`.

## [0.1.25]
### Fixed (аудит, волна 1 — безопасность и реальный HTTP)
Первая из четырёх волн `docs/audit-findings.md`. Закрыто или частично
закрыто: A01, A02, A03, A04, A05 (частично), A06, A08, A09, A14, A17,
A18, C02 (частично), C05, D01 (частично).
- **A01 CSP**: `script-src 'self' 'nonce-…'` с nonce на каждый запрос
  (`res.locals.cspNonce`); шаблоны ставят nonce только на свои
  `<script>`, HTML не переписывается. Inline-скрипты workshop снова
  работают. Плюс `object-src 'none'`, `base-uri`, `form-action`,
  `frame-ancestors`, Permissions-Policy, COOP/CORP, HSTS только по HTTPS (A18).
- **A02/A09 перебор**: per-IP лимит на логин, экспоненциальная блокировка
  по введённому логину (`security.lockout`), `429` + `Retry-After`;
  ключ — введённое имя в нижнем регистре, поэтому блокировка не выдаёт,
  существует ли пользователь. Время ответа выровнено для несуществующего
  логина. Ограничение: состояние в памяти процесса.
- **A03 CSRF**: `http.csrfProtection()` без токенов — Origin /
  Sec-Fetch-Site / Referer, для запросов без куки запасной вариант;
  включается `security.csrf`.
- **A04/C05 сервер**: `http/server.js` — `host`, `https.mode`
  (standalone / self-signed / reverse-proxy), `trustProxy` (1 hop),
  `requestTimeoutMs`, `bodyLimit` теперь реально применяются;
  `reverse-proxy` без `trustProxy` отказывается стартовать; cookie
  `Secure` по режиму. Workshop по умолчанию слушает HTTPS с
  самоподписанным сертификатом.
- **A05/A06/A08**: сессии отзываются при смене пароля/disable;
  `mustChangePassword` принуждается; TOTP-enrollment привязан к своему
  пользователю.
- **A14/A17**: экранирование имени пользователя; `X-Request-Id`
  принимается только в безопасной форме.
- **C02**: код выхода отражает ошибки `onShutdown`; хук `onDrainStart`.
- **D01**: `createApp(ctx)` вынесен из `server.js`; новый
  `examples/workshop/test/server.smoke.test.js` поднимает настоящий
  Express на эфемерном порту.
### Честно про проверку
- **Прогнано вживую в песочнице** (Node 22, без сети; реальный код
  проекта поверх заглушек): сокеты и TLS новых модулей, поведение
  SQLite, `routes.test.js` 71/71, ряд core-наборов, проверка мутациями,
  что тесты не пустые.
- **Не запускалось** (нужен ваш `npm test`): `server.smoke.test.js`
  целиком (нужны реальные Express 5, argon2, zod v4, vitest),
  генерация самоподписанного сертификата через `selfsigned` v5.
  Если smoke-тест упадёт — это находка, пришлите вывод.

## [0.1.24]
### Added (аудит ядра перед Stage F — `docs/audit-findings.md`)
По вашей просьбе портирование отложено, проведён многостадийный аудит
(A безопасность/auth, B данные/надёжность, C runtime/операции,
D контракты/тесты/репозиторий/готовность к портированию). Код ядра **не
менялся** — результат это новый файл `docs/audit-findings.md`: 58
находок (1 critical, 19 high, 27 medium, 10 low, 1 info), у каждой
файл:строка, влияние, предложение исправления и пометка, перепроверена
ли находка мной после отчёта аудитора (`✔`) или найдена только чтением
(`○`). Файл также содержит рекомендуемый порядок доработки в 4 волны и
список ещё не аудированных зон (стадии E–J).
Самые важные находки: бэкап копирует живую WAL-базу через
`copyFileSync` (B01, critical); CSRF/rate-limit/HTTPS/trust proxy/лимит
тела существуют только как поля конфига и не подключены (A02–A04, C05);
CSP ломает inline-скрипты всех страниц workshop (A01); единственные
HTTP-тесты работают на фейковом Express (D01).
**Честно про проверку**: ничего не запускалось; находки — результат
чтения кода, поведение Node/SQLite/браузера помечено как гипотеза.

## [0.1.23]
### Decided (Drizzle / мульти-БД абстракция — §17.1)
Пересмотр решения из §17 перед стартом Workshop Stage F. В песочнице
по-прежнему нет сети, так что фактический номер текущей stable-версии
`drizzle-orm` на npmjs.com здесь надёжно не проверить — веб-поиск этой
сессии дал противоречивые ответы (один источник: "стабильный 1.0 вышел
в середине 2025"; другой, со статической страницы релизов Drizzle:
только `1.0.0-beta.2`). Раздувать архитектурное решение по непроверенному
номеру версии — тот же риск, что уже раз подвёл с `vitest`/`node:sqlite`
(§13–§15).

**Решение**: `drizzle-orm` в зависимости `@das-forge/core` не
добавляется — ни сейчас, ни в рамках этого решения вообще, независимо
от того, вышел ли уже стабильный 1.0. Причина не в версии пакета, а в
том, что `DatabaseAdapter` (`packages/core/src/database/adapter.js`) —
duck-typing контракт на 8 методов, уже сегодня не завязанный на SQLite
API, и он без единого изменения допускает Drizzle-backed
Postgres-адаптер как отдельный опциональный пакет (по аналогии с
`@das-forge/email`, §4.5e), когда это реально понадобится одному из 4
приложений. Workshop Stage F стартует на чистом `node:sqlite`-адаптере.
Подробности — `docs/roadmap.md` §17.1.

## [0.1.22]
### Fixed (второй настоящий `npm test` — гонка в тестовом харнессе)
После 0.1.21 (`sessionMiddleware`-фикс) пользователь прогнал тесты
второй раз: `packages/core` — по-прежнему 277/279 зелёных,
`routes.test.js` — с 27 провалов до **2**. Оба разобраны — ни один не
в `routes.js`.

**Баг №1 — гонка в `dispatch()`, не в проде**: `generates a usable set,
and a step-up login can consume one` падал с `Cannot read properties of
undefined (reading 'codes')` — `res.body` целиком оставался
`undefined`, хотя `/recovery-codes/generate`'s handler точно
отрабатывал. Корень: реальные middleware ядра
(`session-middleware.js`'s `sessionMiddleware`/`requireAuth`,
`validation-middleware.js`'s `validateBody`) вызывают `next()`
обычным statement'ом, Express-стиль, никогда не `return next()`.
Прежняя версия `dispatch()` ждала завершения цепочки, **await**'я
возвращаемое значение КАЖДОГО handler'а — для синхронного middleware
это даёт `undefined` сразу же, как только он синхронно вызвал `next()`
и вернулся, НЕ дожидаясь того, что `next()` в это время успел
асинхронно запустить дальше по цепочке. Пока терминальный handler был
либо синхронным, либо async-но-без-реального-ожидания (как SHA-256
стенд-ин `verifyPassword` в этом же файле), гонка не проявлялась —
обе "цепочки" успевали завершиться в один и тот же микротаск-тик.
`auth.generateRecoveryCodes()` делает 8 РЕАЛЬНЫХ вызовов argon2-хэша —
настоящие обращения к пулу потоков libuv, не микротаски — и
"официальная" awaited-цепочка в `dispatch()` стабильно завершалась
(резолвясь в `undefined`) РАНЬШЕ, чем реальная работа успевала дойти
до `res.json()`.

Исправление: `dispatch()` больше не доверяет промис-цепочке `next()`
как сигналу завершения. Теперь `res.json()`/`res.send()` сами
резолвят отдельный промис `finished` (так же, как настоящий HTTP-ответ
сигнализирует "готово" — Express тоже не ждёт промисов из middleware,
он следит за объектом ответа), и `dispatch()` ждёт именно его. Ошибка,
брошенная где-то в цепочке, по-прежнему долетает — перехватывается на
ближайшем уровне `next()` и реджектит тот же `finished`, так что
сломанный handler роняет тест с понятной ошибкой, а не вешает его
навечно.

**Баг №2 — настоящий баг, но в самом тесте, не в `routes.js` или
ядре**: `a write on another resource (asset create) is recorded too`
падал на `expect(entry).toBeTruthy()`. Причина — `core/audit`'s
`entity_id` колонка в БД типа `TEXT` (`log.js` хранит её как
`String(entityId)`, намеренно — entity id может быть и UUID, не только
числом), так что `mapper.js`'s `rowToEntry()` всегда возвращает
`entityId` строкой. Тест сравнивал `e.entityId === created.res.body.id`
строгим `===` со ЧИСЛОМ (реальный `id` ассета из SQLite) — строка
никогда не равна числу по `===`. Поведение `core/audit` корректно и
намеренно; поправлен сам тест — сравнение теперь через
`String(created.res.body.id)`.

**Честно про проверку**: обе гонки/баги прогнаны и подтверждены здесь
напрямую вживую — отдельный скрипт воспроизвёл СТАРУЮ версию
`dispatch()` (синхронные middleware, вызывающие `next()` statement'ом,
перед медленным async-терминальным handler'ом с реальной
`setTimeout`-задержкой, эмулирующей обращение к пулу потоков) и
показал тот же `res.body === undefined`; та же сцена против НОВОЙ
версии `dispatch()` — `res.body` корректно заполнен, ошибка из
handler'а по-прежнему долетает до `dispatch()`'s `catch`. Отдельно
прогнаны (ещё раз, против новой механики `dispatch()`) все 4
сценария `sessionMiddleware`/`requireAuth`/`requirePermission` из
0.1.21 — все по-прежнему верны, включая медленный async-терминальный
handler за `requireAuth()`. Сам барреля-импорт `@das-forge/core`
по-прежнему блокирует прогон `routes.test.js` целиком здесь — третий
`npm test` пользователя остаётся единственным полным подтверждением
48/48.

## [0.1.21]
### Fixed (первый настоящий `npm test` по `examples/workshop/test/routes.test.js`)
Пользователь впервые реально прогнал `examples/workshop`'s тесты
(Windows, все зависимости установлены, включая argon2) — до этого
момента весь Stage B–E тестировался в песочнице только построчной
сверкой кода, этот файл целиком ни разу не выполнялся. Результат:
`packages/core` — 277/279 (зелено, 2 skip — ожидаемо), но
`routes.test.js` — **27 из 37 упали**, каждый раз `401` там, где
ожидался другой код.

**Корень один на все 27**: это баг тестового харнесса, не `routes.js`.
В реальном приложении `server.js` монтирует
`http.sessionMiddleware({authProvider})` **глобально**, перед любым
роутом — это единственное место, где вообще выставляется `req.user`
(см. собственный doc-comment `session-middleware.js`). Фейковый `app`
в `test/routes.test.js` (`createFakeApp()`) эмулировал только
middleware-цепочку КОНКРЕТНОГО роута (`app.get(path, requireAuth(),
handler)`), но никогда не прогонял то, что в реальности монтируется
один раз глобально — так что `req.user` оставался `undefined`
ВСЕГДА, и `requireAuth()` закономерно возвращал 401 независимо от
того, был ли в куках реально валидный сессионный cookie. Этим же
объясняются и косвенные провалы вида `TypeError: Cannot read
properties of undefined (reading 'toUpperCase')` в
`enrollTotpFor()`-хелпере — `/totp/enroll/start` тоже требует
`requireAuth()`, так что `start.res.body.secret` был `undefined` (тело
401-ответа), а не настоящим секретом.

**Исправление**:
- `createFakeApp()` получил настоящий `app.use()` — middlewares из
  него `dispatch()` теперь прогоняет ПЕРЕД цепочкой конкретного роута,
  в том же порядке монтирования, что и у Express/`server.js`
- `makeFakeAuthProvider()` получил реальный `verifySession: (id) =>
  auth.verifySession(db, id)` — чистая `node:sqlite`-логика, argon2 не
  нужен, стенд-ин не требуется
- Оба места, создающие харнесс (основной `beforeEach` и отдельный
  harness для "Demo Records (Stage C) — finance-gated cost"), теперь
  вызывают `harness.app.use(http.sessionMiddleware({authProvider}))`
  перед `registerRoutes()`

**Честно про проверку**: сам барреля-импорт `@das-forge/core`
по-прежнему блокирует прогон `routes.test.js` целиком в этой
песочнице — но механика фикса (цепочка `app.use()` + `sessionMiddleware`
+ `requireAuth`/`requirePermission`) прогнана здесь напрямую вживую:
реальный `session-middleware.js` (без стенд-инов, он ни от чего не
зависит) + zod-free стенд-ин `createSession`/`verifySession`,
подтверждающий, что тот же код `auth/sessions.js` делает, против
настоящего `node:sqlite` — валидная сессия даёт `200` с заполненным
`req.user`, отсутствие cookie — `401`, нехватка permission — `403`,
pending-сессия (без `user` в `data`) по-прежнему блокируется
`requireAuth()` — `401`. Следующий `npm test` пользователя —
единственное полное подтверждение, что оставшиеся 27 тестов теперь
зелёные.

## [0.1.20]
### Added (Workshop Stage E — System & Maintenance + Realtime Lab)
Закрывает последний пункт roadmap-а перед Stage F. Два независимых
куска функциональности в одной версии, оба — тонкая HTTP/UI-обвязка
над уже существующими core-модулями (ничего нового в самом ядре):

**System & Maintenance** — `core/scheduler`, `core/health`,
`core/cli`'s `migrationStatus()` уже умели всё нужное (CLI это
доказывает с 0.1.3/0.1.9); не было только HTTP/UI-поверхности:
- **`routes.js`**: `GET /system/status` (`requireAuth`+
  `requirePermission('admin:write')`, тот же порог, что у `/audit` и
  `/admin/users`) — одним ответом health + статус миграций + список
  бэкапов + retentionDays, чтобы страница делала один round-trip, а
  не три. `POST /system/backup/run` вызывает тот же `runBackupJob`,
  что и планировщик/CLI (`backup run`) — одна реализация, третий
  способ её вызвать. `POST /system/backup/verify` — **НЕ** принимает
  произвольный путь от клиента: сверяется со списком из
  `scheduler.listBackups()`, снятым в тот же момент, и 404 на всё,
  чего там нет — `verifyBackupFile()` открывает свой аргумент как
  sqlite-базу, открывать так что попало по запросу клиента нельзя (тот
  же принцип, что у `files.js`'s upload-путей, которые тоже никогда не
  берутся из клиентского ввода напрямую)
- **`backup restore` сознательно НЕ выведен в UI** — он перезаписывает
  живую БД; в CLI он и так требует явного `--yes`, в вебе это не
  должно быть одной кнопкой. Явное решение, не пропуск — отмечено и в
  коде, и на самой странице
- **`GET /ui/system`**: health/миграции/бэкапы read-only + кнопка "Run
  backup now" + кнопка "Verify" на каждой строке таблицы бэкапов,
  обе — `fetch()` к роутам выше
- Каждое действие (`backup_run`, `backup_verify`) идёт через
  `logAudit()` (Stage D, 0.1.19) — Stage E не исключение из общего
  правила

**Realtime Lab** — второй, отдельный от `assets` SSE-канал (`lab`) на
том же `core/realtime` event bus, чтобы попробовать pub/sub
интерактивно, не завязываясь на Demo Records:
- `POST /events/lab/broadcast` (`requireAuth`, БЕЗ admin-гейта — общая
  песочница, не чувствительная поверхность) — `message` (1–500
  символов, Zod), `from` всегда из `req.user.username` (никогда от
  клиента)
- `GET /events/lab` — та же `realtime.createSseHandler()`, что и
  `/events/assets`, просто другой канал
- `GET /ui/realtime` — форма отправки + `EventSource` на `/events/lab`,
  живой лог; открыть в двух вкладках — сообщение из одной появляется в
  обеих

**Тесты** (`test/routes.test.js`) — 13 новых, с акцентом на негативные
сценарии (явное требование этой задачи, не только "happy path"):
System & Maintenance — 401/403 на `/system/status` и
`/system/backup/run` (и подтверждение, что 403 реально НЕ вызывает
бэкап-job), успешный `backup/run` + его же запись в audit-трейле,
`backup/verify` с путём не из списка известных бэкапов → 404 (не
попытка открыть файл), `backup/verify` с пустым `file` → 400
VALIDATION_ERROR. Realtime Lab — 401 без сессии, 400 на пустое/>500-
символьное сообщение, успешная отправка ЛЮБЫМ аутентифицированным
пользователем (не только admin) с проверкой, что событие реально дошло
до event bus на канале `lab` с `from`, равным сессионному username, а
не тому, что клиент мог бы попытаться подставить.

**Честно про проверку**: `renderSystemBody()`/`renderRealtimeBody()`
(как весь `pages.js`) не зависят от `@das-forge/core` — прогнаны
здесь напрямую вживую: XSS-экранирование вредоносных имени миграции и
пути бэкапа, рендер неподдерживаемого типа destination, классы
`ok`/`warn`, единственное/множественное число у "day/days", пустые
состояния для миграций и бэкапов. Роуты и тесты сверены построчно с
реальными сигнатурами `core/scheduler`
(`listBackups`/`verifyBackupFile`), `core/health`'s `checkHealth()`,
`core/cli`'s `migrationStatus()`, `core/realtime`'s
`createSseHandler()`/event bus `publish()` — но не прогнаны через
реальный HTTP-слой или настоящий `node:sqlite`-харнесс здесь, барреля-
импорт `@das-forge/core` блокирует это в песочнице, как и весь
остальной Stage B–E. `npm test` пользователя — единственное полное
подтверждение.

Workshop Stage A–E теперь закрыты. Следующее — Stage F (IT Assets →
`apps/`).

## [0.1.19]
### Added (Workshop Stage D — Audit & Activity)
`core/audit` существовал с 0.1.1, но ни один роут `examples/workshop`
его не вызывал — страница активности не могла бы показать ничего,
потому что ничего не писалось. Это и было содержанием задачи, не
только страница:
- **`routes.js`**: новый `logAudit(req, {...})` — тонкая обёртка над
  `audit.log()`, достаёт `req.id`/`req.ip` автоматически, глотает
  собственные ошибки (запись аудита не должна валить запрос, который
  пыталась залогировать — тот же принцип, что в `core/audit`'s
  `log.js`). Вызывается на каждой значимой точке: `/login` (успех,
  неверный пароль, неизвестный пользователь, отключённый аккаунт,
  pending-MFA отдельным action'ом), `/login/totp`, `/login/recovery`
  (оба — успех/неудача), `/logout`, `/password/change` (успех/неудача),
  `/totp/enroll/verify`, `/totp/authenticators/:id/remove`,
  `/recovery-codes/generate`, все мутации `/assets*` (create/update/
  delete/cost/logo)
- **`GET /audit`** (`requireAuth` + `requirePermission('admin:write')`
  — тот же порог, что у `/admin/users`: журнал аудита сам по себе
  чувствительные данные, не казуальное чтение): фильтры
  actor/action/entity/entityId/result/since/until, все опциональны и
  идут напрямую в `audit.query()`/`audit.count()` — routes.js не
  содержит собственной фильтрующей логики
- **`GET /ui/audit`**: server-rendered таблица (`pages.js`'s новая
  `renderAuditBody()`) с формой-фильтром (plain `<form method="get">`
  — страница работает и без JS, в отличие от форм account-страницы,
  которым fetch() нужен по сути их мутирующих действий). Ссылка на неё
  в `/ui` показывается только администраторам (`permissions.includes
  ('admin:write')`) — тот же "скрыто в UI И заблокировано на роуте"
  принцип, что у finance-поля Stage C
- **`test/routes.test.js`**: 7 новых тестов — 401 без сессии, 403 не-
  admin, успешный логин реально виден админу через `GET /audit`,
  неудачный логин записан как `failure` с попыткой username в actor
  (включая логин несуществующего пользователя), запись на ДРУГОМ
  ресурсе (`asset.create`) тоже попадает в журнал (не только auth-
  события), фильтр по action не цепляет соседние action'ы
  (`auth.login` ≠ `auth.login.pending`)

**Проверено вживую**: `renderAuditBody()` (как и весь `pages.js`) не
зависит от `@das-forge/core` — прогнано здесь напрямую
(`node --input-type=module -e`): HTML-экранирование подтверждено на
вредоносном `actor` со вставленным `<script>`, классы `audit-ok`/
`audit-fail` на правильных строках, пустое состояние, fallback
"(system)" для `actor: null`. Остальное (роуты, `logAudit()`,
`audit.query()`'s реальная фильтрация) сверено построчно с кодом
`core/audit`, но не прогнано через реальный HTTP-слой — тот же
барреля-импорт блокирует это здесь, что и весь остальной Stage B/C/D.
`npm test` пользователя — единственное подтверждение целиком.

## [0.1.18]
### Added
По вопросу "а ты аналог man для cli в итоге сделал?" — нет, не делал;
это был открытый пункт в `docs/roadmap.md`'s backlog ("CLI help в духе
`man`"). Сделано сейчас, механизм целиком:
- **`packages/core/src/cli/cli.js`**: `command(path, opts)` принимает
  необязательные `usage`/`flags`/`examples` в дополнение к
  `description` (обратная совместимость — старые вызовы без этих
  полей продолжают работать как раньше). Новая `printCommandHelp(path)`
  — развёрнутая карточка по одной команде (описание, `Usage:`,
  `Flags:`, `Examples:`), с честной заглушкой, если поля не заполнены,
  вместо того чтобы либо падать, либо молча показывать общий список
- Два входа в help по одной команде: `app help <command...>` (новое) и
  `app <command> --help`/`-h` (раньше любой `--help` ВСЕГДА показывал
  общий список, даже после реального пути команды — это и была дыра:
  `if (positionals.length === 0 || flags.help || flags.h)` проверялся
  ДО попытки матчинга команды, так что `app migrate --help` не имел
  способа отличаться от просто `app --help`)
- Попутно поправлен код выхода: `app --help` без команды теперь
  возвращает `0` (это осознанный запрос помощи), а не `1`, как раньше
  — голый `app` без аргументов по-прежнему `1` (ошибка использования).
  Другого поведения это не затрагивает (`run([])` в существующих
  тестах `cli.test.js` по-прежнему `1`, проверено)
- Матчинг «самого длинного префикса» работает и для help: `app migrate
  --help` показывает справку именно по `migrate`, не по `migrate
  status`, даже когда обе команды зарегистрированы
- `usage`/`flags`/`examples` заполнены для `migrate`, `migrate status`
  и всех пяти `user *` команд (`create-admin`, `reset-password`,
  `authenticators`, `authenticators-remove`, `recovery-codes`) — как
  демонстрация механизма на реальных командах, не только в тесте.
  **Осознанно не доделано**: оставшиеся ~18 команд (см. Unreleased
  выше) — заполнение это чисто текстовая работа без архитектурных
  решений, корректно оставить на потом, не блокировать сам механизм
- `packages/core/test/cli.test.js`: 7 новых тестов на help-механизм —
  `help <command>` не запускает handler, `<command> --help` ведёт туда
  же, пустая справка честно помечена, матчинг длинного префикса для
  help, `help` без команды = общий список (код 0), неизвестная команда
  в `help` обрабатывается так же, как при обычном вызове, код выхода
  `--help` без команды (0) отличается от голого вызова (1)

**Проверено вживую** (не просто `node --check`): `cli.js` не тянет
zod/argon2/sharp ни напрямую, ни транзитивно (сам модуль работает на
чистом JS без зависимостей) — весь help-механизм реально прогнан
здесь, в этой песочнице, через `node --input-type=module -e`: все 7
сценариев из теста плюс отдельно `registerMigrateCommands()` и
`registerUserCommands()` с их реальным кодом (не стендом) — вывод
проверен построчно, не предположен. Это первый модуль в Stage B/C
работе этой сессии, который не попадает под обычное "барреля-импорт
блокирует живую проверку" ограничение.

## [0.1.17]
### Added (Workshop Stage C, доведено до конца)
- **`examples/workshop/src/context.js`**: `buildContext()` теперь
  возвращает `uploadsDir` (рядом с `certDir`, та же "вывести из
  `database.file`" логика) и `migrationsDir` (была локальной константой
  в `bin/app.js`, теперь одна точка истины для HTTP-сервера и CLI)
- **`server.js`**: migrate-on-boot — `cliModule.runMigrations(db,
  migrationsDir)` перед `registerRoutes()`, идемпотентно (уже
  применённые миграции пропускаются самим раннером), плюс
  `seedAssetsIfEmpty(db)`. Свежая БД теперь работоспособна сразу после
  `npm start`, без обязательного ручного `migrate` — он остаётся
  доступным отдельно для тех, кто хочет прогнать миграции отдельно от
  запуска сервера. `uploadsDir` прокинут в `registerRoutes()`
- **`bin/app.js`**: `MIGRATIONS_DIR`-константа убрана, везде заменена
  на `ctx.migrationsDir` — миграции больше не вычисляются в двух
  разных местах с риском разойтись
- **`test/routes.test.js`**: полный блок негативных сценариев для
  Stage C — 401 без сессии на каждом `/assets*` роуте, 404 на
  несуществующем id (get/update/delete/cost), 400 на невалидном
  create/cost, create игнорирует подсунутый `cost` в теле (схема его
  не принимает), delete только для admin (403 у operator, реально
  удаляет у admin), и отдельный харнесс с НАСТОЯЩИМ `moduleRegistry` +
  `reporting-module.js` (не `moduleRegistry: null`, как в остальном
  файле) — проверяет, что `cost` реально вырезается из ответа без
  `read:finance` и что запись `cost` без этого права получает 403, не
  молчаливый игнор. Апгрейд `createFakeApp()`: добавлены `patch`/
  `delete` (раньше были только `get`/`post`)
- Общий `beforeEach` файла тоже обновлён: `assets`-таблица (в отличие
  от `users`, которую `core/auth` создаёт лениво сама) без явного
  `up(002_assets.js)` не существует — без этого фикса уже
  существовавший тест "the existing field-permission scenario" упал бы
  на первом же `npm test` пользователя

### Docs
- `examples/workshop/README.md` — Stage B помечен полностью закрытым
  (включая UI и QR из 0.1.13/0.1.14), добавлен раздел Stage C, порядок
  команд в quickstart приведён в соответствие с migrate-on-boot

**Честно про проверку**: как и весь остальной HTTP-слой Stage B/C,
`test/routes.test.js` синтаксически корректен (`node --check` прошёл)
и логика сверена построчно с реальным кодом (`serialize()`'s field-
stripping, `requirePermission()`'s 403/`FORBIDDEN`, `validateBody()`'s
400/`VALIDATION_ERROR`, `CreateAssetSchema`/`SetCostSchema` — все
прочитаны заново из текущих файлов, не по памяти), но не прогнан —
барреля-импорт `@das-forge/core` тянет весь граф зависимостей разом.
`npm test` пользователя — единственное реальное подтверждение.

## [0.1.16] 
### Docs
По запросу "че там по переводу? вынеси в доку это тоже" — третий
справочник того же вида, что CLI-команды (0.1.11) и структура
репозитория (0.1.15):
- **README.md**: раздел "Переводы / i18n — полный справочник" — что
  реально готово (`core/modules`'s `translations`-схема в Module-
  контракте, `registry.getTranslations()` со слиянием и детекцией
  конфликтов ключей, `core/ui`'s `shell.js` inline `t()` и
  автономный `translate()`), и что в явном backlog и НЕ начато:
  билингвальные error-страницы (404/500 сейчас захардкожены на
  русском, i18n-реестр не используют вовсе), полный каталог
  error-страниц под остальные статус-коды, переключалка EN/RU в
  `docs/index.html`
- **docs/index.html**: новая секция `#i18n` в той же форме (таблица +
  `pill done`/`pill open`), добавлен якорь в навигацию
- Честно разграничено: "готово" — только те 4 пункта, которые
  реально используются кодом прямо сейчас; остальные 3 — не
  "частично", а не начаты вовсе, несмотря на то что инфраструктура
  (Module.translations) технически уже могла бы их обслуживать

Чисто документационный патч, кода не менял.

## [0.1.15] 
### Docs
По просьбе пользователя: "вот так как мы сделали с командами,
переработай раздел со структурой папок и тоже его будем вести" — то же
обращение, что получил справочник CLI-команд (0.1.11), теперь и у
структуры репозитория:
- **README.md**: новый раздел "Структура репозитория — полный
  справочник" — верхнеуровневое дерево + две построчные таблицы
  (`packages/core/src/*` — 15 модулей, `examples/workshop/src/*` — 6
  файлов) со статусом ✅/⚠️/∅ и примечанием, что именно не покрыто,
  где статус не полный (`realtime/` — только SSE, `health/` — CLI-
  обёртка частично)
- **docs/index.html**: `#packages` переписан в ту же форму (таблицы +
  `pill done`/`pill next`), заменяет полностью устаревший `<pre>` с
  деревом пятилетней давности (там были только 5 модулей вместо 15,
  отсутствовали `examples/workshop/src/*` целиком)
- **docs/roadmap.md §0.1**: сокращён до верхнеуровневой карты +
  указания, что README/index.html — источник истины для построчного
  состояния; не дублирует одну и ту же таблицу в третьем месте, чтобы
  три копии не расходились при каждом патче
- Правило на будущее: справочник обновляется, а не переписывается —
  тем же способом, что уже действует для CLI-таблицы и CHANGELOG

Чисто документационный патч, кода не менял — `node --check` не
применим, проверена структурная целостность HTML (`<section>`/`</section>`
совпадают по количеству) и markdown-таблиц.

## [0.1.14] 
### Added
Настоящий QR-кодек — явный разворот решения из 0.1.13 по прямому
запросу пользователя ("конечно же добавляем зависимости и делаем по
человечески — QR коды нужны IT Assets для инвентаризации, так что их
в любом случае придётся добавлять"):
- **Новая зависимость `packages/core`**: `qrcode@^1.5.4`
  (soldair/node-qrcode) — проверено по реальному README пакета и
  npm-registry (`registry.npmjs.org/qrcode/latest` → `1.5.4`) перед
  тем, как фиксировать версию, тем же способом, что поймал реальный
  баг с `selfsigned` в 0.1.10. Выбран, а не альтернативы, потому что
  серверный `QRCode.toString(text, {type:'svg'})` не тянет за собой
  canvas/sharp/jsdom — чистый SVG из строки.
- **`packages/core/src/qr/index.js`** (новый модуль, экспортирован в
  барреле как `qr`): `generateQrSvg(text, options)` — тонкая обёртка,
  возвращает Promise со строкой `<svg>...</svg>`. Namespace, не
  raster — SVG не зависит от разрешения (годится и для панели в
  браузере, и для печатной инвентарной этикетки), и не тянет лишних
  бинарных зависимостей. Нужен растр — `core/files` уже зависит от
  `sharp`, им можно самостоятельно рендернуть этот SVG в PNG.
- **`examples/workshop/src/routes.js`**: `POST /totp/enroll/qr.svg`
  (`requireAuth`, принимает `{otpauthUri}` в теле — POST, а не GET,
  потому что URI несёт секрет регистрации открытым текстом, и в query
  string он осел бы в логах доступа/Referer) и `GET
  /assets/:id/qr.svg` (`requireAuth`, отдаёт `image/svg+xml` напрямую
  — для `<img src>` или печати этикетки; кодирует путь `/assets/:id`,
  без секретов, поэтому GET уместен).
- **`examples/workshop/src/pages.js`**: TOTP enrollment panel теперь
  реально рендерит QR (inline `<svg>` через `innerHTML` после фетча
  `/totp/enroll/qr.svg`) — ручной ввод `otpauth://` URI и секрета
  остаётся как текст под картинкой, настоящий резерв для
  authenticator-приложения без камеры, а не "QR не загрузился".
- **`packages/core/test/qr.test.js`** (новый) — покрывает пустой/не-
  строковый вход, рендер для обычной строки, для `otpauth://` URI,
  кастомный `errorCorrectionLevel`.

**Честно про проверку**: пакет `qrcode` физически не установить в
этой песочнице (нет доступа к npm-registry — подтверждено отдельной
попыткой `npm install` в `/tmp`, не только barrel-импортом ядра), так
что ни `core/qr`, ни новые роуты QR не прогнаны вживую здесь. API
пакета (`toString(text, {type:'svg'}, cb)`, опции
`errorCorrectionLevel`/`margin`/`color`) сверен с его README и
npm-registry через веб-поиск/фетч, а не взят по памяти. Всё, что
написано, прошло `node --check`. Полная проверка — на `npm install &&
npm test`/`npm start` у пользователя.

## [0.1.13]
### Added (examples/workshop, не packages/core/src)
Stage B's interactive UI — закрывает единственный явно отложенный
пункт из 0.1.12 ("API-слой готов, UI отложен"):
- `examples/workshop/src/pages.js` — новый файл, server-rendered
  HTML-страницы без клиентского фреймворка и без сборки (то же
  "минимально реальное, не аспирационное" решение, что и
  `core/ui`'s `renderAppShell()`): `renderLoginPage()` (двухшаговая
  форма логина — пароль, затем TOTP/recovery-код, если сервер ответил
  `mfaRequired`) и `renderAccountBody()` (смена пароля, список/enroll/
  remove аутентификаторов, генерация recovery-кодов)
- Новые роуты в `routes.js`: `GET /login` (публичная страница, форма
  бьёт в уже существующие `/login`/`/login/totp`/`/login/recovery`
  JSON-эндпоинты) и `GET /ui/account` (`requireAuth()`, рендерит
  `renderAccountBody()` внутри `core/ui`'s `renderAppShell()`)
- **Сознательно НЕ рендерит QR-картинку** — для этого нужен QR-кодек,
  а ни `qrcode`, ни `jsqr` не входят в зависимости ни core, ни этого
  примера (оба в списке "известны, не используются", §0.2 roadmap).
  Вместо картинки показывается `otpauth://` URI и сырой секрет как
  выделяемый текст — "manual entry", которую принимает любое TOTP-
  приложение (Google/Microsoft Authenticator, Authy, ...), не
  deграded-замена, а полноценная альтернативная форма того же самого
  ввода. Добавление реального QR — осознанное решение о новой
  зависимости, не тихий побочный эффект UI-страницы
- Живо проверено (без сети, `pages.js` не тянет `@das-forge/core`
  вообще — чистые строковые функции): HTML-экранирование имени
  пользователя, условный рендер remove-кнопки только для `active`
  аутентификаторов, и подсказка про `mfaRequired` для роли

## [0.1.12]
### Docs
- Полный справочник всех 25 CLI-команд с галочками по покрытию тестом
  (README.md, docs/index.html#cli) — каждая команда сверена напрямую с
  `src/cli/commands/*.js` (не по памяти): путь, описание, флаги,
  статус. `health`/`doctor` помечены отдельно (⚠️ partial) — их движок
  (`checkHealth()`/`runDoctor()`) покрыт тестом, а сама
  зарегистрированная CLI-обёртка нет. Явно отмечено, что
  `backup destinations` не реализовано и почему

### Added (examples/workshop, не packages/core/src)
Stage B (Users & Access, §0.3 плана) — полный цикл логина с MFA-step-up
в `examples/workshop/src/routes.js`, поверх уже существующих
`core/auth` TOTP/recovery-code примитивов (ничего нового в core не
понадобилось - само Stage B и есть доказательство, что core уже
достаточен):
- `/login` → при наличии активного TOTP-фактора выдаёт короткоживущую
  (5 мин) "pending"-сессию вместо полной — `session.data` без ключа
  `user`, поэтому `req.user` не выставляется и `requireAuth()`
  блокирует её на любом обычном роуте автоматически, без отдельной
  проверки "это pending-сессия?" на каждом роуте
- `/login/totp`, `/login/recovery` — достраивают step-up верным
  TOTP- или recovery-кодом; неверный код НЕ сжигает pending-сессию
  (разрешён повтор в пределах TTL), успех всегда выдаёт
  НОВЫЙ id сессии (анти-fixation, не промоция pending)
- `/password/change` — требует текущий пароль, не только живую сессию
- `/totp/enroll/{start,verify}`, `/totp/authenticators`,
  `/totp/authenticators/:id/remove` — политика `mfaRequired`
  (app-уровня решение, как и предполагает `removeAuthenticator()`'s
  контракт в core): admin не может удалить последний фактор,
  operator — может
- `/recovery-codes/{generate,remaining}`
- `/admin/users` — ролевое ограничение проверено на реальном
  HTTP-уровне через `requirePermission('admin:write')`, не только
  спрятано в UI
- `examples/workshop/test/routes.test.js` — новый тестовый файл,
  полный цикл через `registerRoutes()` с фейковым Express-harness
  (мидлвар-цепочка: validateBody→requireAuth→requirePermission→handler,
  как в core's собственных http-тестах) и фейковым
  SHA-256-based authProvider (argon2 недоступен в песочнице)

**Честно про проверку**: `test/routes.test.js` существует и
синтаксически корректен, но НЕ был реально прогнан в этой сессии -
импорт `@das-forge/core`'s барреля тянет весь граф модулей разом
(zod/argon2/sharp/...), так что ни одна функция из `auth`/`http` не
загружается без всех зависимостей сразу. Вместо этого основная
state-machine логика (TOTP enroll→pending→active, pending-сессия без
`user`, single-use после step-up, политика `mfaRequired` по роли)
живо проверена отдельно против настоящего `node:sqlite` через
zod-free копии `sessions.js`/`authenticators.js`/`totp.js` — **18 из
18 проверок прошли**. Полное подтверждение HTTP-слоя (коды ответов,
express-роутинг, Zod-валидация тела запроса) ждёт `npm test`
пользователя - см. `examples/workshop/README.md`

**Не сделано в этой версии**: интерактивный UI (формы, рендер QR-кода
для TOTP-enroll) - реализован только API-слой; `/ui` по-прежнему
показывает только "Signed in as X". Сознательно отложено, не забыто -
Stage B's API-поверхность была приоритетом как более рискованная и
security-значимая часть.

## [0.1.11]
### Added
- Реальная beta-артворк в `assets/brand/`: `logo.png` (light) и
  `logo-dark.png` (dark) — шестиугольный "наковальня" знак, заменил
  placeholder-монограмму "DF" в `logo.svg`/`logo-dark.svg` (теперь
  удалены). SVG-версии того же знака ожидаются позже — резолвер уже
  предпочитает `.svg` над `.png` автоматически, код трогать не нужно.
  Живо проверено: `CORE_IDENTITY.logo.format === 'png'`,
  `CORE_IDENTITY.getLogo('dark').file === 'logo-dark.png'`
- `test/branding.test.js`'s `CORE_IDENTITY`-тесты обновлены под новое
  состояние (ждали `format: 'svg'`, теперь `'png'`)

### Investigated
- Два реальных HEIC-файла (iPhone-фото) прогнаны через
  `detectFileType()` (`core/files/magic-bytes.js`) по разовой просьбе —
  **живой результат: `null` на обоих** (подтверждено реальными байтами,
  `ftyp`/`heic` ISOBMFF-контейнер). Это означает: HEIC-загрузка сейчас
  безопасно отклоняется как "unsupported or undetectable file type" ДО
  того, как дойдёт до `sharp` — не падает и не проходит без проверки.
  Не баг, фиксирую как рабочее поведение, не как найденную проблему
  для фикса.
- **Важная находка для будущего**: даже если добавить HEIC-сигнатуру в
  `magic-bytes.js`, предустановленный `sharp` (prebuilt-бинарники,
  `^0.35.0` в зависимостях) **не декодирует HEIC/HEIF вообще** —
  официальная документация sharp перечисляет только JPEG/PNG/Ultra
  HDR/WebP/AVIF/TIFF/GIF/SVG как поддерживаемые форматы ВВОДА у
  prebuilt-сборки; HEIC/HEIF требует кастомной сборки `libvips` с
  `libheif`, которую npm install сам не поставит (патентные/лицензионные
  причины). Раз реальные приложения (особенно фото с iPhone) будут
  получать HEIC на входе регулярно — это нужно решить осознанно до
  Workshop Stage B/C: либо явная кастомная libvips-сборка на стороне
  деплоя, либо серверная конвертация через отдельный HEIC→JPEG шаг
  (например, `heic-convert`/аналоги) перед `reencodeImage()`, либо
  явный, понятный отказ с объяснением пользователю. Не реализовано в
  этой версии — решение сознательно отложено до того, как решится,
  какой путь нужен реальным приложениям

## [0.1.10]
### Fixed
Второй настоящий `npm test` на Windows (теперь с установленными argon2/
selfsigned/zod — реальными, не stand-in) — 266 тестов, 11 упавших в
3 файлах. Все три — реальные баги кода, не особенности окружения, кроме
одного:

- **`src/auth/schema.js`'s `migrateLegacyTotpSecrets()`** — безусловно
  делала `SELECT id, totp_secret, totp_enabled FROM users WHERE
  totp_secret IS NOT NULL`, предполагая, что `CREATE TABLE IF NOT
  EXISTS users (...)` выше всегда даёт таблицу с этими колонками. Но
  `IF NOT EXISTS` — no-op, если `users` уже существует (например, тест
  сам создаёт `CREATE TABLE users (id, username)` до первого вызова
  `ensureAuthTables()`, как и делает `test/auth.test.js`'s `sessions`
  fixture) — колонок там нет, запрос падает `"no such column:
  totp_secret"`. Все 5 тестов `sessions` валились именно на этом, через
  `createSession()`/`verifySession()` → `ensureAuthTables()`. Исправлено
  добавлением проверки `PRAGMA table_info(users)` перед миграцией —
  если колонки `totp_secret` нет, миграции просто нечего делать, выход
  без ошибки. Живо проверено против настоящего `node:sqlite`
- **Реальный, security-значимый баг в `src/auth/recovery-codes.js`'s
  `verifyAndConsumeRecoveryCode()`**: `if (await verifyPassword(...))`
  — `verifyPassword()` всегда резолвится в объект `{ valid, scheme,
  needsRehash }` (см. `password.js`), а не в `boolean`, так что
  условие было истинным для ЛЮБОГО объекта независимо от `.valid` —
  первая же непогашенная строка кода "совпадала", и функция возвращала
  `true` на заведомо неверный код, а заодно гасила чужую валидную
  запись. Исправлено на `result.valid`. Живо проверено логикой цикла
  против настоящего `node:sqlite` (без argon2 — зависимость от
  `verifyPassword()` изолирована как stand-in, сама `password.js`
  логика в этом баге не участвовала и её собственные тесты и так были
  зелёными)
- **Реальный баг в `src/certs/generate.js`'s `generateSelfSignedCert()`**:
  вызывала `selfsigned.generate(attrs, { days, ... })`, но `selfsigned`
  v5 не читает опцию `days` вообще (проверено по актуальному исходнику
  пакета на GitHub, а не по памяти/старым версиям) — она читает
  `notBeforeDate`/`notAfterDate` (объекты `Date`), а без них молча
  уходит в дефолт 365 дней. Из-за этого `daysRemaining` всегда выходил
  ~365 независимо от запрошенных `days`, что валило и прямой тест
  `readCertInfo`, и `certChecks`'s warn/ok тест (окно в 20 дней не
  попадало в `warnDays: 30`). Исправлено: `days` теперь конвертируется
  в `notAfterDate = notBeforeDate + days` перед вызовом
- **НЕ баг кода, баг теста**: `test/certs.test.js`'s два теста на
  `statSync(...).mode & 0o777 === 0o600` падали `438 (0o666) !== 384
  (0o600)` — на Windows/NTFS нет POSIX permission bits, `chmod()` там
  лишь переключает read-only атрибут, а `fs.Stats.mode` синтезирует
  `0o666`/`0o444`, а не настоящий запрошенный режим. `writeCertFiles()`
  как писала, так и пишет `0o600` — это единственно верное поведение на
  POSIX, и исправлять тут нечего. Точная проверка режима вынесена в
  отдельные `it`-тесты, пропускаемые на `process.platform === 'win32'`
  (`it.skip`); базовый тест "файлы существуют и пути верны" остаётся
  кросс-платформенным

Как и в 0.1.9, это были баги, которые sandbox без сети в принципе не
мог поймать — локальные zod/argon2/selfsigned-free stand-in'ы для
живых прогонов не воспроизводят точное поведение настоящих библиотек
(особенно `selfsigned`'s `days`→`notAfterDate` breaking change между
мажорными версиями). Полный `npm test` на машине пользователя остаётся
единственным источником истины для таких ошибок; все три
кодовых-фикса в этой версии дополнительно живо провалидированы вручную
против настоящего `node:sqlite` (логика миграции, логика
верификации recovery-кода) там, где это было возможно без сети.

## [0.1.9]
### Fixed
Первый настоящий `npm test` (Windows, реальные zod/argon2/selfsigned/
vitest) — 246 тестов, 17 упавших в 6 файлах. Разобрано по одному:

- **Реальный баг в коде**: `core/modules/schema.js`'s `translations` —
  было `z.record(z.enum(['ru','en']), ...)`. В Zod 4 `z.record()` с
  enum-ключом строит ТОЧНЫЙ тип, требующий ВСЕ значения enum как ключи
  — регистрация модуля с одним `translations: { ru: {...} }` (без `en`)
  падала с `"translations.en: expected record, received undefined"`.
  Исправлено на `z.object({ ru: ...optional(), en: ...optional() })` —
  правильная форма для "ru и/или en, любое из двух". Мой собственный
  zod-free stand-in для живых прогонов эту ошибку пропустил — он не
  воспроизводит строгость настоящей Zod-валидации; отмечено как
  методологический пробел на будущее
- **Устаревшие тесты** (`test/branding.test.js`): `CORE_IDENTITY`-тесты
  всё ещё ждали черновой PNG без тёмного варианта — забыл обновить их,
  когда добавлял плейсхолдер `logo.svg`/`logo-dark.svg` в 0.1.7.
  Поправлено под актуальное поведение (подтверждённое живым прогоном
  тогда же)
- **Баг в счёте теста** (`test/health.test.js`): `runDoctor`-тест ждал
  `{ok: 1, ...}`, но `runtimeChecks()` всегда возвращает ДВЕ проверки
  (версия Node + платформа), не одну — тест ни разу не выполнялся
  по-настоящему раньше (только синтакс-чек в контейнере без сети),
  поэтому ошибка в подсчёте не всплывала. Поправлено на `{ok: 2, ...}`
- **Порядок операций** (`test/audit.test.js`, 2 теста): сырой
  `db.run("INSERT INTO audit_log ...")` стоял ПЕРЕД первым вызовом
  `log()`, который и создаёт таблицу (`ensureAuditTable()`) — на чистой
  `:memory:` БД это `"no such table: audit_log"`. Переставлено:
  `log()` теперь выполняется первым в обоих тестах
- **Тестовая fixture зависела от `openssl`** (`test/certs.test.js`, все
  10 падений) — на Windows-машине тестировщика `openssl` не в PATH.
  Переписано на уже реальную `generateSelfSignedCert()` (пакет
  `selfsigned` — теперь установлен у пользователя) вместо внешнего
  `openssl` CLI: работает на любой ОС без системных зависимостей, и
  заодно `generateSelfSignedCert()` впервые получает живую проверку —
  единственный путь, который было невозможно прогнать в песочнице без
  сети, теперь проверяется там, где `npm install` реально прошёл

## [0.1.8]
### Added
- `core/auth`: многофакторная модель — таблица `authenticators` (+
  `totp_credentials`) вместо плоских `users.totp_secret`/`totp_enabled`.
  Принято по итогам обсуждения общего security-документа (TOTP+WebAuthn,
  RBAC+scope, step-up) — забрали то, что явно полезно и дёшево сейчас
  (эта модель + recovery codes), явно отложили WebAuthn/полный RBAC/
  resource scopes/отдельную таблицу security_events (дублирует уже
  готовый `core/audit`) до реальной необходимости в одном из 4
  приложений — не стали строить недоказанное
- `type` в `authenticators` ограничен `CHECK (type IN ('totp'))` — не
  оставлен открытым под будущий `'webauthn'`, в отличие от
  `dataSubject` в `core/modules` (там это было честное хранение данных
  под будущего потребителя). Authenticator без функции проверки за ним
  — не безобидные данные, а дыра: пользователь может решить, что у него
  рабочий второй фактор, который на самом деле никто не умеет проверить
- `startTotpEnrollment()`/`verifyTotpEnrollment()` — PENDING →
  (верный код) → ACTIVE, с TTL на enrollment-окно и
  `purgeExpiredPendingAuthenticators()` для забытых; `verifyTotpLogin()`
  — проверяет код против ВСЕХ активных TOTP-аутентификаторов
  пользователя (поддержка нескольких факторов); `removeAuthenticator()`
  — защита "нельзя удалить последний обязательный фактор" (документ,
  §18), включается через `mfaRequired` (политику — required или нет —
  по-прежнему решает приложение, не core)
- Одноразовая миграция: существующий `users.totp_secret` (если есть)
  переносится в новые таблицы при `ensureAuthTables()` — идемпотентно,
  старые колонки не удаляются (аддитивная миграция, не cutover)
- `core/auth/recovery-codes.js` (§22): `generateRecoveryCodes()`
  (всегда полный сброс — старый набор инвалидируется, план хранит
  только argon2-хеш через уже существующий `hashPassword()`, не новый
  примитив), `verifyAndConsumeRecoveryCode()` (одноразовое
  использование), `countRemainingRecoveryCodes()`
- **Найден и исправлен реальный баг** в процессе прогона:
  `purgeExpiredPendingAuthenticators()` сравнивал ISO-строку
  (`new Date().toISOString()`) с SQL-вым `datetime('now')` — разные
  форматы (`T`/`Z`/миллисекунды против пробела), лексикографическое
  сравнение ненадёжно и могло не находить реально истёкшие записи.
  Исправлено на сравнение ISO со значением, переданным из JS. Других
  похожих мест в кодовой базе не найдено (проверено отдельно)
- `cli user {authenticators, authenticators-remove, recovery-codes}` —
  админский recovery-путь (пользователь потерял телефон/лист кодов) без
  self-service UI, которого пока нет (Workshop Stage B не начат).
  `authenticators-remove` защищён по умолчанию (`mfaRequired: true`),
  `--force` — осознанный override
- Прогнано вживую целиком (zod-free stand-in для `schema.js`, как и
  раньше): полный цикл enrollment (неверный/верный код, TTL, purge),
  два одновременных TOTP-аутентификатора у одного пользователя, все три
  исхода §18 (запрет/разрешение по count/not_found), миграция legacy
  secret (включая проверку, что смигрированный секрет реально проходит
  verifyTotpLogin, и идемпотентность повторного `ensureAuthTables()`),
  полный цикл recovery codes (генерация/формат/одноразовость/
  regenerate инвалидирует старые), и все новые CLI-команды через
  реальный `createCli()`

## [0.1.7]
### Added
- `core/certs` — §4.5f. `readCertInfo()` — чистый `node:crypto`
  (`X509Certificate`, доступен с Node 15.6+), без зависимостей: subject,
  subjectAltName, self-signed (через `checkIssued(self)` — корректная
  проверка, не эвристика "issuer строкой равен subject"), дней до
  истечения. `generateSelfSignedCert()` — через `selfsigned` (npm,
  `^5.5.0` — проверено на npmjs.com по стоячему правилу свежести
  зависимостей, не по памяти обучения; v5 — async-only, полностью
  переписан на нативный WebCrypto). `writeCertFiles()` — `data/certs/
  {cert.pem,key.pem}`, приватный ключ — `0600`, права переустанавливаются
  и при перезаписи (`--force`), не только при первом создании.
  `certChecks()` — doctor-категория, закрывающая пробел, явно оставленный
  открытым в `core/health` §11b ("ждут core/certs")
- `cli cert {info,generate,renew,trust}`. Командный файл НЕ импортирует
  `core/certs` напрямую (как и все остальные `commands/*.js`) — получает
  функции через параметры, поэтому `cert info`/`cert trust` работают
  даже в сборке без установленного `selfsigned` (нужен только для
  `generate`/`renew`). `cert renew` — честно извлекает те же SAN из
  текущего сертификата перед перевыпуском
- **Важная методологическая деталь**: `readCertInfo`/`writeCertFiles`/
  `certChecks`/вся read-часть CLI прогнаны **вживую** на реальном
  X.509-сертификате (сгенерирован `openssl` — только как тестовая
  фикстура, не часть реализации); `generateSelfSignedCert()` —
  единственная часть, требующая `selfsigned` из npm, не прогнана
  вживую (нет сети в контейнере) — честно так и помечено, по той же
  методологии, что и argon2/sharp/dompurify
- `examples/workshop`: `cert {info,generate,renew,trust}` и doctor-
  категория `Certificate` подключены в `bin/app.js`, путь к сертификату
  берётся из `app.config.js`'s `server.https.certPath`/`keyPath` с
  дефолтом `data/certs/`
- `core/ui` — минимальная, но настоящая реализация §5.4 (NOT
  аспирационный фреймворк целиком — ровно то, что честно можно
  построить над тем, что уже хранится в `core/modules`). Это и есть тот
  самый потребитель, которого ждала TODO-метка из §11c ("navigation/
  routes/translations/search хранятся, потребителя нет — подключить,
  когда появится `@das-forge/ui`"):
  - `renderAppShell()` — серверный рендер: навигация из
    `registry.getNavigation()`, отфильтрованная по правам (та же
    fail-closed логика, что у `http.serialize()` — пункт без
    `permission` виден всем, пункт С `permission` скрыт, если его нет у
    зрителя), переводы из `registry.getTranslations()` (честный fallback
    на сырой ключ, не на пустую строку), экранирование HTML
  - `translate()` — автономный i18n-лукап для обработчиков роутов
  - `searchModules()` — агрегирует `search.provider()` каждого
    зарегистрированного модуля; падение одного провайдера не прячет
    результаты остальных
  - **Честно НЕ реализовано**: `routes[].component` ничем не монтируется
    — в core нет клиентского фреймворка/бандлера; это серверный shell с
    `<nav>`, не SPA-хост
  - `examples/workshop`: `reporting-module.js` дополнен реальными
    `navigation`/`translations`/`search` (не выдуманными — поиск
    реально фильтрует настоящие audit-записи по подстроке); `GET /ui` и
    `GET /ui/search` в `routes.js`
  - Прогнано вживую целиком на реальном `reporting-module.js`: фильтрация
    навигации по правам, честный i18n-fallback, экранирование от XSS
    (инъекция в label и path), реальный поиск по audit-записям (3
    настоящих записи, 2 матчат по "asset", 1 — по "backup"), агрегация
    при падении одного провайдера
- Плейсхолдер-эмблемы (`logo.svg`/`logo-dark.svg`) добавлены для ядра
  (`packages/core/assets/brand/`, впервые — раньше был только черновой
  PNG) и обновлены для workshop (устаревшая монограмма "AE" от старого
  имени `app-example` → актуальная "WS"); живым прогоном подтверждено,
  что `resolveVendorLogo()`/`readVendorLogo()` реально подхватывают
  новые SVG поверх старого PNG без изменений в коде. Это плейсхолдеры
  ("пока с художеством проблемы"), не финальная отрисовка — явно
  помечено в `assets/brand/README.md`
- Логотипы 4 реальных приложений (procure-it/atlas-ao/net-monitor/
  it-assets) по-прежнему не присланы — для них даже нет папок в `apps/`
  в этом репозитории, placeholder для них добавить было физически
  некуда

## [0.1.6]
### Added
- `core/privacy` — §4.5k (152-ФЗ/GDPR техническая база; окончательное
  юридическое соответствие — вопрос комплаенса, не архитектуры).
  `exportUserData()` — собирает запись пользователя (`core/auth`) +
  `dataSubject.export(userId)` каждого модуля, зарегистрированного через
  `core/modules`, в один JSON; один упавший модуль не прячет данные
  остальных (`modules.<id>.error`). `eraseUserData()` — по умолчанию
  `mode: 'anonymize'` (не `'delete'` — потому что `audit_log`
  append-only и обязан сохранять целостность истории; анонимизация НЕ
  переписывает прошлые audit-записи задним числом, только саму запись
  пользователя), `'delete'` — только явным флагом. Каждый модуль
  вызывается через `dataSubject.erase(userId, {mode})` ДО изменения
  записи пользователя (модуль может успеть прочитать ещё не тронутую
  запись). Каждое действие — `audit.log('privacy.export'/'privacy.
  erase')` — "сам факт запроса на приватность тоже часть аудита"
- `core/auth`: `anonymizeUser(db, id)` — заменяет username на
  `deleted-user-<id>`, обнуляет email/password_hash/totp, `disabled:
  true`, СТРОКА ОСТАЁТСЯ (id сохраняется для ссылочной целостности);
  `deleteUser(db, id)` — настоящий hard delete, явный выбор вызывающего
- `cli privacy {export,erase}` — `export --user <username> [--out
  <file>]`, `erase --user <username> [--mode anonymize|delete] --yes`.
  `--user <username>`, не `<email>` как в примере документа — email
  nullable в `UserSchema`, username — гарантированный уникальный
  идентификатор (та же причина, что у `user reset-password`)
- Cookie-уведомление из §4.5k — часть `@das-forge/ui` (`ui/cookie-
  notice`), которого нет; НЕ реализовано, не фасад
- `examples/workshop`: `src/modules/reporting-module.js` стал фабрикой
  (`createReportingModule`) — его `dataSubject.export()` честно
  возвращает число реальных audit-записей пользователя (не
  выдуманные данные), `erase()` — честный no-op (модулю нечего удалять
  в этом демо). `context.js` собирает `exportUserData`/`eraseUserData`,
  `bin/app.js` подключает `cli privacy {export,erase}`
- Прогнано вживую дважды: изолированно (zod-free stand-in для
  auth/audit/modules — полный цикл export/erase/delete + все отказные
  пути CLI) и **end-to-end на реальном, неподменённом коде
  `reporting-module.js`**: реальный пользователь с 3 реальными
  audit-записями → `privacy export` через настоящий CLI → модуль
  реально насчитал 3 → `privacy erase` → пользователь не резолвится по
  старому username, под новым — анонимизирован → **прежние audit-записи
  с оригинальным username не тронуты** (append-only подтверждён на деле)

## [0.1.5]
### Changed
- `ModuleRegistrationSchema` восстановлена до полной §7.5-формы —
  `navigation`/`routes`/`translations`/`search`/`dataSubject` возвращены
  по явному запросу пользователя (ранее были убраны как преждевременные).
  Правильное различие: core/modules **принимает и честно хранит** эти
  поля (`registry.getNavigation()`/`getRoutes()`/`getTranslations()`/
  `getSearchProviders()`/`getDataSubjectHandlers()`, с реальными
  функциями внутри, не заглушками) — но ничего в core пока не читает их
  обратно и не действует на их основе, потому что `@das-forge/ui`
  (потребитель navigation/routes/translations/search) и `core/privacy`
  (потребитель dataSubject) ещё не существуют. Это не "фасад без
  начинки" — это честное хранение данных, которые не теряются, готовые
  к подключению в момент появления этих модулей (см. `roadmap.md`,
  явная заметка-напоминание добавлена в §11c)
- Конфликт одного translation-ключа между двумя модулями — explicit
  throw при регистрации, та же логика, что у конфликта fieldPermissions
- Прогнано вживую (zod-free stand-in для реестра, как и раньше):
  navigation/routes сохраняются и возвращаются с `moduleId`, переводы
  от двух модулей сливаются, конфликт одного ключа — throw,
  `search.provider` и `dataSubject.export`/`erase` — реальные
  сохранённые функции, вызываются напрямую из возвращённых объектов

## [0.1.4]
### Added
- `core/modules` — третий из трёх контрактов §1 ("core не знает про
  Atlas/procure-it — оперирует только контрактами `ApplicationConfig`,
  `Module`, `DatabaseAdapter`"). `ApplicationConfig` — это `core/config`,
  `DatabaseAdapter` — `core/database/adapter.js`, этого контракта не
  хватало. `ModuleRegistrationSchema` (Zod) — урезанная версия полной
  §7.5-схемы: оставлены `id`/`permissions`/`fieldPermissions`/
  `cliCommands` (то, на что core реально может повлиять сегодня),
  убраны `navigation`/`routes`/`translations`/`search` (поверхность
  регистрации ещё не существующего `@das-forge/ui`, §5.4) и
  `dataSubject` (поверхность ещё не существующего `core/privacy`,
  §4.5k) — не валидировать и тихо игнорировать, а не принимать вовсе,
  пока модуля действительно нет
- `z.function()` для `handler` НЕ используется — в Zod 4 это полностью
  другой API (standalone function-factory, уже не field-схема внутри
  `z.object()`); заменено на `z.custom(v => typeof v === 'function')`
  — не слабее, чем было (сам документ называет `z.function()`
  сознательно поверхностной проверкой)
- `createModuleRegistry()` — собирает регистрации, отдаёт
  `getFieldPermissions()` (единая карта для `http.serialize()`),
  `getPermissions()`, `applyCliCommands(cli)` (вешает команды модулей
  на тот же `createCli()`, что и встроенные команды core). Конфликт
  `fieldPermissions` между двумя независимыми модулями на одном имени
  поля — explicit throw при регистрации (как `assertDatabaseAdapter` —
  падать на старте, а не тихо резолвить last-wins, меняя доступ в
  зависимости от порядка регистрации)
- `examples/workshop`: `src/modules/reporting-module.js` — демо-модуль,
  **реально заменивший** прежний захардкоженный `ASSET_FIELD_PERMISSIONS
  = { cost: 'read:finance' }` в `routes.js` — теперь `routes.js` берёт
  карту из `moduleRegistry.getFieldPermissions()` и не имеет своего
  мнения о том, что такое "cost"/"finance"; плюс CLI-команда `report
  summary`, подключаемая через `moduleRegistry.applyCliCommands(cli)` в
  `bin/app.js`
- Прогнано вживую (реестр — через zod-free stand-in схему, как и для
  audit/auth ранее; дальше — реальный код без обхода): регистрация
  с дефолтами, отказ без `id`, отказ на non-function handler, отказ на
  дублирующемся id, слияние непересекающихся `fieldPermissions` от
  двух модулей, явный throw на конфликте одного поля между модулями,
  `applyCliCommands()` на настоящем `createCli()` — команда реально
  выполняется. Отдельно — **полный сквозной прогон на реальном,
  неподменённом коде**: настоящий `reporting-module.js` →
  `createModuleRegistry()` → настоящий `core/http/serialize.js`
  (оператор без `read:finance` реально не видит `cost`, финансист —
  видит) → настоящий `createCli()` (`report summary` реально печатает
  отчёт)

## [0.1.3]
### Added
- CLI-обвязка расширена до покрытия §4.1 там, где за командой есть
  реальная реализация (список ниже), вместо фасада без начинки:
  - `core/scheduler/backup-ops.js` — `listBackups()`, `verifyBackupFile()`
    (readonly-открытие + `PRAGMA integrity_check`, без касания живой БД),
    `restoreBackup()` — оркестрированный пайплайн §4.3 (verify → safety
    copy → restore → integrity → migration check → audit entry → health
    check), останавливается на первом неудачном шаге, перед перезаписью
    держит файловую копию текущей БД (`<file>.pre-restore-<ts>`)
  - `cli backup {list,verify,restore}` (плюс уже существовавший `run`) —
    `restore` требует `--yes`, иначе явно отказывает
  - `cli db {status,integrity}` — отдельно от уже существующих
    `migrate`/`migrate status` (не переименовывал — сломало бы уже
    написанную интеграцию в `examples/workshop`); `integrity --repair`
    честно делает только `VACUUM` (`node:sqlite` не умеет чинить
    структурную порчу, только `PRAGMA integrity_check`), в выводе
    прямо сказано, что для реального ремонта нужен `backup restore`
  - `cli audit {tail,export}` — обёртка над уже готовым `core/audit`;
    `export` пишет JSON или CSV (`--format csv`)
  - `cli user reset-password <username>` — recovery для существующего
    пользователя (в отличие от `create-admin`, никогда не создаёт юзера)
  - `cli version [--json]`
- `examples/workshop/bin/app.js`: все новые команды подключены;
  `backup restore` закрывает текущее соединение и переоткрывает новое
  (`activeDb`/`getDb()`), чтобы `doctor`/другие команды в том же
  процессе не держались за уже закрытый handle
### NOT added (осознанно, не фасад)
- `cli user unlock` — в `core/auth` нет механизма блокировок/учёта
  неудачных попыток входа вообще, нечего "разблокировать"
- `backup destinations {list,add,remove,set-primary}` — потребовало бы
  записи в `app.config.js` из работающего процесса; `core/config`
  сейчас только читает конфиг, механизма безопасной записи нет —
  реальный дизайн-вопрос, не однострочный пробел
- `cert`, `secrets`, `security bans`, `security incident`,
  `maintenance`, `privacy {export,erase,...}`, `integrations
  {keys,webhooks}`, `logs {tail,export,config}`, `cron
  {list,history,run}` (как отдельная CLI-команда — `core/scheduler`
  есть, но история прогонов не персистится), `deps`, `test:perf`,
  `dev/start/stop/restart/status`, `service install/...` — ни для
  одной нет core-модуля с реальной функциональностью за ней
- `app version sync` (сверка с версией живого сервера) — тривиально
  добавить поверх `GET /health`, но без реального сценария использования
  сейчас это было бы гаданием на дизайне
- Прогнано вживую: `restoreBackup()` целиком (реальная БД, реальная
  мутация после бэкапа, восстановление возвращает именно
  добэкапное состояние, pending-миграция в отчёте не применяется
  автоматически), весь CLI end-to-end через `createCli()` с реальными
  командами (`migrate` → `db status/integrity` → `user create-admin` →
  `user reset-password` (включая отказ на несуществующем юзере и без
  аргумента) → `version` → `backup run/list/verify/restore` (отказ без
  `--yes`, все шаги §4.3 в выводе) → `audit tail/export` (json+csv) →
  `doctor` → `health`)

## [0.1.2]
### Added
- `core/health` — `health` vs `doctor`, два разных инструмента под
  разную аудиторию (§4.5): `checkHealth()`/`healthHandler()` —
  быстрый liveness-чек (`SELECT 1`, без integrity check), `GET /health`
  отдаёт 503 (не 500) при деградации; `runDoctor(categoryProviders,
  {fix})` — оркестратор категорийной диагностики, категории подаёт
  приложение (core не хардкодит, что именно проверять — только
  механизм); готовые категории: `runtimeChecks()` (версия Node/платформа),
  `databaseChecks()` (connection + `PRAGMA integrity_check` +
  pending-миграции через существующий `migrationStatus()`),
  `storageChecks()` (директории существуют/доступны на запись, с
  `fix()` = `mkdir -p` для отсутствующих), `securityChecks()`
  (session secret не дефолтный/не короче 16 символов, HTTPS mode),
  `applicationChecks()` (порт свободен — `warn`, не `fail`, т.к. часто
  doctor запускают при уже работающем сервере); `formatDoctorText()`/
  `formatDoctorJson()`. Exit codes по §4.2: `health` — 0/1,
  `doctor` — 0/3 (критичные проблемы). Integrations/Security-сертификаты
  из полной §4.5-матрицы НЕ реализованы — для них нет core/ldap,
  core/email, core/certs; добавятся вместе с теми модулями, без
  изменения doctor-фреймворка (ровно как описано в самом документе)
- `cli health [--json]`, `cli doctor [--json] [--fix]` — тонкие обёртки
  над `core/health`
- `examples/workshop`: `GET /health` (без аутентификации — пробник сам
  по себе сессии не имеет), `app health`/`app doctor` подключены в
  `bin/app.js` со своим набором категорий (Runtime/Database/Storage/
  Security/Application), собранным из `app.config.js`

## [0.1.1]
### Added
- `core/audit` — лог событий (кто/когда/что/результат), отдельный
  модуль (не часть `core/auth`): `log()` — единственная точка записи в
  append-only `audit_log`; `tail()`/`query()`/`count()` — чтение с
  фильтрами по actor/action/entity/entityId/result и диапазоном дат
  (`since`/`until`); `purgeOlderThan()` — retention-удаление, обычная
  функция, не привязанная к `core/scheduler`; `contextFromRequest()` —
  `{actor, requestId, ip}` из Express-запроса (`core/http`'s
  `requestId()` + `sessionMiddleware()`); `AuditEntrySchema` (Zod) +
  `ensureAuditTable()`

## [0.1.0]
### Added
- `core/config` — Zod-схемы (`ApplicationConfigSchema`), `loadConfig()`,
  env-override, единый формат ошибок валидации
- `core/database` — `createSqliteAdapter()` на `node:sqlite`, WAL,
  FTS5, `queryByExample()`, `assertDatabaseAdapter()`
- `core/branding` — vendor identity (неизменяемая, файловая,
  light/dark) + company branding (DB-backed, admin-editable)
- `core/auth` — argon2id, multi-scheme legacy verify, сессии (с
  защитой от fixation), TOTP (RFC 6238), `firstRunBootstrap()`
- `core/http` — `serialize()`/fieldPermissions (zero-trust),
  `validateBody()`/`validateQuery()`, session middleware, брендированные
  404/500, `requestId()`, `securityHeaders()`,
  `registerGracefulShutdown()`
- `core/realtime` — `createEventBus()`, `createSseHandler()`,
  `transports/websocket.js` как точка расширения (не реализован)
- `core/files` — magic-bytes, свой ZIP-ридер + zip-bomb guard,
  path-traversal-proof storage, `sanitizeSvg()` (DOMPurify+jsdom),
  `validateUpload()`, `reencodeImage()` (sharp)
- `core/scheduler` — свой cron-парсер, overlap-safe планировщик,
  `createBackupJob()`
- `core/cli` — `createCli()`, мигратор, команды config check/user
  create-admin/migrate/backup run
- `examples/workshop` — Stage A, эталонное приложение на всех 9 модулях

### Fixed
- `core/auth`: `updatePasswordHash()`'s `clearMustChange` была
  инвертирована (true выставляло флаг в 1 вместо 0)
- `core/files`: тестовая ZIP-фикстура переполняла uint32
  (`writeUInt32LE`), не баг в самой логике
- `core/database`: `node:sqlite` не резолвился под Vitest — причина
  оказалась в баге `vite-node` (внутренний модуль Vitest), не в нашем
  коде; исправлено апгрейдом `vitest` до `^5.0.0` (фикс апстрима
  попал только в 3.x+, наш диапазон `^2.1.0` не мог его получить)
- `core/config`: Zod 3→4 breaking changes — `.default({})` на вложенных
  object-схемах больше не пересчитывает дефолты (фикс — `.prefault({})`
  везде, где нужно); `z.record(valueSchema)` теперь требует явную схему
  ключа (`z.record(keySchema, valueSchema)`)

### Dependencies
Версии сверены пользователем вручную на npmjs.com (все предыдущие были
устаревшими на 1–2 года): zod ^4.6.0, argon2 ^0.45.0, sharp ^0.35.0,
dompurify ^3.4.0, jsdom ^30.0.0, express ^5.2.1 (peer), cookie-parser
^1.4.7 (peer), vitest ^5.0.0 (dev)
