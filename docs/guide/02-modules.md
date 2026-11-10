# Модули ядра

Справочник по модулям `@das-forge/core`: для чего модуль, что даёт по умолчанию, как подключить и на что обратить внимание. Подробности по темам вынесены в отдельные руководства: [Конфигурация](03-configuration.md), [Безопасность](04-security.md), [Администрирование](05-administration.md), [Переводы](06-translations.md), [Темы и оформление](07-themes-and-branding.md), [CLI](08-cli.md).

Пакет подключается целиком (`import { auth, http } from '@das-forge/core'`) или по модулям (`@das-forge/core/auth`). Тяжёлые и нативные зависимости (argon2, sharp, jsdom, dompurify, qrcode, selfsigned, ssh2, ldapts, libheif-js, docx, i18next) подгружаются лениво, при первом использовании функции, а не при импорте.

| Модуль | Назначение | Опциональные пакеты |
|---|---|---|
| `config` | схема, загрузка и проверка конфигурации | — |
| `database` | адаптер SQLite, FTS, помощники миграций, мягкое удаление | — |
| `auth` | пароли, сессии, TOTP, recovery-коды, управление пользователями | `express-session` (peer), `argon2`, `otplib` |
| `http` | сессии, CSRF, заголовки, CORS, лимиты, сериализация, страницы ошибок | `express`, `cookie-parser` (peer), `helmet`, `express-rate-limit` |
| `security` | баны IP и пользователей | — |
| `policy` | страницы политик и баннер cookie | — |
| `privacy` | экспорт и стирание данных субъекта | — |
| `audit` | журнал с цепочкой хешей, псевдонимы, запросы | — |
| `ldap` | вход через LDAP/AD | `ldapts` |
| `files` | приём, проверка и выдача загрузок | `multer`, `sharp`, `jsdom`, `dompurify`, `libheif-js`, `yauzl` |
| `realtime` | шина событий, SSE, WebSocket | — |
| `scheduler` | cron, блокировки, резервные копии | `ssh2` (для SFTP), `yazl`, `yauzl` |
| `health` | health и doctor | — |
| `certs` | чтение и создание сертификатов | `selfsigned` |
| `email` | письма, очередь, шаблоны | `nodemailer` |
| `alerts` | алерты: запись, письмо контактам по инцидентам, периодические проверки | — |
| `qr` | QR-коды SVG | `qrcode` |
| `logs` | логгер, журнал доступа, приёмники логов | `pino`, `pino-http`, `pino-pretty` |
| `modules` | контракт модуля приложения | — |
| `ui` | оболочка страниц, тема, язык, поиск | — |
| `branding` | личность производителя и оформление компании | — |
| `maintenance` | режим обслуживания: страница 503 и состояние в базе | — |
| `announcement` | объявление: строка над страницами приложения, состояние в базе | — |
| `accounts` | маршруты входа и учётной записи: пароль, TOTP, коды восстановления, смена и сброс пароля | — |
| `admin` | админ-панель | — |
| `xlsx` | выгрузка и загрузка Excel (.xlsx): писатель, строгий читатель, сопоставление строк с полями | `yauzl`, `yazl` |
| `csv` | CSV для выгрузок и загрузок: защита от формул по умолчанию, кодировки (UTF-8, windows-1251), разделитель `;` | — |
| `observability` | метрики Prometheus: `GET /metrics` | `@prometheus-io/client` (по требованию) |
| `i18n` | переводы на i18next | `i18next` |
| `cli` | каркас командной строки | — |

Версия ядра доступна как `CORE_VERSION`.

---

## config

**Назначение.** Единая проверенная конфигурация приложения. Данные валидирует Zod; интерфейсы (адаптер БД, провайдер аутентификации) проверяются отдельными `assert…`-функциями, а не схемами.

**API.**

| Функция | Что делает |
|---|---|
| `loadConfig({ cwd })` | читает файл конфигурации, накладывает значения по умолчанию и переменные окружения, проверяет; при ошибке бросает `ConfigValidationError` со списком полей |
| `validateConfig(plain)` | синхронная проверка готового объекта (CLI `config check`, тесты) |
| `applyEnvOverrides(obj)` | переопределения из `DAS_*` и других переменных (например, `DAS_BACKUP_KEY` → `backup.encryptionKey`) |

**Пример (workshop).** `examples/workshop/src/context.js`: `const appConfig = await config.loadConfig({ cwd: REPO_ROOT })`.

**Внимание.** Полный список ключей и значений по умолчанию — в [Конфигурации](03-configuration.md). Схема строгая: неизвестный ключ — ошибка. Заглушки секретов (`KNOWN_PLACEHOLDER_SECRETS`) не допускаются в production.

---

## database

**Назначение.** Адаптер к `node:sqlite` (WAL) и помощники поверх него. `adapter.snapshotTo(файл)` — согласованная копия (`VACUUM INTO`); `adapter.snapshotToAsync(файл, { check })` делает то же и `integrity_check` копии в рабочем потоке, не останавливая обработку запросов (только файловая база; в памяти — обычная копия). Плановое резервное копирование использует асинхронный вариант. Страницы: `adapter.pageByExample(table, example, { pageSize, cursor, orderBy, direction, withTotal })` возвращает `{ rows, nextCursor, total? }` — постраничный просмотр «после этой строки» по одному уникальному индексированному столбцу (по умолчанию `id`), устойчивый к добавлению и удалению строк; `nextCursor` (непрозрачная строка, годится для URL) передаётся как `cursor`, `null` — последняя страница. Для небольших списков остаётся `queryByExample({ limit, offset })`.

**Адаптер.** `database.createSqliteAdapter({ file, walMode, normalizeValues })` возвращает объект с `get`, `all`, `run`, `exec`, `transaction`, `queryByExample` и закрытием. `assertDatabaseAdapter(obj)` проверяет, что объект соответствует интерфейсу.

| Помощник | Что делает |
|---|---|
| `upsert(db, table, row, { conflictColumns, updateColumns })` | `INSERT … ON CONFLICT DO UPDATE` |
| `addColumnIfMissing`, `addUpdatedAtTrigger`, `rebuildTable` | безопасные миграции (идемпотентно; `rebuildTable` — 12 шагов SQLite) |
| `addSoftDelete`, `softDelete`, `restoreDeleted`, `purgeDeleted` | мягкое удаление через `deleted_at` |
| `queryByExample`, `countByExample`, `likeEscape` | параметризованные запросы по образцу; `deleted: 'exclude'|'only'|'include'` |
| `createFtsIndex`, `ftsEscape`, `foldYo` | полнотекстовый поиск FTS5 с русской свёрткой (`ё`=`е`) |
| `assertSafeIdentifier`, `normalizeLimit` | защита идентификаторов и `LIMIT` |

**Внимание.** Имена таблиц и столбцов проверяются (`assertSafeIdentifier`): передавайте их из кода, не из пользовательского ввода. Пустой образец в `softDelete` запрещён (скрыл бы всю таблицу). Значения всегда передаются параметрами.

**Пример (workshop).** `examples/workshop/src/context.js` создаёт адаптер; миграции — `cli.runMigrations` из каталога `migrations` (`bin/app.js`).

---

## auth

**Назначение.** Пароли, сессии, вторые факторы, управление учётными записями.

**Пароли.** `hashPassword` (argon2id), `verifyPassword` (любая поддерживаемая схема, в том числе старые: `pbkdf2Scheme`, `scryptScheme`, `scryptSaltColumnScheme` для приложений, где соль лежит в отдельном столбце), `checkPasswordPolicy`, `generateTempPassword` (24 символа). `configurePasswordConcurrency` ограничивает число одновременных проверок; при перегрузке — `PasswordBusyError` (отвечайте 503).

**Провайдер.** `createAuthProvider({ db, argon2Options, legacySchemes… })` объединяет проверку пароля, ленивую миграцию старого хеша при входе и создание сессий; `assertAuthProvider` проверяет интерфейс. Пример: `examples/workshop/src/context.js`.

**Сессии.** `createSessionStore` (SQLite, хеш идентификатора), `destroyUserSessions`, `purgeExpiredSessions`, `hashSessionId`. Подробнее — [Безопасность](04-security.md#сессии).

**Вторые факторы.** TOTP: `startTotpEnrollment`, `verifyTotpEnrollment`, `generateTotp`/`verifyTotp`/`matchTotpStep` (шаг запоминайте, чтобы не принять код дважды), `buildTotpUri`; recovery-коды: `generateRecoveryCodes`, `verifyAndConsumeRecoveryCode`, `countRemainingRecoveryCodes`; `listAuthenticators`, `removeAuthenticator` (последний фактор нельзя удалить, если политика требует MFA). Секреты TOTP шифруются: `sealSecret`/`openSecret`, `sealExistingTotpSecrets` приводит все секреты к текущему ключу.

**Сброс пароля по ссылке.** `createPasswordResetToken`, `peekPasswordResetToken` (проверить, не сжигая), `consumePasswordResetToken` (одноразово), `purgePasswordResetTokens` (вызывайте из планировщика).

**Управление пользователями.** `listUsers`, `getManagedUser`, `createManagedUser`, `renameUser`, `setUserEmail`, `changeUserRole`, `setUserDisabled`, `resetUserPassword`, `removeUser` (`mode: 'anonymize'` по умолчанию или `'delete'`), `countActiveAdmins`. Все операции отзывают сессии затронутого пользователя и **не допускают** потерять последнего активного администратора.

**Парольная политика.** `createPasswordPolicy({ db, config, appName, blocklistFile })` даёт правила, которые администратор меняет в [админке](05-administration.md): `get`, `set`, `reset`, `check` (длина, классы символов, логин, часть e-mail, название приложения, список типовых) и `checkFull` (плюс запрет повторов по хешам прошлых паролей и список утёкших паролей из файла `createPasswordBlocklist`), `isExpired` (срок действия). Профили в `PASSWORD_PROFILES` (`nist`, `fstec`). Низкоуровневые `checkPasswordPolicy`, `characterClasses`; история хешей `recordPassword`, `recentPasswordHashes`, `passwordExpired`; массовая смена `requirePasswordChangeForAll` (в `user-admin`). Правила и коды ответа — в [безопасности](04-security.md).

**Известные устройства.** `recognizeDevice`, `describeAgent` (`auth/devices.js`): браузер узнаётся по cookie `das_device`, в таблице `login_devices` только хеш; на этом построено письмо о входе с нового устройства.

**Первый запуск.** `firstRunBootstrap(db, { argon2Options })` создаёт администратора с временным паролем, если пользователей нет; `writeBootstrapCredentials(file, result)` записывает данные в файл с правами только для владельца (не перезаписывает существующий).

**Внимание.**
- Хеширование пароля выполняет `AuthProvider` приложения: `createManagedUser` принимает уже готовый `passwordHash`.
- Сессия хранит снимок пользователя. Смена роли или имени без отзыва сессий оставит старые права: используйте функции выше или `attachUser({ revalidate })`.
- Отдельный ключ `auth.totpEncryptionKey` обязателен для безопасной ротации `sessionSecret`.

---

## http

**Назначение.** Всё, что нужно Express-приложению вокруг маршрутов.

| Группа | Функции |
|---|---|
| Сервер | `applyServerSettings`, `createHttpServer`, `listenServer`, `loadOrCreateTls`, `defaultCertDir`, `secureCookiePolicy` |
| Запрос | `requestId`, `securityHeaders`, `createCompression`, `createCors`, `csrfProtection`, `createRateLimiter`, `createFailureTracker`, `clientKey` |
| Сессии | `createSessionMiddleware`, `attachUser`, `establishSession`, `endSession`, `requireAuth`, `requirePermission`, `deriveCookieSecret` |
| Данные | `serialize`, `findUnmappedFields`, `validateBody`, `validateQuery` |
| Ответы | `sendError`, `ERROR_CATALOG`, `errorText`, `resolveLocale`, `renderErrorPage`, `notFoundHandler`, `errorPageHandler`, `errorResponder` |
| Жизненный цикл | `registerGracefulShutdown`, `registerFatalHandlers` |

**Страницы статусов.** Каталог `ERROR_CATALOG` содержит тексты для всех кодов 4xx и 5xx из списка MDN (ru/en), плюс общие записи `4xx`/`5xx` и запись `maintenance`; тексты переопределяются через `i18n.setTextOverrides({ errors: … })`. Каждая страница показывает блок бренда приложения (`brand` — функция `(req) => html`, обычно `() => branding.brandBlockHtml(db, vendorIdentity)`) и маленькую строку «Powered by DAS-Forge» с логотипом ядра.

**Формат ошибки.** Ошибки валидации и отказы — `{ error: 'КОД', fields: ['имя поля'], message? }`; браузер получает брендированную страницу, API — JSON (`errorResponder` решает по заголовку `Accept`). Коды ошибок стабильны, тексты берутся из каталога по языку запроса.

**Порядок подключения** (как в `examples/workshop/src/server.js`): `requestId` → `ui.localeMiddleware` → `errorResponder` → `securityHeaders` → сжатие → тела запросов → `cookie-parser` → `csrfProtection` → сессии → `attachUser` → баны → маршруты → страницы 404 и 500 **последними**.

**Внимание.**
- `requireAuth` отвечает 401, `requirePermission` — 403; оба пишут ответ в формате ошибок.
- Для `serialize` поле без объявленного права закрыто по умолчанию.
- Режим `reverse-proxy` без `server.trustProxy` отвергается при запуске.
- Лимиты запросов живут в памяти процесса.

---

## security

`security.createBans(db)` — баны по IP и по логину, срок или бессрочно (`parseDuration('30m'|'2h'|'7d')`). Методы: `ban`, `lift`, `list`, `purge`, `middleware()`. Баны не удаляются: при снятии заполняется `lifted_at`. Пример: `examples/workshop/src/server.js` (`bans.middleware()` после `attachUser`), очистка — задача планировщика `bans-gc`. CLI: `ban add|lift|list`.

---

## policy

`policy.createPolicy({ db, appName, theme, dependencySources, basePath = '/policy', secureCookie, platformCopyright = 'DAS-Forge contributors' })` — публичные страницы `/policy` (политика использования), `/policy/cookies`, `/policy/components` (перечень компонентов и лицензий по `dependencySources`), баннер cookie с согласием (`POST /consent`) и раздел админки. Тексты по умолчанию — `DEFAULT_TEXTS`, редактируются администратором и хранятся в `policy_texts` (языки `ru` и `en`; в админке язык текстов переключается вкладками, а не дублирует поля; есть текст лицензионного соглашения `license` — заготовка для владельца). Методы: `mount(app)`, `getText`, `setText`, `resetText`, `consentOf`, `bannerHtml`, `pageEnd`. `pageEnd(req, res, locale)` — разметка конца страницы (ссылки и баннер): передавайте её в оболочку и страницы ошибок как `bodyEnd`.

Страница `/policy/license` состоит из двух частей. Сверху неизменяемая часть платформы: пояснение и оригинальный английский текст лицензии MIT (в обоих языках, перевод лицензии лицензией не является) с держателем прав `platformCopyright`. Под ней текст владельца приложения (по умолчанию заглушка), который правится в разделе «Политики» админки. Правка текста владельца часть платформы не затрагивает и убрать её нельзя. Остальные страницы политик такой части не содержат.

---

## privacy

`privacy.exportUserData({ db, findUserByIdFn, moduleRegistry, auditLogFn, auditQueryFn, listAuthenticatorsFn, userId })` собирает данные субъекта: учётную запись без секретов, сессии без идентификаторов, способы входа без секретов, записи аудита и данные модулей (`dataSubject.export`). `privacy.eraseUserData({ …, userId, mode })` по умолчанию **обезличивает** (`mode: 'anonymize'`), удаление — явно (`'delete'`), потому что журнал аудита неизменяем; стёртые псевдонимы в аудите читаются как «[erased]». `privacy.createErasureLedger(file)` ведёт файл со списком стёртых, чтобы повторить стирание после восстановления старой копии (`reapply`). Пример подключения — `examples/workshop/src/context.js`.

`privacy.buildProcessingRegistry({ moduleRegistry, config })` собирает реестр обработки персональных данных: записи платформы (учётные записи, сессии, журнал аудита, копии и другие) со сроками хранения из настроек и записи модулей из `dataSubject.purpose`, `dataSubject.legalBasis` и `dataSubject.retentionDays`. Основание обработки для данных платформы определяет владелец приложения, оно остаётся в реестре для заполнения. Модуль без цели или основания попадает в `gaps`. Формат: `privacy.formatProcessingRegistry(реестр, { format: 'md'|'csv'|'json', lang: 'ru'|'en' })`; в CSV значения, похожие на формулы, экранируются. В консоли: `privacy registry`.

**Внимание.** Ядро не отзывает письма из очереди: перед стиранием вызовите `emailQueue.cancelForAddress(адрес)`, как делает workshop в `context.js`. Данные собственных таблиц приложение стирает через `dataSubject.erase` своего модуля.

---

## audit

Журнал событий: `audit.log(db, { actor, action, entity, entityId, result, meta, requestId, ip })`, `contextFromRequest(req)` (актор, id запроса, IP), `onEntry(fn)` (подписка, чтобы копия ушла за пределы машины), запросы `query`, `page` (по курсору, стабильно при добавлении), `count` (фильтры: `actor`, `action`, `actionPrefix`, `entity`, `entityId`, `result`, `since`, `until`), `tail`, `purgeOlderThan`.

- **Цепочка хешей:** каждая запись хранит хеш с учётом предыдущей; `verifyChain(db)` находит первую испорченную запись; `anchor(db)` — снимок головы цепочки для хранения вне базы (его пишет `logs.logAuditAnchor` по расписанию).
- **Псевдонимы:** логины и IP хранятся как псевдонимы (`pseudonymize`), расшифровка через `createResolver`; `eraseSubjects` удаляет соответствие, и записи читаются как «[erased]», цепочка остаётся целой.
- `redactMeta` заменяет значения под ключами, похожими на секрет, на `[REDACTED]`.
- Срок хранения — `audit.retentionDays`.

Пример: `logAudit` в `examples/workshop/src/routes.js` и задачи `audit-gc`, `audit-anchor` в `server.js`. CLI: `audit tail|export|verify`.

---

## ldap

`ldap.createLdapAuthenticator(config, { env, bindPassword, ldapts })` проверяет учётные данные в LDAP/AD и возвращает группы; `roleFromGroups(groups, roleMapping, defaultRole)` сопоставляет группы ролям; `LdapConfigSchema` — схема настроек (пароль привязки только как `env:NAME`). Пакет `ldapts` нужен только при включённом LDAP. Роль по умолчанию — `viewer`. Приложение само решает, создавать ли локальную запись пользователя при первом входе.


**Вход в приложение.** `accounts.mountAccountRoutes(app, { directory })`, где `directory = { authenticate, source: 'ldap', allowedRoles }` (`authenticate` берётся из `createLdapAuthenticator`). Неизвестное имя и учётная запись, созданная из каталога, проверяются в LDAP; при первом удачном входе запись создаётся (роль из `roleMapping`/`defaultRole`, пароль случайный, смена пароля не требуется) и привязывается к каталогу (таблица `directory_links`). Локальная учётная запись с тем же именем каталогом не проверяется и не захватывается. На любой отказ пользователь видит один ответ «неверные данные»; причина (`directory_not_found`, `directory_unavailable`, …) пишется в журнал. Недоступность каталога не считается неудачной попыткой и никого не блокирует. Роли каталога обязаны быть ролями приложения (`allowedRoles`). Пример: блок `ldap` в `app.config.js` workshop (его нет — вход только локальный).
---

## files

**Приём.** `files.createMultipartUpload({ maxBytes, field })` — middleware, берёт один файл в память под жёстким лимитом и кладёт в `req.upload = { buffer, originalName, declaredType, size }`. Далее `files.acceptUpload(buffer, { allowedTypes, maxBytes, storageDir, quota, imageOptions, svgMaxBytes })` проверяет размер, тип по содержимому, архивы и SVG, перекодирует растровые изображения и записывает файл под сгенерированным именем. Возвращает `{ filename, fullPath, type, mime, size }`. Ошибки: `QUOTA_EXCEEDED`, `IMAGE_BUSY` (ответьте 507 и 503 с `Retry-After`).

**Выдача.** `files.sendUpload(res, storageDir, filename, options)` отдаёт файл с защитными заголовками; `uploadResponseHeaders`, `safeDownloadName`.

**Хранение.** `generateSafeFilename`, `storeUpload`, `removeUpload`; квоты `getUploadUsage`, `assertUploadQuota`, `noteUploadStored`; уборка `findOrphanUploads` и `removeOrphanUploads(dir, referenced)` — пустое множество `referenced` удалит всё, передавайте его только намеренно.

**Типы и проверки.** `detectFileType`, `assertAllowedFileType`, `validateUpload`, `sanitizeSvg`, `inspectZip`, `listZipEntries`, `detectOfficeType`, `checkZipSafety`, `assertSafeOfficeFile`, `verifyZipData`; изображения — `reencodeImage`, `decodeHeic`, `configureImageConcurrency`, `withImageSlot`; отчёт — `buildDocx`.

**Пример (workshop).** `POST /assets/:id/logo` в `examples/workshop/src/routes.js`: `createMultipartUpload` → `acceptUpload` → запись в БД; при ошибке записи файл удаляется (`removeUpload`), чтобы не оставлять сирот.

**Внимание.** Лимит `maxBytes` обязателен. Имя и тип от клиента не используются. GIF и BMP отклоняются, если не заданы в `passthroughTypes`. Для SVG нужны `jsdom` и `dompurify`.

---

## realtime

`realtime.createEventBus()` — шина событий без привязки к транспорту: `publish(channel, event)` возвращает число доставленных, `subscribe`. `createSseHandler({ eventBus, resolveChannel, heartbeatMs, initialEvent, maxClients, maxBufferedBytes, authorize, reauthorize, reauthorizeMs, maxClientsPerKey, getReplay })` — обработчик Server-Sent Events с проверкой прав, лимитом потоков (общим и на ключ) и ограничением буфера медленного клиента; `closeAllSseStreams()` завершает потоки событием `shutdown` (вызовите из `onDrainStart` при остановке); `createWebSocketHandler` — транспорт WebSocket. Пример: каналы `assets` и `lab` в `examples/workshop/src/routes.js` и `server.js`. Права на поток перепроверяются периодически (`reauthorize`).

---

## scheduler

**Планировщик.** `scheduler.createScheduler(opts)` и `registerJob(name, cron, handler, { catchUp })`; `parseCron`, `getNextRun`. Один выполняющийся экземпляр задачи, пропущенный запуск после простоя наверстывается (`catchUp`, время последнего запуска хранит `createDbLastRunStore`), `acquireFileLock` не даёт CLI и серверу запустить одну задачу одновременно. `scheduler.createScheduleSetting({ db, scheduler, key, jobName, handler, defaults })` делает задачу управляемой из админки: флажок «включено» и время раз в сутки хранятся в базе (`app_settings`), пока их не меняли, действует расписание из конфигурации; `apply()` регистрирует или снимает задачу, `get()` показывает состояние и следующий запуск, `set({ enabled, time })` меняет (`dailyCron`, `timeOfDaily` переводят `ЧЧ:ММ` в cron и обратно). `scheduler.reschedule(name, cron)` переносит зарегистрированную задачу на другое расписание (неверное выражение оставляет всё как было), `listJobs()` отдаёт и исходное расписание (`defaultExpression`). `scheduler.createTaskSchedules({ db, scheduler })` позволяет администратору менять расписание любой задачи: `set(name, { cron | time })`, `reset(name)`, `isOverridden(name)`, `apply()` (один раз после регистрации всех задач, до `start()`); значения хранятся в `app_settings`. `scheduler.describeCron(expr, locale)` читает cron словами. `createScheduler({ onError })` вызывается при ошибке задачи (сбой самого обработчика игнорируется) — сюда подключают `alerts.onJobError`.

**Резервные копии.** `createBackupJob(opts)` создаёт обработчик для планировщика: база и каталог `uploads` в одном zip, шифрование `.zip.enc` при `backup.encryptionKey` (минимум `MIN_BACKUP_KEY_LENGTH`), несколько мест назначения (локальный путь, смонтированный каталог, SFTP) с независимыми сбоями и сроком хранения. Чтение и проверка: `listBackups`, `listRemoteBackups`, `verifyBackupFile`, `restoreBackup`, `resolveDestinations`. Подробности — в [Эксплуатации](10-operations.md).

**Пример (workshop).** `examples/workshop/src/server.js`: задачи `backup`, `uploads-gc`, `audit-anchor`, `sessions-gc`, `audit-gc`, `bans-gc`, `metrics-gc`.

**Внимание.** Восстановление из копии делается только через CLI и при остановленном сервере.


**Стандартная уборка.** `registerStandardJobs(scheduler, { db, logger, sessionStore, bans, metrics, emailQueue, auditRetentionDays, auditPersonalDataDays, auditPurgeBatchSize, mailKeepFinishedDays })` подключает задачи `sessions-gc`, `audit-gc` (только при `auditRetentionDays > 0`), `bans-gc`, `metrics-gc`, `password-resets-gc` (токены и неподтверждённые регистрации), `email-queue-gc`; задача появляется, только если передан её источник. Вызывать один раз до `scheduler.start()`. `standardJobsChecks(scheduler)` для doctor предупреждает, если вызова не было.
---

## csv

`csv.writeCsv(rows, { excel, delimiter, eol, bom, quoteAll, escapeFormulae })` — единственный писатель CSV в ядре (аудит в админке, реестр обработки и CLI `audit export` идут через него). Текст, который электронная таблица прочла бы как формулу (начало с `=`, `+`, `-`, `@`, табуляции, перевода строки, `|` и шаблоны вроде `=cmd|…`), получает апостроф; числа не меняются; защита включена по умолчанию (`escapeFormulae: false` отключает). `bom: true` нужен, чтобы Excel открыл UTF‑8 как UTF‑8; `delimiter: ';'` — для русской локали Excel. `csv.parseCsv(input, { encoding, fallbackEncoding, delimiter, unescapeFormulae, limits })` принимает строку или байты: метка порядка байтов учитывается, иначе пробуется строгий UTF‑8, при неудаче — `windows-1251` (то, что пишет русский Excel); разделитель (`,` `;` табуляция) определяется по первой строке; пределы: 10 МиБ, 20 000 строк, 200 столбцов, 500 000 ячеек (`CsvError` со стабильным `code`: `TOO_BIG`, `TOO_MANY_ROWS`, `TOO_MANY_COLS`, `TOO_MANY_CELLS`, `UNTERMINATED_QUOTE`, `BAD_ENCODING`). Все ячейки — строки; числа и даты из текста понимает `xlsx.mapRows`. Известная неоднозначность: текст, который сам начинался с `'-5`, при записи не меняется, а при `unescapeFormulae` потеряет апостроф.

`excel: 'ru'` — для файла, который человек откроет двойным щелчком в Excel: метка UTF-8 (без неё кириллица превращается в кракозябры) и `;` между полями (это разделитель списков русского Excel; с запятой всё попадает в одну колонку); `excel: 'en'` оставляет запятую. Так пишут выгрузки админки (язык интерфейса) и `privacy registry --format csv`. Для обмена между программами `excel` не нужен.

## xlsx

Excel без внешних библиотек (SheetJS и exceljs отвергнуты: открытые уязвимости и размер); архив читают и пишут `yauzl` и `yazl`, которые в ядре уже есть, и подгружаются при первом использовании.

`xlsx.buildWorkbook({ title, creator, created, sheets: [{ name, columns: [{ header, key, width, format, list, style, headerStyle }], rows, header, freezeHeader, freezeColumns, autoFilter, conditional, merges, tabColor, print }] })` возвращает `Buffer` (`xlsx.XLSX_MIME` — тип содержимого). `format`: `text`, `number`, `integer`, `money`, `percent`, `date`, `datetime`. Значение ячейки: строка, число, логическое, `Date` (UTC) или `{ formula, value }` — формула с сохранённым значением; формулы принимаются только в таком виде и проверяются (нельзя ссылки на другие книги, `HYPERLINK`, `WEBSERVICE`, `INDIRECT` и подобные). Текст всегда записывается как текст, никогда как формула; текст, начинающийся с `=`, `+`, `-`, `@`, получает стиль «текст с апострофом», поэтому остаётся текстом и после правки в Excel (`xlsx.isFormulaLike`). Управляющие символы удаляются, ячейка не длиннее 32767 знаков, листов до 50, имена листов очищаются. `list: ['новая', 'в работе']` делает в столбце выпадающий список (простые тексты без запятых и кавычек, всего до 255 знаков). В книгу пишутся свойства документа, а при наличии формул — пересчёт при открытии; сохранённый результат формулы может быть числом, строкой или логическим значением. Одни и те же данные дают один и тот же файл.

**Вторая проверка схемой Zod.** `mapRows(rows, spec, { schema })`: после правил столбцов (`type`, `required`, `pattern`, `validate`…) каждая строка проходит `schema.safeParse(data)`, где `schema` — схема Zod или любой объект с `safeParse`. Схема видит только уже сопоставленные значения (не лист), может их преобразовать (в `records` попадает результат разбора) и проверить связи между полями (`.refine`). Каждое замечание схемы — ошибка `SCHEMA` со столбцом, на который указывает путь замечания, и текстом замечания в `hint` (до 200 знаков; тексты замечаний пишет приложение, в них не должно быть чужих данных). Исключение внутри схемы — `SCHEMA_ERROR` для строки; схема должна быть синхронной. Строка, не прошедшая схему, не считается принятой, поэтому её ключ `unique` не занимает место: настоящий дубль потом всё равно найдётся.

**Журнал импорта.** `audit.logSpreadsheetImport(db, contextFromRequest(req), { buffer, fileName, read, mapped, error })` пишет в обычный журнал аудита (та же цепочка, псевдонимы и срок хранения) запись `import.spreadsheet`: размер и SHA-256 файла (по нему видно, какой именно файл загружали), формат, число листов и прочитанных строк, `accepted` и `rejectedRows`, счётчики кодов ошибок (`errorCodes: { REQUIRED: 3 }`) и предупреждений. Значений ячеек, заголовков и текстов подсказок в записи нет. Если файл отклонён ещё до сопоставления, передайте `error`: запись получит результат `failure` и `errorCode`. Имя файла сохраняется только если вы его передали (в имени бывает фамилия): оставляйте его, когда оно может содержать персональные данные.

**Скрытые столбцы.** `skipHiddenColumns: true` (`readWorkbook`, `streamSheet`, только `.xlsx`) не отдаёт значения скрытых столбцов: они остаются на своих местах пустыми (`null`), поэтому буквы столбцов, `index` в `mapRows`, объединения и таблицы по-прежнему верны, а скрытые данные не попадают в результат. Для `.ods`, `.xlsb` и `.xls` опция отклоняется с `BAD_OPTION`, а не игнорируется молча. Скрытые строки — отдельная опция `skipHiddenRows`.

**Даты числом.** `dates: 'serial'` (у `readWorkbook`, `streamSheet`, `.xlsb`, `.xls`) оставляет в датированных ячейках номер дня таблицы (45368 вместо даты 17.03.2024); по умолчанию `'date'`. Для `.ods` недоступно (там даты хранятся текстом) и даёт `BAD_OPTION`; любое другое значение — `RangeError`.

**Все пределы в одном файле.** `src/xlsx/limits.js` (`xlsx.DEFAULT_LIMITS`, `xlsx.STREAM_LIMITS`, `xlsx.WRITE_LIMITS`, `xlsx.LIMIT_NOTES`): значения чтения можно поднимать через `limits: {…}` при вызове, пределы записи повторяют потолки Excel и не меняются. В `LIMIT_NOTES` для каждого предела сказано простыми словами, от чего он защищает.

**Ссылки.** Ячейка `{ value: 'Сайт', link: 'https://example.org/' }` пишется как внешняя гиперссылка (если `value` пуст, показывается сам адрес; ссылка красится в синий, подчёркивания в безопасном наборе стилей нет). Разрешены только `https:`, `http:` и `mailto:`; всё остальное (`javascript:`, `file:`, `data:`, `ftp:`, UNC-пути, адрес с логином и паролем, пробелы и управляющие символы, длиннее 2000 знаков, больше 65 530 ссылок на лист) отклоняется с `BAD_LINK`. Ссылка ничего не открывает и не проверяет: это только запись в файл. Работает и в `buildWorkbookStream`.

**Объединения (`merges`).** Диапазон над строкой заголовка при включённом автофильтре отклоняется (`BAD_SHEET`): Excel показывает такие заголовки пустыми. Задайте `autoFilter: false` или объединяйте ниже заголовка.

**Оформление.** `style` столбца (и `headerStyle` для его заголовка) и `style` отдельной ячейки (значение в виде `{ value, style }` или `{ formula, value, style }`, например для цвета статуса) — только из безопасного набора: `bold`, `italic`, `wrap` (логические), `color` и `fill` (имя цвета: `white black grey darkgrey green darkgreen red darkred yellow darkyellow blue darkblue orange darkorange` или строго `#RRGGBB`), `border` (`'thin'` — рамка, `'bottom'` — линия снизу), `align` (`left center right`), `valign` (`top center bottom`). Всё остальное, как и цвет не из этого вида, — ошибка `BAD_STYLE` (в файл ничего подставить нельзя). Стиль ячейки накладывается на стиль столбца; одинаковые стили делят один формат, а различных в книге не больше 1000. Стиль не отменяет защиту: текст, похожий на формулу, остаётся текстом. **Цвет по правилу:** `conditional: [{ column: 'status', rules: [{ equals: 'Готово', style: { fill: 'green', color: 'darkgreen' } }, { contains: 'проср', style: { fill: 'red' } }] }]` (столбец — по `key` или номеру с 0) красит ячейки по значению, поэтому цвет статуса не «залипает», когда человек правит ячейку (стиль ячейки, в отличие от этого, остаётся, как был). Условия: `equals`, `notEquals`, `greaterThan`, `greaterOrEqual`, `lessThan`, `lessOrEqual` (число или текст до 255 знаков), `between: [от, до]`, `contains: 'текст'`; у правила ровно одно условие и `style` из `bold`, `italic`, `color`, `fill`, `border` (выравнивание и перенос правилом не задаются, `BAD_STYLE`). Правила действуют с первой строки данных до конца листа; не больше 20 правил на столбец и 50 столбцов. `merges: ['A1:C1']` — объединение ячеек (номера строк считаются с заголовком; не больше 1000; пересекающиеся, перевёрнутые и из одной ячейки — `BAD_SHEET`), `freezeColumns: n` закрепляет первые `n` столбцов, `tabColor` красит вкладку, `print: { orientation: 'landscape', paper: 'A4' | 'A3' | 'Letter', fitToWidth: true, repeatHeader: true }` — печать по ширине страницы с повтором заголовка на каждой странице. Формулы: функции новее Excel 2007 (`XLOOKUP`, `IFS`, `TEXTJOIN`, `MAXIFS`, `STDEV.S` и другие) получают префикс `_xlfn.` автоматически (кроме текста в кавычках), иначе Excel показал бы `#NAME?`; функции, возвращающие массив (`FILTER`, `SORT`, `UNIQUE`, `LET`, `LAMBDA`, `VSTACK` и подобные), не поддерживаются — `BAD_FORMULA`, результат пишите значениями. Проверено открытием в LibreOffice, в самом Excel — нет.


`xlsx.readWorkbook(buffer, { limits, sheets, fillMergedCells, macros, externalLinks, skipHiddenRows, display, locale, signal })` возвращает `{ sheets: [{ name, hidden, rows, merges, tables }], warnings }` (`tables` — таблицы Excel листа, см. ниже; `limits` по умолчанию — `xlsx.DEFAULT_LIMITS`); строки — массивы значений (строка, число, логическое, `Date`, `null`). Читатель строгий: файл до 10 МиБ, до 200 частей, часть до 64 МиБ в распакованном виде, до 20 000 строк, 200 столбцов, 500 000 ячеек (всё меняется через `limits`); отказ для файлов не из Excel, старых `.xls` и зашифрованных, книг с макросами и внешними ссылками, XML с объявлением типа документа и сущностями (защита от XML-бомб). Формулы не вычисляются: берётся сохранённое значение, число таких ячеек — в `warnings` (`FORMULAS_NOT_EVALUATED`). Даты определяются по формату ячейки (встроенному и собственному, системы 1900 и 1904): время без даты приходит как `Date` на 1899‑12‑30, длительность `[ч]:мм` — числом (в сутках). Объединённые ячейки: значение есть только в левой верхней, диапазоны отдаются в `merges`, а `fillMergedCells: true` копирует значение в остальные. Макросы определяются по тому, что в файле есть на самом деле (проект макросов, листы макросов, тип главной части `macroEnabled`), а не по типам по умолчанию, которые тянут за собой шаблоны Excel (так procure‑it получал ложный отказ). Разбор XML линейный и строгий (невалидный XML — `BAD_XML`; любые префиксы пространств имён, ячейки без адреса, книга ищется через `_rels/.rels`; листы-диаграммы пропускаются с предупреждением `NON_WORKSHEET_SKIPPED`). Имена частей архива приводятся к одному виду (регистр, `\\`, ведущий `/`), поэтому макрос нельзя спрятать необычным написанием пути. Архив проверяется до распаковки: дубли имён (`DUPLICATE_ENTRY`), заявленные размеры, степень сжатия (`ZIP_BOMB`). `skipHiddenRows` пропускает скрытые строки, `signal` (`AbortSignal`) отменяет чтение, которое уступает циклу событий. Скрытые столбцы пока не пропускаются. Файл `.xlsm` по умолчанию отклоняется; `macros: 'ignore'` читает только ячейки, проект макросов не открывается и не запускается. Ошибка — `xlsx.XlsxError` со стабильным `code` (`TOO_BIG`, `TOO_MANY_ROWS`, `MACROS`, `EXTERNAL_LINKS`, `UNSAFE_XML`, `LEGACY_OR_ENCRYPTED`, `NOT_A_WORKBOOK` и другие): текст для человека делает приложение.

**Что читаем, пишем и отказываем.**

| Формат / содержимое | Читаем | Пишем | Отказываем |
|---|---|---|---|
| `.xlsx` | да (`readWorkbook`, `readSpreadsheet`) | да (`buildWorkbook`) | зашифрованные, с внешними ссылками (кроме `externalLinks: 'ignore'`), DOCTYPE и сущности в XML |
| `.xlsm` | ячейки, при `macros: 'ignore'` | нет | проект макросов не открывается и не запускается; без `macros: 'ignore'` — отказ |
| `.xlsb`, `.ods`, `.xls` (BIFF8) | да (`readSpreadsheet` определяет по содержимому) | нет | шифрованные, с макросами, Excel 5 и старше (`.xls`) |
| Формулы | сохранённое значение, число формул — в `warnings` | только `{ formula, value }` с проверкой | не вычисляются никогда |
| Значение «как показано» | да (`display: true`) | не применимо | — |
| Таблицы Excel (ListObject) | да (только `.xlsx`) | нет | — |
| Гиперссылки | не читаем | `link` в ячейке (https, http, mailto) | — |
| Большие файлы потоком | `.xlsx`: `streamSheet` по строке | `buildWorkbookStream` | — |
| Гиперссылки, картинки, графики, сводные, срезы, условное форматирование | нет | нет | не читаются и не загружаются |
| Оформление в писателе | — | числовые форматы столбцов, ширина, закрепление строки и столбцов, автофильтр, выпадающий список, стили из безопасного набора, цвет по правилу (условное форматирование), объединение ячеек, печать, цвет вкладки | произвольные шрифты и цвета, картинки не пишутся |
| CSV | да (`parseCsv`) | да (`writeCsv`, с защитой от формул) | — |

**Другие форматы.** `xlsx.readSpreadsheet(buffer, опции)` определяет формат по содержимому, а не по имени файла (имя выбирает тот, кто загружает), и возвращает то же самое, что `readWorkbook`, плюс `format`: `'xlsx'` (включая `.xlsm`), `'xlsb'`, `'ods'` или `'xls'`. Те же читатели доступны по отдельности: `xlsx.readXlsb`, `xlsx.readOds` и `xlsx.readXls`. Правила у всех одни: те же пределы (`limits`), те же отказы (шифрование, макросы, внешние ссылки, XML с типом документа), формулы не вычисляются, а число таких ячеек идёт в `warnings`. `.xlsb` разбирается по записям с проверкой границ каждой записи (повреждённый файл — `BAD_BINARY`, а не догадка). `.ods`: повторы («миллион пустых строк» — так заканчивается любой `.ods`) не раскрываются, пока в строках нет данных, а данные считаются в пределы заранее; примечания, рисунки и вложенные таблицы не попадают в текст ячейки; скрытый лист определяется по стилю. Внешние ссылки по умолчанию отклоняются; `externalLinks: 'ignore'` читает сохранённые значения (ничего не загружается) и добавляет предупреждение `EXTERNAL_LINKS_IGNORED`. Старые `.xls` (Excel 97–2003, BIFF8 в контейнере OLE2) читает `xlsx.readXls` (и `readSpreadsheet`, `format: 'xls'`): контейнер разбирается с проверкой каждого сектора и цепочки (петля, выход за файл, заявленный размер больше фактического — `BAD_CONTAINER`), записи — с проверкой границ (`BAD_BINARY`); отказ для зашифрованных (`FILEPASS`, шифрованный `.xlsx` в том же контейнере), с макросами (проект макросов или лист макросов), со ссылками на другие книги (`externalLinks: 'ignore'` разрешает чтение сохранённых значений) и для версий Excel 5 и старше (`UNSUPPORTED_FORMAT`). Общие строки, продолжающиеся в `CONTINUE` (в том числе со сменой 8-/16-битного текста), даты по формату ячейки, RK/MULRK, результаты формул, объединения, скрытые листы и строки читаются так же, как в `.xlsx`. Для `readXlsx`/`readWorkbook` (только `.xlsx`) старые файлы по‑прежнему дают `LEGACY_OR_ENCRYPTED`.

**Большие файлы построчно.** `xlsx.streamSheet(buffer, { sheet, limits, display, locale, skipHiddenRows, macros, externalLinks, signal })` открывает один лист `.xlsx` (по имени или по номеру с 0; без `sheet` — первый) и отдаёт строки по одной: `const s = await xlsx.streamSheet(buf, { sheet: 'Заявки' }); for await (const { row, values, shown } of s.rows) { … }`. Строка не копится: в памяти файл, общие строки и одна порция строк (на файле в 300 тысяч строк по 5 столбцов пик памяти был около 100 МБ против около 600 МБ у `readWorkbook`; читается медленнее, на этом файле 7 с против 4 с). `row` — номер строки листа с 1, пустые строки пропускаются, `values` без хвостовых пустых; `s.merges`, `s.tables` и `s.warnings` полные, когда строки прочитаны (`tables` — сразу). Лист распаковывается по ходу чтения и считается (`limits.maxSheetBytes`, по умолчанию 1 ГиБ; `maxRows` по умолчанию 1 048 576 и `maxCells` 20 млн — значения `xlsx.STREAM_LIMITS`); остальное как у `readWorkbook`: архив проверяется заранее, макросы, внешние ссылки, шифрование и тип документа в XML отклоняются, CDATA в потоковом листе не принимается (`UNSAFE_XML`), неизвестный лист — `NO_SUCH_SHEET`. Сам файл всё равно целиком в `Buffer`, поэтому для большой выгрузки поднимайте `limits.maxBytes` (10 МиБ по умолчанию). `fillMergedCells` в потоке не работает (объединения известны только после последней строки). Только `.xlsx`/`.xlsm`; `.xlsb`, `.ods`, `.xls` читаются целиком.

`xlsx.buildWorkbookStream(book)` пишет книгу потоком: `rows` листа может быть любым итерируемым или асинхронно итерируемым (курсор базы, генератор), строки превращаются в XML и сразу уходят в архив, `Promise<Readable>` отдаёт `pipeline(await xlsx.buildWorkbookStream(book), res)`. Все проверки `buildWorkbook` (стили, формулы, имена, пределы) сохраняются; что неверно в самом листе (имя, стиль столбца, объединения), находится до первого байта, а неверная ячейка или ошибка источника посреди выгрузки обрывает поток с этой ошибкой, поэтому получатель обязан считать оборванный поток негодным файлом (не «почти готовым»). Части, зависящие от всех строк (стили, признак формул, диапазон автофильтра), пишутся в конце архива.

**Значение «как показано».** Опция `display: true` (и `locale: 'en' | 'ru'`, по умолчанию `'en'`) добавляет к каждому листу матрицу `shown` — той же формы, что `rows`, но с текстом, который человек видит в ячейке: `1 234,50 ₽`, `02.11.2026`, `25,6%`, `ИСТИНА`, `#DIV/0!`. Типизированные `rows` не меняются (цифра остаётся числом, дата — датой), `shown` лежит рядом, поэтому ничего не теряется. Работает для .xlsx/.xlsb/.xls (по числовому формату ячейки: разделы, условия `[>100]`, дроби, `E+`, `[h]:mm`, AM/PM, месяцы по-русски, системные `[$-F800]`/`[$-F400]`) и .ods (берётся текст, который программа записала в ячейку). Текст остаётся как есть, числа — по формату; отступы для выравнивания (`_)`, `* `) отбрасываются, пробел в разделителе тысяч для `ru` неразрывный, как в Excel. Известные пробелы: цвета и символы-заполнители не воспроизводятся, `General` даёт до 15 значащих цифр (Excel обрезает по ширине столбца), календарные эры (`e` для тайваньского года) не поддержаны. Движок отдельно: `xlsx.createFormatter({locale, date1904}).show(value, 'dd.mm.yyyy')`.

**Файлы от посторонних.** `xlsx.readSpreadsheetIsolated(buffer, опции)` — то же чтение, но в отдельном потоке: у него своя куча с потолком (`maxMemoryMb`, по умолчанию 512; файлу не хватило памяти — `RESOURCE_LIMIT`, а сервер не страдает), своё время (`timeoutMs`, по умолчанию 30 с; зависший разбор останавливается принудительно — `TIMEOUT`), пустое окружение (поток не видит секретов процесса) и остановка по `signal`. Ошибки — те же `XlsxError` с теми же кодами; результат тот же, включая `format`. Опции — те, что можно скопировать в другой поток (поэтому нельзя передать `zip`). Для файлов, которые загружают пользователи, берите его; обычный `readSpreadsheet` — для своих файлов. В обычный `readSpreadsheet` добавлены `timeoutMs` (читатель часто отдаёт управление, поэтому часы замечаются) и `hiddenSheets`: `'include'` (по умолчанию) читает скрытые листы и сообщает об этом предупреждением `HIDDEN_SHEETS_READ`, `'skip'` оставляет их (`HIDDEN_SHEETS_SKIPPED`): скрытый лист — это данные, которые автор файла не показывал, поэтому импорт должен либо показать их в предпросмотре, либо не брать.

`mapRows`: `pattern` — регулярное выражение приложения, которое запускается на тексте из файла, поэтому текст сначала проверяется по длине: по `max` столбца, а если его нет — не длиннее 1000 знаков (`TOO_LONG`); плохо написанное выражение не получит огромную ячейку. Флаги `g` и `y` в `pattern` отбрасываются (с ними `test` помнит позицию и на разных строках отвечает по-разному).

`xlsx.mapRows(rows, { columns: { ключ: { header, type, required, max, min, allowed, pattern } } })` для импорта: находит строку заголовков (среди первых 10), сопоставляет столбцы по тексту заголовка (без учёта регистра, допускаются синонимы), приводит значения (`string`, `number` с десятичной запятой или точкой и разделителями тысяч, `integer`, `date` в виде ISO, ДД.ММ.ГГГГ или номера дня Excel, `boolean`) и возвращает `{ records, errors, missingColumns, unknownColumns, duplicateColumns, headerRow, truncated }`; у столбца ещё `default`, `unique` (повтор — `DUPLICATE`) и `normalize` (например, привести «Используеться» к «используется» до проверки `allowed`); у каждой ошибки номер строки, ключ столбца и код (`REQUIRED`, `TOO_LONG`, `NOT_A_NUMBER`, `OUT_OF_RANGE`, `NOT_A_DATE` и т. д.). Ничего не сохраняется: приложение показывает предпросмотр и сохраняет после подтверждения. Загруженный файл сначала проверяйте `files.acceptUpload`.

**Таблицы Excel и листы без заголовка.** Читатель `.xlsx` отдаёт для каждого листа `tables: [{ name, c1, r1, c2, r2, headerRow, totalsRow, columns }]` (границы — как у `merges`: `r` с 1, `c` с 0; у остальных читателей поля `tables` нет). Таблица Excel — надёжная подсказка строки заголовков: `mapRows(rows, spec, { table: sheet.tables[0] })` берёт первую строку таблицы как заголовок, читает только её ячейки и не берёт итоговую строку, а номера строк в ошибках остаются номерами листа. Другие подсказки: `headerRow: 7` (номер строки заголовка прямо), `header: false` с `firstRow` (лист без заголовка: столбцы находятся по `index`). У столбца `index` — номер с 0 или буквы (`'C'`): столбец, который берётся, если текст заголовка не найден, а при `header: false` единственный способ. `validate(значение, запись)` выполняется последним и возвращает ничего (всё хорошо), строку-код ошибки или `false` (код `INVALID`). Если значение не входит в `allowed` и отличается от допустимого на пару букв («Используеться», «резрев»), в ошибке `NOT_ALLOWED` есть `hint` с ближайшим допустимым: превью может спросить «имелось в виду…».


**Внимание.** Читатель не доверяет файлу, но и не заменяет проверок приложения: значения из файла проходят ту же проверку (Zod), что и ввод в форме.

---

## health

`health.checkHealth(db, { version })` и `healthHandler(db, opts)` — быстрая проверка «процесс жив и отвечает» для `GET /health`; ухудшение — ответ 503, не 500; `minimal: true` скрывает подробности. `health.runDoctor(categories)` — диагностика установки по категориям (`runtimeChecks`, `databaseChecks`, `storageChecks`, `securityChecks`, `applicationChecks`, `certChecks`, `emailChecks`); `formatDoctorText`, `formatDoctorJson`; `localizeDoctor(отчёт, 'ru'|'en')` переводит названия категорий, проверок и сообщения на русский (раздел «О системе» и `doctor --lang ru` используют его; идентификаторы проверок остаются английскими, строка без правила остаётся на английском). Приложение собирает свои категории (пример: `examples/workshop/src/doctor-categories.js`). Результат показывает раздел «О системе» в админке и CLI `doctor`. `dependencyChecks({ lockFile, db, ignore, … })` и `nodeVersionChecks()` (категория «Dependencies», см. «Эксплуатацию»); `applicationChecks({ host, port, inProcess })` проверяет порт: из CLI занятый порт — предупреждение («возможно, сервер уже запущен»); внутри самого сервера (`inProcess: true`: раздел «О системе», плановая диагностика) занятый порт — норма, а свободный означает, что приложение не слушает настроенный порт.

---

## certs

`readCertInfo(pem)` — срок, `subjectAltName`, самоподписанный ли (чистый `node:crypto`); `generateSelfSignedCert(opts)`; `writeCertFiles(dir, { cert, key })` (ключ с правами только для владельца), `certFilePaths(dir)`; `certChecks` — категория doctor. CLI: `cert info|generate|renew|trust`.

---

## email

`email.createEmailService({ config, brandName, queue })` — письма системы; `createEmailQueue(…)` — очередь с повторами, отзывом по адресу (`cancelForAddress`), `expireStale`, `purgeFinished`; `renderEmail(scenario, data)` с экранированием (`SCENARIOS`); `checkMailDomainDns` проверяет SPF и DMARC домена отправителя; `emailChecks` — категория doctor. Выключено по умолчанию: при включении нужны `from` и `smtp.host`. Пароль SMTP — `env:NAME`. Пример: `examples/workshop/src/context.js`.

---

## about

Публичная страница «О платформе» (без входа): `about.mountAboutPage(app, { appName, appVersion, apps, author, copyright, licenseUrl, repositories, description, brand })` отдаёт `/about` с описанием, версиями ядра и приложений (у приложения может быть свой логотип: путь на этом сайте или адрес https, и ссылка на репозиторий), лицензией MIT с держателем прав, автором и ссылками на исходный код. Версии Node, система, пути и списки зависимостей на ней не показываются, это остаётся в админке. Маленькая строка «Powered by DAS-Forge <версия>» на каждой странице ведёт на эту страницу (`linkPoweredBy: false` оставляет ссылку на репозиторий). Имена, описания и ссылки экранируются; допускаются только https-ссылки.

## notifications

Уведомления людям: одно общее место, куда пишет любой модуль или приложение, и колокольчик со страницей, которые читают. `notifications.createNotifications({ db, keepDays = 90, maxPerUser = 200 })` даёт `notify({ userId, title, body, link, severity, category })` (важность `info`/`warning`/`critical`; ссылка только внутри приложения: `/путь`, не `//`, не `http:`), `notifyMany(userIds, what)`, `notifyRole(role, what)` (всем включённым пользователям роли), `list`, `unreadCount`, `markRead(userId, id)` (только владелец), `markAllRead`, `purge()` (удаляет прочитанные старше `keepDays`; непрочитанные не трогает). Каждый пользователь сам выбирает, что получать: `setPref(userId, category, level)` и `prefs(userId)`; уровень `off`, `info` (всё), `warning` (важные и критичные) или `critical`; пока выбора нет, приходит всё. Выбор применяется внутри `notify`, поэтому производителям уведомлений ничего учитывать не нужно. `mountNotificationsPage(app, { notifications, requireAuth, render, categories })` монтирует страницу `/ui/notifications` с кнопками «прочитано» и формой выбора по категориям; `bellHtml({ url, count, locale })` даёт колокольчик для шапки (`renderAppShell({ bellHtml, userBadge })`; `userBadge` показывает тип учётной записи значком рядом с именем). `createAdmin({ notifications, notificationsUrl })` показывает колокольчик и в админке. `createAlerts({ onRaised })` вызывается для каждого нового алерта (не для повтора в паузе), через него алерты попадают в колокольчик администраторов; ошибка слушателя на алерты не влияет.

## alerts

`alerts.createAlerts({ db, email, contacts, logger, cooldownMs, keepDays, locale })` превращает «что-то не так» в запись таблицы `alerts`, строку лога и (если почта включена) письмо контактам `security.incidentContacts`. `raise({ key, severity, title, message })` не бросает исключений; тот же `key` в пределах `cooldownMs` только увеличивает счётчик повторов, письмо второй раз не уходит (кеш в памяти: после перезапуска повтор объявляется ещё раз). Сбой почты не прячет алерт: в строке остаётся `notify_error`. Готовые источники: `onJobError` (для `createScheduler({ onError })`; сбой копии — критический), `lockoutWatcher` (для `createFailureTracker({ onLock })`: много блокировок за короткое время похоже на подбор паролей), `checkAuditChain`, `checkDoctor` (пропускает «Port availability»), `watch(scheduler, { doctor, doctorSchedule, auditSchedule })` регистрирует задачи `alerts-doctor`, `alerts-audit-chain`, `alerts-purge`. `list()` и `purge()` — чтение и очистка. Параметры — раздел `alerts` конфигурации; в админке — раздел «Алерты»; подключение и таблица источников — «Эксплуатация». Пример: `examples/workshop/src/context.js` (`buildAlerts`) и `server.js`.

---

## qr

`qr.generateQrSvg(text, options)` возвращает SVG-строку (нужен `qrcode`); размер в пикселях (`size`, по умолчанию 256, `0` — оставить странице) записывается в корневой элемент: SVG только с `viewBox` внутри блока «по размеру содержимого» схлопывается в ноль. Используется для привязки TOTP; пример — маршрут `POST /totp/enroll/qr.svg` в workshop.

---

## logs

`logs.createLogger({ pretty, … })` — логгер (pino) с редактированием значений по имени ключа (`password`, `token`, `secret`, `authorization`, `cookie`, …), ошибками как объектами и защитой от исключений; в терминале каждая строка запроса и аудита сжимается (`GET /admin 401 15ms`, `audit auth.login success`), в JSON остаются все поля. `logs.accessLog(…)` — журнал доступа (4xx — info, 429 — warn, 5xx — error). `logs.createLogDestination({ sinks })` рассылает строки по приёмникам: `stdout`, `file` (в том числе сетевой путь, права 0600, ротация), `syslog` (RFC 5424: UDP, TCP, TLS), `http` (Loki, Elasticsearch, Splunk HEC, NDJSON); запись не ждёт сеть, есть буфер и повтор, при недоступности — локальный резерв. `mirrorAuditToLogs` и `logAuditAnchor` дублируют аудит и якорь цепочки в журнал. Секреты приёмников — `env:NAME`; https обязателен, кроме localhost. Хотя бы один приёмник нужно вынести с машины приложения. `logs.accessLog(logger, { skip, ipMode })` — строка на запрос без query-строки и заголовков; `ipMode: 'truncate'` сокращает адрес (`203.0.113.0`, IPv6 до /48), `'none'` не пишет его, по умолчанию `'full'` (workshop: `truncate`; полный адрес остаётся в аудите). `logs.anonymizeIp(ip, mode)` — то же для своих журналов.

---

## modules

Контракт модуля приложения. `modules.createModuleRegistry()` и `registerModule({ … })` собирают регистрации; схема `ModuleRegistrationSchema`:

| Поле | Что делает ядро |
|---|---|
| `permissions`, `fieldPermissions` | используются `http.serialize` |
| `cliCommands` | добавляются в CLI |
| `navigation` | меню оболочки (`registry.getNavigation()`) |
| `translations` | словари оболочки (`getTranslations()`), конфликт ключей — ошибка |
| `search` | провайдеры поиска (`getSearchProviders()`, `ui.searchModules`) |
| `routes` | хранятся; клиентских компонентов в ядре нет |
| `dataSubject` | экспорт и стирание данных модуля для `privacy` |

Пример: `examples/workshop/src/modules/reporting-module.js` (все поля реальные, не заглушки).

---

## ui

`ui.renderAppShell({ moduleRegistry, viewerPermissions, locale, activePath, title, bodyHtml, theme, user, brandHtml, nonce, bodyEndHtml, extraNav })` возвращает полную HTML-страницу: меню по правам (пункт с `permission` скрыт без права), шапка с именем пользователя, кнопкой языка и иконкой темы, содержимое, подвал. Вывод экранируется, кроме `bodyHtml`, `bodyEndHtml` и `brandHtml`: это доверенная разметка вызывающего. Также: `ui.localeMiddleware`, `langSwitchHtml`, `poweredByHtml(locale)` (строка «Powered by DAS-Forge» с логотипом ядра, стоит на каждой странице оболочки), `themeHead`, `themeToggleHtml`, `THEME_TOKENS`, `tokenCss`, `BASE_CSS`, `THEME_SCRIPT`, `MODAL_SCRIPT` (`admDialog.alert|confirm|prompt` и `data-confirm` на кнопках), `searchModules`, `translate`. См. [Переводы](06-translations.md) и [Темы и оформление](07-themes-and-branding.md).

**Внимание.** Меню берёт `path` как серверный маршрут приложения; клиентской маршрутизации и компонентов в ядре нет.

---

## branding

Два слоя. **Личность производителя** (`defineVendorIdentity`, `resolveVendorLogo`, `readVendorLogo`) — файлы `assets/brand/logo*.svg|png|jpg`, не меняются из интерфейса; **оформление компании** (`getCompanyBranding`, `setCompanyBranding`, `getEffectiveBranding`, `themeWithBranding`, `brandingHtml`, `brandBlockHtml(db, vendorIdentity)` (блок «логотип + название» для любой страницы: оформление администратора, иначе личность приложения), `mountLogoRoute`, `readableOn`) — редактируется администратором. Подробности — [Темы и оформление](07-themes-and-branding.md).

---

## maintenance

**Назначение.** Режим обслуживания. `createMaintenance({ db, cacheMs })` возвращает `get`, `enable({ message, until, by })`, `disable`, `retryAfterSec`, `middleware({ vendorIdentity, permission, allowPaths, bypass, brand, bodyEnd, theme })`. Состояние хранится в `app_settings`; `enable` бросает `MaintenanceError` с кодом `MESSAGE_TOO_LONG` или `UNTIL_INVALID`. Подключайте middleware после сессий и до маршрутов. Раздел в админке — см. [Администрирование](05-administration.md).

## announcement

**Назначение.** Короткое объявление над страницами приложения («сегодня в 22:00 плановые работы»), в отличие от режима обслуживания страницы остаются доступными. `announcement.createAnnouncement({ db, cacheMs })` возвращает `get`, `active`, `set({ message, level, until, by })`, `clear`, `bannerHtml(locale, { nonce })`, `audited`.

**По умолчанию.** Одно объявление: текст до 300 символов, важность `info`, `warning` или `critical`, необязательное время окончания (после него баннер пропадает сам). `info` и `warning` читатель может скрыть крестиком; выбор помнится в его браузере, пока текст не изменится. `critical` скрыть нельзя. Текст экранируется. Состояние хранится в базе (`app_settings`), общее для всех процессов, процесс перечитывает его не реже раза в 2 секунды. Ошибки ввода: `AnnouncementError` с кодом `MESSAGE_REQUIRED`, `MESSAGE_TOO_LONG`, `LEVEL_INVALID`, `UNTIL_INVALID`.

**Как подключить.** Раздел «Объявление» в админке включается опцией `announcement` у `createAdmin`; баннер на страницах админки появляется сам. На страницы приложения его выводит оболочка: `ui.renderAppShell({ ..., bannerHtml: announcement.bannerHtml(locale, { nonce }) })`. Пример: `examples/workshop/src/server.js` кладёт функцию в `res.locals.banner`, а `appShell` в `src/routes.js` передаёт её результат оболочке. Страницы вне оболочки (вход, ошибки) баннер не показывают.

## accounts

**Назначение.** Готовые маршруты и страницы учётной записи для приложения. `accounts.mountAccountRoutes(app, { db, authProvider, appConfig, bans, onLock, emailService, logger, permissionsForRole, mfaRequiredForRole, appName, vendorIdentity, theme, brand, texts, pages, accountShell, accountPath, homePath, passwordChangePath, allowDuringPasswordChange })` подключайте после сессий.

**Маршруты (JSON).** `POST /login` (шаг 1: пароль; пользователь с активным TOTP получает короткую «ожидающую» сессию), `POST /login/totp` и `POST /login/recovery` (шаг 2), `POST /logout`, `GET /me` (строгий список полей), `POST /password/change`, `POST /password/forgot` и `POST /password/reset` (ссылка на почту, ответ всегда 202), `POST /account/email`, `GET /totp/authenticators`, `POST /totp/enroll/start|qr.svg|verify`, `POST /totp/authenticators/:id/remove`, `POST /recovery-codes/generate`, `GET /recovery-codes/remaining`, а также `GET /` (вход или `homePath`) и `GET /favicon.ico` (204).

**Страницы.** Ядро рисует `GET /login` (два шага, второй — код TOTP или восстановления), `/forgot-password`, `/reset-password` (токен в адресе после `#`, в логи не попадает), страницу обязательной смены пароля (`passwordChangePath`, по умолчанию `/ui/password`) и, если передан `accountShell(req, res, { title, bodyHtml, activePath })`, страницу «Аккаунт» (`accountPath`, по умолчанию `/ui/account`: пароль, e-mail, интерфейс, аутентификаторы, коды восстановления). Страница разбита мини-меню на четыре части: «Смена пароля», «E-mail», «Интерфейс», «Двухфакторная аутентификация» (вместе с кодами восстановления); часть выбирается якорем (`#pw`, `#email`, `#ui`, `#mfa`), без скрипта видны все части сразу. Блок «Интерфейс» даёт выбор языка (`?lang=ru|en`, cookie `das_lang`) и темы (как в системе, светлая, тёмная; ключ `adm-theme` в браузере, тот же, что у переключателя в шапке); выбор хранится в браузере, а не в учётной записи внутри страницы приложения. Страницы показывают блок бренда (`vendorIdentity`: название и логотип из «Оформления», иначе приложения; свой блок задаёт `brand(req) => { theme, html }`), строку «Powered by DAS-Forge», кнопки языка и темы; в заголовке стоит `appName`. Тексты — `ACCOUNT_TEXTS` (ru/en), переименовываются через `texts` или `i18n.setTextOverrides({ accounts: … })`. Любую страницу можно заменить своей функцией `pages: { login, forgotPassword, resetPassword, forcedPassword }` вида `(req, res) => html` или выключить значением `false`.

**Защита.** Лимит запросов `security.loginRateLimit`; блокировка после неудачных входов по трём счётчикам (имя + адрес, имя, адрес; настраивается `security.lockout`) с записью `auth.lockout` в аудит; общий счётчик ошибок второго шага на пользователя; выравнивание времени ответа для неизвестного имени; новая сессия при каждом входе; секреты TOTP хранятся зашифрованными (ключи `auth.totpEncryptionKey`, `previousTotpEncryptionKeys`, секреты сессий). Пока включена обязательная смена временного пароля, закрыты все пути, кроме `/password/change`, `/logout`, `/me`, `/login`, `/`, `/favicon.ico` и перечисленных в `allowDuringPasswordChange`; браузер отправляется на `passwordChangePath`.

**Что решает приложение.** `permissionsForRole(role)` — права по роли; `mfaRequiredForRole(role)` — роли, которые не могут снять последний фактор. Возвращает `{ forgetLoginFailures(username), userPublicShape(user), totpKey }`: первое вызывают после сброса пароля администратором. Все действия пишутся в аудит (`auth.login`, `auth.login.totp`, `auth.password_change` и другие).

## admin

Админ-панель `/admin`: `admin.createAdmin({ … }).mount(app, { requireAuth, requirePermission })`, `createMetrics`, графики `svgBarChart` и `svgLineChart`. Полное описание — [Администрирование](05-administration.md).

---

## observability

`observability.createPrometheusMetrics({ config, version })` (асинхронная) создаёт сборщик, только если включено `observability.metrics.enabled`; иначе возвращает `null`. Методы: `middleware()` (счётчик и длительность запросов по шаблону маршрута, подключается как можно раньше), `mount(app)` (`GET /metrics`, адрес из `observability.metrics.path`), `registry`. `observability.registerCoreGauges(prom, { db, mailQueue, lastBackupAt, maintenance })` добавляет показания: активные сессии, очередь почты, возраст последней копии, действующие блокировки, незакрытые инциденты, тревоги за сутки, режим обслуживания. Эндпоинт отвечает только адресам из `allowIps` или владельцу токена, остальным 404. Настройки: [Настройка → observability](03-configuration.md#observability); подключение к Prometheus: [Эксплуатация → Метрики](10-operations.md). Пример: `examples/workshop/src/server.js`.

---

## i18n

`i18n.createI18n({ locales, defaultLocale, namespaces })` — переводы на i18next (асинхронно); `i18n.createI18nSync({ i18next, … })` — то же синхронно, для страниц, которые строятся в синхронных функциях. См. [Переводы](06-translations.md).

---

## cli

Каркас CLI: `cli.createCli`, `parseArgs`, коды завершения `EXIT`, регистрация групп команд (`registerConfigCheckCommand`, `registerUserCommands`, `registerMigrateCommands`, `registerBackupCommands`, `registerHealthCommand`, `registerDoctorCommand`, `registerDbCommands`, `registerAuditCommands`, `registerBanCommands`, `registerVersionCommand`, `registerPrivacyCommands`, `registerCertCommands`, `registerDepsCommands`), миграции `runMigrations` и `migrationStatus`. Файлы с персональными данными пишутся безопасно (`writeOwnerOnly`: права 0600, без перезаписи без `--force`). Справочник команд — [CLI](08-cli.md).

---

## Вспомогательные функции

Функции ниже экспортирует ядро, но в повседневной работе они нужны реже основных. Группировка по модулям.

| Модуль | Функции | Для чего |
|---|---|---|
| `auth` | `countUsers`, `findUserByUsername`, `findUserByEmail` (пустой результат, если адрес у нескольких учётных записей), `createUser`, `setUserRole`, `updatePasswordHash`, `setTotpSecret`, `anonymizeUser`, `deleteUser` | низкоуровневые операции над таблицей `users`; для управления из интерфейса используйте функции раздела «Управление пользователями», они отзывают сессии и защищают последнего администратора |
| `auth` | `validateUsername`, `isAnonymizedUser`, `forceUserLogout`, `UserAdminError` | проверка логина (3–64 символа: буквы, цифры и `. _ @ -`; префикс обезличенных записей занят), признак обезличенной записи, выход из всех сессий, ошибка с кодом (`USERNAME_INVALID`, `USERNAME_TAKEN`, `EMAIL_INVALID`, `EMAIL_TAKEN`, `ROLE_INVALID`, `LAST_ADMIN`, `NOT_FOUND`) |
| `auth` | `verifyTotpLogin`, `generateTotpSecret`, `purgeExpiredPendingAuthenticators`, `isSealed`, `PASSWORD_ABSOLUTE_MAX` | проверка кода при входе, секрет TOTP, уборка неподтверждённых аутентификаторов, признак зашифрованного секрета, предельная длина пароля |
| `auth` | `passwordConcurrencyStats`, `loadExpressSession`, схемы `UserSchema`, `SessionSchema`, `AuthenticatorSchema`, `RecoveryCodeSchema`, `ensureAuthTables` | счётчики очереди хеширования, ленивая загрузка `express-session`, схемы таблиц и их создание |
| `audit` | `normalizeTimestamp`, `AuditEntrySchema`, `ensureAuditTable`, `ERASED` | время записи в одном формате, схема записи, создание таблицы, маркер стёртого субъекта |
| `branding` | `CORE_IDENTITY`, `brandingUploadDir`, `ensureSettingsTable` | личность ядра для страницы «О системе», каталог файлов оформления, таблица настроек `app_settings` |
| `database` | `DEFAULT_FTS_TOKENIZER`, `MAX_IN_VALUES` | токенизатор FTS5 по умолчанию, предел значений в одном `IN (…)` |
| `email` | `EmailError`, `EmailQueueError`, `senderDomain`, `escapeHtml` | ошибки с устойчивым `code` (в тексте нет секретов), домен отправителя, экранирование для шаблонов |
| `email` | `queue.list({ limit, status })` | последние строки очереди для раздела «Почта»: адреса уже сокращены, текстов писем нет |
| `files` | `imageConcurrencyStats`, `ImageBusyError`, `invalidateUploadUsage`, `loadMulter` | очередь обработки изображений и её переполнение, сброс кэша занятого места, ленивая загрузка `multer` |
| `logs` | `createStdoutSink`, `createFileSink`, `createSyslogSink`, `createHttpSink`, `createBufferedSink`, `formatSyslog`, `resolveEnvRef`, `streamOfLine`, `STREAMS`, `HTTP_SINK_FORMATS` | приёмники логов по отдельности (обычно их собирает `createLogDestination` из `logging.sinks`), буфер с повторами, строка syslog (RFC 5424), раскрытие `env:ИМЯ`, поток строки (`app`, `access`, `audit`, `security`) |
| `policy` | `renderPolicyText`, `KINDS`, `POLICY_UI_TEXTS`, `ensurePolicyTable` | разметка текста политики в безопасный HTML (заголовки, списки, жирный, код, ссылки только http(s)/mailto/относительные), виды текстов, тексты интерфейса, таблица |
| `qr` | `withSize` | запись размера в корневой элемент готового SVG |
| `scheduler` | `encryptBackupFile`, `decryptBackupFile`, `isEncryptedBackup`, `BackupCryptoError`, `createMountTarget`, `createSftpTarget`, `normalizeFingerprint`, `readLockOwner` | шифрование копий (`.zip.enc`), цели «смонтированная папка» и SFTP по отдельности, приведение отпечатка ключа хоста, кто держит файловую блокировку задачи |
| `security` | `normalizeBanValue`, `ensureBansTable` | приведение значения бана к единому виду (обрезка пробелов, IPv4-адрес в записи IPv6 `::ffff:…` как обычный IPv4; не IP — ошибка), создание таблицы |
| `i18n` | `getTextOverrides`, `pickTexts`, `DEFAULT_LOCALES` | чтение переопределений, выбор текстов по языку с учётом переопределений, список языков |
| `admin` | `readForm`, `compareVersions`, `readDependencies`, `checkLatest`, `flattenConfig`, `ensureMetricsTable`, `hourBucket`, `OVERVIEW_TEXTS`, `ALERT_TEXTS`, `SYSTEM_TEXTS` | разбор формы без body-parser (до 16 КБ), сравнение версий x.y.z, чтение зависимостей, запрос последних версий в реестре npm, плоский вид конфигурации без секретов, таблица метрик, словари разделов |
| `alerts` | `SEVERITIES` | допустимые уровни важности: `info`, `warning`, `critical` |
| `ui` | `modalScript`, `UI_TEXTS`, `uiTexts`, `CREATED_BY_CSS`, `LOGO_CSS`, `THEME_BUTTON_CSS`, `parseUtc`, `formatUtc` | скрипт диалогов, общие тексты оболочки, куски стилей, разбор и вывод дат в UTC |
| `config` | `ServerConfigSchema`, `DatabaseConfigSchema`, `BackupConfigSchema`, `BackupDestinationSchema`, `UiConfigSchema`, `ModuleEntrySchema`, `SecurityConfigSchema`, `AuthConfigSchema`, `PerformanceConfigSchema`, `UploadsConfigSchema`, `EmailConfigSchema` | схемы разделов конфигурации по отдельности, чтобы приложение собирало свою схему из готовых частей |

## Что требует внимания при разработке

1. **Порядок middleware** важен: локаль → ошибки → заголовки → тела → cookie-parser → CSRF → сессии → `attachUser` → баны → маршруты → обработчики 404 и 500.
2. **Ядро — механизм, приложение — смысл.** Права, роли, имена полей и тексты задаёт приложение (контракт `Module`), а не ядро.
3. **Хеширование паролей** делает `AuthProvider` приложения; не храните пароль нигде, кроме хеша.
4. **Права поля вырезаются на сервере** (`serialize`), а не скрываются в интерфейсе.
5. **Стирание** должно отзывать письма из очереди и стирать данные собственных таблиц модуля.
6. **Загрузки** только через `acceptUpload`, выдача только через `sendUpload`; каталог брендинга отделён от загрузок приложения.
7. **Задачи обслуживания** (`sessions-gc`, `audit-gc`, `bans-gc`, `metrics-gc`, `uploads-gc`, очистка токенов сброса, резервные копии) регистрируйте в планировщике: ядро само их не запускает.
8. **Нативные пакеты** после `npm install` требуют одобрения скриптов установки.

**См. также:** [Конфигурация](03-configuration.md), [Безопасность](04-security.md), [Администрирование](05-administration.md), [Консольные команды](08-cli.md).
