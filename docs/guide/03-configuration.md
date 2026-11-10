# Конфигурация

## Назначение

Вся настройка приложения — один объект, проверяемый схемой Zod (`ApplicationConfigSchema`, `packages/core/src/config/schema.js`). Ошибка в ключе — ошибка запуска, а не молчаливое игнорирование: все объекты строгие (`strictObject`), опечатка `sever.port` не пройдёт.

## Откуда берутся значения

Порядок, каждый следующий слой перекрывает предыдущий:

1. значения по умолчанию из схемы;
2. файл `app.config.js` в рабочей папке (или путь `configPath`; явно указанный, но отсутствующий файл — ошибка, отсутствие файла по умолчанию — нормально);
3. `overrides` — объект, переданный в `loadConfig` (в основном для тестов);
4. переменные окружения из списка ниже.

```js
import { loadConfig } from '@das-forge/core';
const config = await loadConfig();                       // app.config.js + env
const config2 = await loadConfig({ overrides: { server: { port: 0 } } });
```

Пример файла — `examples/workshop/app.config.js`: имя, порт, база, резервная копия в `data/backups`, секрет сессии (только для локального примера).

Свои настройки приложение добавляет расширением схемы и передаёт её как `schema`:

```js
const Schema = ApplicationConfigSchema.extend({ myApp: z.strictObject({ plantId: z.string() }) });
const config = await loadConfig({ schema: Schema });
```

## Переменные окружения

Только перечисленные — «магического» отображения любых `FOO_BAR` нет.

| Переменная | Ключ конфигурации |
|---|---|
| `DAS_HOST`, `DAS_PORT` | `server.host`, `server.port` |
| `DAS_TRUST_PROXY` | `server.trustProxy` (`true`, число хопов ≥ 2, или список `10.0.0.0/8,loopback`) |
| `DAS_HTTPS_MODE` | `server.https.mode` |
| `DAS_DB_FILE` | `database.file` |
| `DAS_ENV` | `env` |
| `DAS_LOG_LEVEL` | `logLevel` |
| `DAS_SESSION_SECRET` | `auth.sessionSecret` |
| `DAS_TOTP_KEY` | `auth.totpEncryptionKey` |
| `DAS_SMTP_PASSWORD` | `email.smtp.auth.pass` |
| `DAS_BACKUP_KEY` | `backup.encryptionKey` |

Для любой из них работает вариант `<ИМЯ>_FILE=/run/secrets/x` (Docker/Kubernetes secrets): значение читается из файла, перевод строки в конце отбрасывается. Если заданы оба, побеждает обычная переменная. Булевы значения строгие: `true/false/1/0/yes/no/on/off`, иное — ошибка.

## Справочник ключей

Значения по умолчанию указаны в скобках.

### Корень

| Ключ | Описание |
|---|---|
| `appName` | обязательное имя приложения |
| `env` | `development` / `test` / `production` (`development`) |
| `logLevel` | `debug` / `info` / `warn` / `error` / `silent` (`info`) |

### server

| Ключ | Описание |
|---|---|
| `host`, `port` | адрес и порт HTTPS (`127.0.0.1`, `3000`; приложения платформы — по [схеме портов](#порты-приложений-платформы)) |
| `httpRedirectPort` | порт обычного HTTP, который только перенаправляет на HTTPS (`308`); не задан — `port − 1`, если TLS завершает сам процесс, и нет за обратным прокси; `false` — выключить |
| `allowedHosts` | дополнительные имена хостов, на которые редирект может отправить браузер (заголовку `Host` верят только для них, для `host` из конфигурации, `localhost` и loopback) |
| `trustProxy` | `false` / `true` / число хопов / список адресов и подсетей, которым доверяют заголовки `X-Forwarded-*` |
| `https.mode` | `standalone` / `reverse-proxy` / `self-signed` (`self-signed`), `certPath`, `keyPath` |
| `bodyLimit` | лимит тела запроса (`1mb`) |
| `requestTimeoutMs` | таймаут запроса (30000) |
| `shutdownDrainTimeoutMs` | время на завершение запросов при остановке (10000) |
| `admin.port`, `admin.host` | отдельный слушатель для админки (по умолчанию не задан: админка на адресе приложения). С `admin.port` панель отвечает только там (на адресе приложения — 404), `admin.host` по умолчанию `127.0.0.1`, и тогда панель слушает ещё и `::1`, поэтому `localhost` открывается при любом разрешении имени: доступ с самой машины, через SSH-туннель или VPN; порт не должен совпадать с портом приложения; см. [безопасность](04-security.md) |

### database

| Ключ | Описание |
|---|---|
| `driver` | только `node:sqlite` |
| `file` | путь к файлу (`data/app.db`) |
| `walMode` | журнал WAL (`true`) |
| `normalizeValues` | даты и булевы приводятся к типам при чтении (`false`) |

### backup

| Ключ | Описание |
|---|---|
| `enabled` | (`true`); администратор может включить и выключить автобэкап в разделе «Резервные копии» |
| `schedule` | cron (`0 3 * * *`); время суток администратор меняет там же, значение из админки приоритетнее |
| `retentionDays` | сколько дней хранить (30) |
| `encryptionKey` | пароль ≥ 16 символов, копии шифруются AES-256-GCM (`.zip.enc`); лучше `DAS_BACKUP_KEY` |
| `destinations[]` | `{ id, type, path, config }`, `type`: `local`, `mount`, `sftp` (`s3` и `webdav` схема отклоняет: записи в них нет) |

Для `sftp` обязательны `host`, `username`, `hostKeySha256` (доверие при первом подключении запрещено), `remotePath` и один способ входа (`privateKey` как `env:ИМЯ`, `privateKeyFile` или `password` как `env:ИМЯ`). Секреты в конфиге пишутся только ссылкой `env:ИМЯ`. У `sftp` дополнительно: `passphrase` (`env:ИМЯ`, пароль закрытого ключа), `readyTimeoutMs` (20000) и `keepaliveMs` (15000). У `sftp` и `mount` есть `verify` (`hash` по умолчанию: после копирования сверяется контрольная сумма; `size` — только размер) и `allowUnencrypted` (`false`: без `backup.encryptionKey` копия за пределы машины не отправляется; `true` снимает запрет). Для `mount` обязателен `path`; `markerFile` подтверждает, что ресурс действительно смонтирован, а `allowSameDevice` (`false`) разрешает путь на том же устройстве, что и данные (только для тестов: иначе копия лежала бы рядом с базой). Подробнее — в разделе «Эксплуатация».

### uploads

| Ключ | Описание |
|---|---|
| `maxTotalBytes` | общий объём (1 ГиБ; 0 — без лимита) |
| `maxFiles` | число файлов (20000; 0 — без лимита) |
| `imageProcessing.maxConcurrent` / `maxQueue` | одновременная обработка изображений и очередь (2 / 16), сверх очереди — 503 |

### email

Выключена по умолчанию; при `enabled: true` обязательны `from`, `baseUrl` (адрес приложения для ссылок в письмах) и `smtp.host`.

| Ключ | Описание |
|---|---|
| `locale` | `ru` / `en` для писем (`ru`), `replyTo` |
| `smtp` | `host`, `port` (587), `secure` (`false` = STARTTLS), `requireTLS` (`true`), `rejectUnauthorized` (`true`), `auth {user, pass}`, `connectionTimeoutMs` (10000), `socketTimeoutMs` (30000) |
| `dkim` | `domainName`, `keySelector`, ровно одно из `privateKey` / `privateKeyFile` |
| `retry` | повторы при временных сбоях: `attempts` (3), `baseDelayMs` (500) |
| `queue` | очередь в базе: `enabled` (`true`), `maxAttempts` (6), `baseDelayMs` (60000), `intervalMs` (15000), `keepFinishedDays` (7), `pendingTtlHours` (72) |
| `rateLimit` | на получателя и сценарий: `perRecipientMax` (5), `windowMs` (1 час) |

### audit

| Ключ | Описание |
|---|---|
| `retentionDays` | срок хранения записей (365; 0 — вечно, нужно юридическое основание) |
| `purgeBatchSize` | размер пачки очистки (5000) |
| `archiveDir` | папка для архива: перед удалением старые записи пишутся туда файлом `audit-<от>-<до>.ndjson.gz` с контрольной суммой (пусто — без архива) |

### alerts

| Ключ | Описание |
|---|---|
| `enabled` | модуль алертов включён (`true`) |
| `cooldownMinutes` | один и тот же алерт отправляется не чаще раза в столько минут (60) |
| `keepDays` | сколько дней хранить записи (90) |
| `doctorSchedule` | cron проверки диагностики; по умолчанию раз в сутки (`5 3 * * *`); `false` — выключить. Администратор может выключить проверку или перенести её на другое время суток в «О системе» (раздел «Администрирование»): сохранённый выбор заменяет это значение |
| `auditSchedule` | cron проверки цепочки аудита (`15 3 * * *`); `false` — выключить |
| `lockouts` | `threshold` (10) блокировок входа за `windowMinutes` (10) — алерт о вероятном подборе пароля |

Получатели — `security.incidentContacts`; письма уходят, только если включена почта (`email.enabled`).

### logging

| Ключ | Описание |
|---|---|
| `sinks[]` | куда писать: `stdout`, `file` (`path`, `maxBytes`, `keep`), `syslog` (`host`, `port`, `protocol` udp/tcp/tls, `caFile` — свой корневой сертификат для tls, `rejectUnauthorized`, `facility` 0–23, по умолчанию 16), `http` (`url` только https, `format`: `ndjson`/`loki`/`elastic-bulk`/`splunk-hec`, `headers` со значениями `env:ИМЯ`, `labels` — метки для Loki, `index` и `source` — для Splunk HEC и Elastic, `timeoutMs` — 5000); у каждого `streams` и `minLevel` |
| `buffer` | очередь в памяти: `maxLines` (10000), `batchSize`, `flushIntervalMs`, `retryBaseMs`, `retryMaxMs`, `onFull` |
| `localFallback` | файл для строк, которые не удалось отправить |
| `auditMirror` | `off` / `minimal` / `full` (`minimal`) — что из аудита идёт в поток логов |
| `auditAnchorSchedule` | как часто писать «голову» цепочки аудита в лог (`5 * * * *`) |

Хотя бы один приёмник выносите за пределы сервера приложения: тот, кто захватил хост, удалит локальные файлы.

### ui

`theme` (`default`), `title`, `locale` (`ru` / `en`, `ru`). Тема и логотип компании настраиваются в админке — см. «Темы и оформление».

### observability

| Ключ | Описание |
|---|---|
| `metrics.enabled` | включить `/metrics` для Prometheus (`false`; нужен пакет `@prometheus-io/client`) |
| `metrics.path` | адрес эндпоинта (`/metrics`) |
| `metrics.token` | токен для сборщика с другой машины (от 16 знаков); передаётся как `Authorization: Bearer <токен>`; без токена читать могут только адреса из `allowIps` |
| `metrics.allowIps` | адреса, которым токен не нужен (по умолчанию эта же машина: `127.0.0.1`, `::1`) |
| `metrics.defaultMetrics` | метрики процесса: память, процессор, задержка цикла событий, сборка мусора (`true`) |

### modules

Список `{ name, enabled, options }` — какие модули ядра включены у приложения.

### security

| Ключ | Описание |
|---|---|
| `cors.origins` | разрешённые источники (пусто) |
| `csrf` | защита форм (`true`) |
| `csp` | `reportOnly` (`false`) и `reportPath` (`/csp-report`): строгая политика CSP в режиме отчёта, см. [безопасность](04-security.md) |
| `rateLimit` | общий лимит: 300 запросов за 60 с (страницы админки и фоновые запросы тоже считаются) |
| `loginRateLimit` | лимит для `/login`, `/login/totp`, `/login/recovery`: 10 за 60 с |
| `lockout` | блокировка после `maxFailures` (5) неудач на `baseLockMs` (5 мин), каждая следующая удваивает до `maxLockMs` (24 ч); `resetAfterMs` (24 ч) — через сколько тишины счётчик неудач обнуляется |
| `incidentContacts` | адреса, на которые уходят письма-алерты (см. `alerts`) |
| `dependencyAudit.enabled` | проверка известных уязвимостей зависимостей в диагностике (`true`) |
| `dependencyAudit.ignore` | принятые на время уязвимости: `[{ id: 'GHSA-xxxx-xxxx-xxxx', reason: '…', until: '2026-12-31' }]`; после `until` снова считаются; `until` можно не указывать |
| `securityTxt.contact` | адреса для сообщений об уязвимостях (`mailto:`, `https://`, `tel:`; голый адрес становится `mailto:`); пока список пуст, `/.well-known/security.txt` не отдаётся |
| `securityTxt.policy` / `canonical` | ссылка на политику раскрытия (например `SECURITY.md` в репозитории) / канонический адрес файла |
| `securityTxt.expires` | срок действия (дата-время ISO); без значения — 180 дней от запроса |
| `stepUp.enabled` / `stepUp.maxAgeMinutes` | повторное подтверждение (пароль и код TOTP) перед опасными действиями администратора, срок действия 1–120 минут (10 по умолчанию). Само подключение делает приложение (`admin.createStepUp`); doctor в production предупреждает, если выключено |
| `secretsRotation.maxAgeDays` | предельный возраст ключа, дней (30–3650, по умолчанию 365); старше — предупреждение в doctor |
| `secretsRotation.sessionSecretCreatedAt` / `totpKeyCreatedAt` / `backupKeyCreatedAt` | дата создания ключа (`ГГГГ-ММ-ДД`); без неё возраст не проверяется, doctor пишет «дата не записана». Проверяются только заданные ключи |
| `securityTxt.preferredLanguages` | языки сообщений (`['ru', 'en']`) |
| `dependencyAudit.checkNode` | сверять версию Node.js с релизами безопасности nodejs.org (`true`; без сети только предупреждение) |

### auth

| Ключ | Описание |
|---|---|
| `sessionSecret` | обязателен, ≥ 16 символов |
| `previousSessionSecrets` | старые секреты после ротации: cookie с ними ещё принимаются и перевыпускаются |
| `totpEncryptionKey` / `previousTotpEncryptionKeys` | ключ шифрования секретов TOTP в базе; без него выводится из `sessionSecret` (ротация тогда ломает вход по TOTP — задайте отдельный) |
| `sessionTtlMs` | жизнь сессии (8 ч) |
| `registration` | самостоятельная регистрация (по умолчанию выключена): `enabled`, `requireEmailConfirmation` (true: учётная запись создаётся только после перехода по ссылке из письма, это и есть защита от ботов; false: сразу, для закрытых сетей), `role` (`operator`), `ttlHours` (24, срок ссылки), `minFillMs` (2000, быстрее форма не принимается) |
| `hostCookiePrefix` | cookie сессии называется `__Host-das_session` (`false`): браузер не примет её с соседнего поддомена и не разрешит перезаписать; только HTTPS, при входе по обычному HTTP сессия не сохранится |
| `newDeviceNotice` | письмо владельцу при входе с браузера, которого не было раньше (`true`; нужны включённая почта и адрес в учётной записи) |
| `clearSiteDataOnLogout` | при выходе браузеру уходит `Clear-Site-Data: "cache", "storage"` (`false`); только по HTTPS, cookie, в том числе метка устройства, остаются |
| `sessionIdleTimeoutMs` | простой до выхода (1 ч; 0 — выключено) |
| `passwordPolicy` | значения по умолчанию, пока администратор не сохранил свои в разделе «Парольная политика»: `minLength` (12, не меньше 8), `adminMinLength` (12), `requireClasses` (0–4, по умолчанию 0), `maxAgeDays` (срок действия в днях, по умолчанию 0 — без ограничения), `historyCount` (0–24, по умолчанию 0), `maxLength` (128); отдельно `auth.passwordBlocklistFile` — файл утёкших паролей; сгенерированные пароли — 24 символа |
| `argon2` | `memoryCost` (19456), `timeCost` (2), `parallelism` (1), `maxConcurrent` (2), `maxQueue` (64) |
| `totp.enabled` | двухфакторный вход (`false`) |

### performance

`budgets.p95HealthMs` (20), `budgets.p95ApiMs` (150) — бюджеты, которые проверяет нагрузочный сценарий.

## Порты приложений платформы

Каждое приложение занимает два соседних порта в диапазоне 9xxx: **HTTPS — `9N02`, HTTP — `9N01`**, причём HTTP всегда только перенаправляет на HTTPS (обмен данными идёт лишь по HTTPS). Следующее приложение получает порты на 100 больше: шаг между приложениями — 100.

| Приложение | HTTPS (`server.port`) | HTTP → HTTPS (`httpRedirectPort`) |
|---|---|---|
| workshop (эталон) | 9002 | 9001 |
| IT Assets | 9102 | 9101 |
| следующие | 9202, 9302, … | 9201, 9301, … |

Редирект включается сам: порт HTTP — это `server.port − 1`, поэтому достаточно задать `server.port`. Реализация — `http.createHttpRedirectServer` и `http.resolveRedirectPort`, подключение — `examples/workshop/src/server.js`. За обратным прокси редирект выполняет прокси, слушатель не запускается. Запросы с телом (POST и т. п.) по HTTP не перенаправляются, а отклоняются кодом 426; остальные меры защиты от захода по HTTP — в разделе «Безопасность» («Заход по HTTP»).

Как открыть приложение для локальной сети (адрес, брандмауэр, сертификат, Docker) — «Эксплуатация» → «Доступ из локальной сети».

Внимание: в Docker-образе workshop по умолчанию `DAS_PORT=9002` в режиме `reverse-proxy` (прокси сам отдаёт 443 и редирект); компоновка `docker-compose.yml` публикует `127.0.0.1:9002`.

## Внимание

- В `production` запуск отказывается, если `auth.sessionSecret` — известная заглушка (`changeme`, `secret`, `password`…).
- Секрет сессии и ключи только из окружения или `_FILE`, не из файла в репозитории.
- После смены `sessionSecret` старое значение перенесите в `previousSessionSecrets`, иначе все выйдут из системы.
- `argon2.maxConcurrent` держите ниже `UV_THREADPOOL_SIZE` (по умолчанию 4).
- Проверка без запуска: CLI `config check` (раздел «CLI»), диагностика — `doctor`.

## Тесты

`packages/core/test/config*.test.js`.

**См. также:** [Безопасность](04-security.md), [Эксплуатация](10-operations.md), [Модули ядра](02-modules.md).
