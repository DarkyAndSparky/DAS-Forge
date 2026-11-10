# DAS-Forge — архитектура платформы и роадмап реализации

Репозиторий: `github.com/DarkyAndSparky/DAS-Forge`
Приложения-потребители: `procure-it`, `it-assets`, `atlas-ao`, `net-monitor`

---

## 0. АКТУАЛЬНЫЙ ПЛАН (читать в первую очередь при возобновлении работы)

Всё, что ниже раздела 0, — исторический документ Phase 1 (изначальная
архитектура, как её спроектировали до начала кодинга) + журнал решений
Phase 2 по ходу разработки (разделы 10–17). Он ценен как архив
рассуждений, но **не отражает текущий план актуально и компактно** —
например, раздел 2 ниже описывает полный пакетный набор (`cli`, `ui`,
`email`, `ldap`, `files`, ...) и `pnpm-workspace.yaml`, тогда как по
факту реализован пока только `packages/core` на **npm workspaces** (не
pnpm — решение изменилось по ходу дела). Этот раздел 0 — единственный
источник истины о текущем состоянии; остальное читать для археологии
решений, а не как актуальное описание.

### 0.1 Структура репозитория (текущая, не аспирационная)

Полный, построчный справочник (путь → что внутри → статус ✅/⚠️/пусто),
по тому же принципу, что и справочник CLI-команд (§4.1/README/
docs/index.html #cli) — ведётся как отдельная единица документации,
обновляется каждым патчем, меняющим набор файлов/папок, а не
переписывается с нуля. Источник истины — **README.md, раздел
"Структура репозитория — полный справочник"** и зеркально
`docs/index.html` (`#packages`); здесь — только верхнеуровневая карта
и примечания, не дублирующие построчную таблицу:

```
das-forge-core/
├── package.json         — корень, npm workspaces (packages/*, examples/*)
├── .gitignore
├── packages/core/        @das-forge/core — ЕДИНСТВЕННЫЙ пакет ядра пока что
│                          (package.json version: 0.1.19, см. §0.4)
├── examples/workshop/    — эталонное приложение (Stage A–C готовы)
├── apps/                 — пусто; сюда переедут реальные приложения НЕ РАНЬШЕ Stage F
├── templates/            — пусто; backlog, не сейчас (будущий `das-forge create`)
└── docs/
    ├── index.html        — документация с навигацией (индустриальная тема)
    └── roadmap.md         — этот файл
```

Введено в 0.1.15 по просьбе пользователя — вести структуру тем же
способом, что и CLI-таблицу: полное дерево `packages/core/src/*` и
`examples/workshop/src/*` с построчным статусом живёт в README.md/
index.html (15 модулей ядра на 0.1.14, включая `qr/`), здесь дублировать
его не нужно — risk расхождения трёх копий при каждом патче выше
пользы.

Остальные пакеты из раздела 2 (`cli` как отдельный npm-пакет, `ui`,
`email`, `images`, `ldap`, `files` как отдельный пакет, `documents`,
`exports`, `qr`, `network`, `integrations`, `eslint-config`,
`prettier-config`) — **не существуют**. То, что в разделе 2 называлось
отдельными пакетами `cli`/`files`, по факту реализовано как **подпапки
внутри `packages/core`** (`src/cli/`, `src/files/`), а не отдельные
npm-пакеты — это сознательное упрощение, сделанное по ходу разработки:
дробить на отдельные публикуемые пакеты имеет смысл, когда появится
реальная причина (например, что-то из ядра понадобится переиспользовать
вне DAS-Forge), а не заранее.

### 0.2 Зависимости `packages/core` (актуальные на дату последней сверки, сверено пользователем на npmjs.com)

```json
"dependencies": {
  "zod": "^4.6.0",
  "argon2": "^0.45.0",
  "sharp": "^0.35.0",
  "dompurify": "^3.4.0",
  "jsdom": "^30.0.0"
},
"peerDependencies": {
  "express": "^5.2.1",
  "cookie-parser": "^1.4.7"
},
"devDependencies": {
  "vitest": "^5.0.0"
}
```

**Правило процесса (обязательное):** перед фиксацией версии ЛЮБОГО
пакета — зайти на npmjs.com, проверить актуальную версию, прочитать
документацию/changelog. Не полагаться на память/обучающие данные —
именно это стало причиной трёх раундов отладки `node:sqlite`+Vitest и
двух breaking changes Zod 3→4, пойманных только на реальном прогоне
пользователя (разделы 12–16 ниже).

**Пакеты "известны, но не используются"** — список с версиями на
момент записи в разделе 16 ниже; сверить заново на npmjs.com
непосредственно перед внедрением каждого: `compression`, `cors`,
`express-rate-limit`, `express-session`, `helmet`, `libheif-js`,
`uuid`, `pino`, `pino-http`, `selfsigned`, `docx`, `adm-zip`,
`nodemailer`, `multer`; dev: `@playwright/test`, `pino-pretty`,
`playwright`, `supertest`, `jsqr`.

### 0.3 План этапов — Workshop-центричный (не IT Assets-first)

Портирование реальных приложений начинается **только после** того, как
`examples/workshop` докажет, что ядро реально работает целиком —
включая негативные сценарии (не только "админ может", но и "обычный
юзер не может через голый HTTP-запрос, даже если кнопка спрятана в UI").

| Этап | Что | Статус |
|---|---|---|
| **Stage A** | Запускаемый скелет: workshop подключает все 9 модулей ядра (config→database→branding→auth→http→realtime→files→scheduler→cli), есть bootstrap, роуты, миграция, CLI-команды | ✅ готово |
| **core/audit** | Новый модуль ядра (лог событий: кто/когда/что/результат) — отдельный модуль, не часть core/auth (обоснование — раздел 11) | ✅ готово (0.1.1) |
| **core/health** | `health` vs `doctor` по §4.5 — liveness-чек + диагностика окружения по категориям | ✅ готово (0.1.2) |
| **CLI-обвязка** | Полное покрытие §4.1 там, где есть реальная реализация: `backup {list,verify,restore}`, `db {status,integrity}`, `audit {tail,export}`, `user reset-password`, `version` | ✅ готово (0.1.3) |
| **core/modules** | Контракт `Module` из §1/§7.5 (третий из трёх: `ApplicationConfig`/`Module`/`DatabaseAdapter`), полная §7.5-форма | ✅ готово (0.1.5) |
| **core/privacy** | §4.5k — export/erase данных субъекта (152-ФЗ/GDPR техническая база), подключает `dataSubject` из core/modules | ✅ готово (0.1.6) |
| **core/certs** | §4.5f — self-signed сертификаты: info/generate/renew/trust, doctor-категория | ✅ готово (0.1.7) |
| **core/ui** | §5.4 — минимальный AppShell: навигация/i18n/поиск из core/modules | ✅ готово (0.1.7) |
| **core/auth: MFA-модель + recovery codes** | Таблица `authenticators`, несколько факторов на пользователя, §18, recovery codes (§22) — по итогам обсуждения общего security-документа, WebAuthn/RBAC/scopes отложены | ✅ готово (0.1.8) |
| **Stage B** | Workshop: Users & Access — полный цикл (логин/логаут/смена пароля/TOTP-enroll/ролевые ограничения) + негативные сценарии | ✅ готово (0.1.12–0.1.14, §11j–§11l): API + интерактивный UI + реальный QR-код в enrollment |
| **Stage C** | Workshop: Demo Records — CRUD-ресурс на database+http+files, zero-trust `serialize()` продемонстрирован end-to-end + негативные сценарии | ✅ готово (0.1.14–0.1.17, §11l–§11m): CRUD+QR+migrate-on-boot+негативные тесты |
| **Stage D** | Workshop: Audit & Activity — использует core/audit + негативные сценарии | ✅ готово (0.1.19, §11o): все write-роуты логируют, `GET /audit`+`GET /ui/audit`, 7 негативных тестов |
| **Stage E** | Workshop: System & Maintenance (scheduler/backup/cli через UI) + Realtime Lab (SSE интерактивно) + негативные сценарии | ✅ готово (0.1.20, §11p): `/system/status`+`/system/backup/run`+`/system/backup/verify`+`GET /ui/system`, отдельный SSE-канал `lab`+`GET /ui/realtime`, 13 негативных тестов |
| **Drizzle/мульти-БД** | Абстракция поверх DatabaseAdapter для будущего Postgres (atlas-ao/net-monitor) — после Stage E, до Stage F (раздел 17) | ⏳ backlog |
| **Stage F** | Портирование первого реального приложения (IT Assets) в `apps/` | ⏳ не начато, ждёт Drizzle/мульти-БД |

### 0.4 Версия самого ядра — где хранится и когда апается

Версия `@das-forge/core` — `"version"` в `packages/core/package.json`
(сейчас `0.1.40`), задокументирована по Keep-a-Changelog в
`packages/core/CHANGELOG.md`.

**Правило бампа (ИСПРАВЛЕНО пользователем, отменяет формулировку ниже
в старых разделах 10–17, где говорится про MINOR-за-этап):** MINOR
держится на `1` (`0.1.x`), пока пользователь явно не скажет бампнуть
его. Вместо этого **PATCH двигается за каждый принятый
модуль/этап/значимую пачку работы** — это и есть фактическая шкала
ниже. MAJOR — только на настоящий breaking change публичного API ядра.
Планируемая MINOR-шкала из раздела 0.4 старой редакции (0.2.0=audit,
0.3.0=Stage B, ..., 1.0.0=Stage F) **отменена** этой правкой и оставлена
только для истории ниже.

Фактическая шкала (обновляется по факту, не планируется заранее):

| Версия | Что вошло |
|---|---|
| 0.1.0 | Все 9 модулей ядра + Stage A |
| 0.1.1 | core/audit |
| 0.1.2 | core/health (`health`/`doctor`, §4.5) |
| 0.1.3 | CLI-обвязка расширена до покрытия §4.1 (backup list/verify/restore, db status/integrity, audit tail/export, user reset-password, version) |
| 0.1.4 | core/modules — контракт `Module` из §1/§7.5 |
| 0.1.5 | core/modules: схема восстановлена до полной §7.5-формы (navigation/routes/translations/search/dataSubject — хранятся, ждут @das-forge/ui / core/privacy) |
| 0.1.6 | core/privacy — export/erase данных субъекта (§4.5k), подключает dataSubject из core/modules; core/auth: anonymizeUser()/deleteUser() |
| 0.1.7 | core/certs (§4.5f, info/generate/renew/trust + doctor-категория), core/ui (§5.4, минимальный AppShell: навигация/i18n/поиск из core/modules), плейсхолдер-эмблемы ядра и workshop |
| 0.1.8 | core/auth: таблица `authenticators`+`totp_credentials` (многофакторность, §18), recovery codes (§22), миграция legacy `totp_secret`, `cli user {authenticators,authenticators-remove,recovery-codes}` |
| 0.1.9 | Первый настоящий `npm test` (Windows) — 17 падений из 246 разобраны: реальный Zod-баг в `core/modules/schema.js` (translations), устаревшие branding-тесты, баг в счёте health-теста, порядок операций в audit-тестах, `certs.test.js` переписан без зависимости от `openssl` |
| 0.1.10 | Второй настоящий `npm test` (Windows, теперь с argon2/selfsigned) — 11 падений из 266 разобраны: `totp_secret`-guard в `migrateLegacyTotpSecrets()`, реальный security-баг в recovery-code верификации (`.valid` object truthiness), `selfsigned` v5's `days`→`notAfterDate` breaking change, Windows/NTFS chmod-тест ограничение — см. §11i |
| 0.1.25 | Волна 1 аудита: CSP nonce, lockout, CSRF, реальный HTTP-сервер, smoke-тест |
| 0.1.26 | Волна 2a: бэкап/restore (VACUUM INTO, автооткат), миграции с checksum, savepoint, pragma |
| 0.1.27 | Волна 2b: `acceptUpload`, FTS-экранирование, лимиты |
| 0.1.28 | Волна 2c: хеш-цепочка аудита, cron-фиксы |
| 0.1.29 | Волна 3a: `core/logs`, shutdown/fatal, error handler, `/health`, TOTP replay |
| 0.1.30 | Волна 3b: CLI-парсер, строгий конфиг, `_FILE`-секреты |
| 0.1.31 | Волна 4a: ленивые импорты, subpath exports, Dockerfile/CI, фикс логотипа |
| 0.1.32 | A10: TOTP-секреты шифруются |
| 0.1.33 | A16: пароль админа в файл 0600 |
| 0.1.34 | C09: коды выхода CLI |
| 0.1.35 | C06: SSE authorize / лимит на пользователя / `Last-Event-ID` |
| 0.1.36 | B15: часовые пояса, catch-up, межпроцессный lock |
| 0.1.37 | B14: даты, keyset-пагинация, внешний якорь аудита |
| 0.1.38 | B17 (часть): бэкап `uploads/`, `upsert`, `addColumnIfMissing` |
| 0.1.39 | Исправление `backup.js` (найдено вашим прогоном) |
| 0.1.40 | B17 (часть): права 0600 на БД и бэкапы |

Следующие ожидаемые PATCH-приращения: Stage B–E (по одному на этап,
если не оговорено иначе), Stage F. MINOR → `0.2.0` и далее — только по
явной команде пользователя, не автоматически по достижении Stage F.

---

## 1. Принцип (историческое, Phase 1)

DAS-Forge — не фреймворк, диктующий структуру приложения, а набор пакетов
общей инфраструктуры. Бизнес-логика, доменные модели и специфичные для
приложения схемы БД остаются в приложениях. Ядро не должно знать, что
такое Atlas, procure-it и т.д. — оно оперирует только контрактами
(`ApplicationConfig`, `Module`, `DatabaseAdapter`, ...).

## 2. Структура репозитория

```
DAS-Forge/
├── packages/
│   ├── core/            @das-forge/core
│   ├── cli/              @das-forge/cli
│   ├── ui/               @das-forge/ui
│   ├── email/            @das-forge/email
│   ├── images/           @das-forge/images
│   ├── ldap/             @das-forge/ldap
│   ├── files/            @das-forge/files
│   ├── documents/        @das-forge/documents
│   ├── exports/          @das-forge/exports
│   ├── qr/               @das-forge/qr
│   ├── network/          @das-forge/network
│   ├── integrations/     @das-forge/integrations (§6.5/§6.5a)
│   ├── eslint-config/    @das-forge/eslint-config  — devDependency, не рантайм
│   └── prettier-config/  @das-forge/prettier-config — devDependency, не рантайм
├── templates/
│   └── node-express-app/
├── docs/
├── examples/
├── pnpm-workspace.yaml
└── README.md
```

## 3. `@das-forge/core` — состав

```
core/
├── config/        env/config loading + валидация (ApplicationConfigSchema, §7.5)
├── http/          createApp(), middleware stack, error boundary (JSON+HTML, §6.6.5),
│                   SSE utility, serialize() (§4.5j), graceful shutdown/drain (§4.5g п.7)
├── errors/        единая иерархия ошибок + JSON/HTML error mapping
├── logging/        pino logger factory, request ID (§4.5h п.1)
├── validation/     Zod helpers, единый формат ошибок валидации (§7.5)
├── security/       helmet, cors, rate-limit, CSRF, body-size/timeout лимиты (§4.5h),
│                   bans store (§4.5g п.3)
├── platform/       Linux/Windows абстракция (§4.5a) — {linux.js, windows.js}
├── certs/          self-signed генерация/ротация через `selfsigned` (§4.5f)
├── auth/
│   ├── authentication.js   password verify/issue
│   ├── authorization.js    permissions/RBAC (guest/operator/admin, §3)
│   ├── sessions.js         session abstraction (auth.createSession/destroySession, §4.5h п.2)
│   ├── password.js         argon2id hash/verify + миграция легаси-хэшей
│   └── totp.js             2FA/TOTP, RFC 6238, per-role (§4.5h п.8)
├── database/       node:sqlite adapter, migrations runner, transactions
├── audit/          единый audit log (кто/что/когда)
├── backup/         backup/restore + verify + destinations (§4.5b)
├── health/         health checks (app-level) + doctor framework (§4.5)
├── scheduler/       единый cron-реестр (§4.5g п.4) — backup, cert renew, deps check, retention
├── maintenance/     окна обслуживания, подавление алертов (§6.6.1)
├── version/         VERSION-конвенция + changelog.parse() (§6.6.2)
├── privacy/         export/erase данных субъекта, retention, реестр обработки (§4.5k)
└── realtime/
    ├── event-bus.js
    ├── publisher.js / subscriber.js
    └── transports/
        └── sse.js   (базовый транспорт; websocket.js — опционально позже)
```

**Production-зависимости core** (минимум, никакого зоопарка):
`express`, `zod`, `helmet`, `cors`, `express-rate-limit`, `pino`, `argon2`,
`selfsigned` (self-signed сертификаты, §4.5f), `otplib` (TOTP/2FA, RFC 6238,
§4.5h п.8). БД — через нативный `node:sqlite`, без внешней зависимости.
Сессии — собственная таблица в `node:sqlite` через `core/database`, **не**
`express-session` (несовместимо с §4.5j — session store должен быть под
контролем `assertSessionStore()`, а не сторонним middleware с собственным
форматом хранения). `autocannon` (perf-тесты, §4.5c) и `license-checker`/
аналог (§4.5d) — dev-зависимости самого core, не тянутся в рантайм
потребителей.

### API каждого модуля core (сигнатуры верхнего уровня)

```js
// config
config.load(schema)                         // Zod schema → typed, validated config

// http
createApp({ middlewares, errorHandler })    // Express app с уже настроенным stack
createSseStream(res)                        // SSE utility, без внешней зависимости
defineRoute({ method, path, input: ZodSchema, handler, permission })
                                             // REST-роут с input-схемой — одновременно валидация (§7.5)
                                             // И источник для автогенерации OpenAPI 3.0 (zod-to-openapi),
                                             // не отдельно поддерживаемый Swagger-файл, который разъедется с кодом
generateOpenApiSpec()                       // GET /api/openapi.json — для @das-forge/integrations (§6.5)
                                             // и внешних интеграций (Bitrix24/1С, см. §6.5a)

// errors
class AppError extends Error { statusCode; code; }
errorMiddleware(app)                        // единый JSON/HTML error mapping

// logging
createLogger({ name })                      // pino instance, dev/prod формат — решает приложение

// validation
validate(schema, data)                      // Zod, единый формат ошибок

// security
applySecurity(app, { csrf: true })          // helmet + cors + rate-limit + csrf (csrf по умолчанию ON)

// auth
auth.createSession(user)
auth.destroySession(token)
auth.hashPassword(plain)                    // argon2id
auth.verifyPassword(hash, plain)            // multi-scheme, см. ниже
authorization.can(user, 'resource:action')

// database
db.connect(path)
db.migrate()
db.transaction(fn)
db.createFtsIndex(table, columns)           // FTS5 virtual table — node:sqlite даёт сырой SQLite,
                                             // FTS5 входит в стандартную сборку, доп. зависимостей не нужно
db.queryByExample(table, exampleObject)     // QBE: частичный объект → WHERE по непустым полям,
                                             // тонкая обёртка, не отдельный query-язык

// audit
audit.log({ actor, action, entity, meta })

// backup
backup.create() / backup.list() / backup.verify(file) / backup.restore(file)

// health / doctor
health.check()                              // быстрый рантайм-чек (GET /health)
doctor.run()                                // полная диагностика окружения (CLI-команда)

// realtime
realtime.publish({ type, entityId, payload })
realtime.subscribe(type, handler)
```

### Хорошая новость по данным
Реальных живых продакшн-данных в текущем виде фактически нет — сейчас это
таблицы, наполненные через Excel-импорт, а не боевые системы с историей.
Это меняет приоритет: миграция схем — не риск, а **шанс спроектировать
`core/database`-конвенции (структура таблиц sessions/audit/users) с нуля
правильно**, без оглядки на четыре несовместимых легаси-формата. Не
нужно закладывать сложный data-migration слой в Phase 1 — это можно будет
сделать проще, чем казалось.

### Версионирование core между 4 потребителями
Раз `@das-forge/*` — общие npm-пакеты, а 4 приложения будут обновляться на
них не синхронно (it-assets раньше, atlas позже), core с первого релиза
живёт по semver: breaking change в контракте (`AuthProvider`, `Module`
API) — всегда major-бамп, и `CHANGELOG.md` самого DAS-Forge (тот же паттерн
Keep a Changelog, что уже принят для приложений, §6.6.2) — обязателен с
первого коммита, не как формальность на будущее.

### `node:sqlite` и многопроцессный доступ — проверить, не считать очевидным
CLI (`app backup create`, `app db integrity`) работает в отдельном
процессе от запущенного сервера, одновременно обращаясь к тому же файлу
БД. Перед тем как фиксировать `core/database` как финальный контракт
(Phase 1) — нужно явно протестировать поведение `node:sqlite` в этом
сценарии (WAL-режим, блокировки при параллельной записи), а не считать
"наверное, само справится".

### Контракт паролей / миграция легаси-хэшей
Каждое приложение сейчас хранит пароли по-своему (PBKDF2 у procure-it,
scrypt у atlas и net-monitor, argon2/bcrypt-микс у it-assets). Core должен
поддерживать multi-scheme verify на переходный период:

```
verifyPassword(hash, plain)
  → detect scheme by hash prefix/format
  → verify with legacy scheme if matched
  → if valid: rehash with argon2id, persist new hash (lazy migration)
  → else: verify with argon2id
```

Так миграция происходит на первом успешном логине пользователя, без
принудительного сброса паролей всей базы.

### Базовые роли (RBAC baseline)
Core поставляет три базовые роли, одинаковые по смыслу во всех
4 приложениях. Приложение может добавлять свои роли/права поверх, но эти
три — платформенный минимум, не переизобретаются каждым проектом заново:

```
guest      (без логина, публичный доступ)
  → read-only: дашборды и явно помеченные как публичные разделы
  → не видит Administration вообще, не имеет сессии

operator
  → всё, что guest, плюс:
  → создание/редактирование/изменение бизнес-сущностей (заявки, активы, устройства...)
  → НЕ имеет доступа к Administration (§4.5g) и к management-функциям (backup/users/secrets)

admin
  → всё, что operator, плюс:
  → полный доступ к Administration: backups, cron, secrets, security/bans, users, audit
  → может выдавать роли другим пользователям
```

`authorization.can(user, 'resource:action')` резолвит право сначала по
роли, потом по точечным override'ам (если приложению нужно выдать
конкретному operator доступ к одному разделу Administration — например,
`admin.health.view`, как обсуждали ранее, — без полного `admin`). Роль —
это набор permissions по умолчанию, а не жёстко зашитая проверка `if
(role === 'admin')` в каждом месте кода.

### Расширяемая матрица прав — custom-роли поверх базовых трёх
3 базовые роли — минимум, не потолок. Приложение (или админ через UI, не
только через код) может определить дополнительные роли как **наборы
permissions**, а не хардкодить новые `if`:
```js
authorization.defineRole('warehouse-clerk', {
  extends: 'operator',                          // наследование от базовой роли
  grants: ['assets.viewFinancials'],             // точечные добавления
  revokes: ['assets.delete']                     // точечные ограничения
});
```
**Admin UI**: `Administration → Roles & Permissions` — матрица
"роль × permission" с чекбоксами (по столбцам — все зарегистрированные
модулями permissions, включая `fieldPermissions` из §4.5j), создание
custom-роли через ту же форму, не через правку кода. Хранится в БД
(`core/database`), не в конфиг-файле — иначе смена прав требует деплоя.

### First-run bootstrap: администратор создаётся автоматически

При старте core проверяет количество пользователей в БД. **Если пользователей
ноль** (первый запуск после `app install` / после `db migrate` на чистой БД):

```
1. core генерирует учётку с ролью admin (логин по умолчанию — `admin`,
   либо из ADMIN_EMAIL/ADMIN_USERNAME, если задан в .env)
2. генерирует случайный временный пароль (криптостойкий, не "admin123")
3. печатает его ОДИН РАЗ в stdout/лог при первом запуске крупным блоком,
   не сохраняет в plaintext нигде на диске:

   ┌─────────────────────────────────────────────┐
   │  Initial admin account created                │
   │  Login:    admin                              │
   │  Password: 7f2a-9c31-e8b4-... (temp)          │
   │  You MUST change this password on first login │
   └─────────────────────────────────────────────┘

4. учётка помечена флагом mustChangePassword: true — любой запрос,
   кроме смены пароля, редиректится/блокируется, пока пароль не сменён
```

Это тот же принцип, что и `app user create-admin --temp` (§4.5g, п.2), но
срабатывает автоматически при первом старте, а не только по явной команде
— `create-admin` остаётся резервным путём на случай, если что-то пошло не
так (лог с паролем потерян, БД пересоздана без пересоздания консоли и т.п.).

## 4. `@das-forge/cli`

Отдельный пакет (не тянется в production рантайм сервера по умолчанию).

```
cli/
├── dev
├── start / stop / restart / status
├── install / update / version
├── doctor / health
├── db  {status, migrate, rollback, seed, integrity}
├── backup {create, list, verify, restore}
└── service {install, uninstall, start, stop, restart, status}
```

Разделение команд:
- **Core commands** — db, backup, health, doctor, service (общие для всех приложений)
- **Project commands** — специфичные для приложения (например `atlas import`, `assets sync`)
- **Dev commands** — делегируются npm-скриптам приложения (`test`, `lint`, `format`, `e2e`) — CLI не подменяет собой package manager

CLI ничего не знает о конкретном приложении — только про `app.config.js`:

```js
export default {
  name: 'atlas',
  server: { entry: './src/server.js', port: 3000 },
  database: { migrations: './src/db/migrations', seeds: './src/db/seeds' },
  backup: { directory: './data/backups' },
  modules: { email: true, images: true, ldap: false, realtime: { sse: true } }
}
```

`.bat`/`.sh` остаются только как тонкие compatibility launchers
(`node bin/app.js start`), без бизнес-логики. `app service install`
генерирует systemd unit (Linux) или регистрирует Windows Service —
никакого собственного daemon-менеджера.

### 4.1 Полный список команд

```
Разработка
  app dev                      запуск с --watch, pretty-логи
  app test / test:e2e          делегирует npm test / playwright test
  app lint / format            делегирует npm-скриптам приложения

Сервер
  app start                    foreground production-запуск
  app stop / restart / status  управление запущенным процессом (pid-файл)

Диагностика
  app health [--json]          быстрая проверка живого сервера
  app doctor [--json] [--fix]  полная диагностика окружения/установки

Database
  app db status                текущая миграция, pending, integrity, размер файла
  app db migrate [--to <n>]
  app db rollback [--steps <n>]
  app db seed
  app db integrity [--repair]

Backup
  app backup create [--label <name>] [--destination <id>]
  app backup list [--json]
  app backup verify <file>
  app backup restore <file> [--yes]     (запускает verify → stop writes → restore → integrity → migration check → audit → health, см. §4.3)
  app backup destinations {list,add,remove,set-primary}       (§4.5b)

Сертификаты
  app cert {info,generate,renew,trust}                        (§4.5f)

Обслуживание
  app install [--yes] [--docker]  идемпотентно: node/npm check → npm ci → .env check → dirs → migrate → certs → integrity → health
  app update
  app version [--json] [sync]                                 (§6.6.2)
  app maintenance {declare,list,cancel}                       (§6.6.1)

Гигиена зависимостей
  app deps {licenses,outdated,audit,check} [--json] [--fail-on <list>]   (§4.5d)

Производительность
  app test:perf [--scenario <name>] [--duration 30] [--connections 50]  (§4.5c)

Логи и аудит
  app logs {tail,export,config}                               (§4.5g п.1)
  app audit {tail,export}                                     (§4.5g п.8)

Пользователи и безопасность
  app user {create-admin,reset-password,unlock}               (§4.5g п.2, CLI-only)
  app security bans {list,unban,clear-all}                    (§4.5g п.3)
  app security incident declare --severity <name> --summary <name>   (§4.5k)
  app secrets {rotate,list}                                   (§4.5g п.5)

Периодические задачи
  app cron {list,history,run}                                 (§4.5g п.4)

Приватность (152-ФЗ/GDPR)
  app privacy {export,erase,registry,review-queue}            (§4.5k)

Интеграции (если установлен @das-forge/integrations)
  app integrations keys {issue,list,revoke}                   (§6.5)
  app integrations webhooks {list,retry,delivery-log}         (§6.5)

Сервис ОС
  app service install|uninstall|start|stop|restart|status
```

### 4.2 Конвенции вывода и кодов выхода
Единые для всех приложений на платформе (в этом и весь смысл `@das-forge/cli`):

- **Формат вывода**: человекочитаемый текст по умолчанию, `--json` — везде,
  где команда возвращает структурированные данные (для скриптов/мониторинга).
- **Exit codes**: `0` — успех, `1` — ожидаемая ошибка (например, pending
  migrations при `db status --strict`), `2` — конфигурационная ошибка
  (невалидный `app.config.js`), `3` — окружение не готово (`doctor` нашёл
  критичные проблемы).
- **Логирование CLI** идёт через тот же `pino`-инстанс, что и сервер, но
  в `pretty`-режиме по умолчанию в терминале.
- Единая обработка ошибок: любая необработанная ошибка команды — это
  `AppError` из core, а не голый stack trace в консоли пользователя.

### 4.3 Backup/restore как оркестрированный workflow
`app backup restore <file>` — это не один SQL-запрос, а пайплайн,
который CLI выполняет пошагово, останавливаясь на первой ошибке:

```
verify backup → stop writes → restore → integrity check
    → migration check → audit entry → health check → отчёт
```

Каждый шаг печатается с ✓/✗, при ошибке — откат к состоянию до restore
там, где это технически возможно (файловая копия перед restore).

### 4.4 Команды регистрируются модулями
Как и UI, CLI расширяемый: `@das-forge/ldap` может зарегистрировать
`app ldap test-connection`, приложение — свои project-level команды
(`atlas import`, `assets sync`). Core-команды (db/backup/health/doctor/
service) одинаковы во всех 4 приложениях по определению — это и есть
единый UX, ради которого всё затевалось.

## 4.5a Кроссплатформенность и Docker — обязательное требование core

Не опция "было бы неплохо", а требование к каждому модулю core с первого
коммита: всё, что попадает в `@das-forge/core`/`@das-forge/cli`, обязано
работать одинаково в трёх средах — **Linux, Windows, Docker** — без
platform-specific веток в бизнес-коде приложений.

Что это значит конкретно:
- **Пути** — только через `node:path` (`path.join`, никаких хардкод `/` или `\`).
- **Сертификаты/процессы/сигналы** — `app service install` уже разделён на
  systemd (Linux) / Windows Service (§4), но общий CLI-код (`app start`,
  `app stop`) не должен знать, под чем он работает — платформенная разница
  инкапсулирована в `core/platform/{linux.js,windows.js}` с общим интерфейсом.
- **Docker — first-class сценарий, не костыль**:
  - `templates/node-express-app/` содержит эталонный `Dockerfile` и
    `docker-compose.yml`, которые генерируются/копируются командой `app install --docker`.
  - `app doctor` умеет определять, что процесс запущен в контейнере
    (`/proc/1/cgroup` или `DOCKER_CONTAINER=1` из compose), и **меняет
    смысл некоторых проверок**: например, "Node version" проверяется
    внутри образа, а "port available" — не проверяется вовсе (за это
    отвечает host).
  - `app service install` внутри контейнера — **no-op с понятным сообщением**
    ("контейнер сам является сервисом, используйте `restart: unless-stopped`
    в compose"), а не попытка поставить systemd внутрь контейнера.
  - Volumes: `data/`, `uploads/`, `backups/` — **обязаны быть вынесены в
    volume** в эталонном compose-файле. `app doctor` в контейнере проверяет,
    что эти пути смонтированы (не находятся на overlay-слое контейнера) —
    иначе предупреждает: "данные будут потеряны при пересоздании контейнера".
- **CI**: core должен иметь юнит/интеграционные тесты, гоняющиеся в GitHub
  Actions на матрице `ubuntu-latest` + `windows-latest`, а не только на Linux
  — иначе "работает у автора ядра" не значит "работает у всех 4 приложений".

## 4.5b Расположение backup — конфигурируемое, не только локальный диск

Это прямо озвученная проблема: если backup лежит на том же диске/сервере,
что и сама БД, при отказе диска/сервера теряется всё — и БД, и бэкапы.
Core должен закладывать это с самого начала, а не как доработку потом.

### Модель
`core/backup` работает не с одной директорией, а с **набором destinations**,
как минимум одна из которых должна быть локальной (для быстрого restore),
а остальные — опционально внешние:

```js
// app.config.js
backup: {
  destinations: [
    { type: 'local', path: './data/backups', primary: true },
    { type: 'network-share', path: '\\\\nas01\\backups\\atlas' },   // Windows UNC тоже валиден
    { type: 'directory', path: '/mnt/external-disk/backups' }        // смонтированный внешний том
  ],
  schedule: '0 3 * * *'
}
```
Первая версия поддерживает `local` (в т.ч. путь на смонтированный сетевой
диск/шару — с точки зрения Node это просто путь) — то есть техническую
проблему "не всё на одном физическом носителе" это уже решает без
интеграции с облачными SDK. Тип `s3`/`webdav` — расширение на будущее
(`core/backup/destinations/*.js` — тот же паттерн модульных проверок, что
и в doctor, добавить новый destination = добавить файл).

### Управление расположением — и из CLI, и из веб-панели
```
app backup destinations list
app backup destinations add --type local --path /mnt/external-disk/backups
app backup destinations remove <id>
app backup destinations set-primary <id>
app backup create --destination <id>       # бэкап в конкретное место
app backup create                          # бэкап во все destinations сразу (по умолчанию)
```
В `@das-forge/ui` — экран `Settings → Backup` с тем же CRUD поверх того же
API ядра (`backup.destinations.*`), UI не дублирует логику, а вызывает те
же core-функции, что и CLI.

### `app doctor` проверяет это явно
Новая проверка в категории Storage: если настроен только один destination
и он на том же физическом томе, что и сама БД — **предупреждение**, а не
тихое молчание:
```
Storage
  ✓ backups/ writable
  ⚠ only one backup destination configured, and it's on the same disk as the database
    → consider adding a network/external destination: `app backup destinations add`
```

## 4.5c Performance/load-тестирование — отдельная тестовая категория

До сих пор в роадмапе (§8/Phase 2) были только Vitest+Supertest (юнит/
интеграция) и Playwright (e2e/UI). Нагрузочное тестирование — отдельная,
явно не описанная категория, добавляем её как полноправный слой:

- **Инструмент: `autocannon`** (Node-нативный, не требует отдельного рантайма
  типа k6/Go — вписывается в тот же `npm test`-контур, что и остальные тесты,
  и не тянет внешних бинарников в CI).
- Расположение: `@das-forge/core` поставляет **готовые перф-сценарии** для
  своих же эндпоинтов (`/health`, login, типовой CRUD через `db` adapter),
  приложения добавляют свои сценарии по тому же паттерну.
- CLI: `app test:perf [--scenario <name>] [--duration 30] [--connections 50]`
  — печатает p50/p95/p99 latency и RPS, не просто "прошло/не прошло".
- **Пороговые значения (budgets)** задаются в `app.config.js` — сам
  механизм (exit code `1` при превышении p95, можно включить в CI как
  gate) фиксируем сейчас, но конкретные числа (20ms/150ms ниже) —
  **placeholder**, не согласованный SLA. Реальные budgets выставляются
  только после первого замера настоящего `core` на реальном железе, не
  придумываются заранее:
  ```js
  performance: {
    budgets: {
      'GET /health':      { p95: '<TBD после первого замера>' },
      'POST /auth/login':  { p95: '<TBD после первого замера>' }
    }
  }
  ```
- Место в роадмапе: добавляется в **Phase 2** вместе с юнит-тестами core
  (перф-сценарии для auth/db с первого коммита, чтобы регрессии по
  производительности core было видно сразу), не откладывается на конец.

## 4.5d Гигиена зависимостей — то, что переизобреталось в каждом проекте

Явно озвученная боль: grep лицензий зависимостей и проверка актуальности
пакетов делались вручную и по-разному в каждом из 4 проектов. Это ровно
тот случай, для которого и затевалась платформа — переносим в CLI как
**встроенные команды**, а не в отдельный опциональный пакет (это
операционная, не бизнес-функциональность, место — рядом с `doctor`):

```
app deps licenses [--json] [--fail-on <list>]
    → грепает лицензии всех зависимостей (через library, не самописный парсинг package.json вручную),
      по умолчанию флагует copyleft (GPL/AGPL) как предупреждение;
      --fail-on GPL,AGPL — exit code 1 в CI, если такие найдены

app deps outdated [--json]
    → таблица: текущая версия / latest / wanted / есть ли breaking (major bump)

app deps audit [--json]
    → обёртка над `npm audit`, но с единым форматом вывода для всех 4 приложений
    → интегрируется в `app doctor` как категория Dependencies

app deps check [--fix]
    → licenses + outdated + audit одной командой, для регулярного ручного прогона
```

Реализация — тонкая обёртка над существующими библиотеками
(`license-checker`/аналог для лицензий, `npm outdated --json`, `npm audit
--json`), а не написание парсера npm-реестра с нуля. Ценность платформы —
не в реализации, а в том, что **все 4 приложения получают одну и ту же
команду с одним и тем же форматом вывода**, вместо четырёх раз
переизобретённого скрипта.

## 4.5e `@das-forge/email` — системные письма как часть контракта, не примитивный `send()`

Изначально API пакета был описан слишком узко (`email.send({to, subject,
text, html})`). Это транспортный примитив, а нужен **набор именованных
системных сценариев**, одинаковых по контракту во всех 4 приложениях,
чтобы Atlas/procure-it/it-assets/net-monitor не реализовывали каждый раз
свой текст письма и свою логику "как собрать ссылку с токеном".

### Публичный API (высокоуровневый, поверх transport)
```js
await email.sendAlert({ to, title, message, severity })              // системный алерт (напр. диск заполнен, backup failed)
await email.sendPasswordReset({ to, resetUrl, expiresInMinutes })
await email.sendPasswordChanged({ to })                                // уведомление "пароль был изменён" (security)
await email.sendEmailVerification({ to, verifyUrl })
await email.sendAccountBanned({ to, reason, until })                   // бан/блокировка аккаунта
await email.sendAccountUnbanned({ to })
await email.sendUserInvited({ to, inviteUrl, invitedBy })
await email.sendSystemNotice({ to, subject, message })                 // общий служебный канал (fallback для случаев вне списка)
```
Каждый метод — это **шаблон + обязательный набор полей**, а не свободный
`html`-текст на усмотрение каждого приложения. Это то же самое соображение,
что и с CLI/doctor: одинаковый UX/контракт важнее гибкости.

### Структура пакета
```
email/
├── transport.js         nodemailer под капотом, приложение не видит его напрямую
├── templates/
│   ├── alert.{ru,en}.html
│   ├── password-reset.{ru,en}.html
│   ├── password-changed.{ru,en}.html
│   ├── email-verification.{ru,en}.html
│   ├── account-banned.{ru,en}.html
│   ├── account-unbanned.{ru,en}.html
│   ├── user-invited.{ru,en}.html
│   └── system-notice.{ru,en}.html
├── render.js             подстановка данных + выбор локали (см. §5.6 — те же ru/en)
└── index.js
```
- Шаблоны на **обоих обязательных языках сразу** (тот же принцип, что и в
  UI/doctor) — язык выбирается по `user.locale`, как и в интерфейсе.
- Приложение может **переопределить** конкретный шаблон (`brand`/логотип,
  доп. текст), но не может убрать сам сценарий — то есть кастомизация
  через `templates/overrides/`, а не форк пакета.
- `sendAlert` — это то же самое событие, что могло бы уйти в
  `realtime.publish()` (§3) для UI-уведомлений; на практике alert часто
  дублируется в оба канала (email + realtime), поэтому `core/audit`
  и `email.sendAlert` используют общую структуру severity
  (`info/warning/critical`), чтобы не изобретать два разных enum.
- Rate-limiting на сами письма (чтобы не заспамить пользователя десятком
  "password changed" при брутфорсе) — тоже часть `@das-forge/email`, не
  забота каждого приложения отдельно.

### SPF/DKIM/DMARC — zero-trust применительно к почте (§4.5j, но для email)
Та же логика "не верим на слово" — только здесь не сервер не доверяет
клиенту, а **получатель письма не обязан верить**, что оно реально от
домена компании. Без SPF/DKIM/DMARC `email.sendAlert()`/`sendPasswordReset()`
и т.д. рискуют улетать в спам или быть подделаны (fishing от имени
системы — реальная угроза для функций вроде password reset).
- **DKIM-подпись исходящих писем** — `nodemailer` поддерживает DKIM "из
  коробки" (приватный ключ + селектор в конфиге), `@das-forge/email`
  подписывает всё исходящее по умолчанию, если в `app.config.js` указаны
  DKIM-параметры.
- **SPF/DMARC** — это DNS-записи домена отправителя, не код — core их не
  может "настроить", но **может проверить**. Добавляю в `doctor`
  (категория Integrations): если `email` модуль включён, `app doctor`
  резолвит SPF/DMARC TXT-записи для домена, с которого отправляются
  письма, и предупреждает, если их нет или они не покрывают
  SMTP-сервер, через который реально отправляется почта.
```
Integrations
  ✓ SMTP reachable
  ⚠ SPF record missing or doesn't include sending server
  ⚠ DMARC record missing (рекомендуется p=quarantine минимум)
```
Это именно то разделение, что и с retention/breach notification раньше:
**настройка** DNS — действие человека (добавить TXT-запись у регистратора
домена), **детект, что не настроено** — код.

## 4.5f HTTPS-only и сертификаты — обязательно, включая локальный/LAN-режим

Требование: **никакого голого HTTP** ни в одном режиме работы. `core/http`
физически не поднимает `http.createServer` для внешнего трафика — только
`https.createServer`, за одним явным исключением (режим за reverse-proxy,
см. ниже).

### Три режима работы, три источника сертификата

```
1. Standalone HTTPS с реальным сертификатом
   → пути к cert/key берутся из app.config.js (свой CA / Let's Encrypt через certbot снаружи)
   → core просто загружает файлы, ничего не генерирует

2. За reverse-proxy (nginx/Caddy терминирует TLS)
   → app.config.js: { server: { trustProxy: true } }
   → core слушает HTTP только на loopback/внутреннем интерфейсе,
     доверяет X-Forwarded-Proto, но снаружи трафик всё равно только HTTPS —
     это не нарушение правила "никакого HTTP", это TLS-termination на границе,
     стандартная практика, а не дыра

3. Локальный запуск / внутри LAN без внешнего reverse-proxy (одна машина, офисная сеть)
   → сертификата взять неоткуда (нет публичного домена для Let's Encrypt)
   → core генерирует self-signed сертификат САМ при первом запуске
```

### Механизм self-signed (режим 3)
- Библиотека: **`selfsigned`** (чистый JS, без нативных биндингов и без
  зависимости от системного OpenSSL-бинарника — на Windows его наличие не
  гарантировано, а конфликтовать с версией OpenSSL в самом Node не хочется).
  Опционально core может использовать системный `openssl` CLI, если он
  найден в PATH (быстрее, привычные форматы), но это **fallback наверх**,
  не обязательное требование — `selfsigned` работает всегда и везде,
  включая Docker-образ без openssl внутри.
- Сертификат кладётся в `data/certs/{cert.pem,key.pem}`, попадает под то же
  правило volume-монтирования, что и `data/`/`uploads/`/`backups/` (§4.5a) —
  иначе при пересоздании контейнера сертификат сгенерируется заново и
  все закреплённые доверия в браузерах/ОС слетят.
- В сертификат прописываются `subjectAltName`: `localhost`, `127.0.0.1`,
  реальный hostname машины и, если задан, IP из LAN — чтобы открывать и
  по `https://localhost:3000`, и по `https://192.168.x.x:3000` без второй
  генерации.

### Управление сертификатом — CLI и `doctor`
```
app cert info                     срок действия, subjectAltName, self-signed или нет
app cert generate [--force]       (пере)генерация self-signed
app cert renew                    перевыпуск с сохранением тех же SAN
app cert trust                    печатает инструкцию (Linux/Windows/macOS) как добавить
                                   self-signed сертификат в доверенные корневые — сам в системный
                                   trust store ничего не пишет без явного --system флага
                                   (модификация системного trust store — потенциально опасная операция,
                                   должна быть осознанным действием администратора)
```
`app doctor` (категория Security, уже была в §4.5) расширяется:
```
Security
  ✓ certificate valid (expires in 214 days)
  ⚠ self-signed certificate in use — not trusted by default in browsers
  ⚠ certificate expires in 12 days
    → run `app cert renew`
```
Автоматический перевыпуск: `app cert renew` вызывается по расписанию (тот
же cron-механизм, что и `app backup create`), а не только руками — self-
signed сертификат не должен незаметно протухнуть посреди работы.

### DNS-over-HTTPS / DNSCrypt — решено: резолвер уровня `@das-forge/network`, не общее требование

Подтверждено: речь о сценарии (1) — **сервер сам резолвит исходящие
запросы через DoH/DNSCrypt**, актуально для net-monitor (сетевые
проверки/опросы устройств), не про то, что приложения сами отдают DoH
наружу (сценарий 2 — не делаем, отдельный тяжёлый сервис не нужен).

Контракт: конфигурируемый резолвер на уровне `@das-forge/network`, не
общее требование для всех 4 приложений (procure-it/atlas не резолвят
внешние хосты, которым нужна эта защита):
```js
// app.config.js — только net-monitor
modules: {
  network: {
    resolver: 'system' | 'doh',
    dohEndpoint: 'https://1.1.1.1/dns-query'   // если resolver: 'doh'
  }
}
```
Реализация — `node:dns` с кастомным resolver'ом (Node поддерживает это
через `dns.Resolver` + кастомный сокет, либо тонкая обёртка через
`undici`'s DoH-совместимый lookup) внутри `@das-forge/network`, доступно
только там, где вообще есть исходящие сетевые проверки.

## 4.5 `health` vs `doctor` — разные инструменты, разная аудитория

Их часто путают, но это принципиально разные проверки, и в core это два
разных модуля (`core/health` и `core/health/doctor.js`, но с разным API
и разной точкой входа).

### `app health` / `GET /health` — "сервер жив и отвечает правильно"
Быстрая проверка **работающего процесса**, вызывается часто (мониторингом,
балансировщиком, systemd `ExecStartPost`). Должна отрабатывать за
миллисекунды, не открывать новых соединений без необходимости.

Проверяет:
- процесс отвечает на HTTP
- БД доступна (простой `SELECT 1`, не полный integrity check)
- версия приложения совпадает с ожидаемой (для деплоя)

Вывод (`--json` или `GET /health`):
```json
{ "status": "ok", "database": "ok", "version": "26w40-b03", "uptime": 41233 }
```
При проблеме — `"status": "degraded"` или `"error"` + `503` на HTTP-уровне,
не `500` (это осознанный сигнал "сервис жив, но не готов принимать трафик").

### `app doctor` — "машина/установка настроена правильно"
Диагностика **окружения и конфигурации**, запускается человеком при
установке, после апдейта, при разборе инцидента. Может занимать секунды,
проверяет намного больше и **не должна вызываться автоматически на каждый
запрос**.

Категории проверок (единые для всех 4 приложений, каждый модуль добавляет
свои):
```
Runtime        Node version, npm version, platform (win/linux), architecture
Configuration  .env присутствует, обязательные переменные заданы, секреты не дефолтные
Database       connection, integrity_check, migrations up to date, размер файла
Storage        data/, uploads/, backups/ — существуют и доступны на запись
Security       файловые права на .env/certs, сертификаты валидны и не просрочены,
               auth configuration (session secret не дефолтный, argon2 доступен)
Integrations   SMTP reachable (если email включён), LDAP reachable (если включён),
               внешние network-провайдеры (для net-monitor)
Application    ru+en локали присутствуют и полны (см. §5.6), light/dark темы
               зарегистрированы, обязательные модули из app.config.js загружены,
               порт свободен
```

Пример вывода:
```
Atlas Doctor

Runtime
  ✓ Node.js 26.10.0
  ✓ npm 11.2.0
  ✓ platform: linux/x64

Configuration
  ✓ .env present
  ✓ required variables set

Database
  ✓ connection ok
  ✓ integrity OK
  ✗ migrations: 2 pending
    → run `app db migrate`

Storage
  ✓ data/ writable
  ✓ uploads/ writable
  ✓ backups/ writable

Security
  ✓ certificates valid (expires in 214 days)
  ✓ session secret configured

Integrations
  ✓ SMTP reachable
  – LDAP disabled

Application
  ✓ locales: ru, en complete
  ✓ themes: light, dark, system registered
  ✓ port 3000 available

2 issues found. Run `app db migrate` to resolve pending migrations.
```

`--json` выдаёт ту же структуру машиночитаемо (для скриптов CI/onboarding).
`--fix` — там, где безопасно (создать недостающую директорию, прогнать
миграции после подтверждения) — doctor чинит сам, а не просто ругается.
Каждая проверка — отдельный модуль в `core/health/doctor/checks/*.js`, так
что `@das-forge/ldap` добавляет свою проверку в `Integrations`, а
`@das-forge/images` — проверку доступности `libheif-js`/`sharp`-биндингов,
без изменения самого doctor-фреймворка.

## 4.5g Операционные инструменты — CLI + admin-панель, парный контракт

Общий принцип для всего этого блока (как и для backup destinations в
§4.5b): **CLI и UI вызывают один и тот же core-API**, ничего не
дублируется. UI — это тонкая обёртка над той же функцией, что и команда.
Ниже — 8 инструментов, которых не хватало.

### 1. Логи: просмотр, экспорт, retention
```
app logs tail [--follow] [--level error] [--since 1h]
app logs export --since 2026-09-01 --until 2026-09-30 --out logs.ndjson
app logs config set --retention-days 30 --max-size 500MB
```
`core/logging` пишет через `pino` в ротируемые файлы (`pino-roll`, уровень
приложения — не core-зависимость, но core задаёт дефолтную политику).
Retention/rotation конфигурируется, а не хардкожено.

**Admin-панель**: `Administration → Logs` — живой tail через SSE (тот же
`core/realtime`, что и notifications), фильтр по уровню/дате/модулю,
кнопка "Export". Доступ — отдельное право `admin.logs.view` (не то же,
что общий admin).

### 2. Восстановление доступа администратора (без веб-логина)
```
app user create-admin --email admin@company.local           # интерактивно спросит пароль, или --temp-password
app user reset-password <email> --temp                       # генерирует временный пароль, требует смены при первом входе
app user unlock <email>                                      # снять блокировку после лишних попыток входа
```
Работает напрямую через `core/database`, в обход HTTP/сессий — это
единственный путь "почини доступ", когда сам веб-интерфейс недоступен
(забыт пароль, все админы заблокированы). **В admin-панели этой команды
нет и не может быть** — по определению, если у тебя есть доступ в панель,
эта функция тебе не нужна.

### 3. Баны и rate-limit — просмотр и снятие
```
app security bans list [--json]
app security bans unban --ip <ip> | --account <email>
app security bans clear-all --yes
```
**Admin-панель**: `Administration → Security → Blocked` — таблица
(IP/аккаунт, причина, время бана, сколько осталось), кнопка "Unban" на
каждой строке. И CLI, и UI читают из одного стора банов в `core/security`
(не in-memory — переживает рестарт процесса).

### 4. Единый реестр периодических задач (cron registry)
Backup schedule, cert renew, deps check и любые задачи, которые
зарегистрируют модули — всё через одну точку `core/scheduler`, а не
каждый со своим `setInterval`:
```
app cron list                     # что зарегистрировано, расписание, когда следующий запуск
app cron history [--task backup]  # что и когда реально выполнялось, успех/ошибка, длительность
app cron run <task> --now         # запустить вне расписания (напр. "сделай бэкап прямо сейчас")
```
**Admin-панель**: `Administration → Scheduled Tasks` — список задач + статус
последнего запуска (✓/✗ + длительность), кнопка "Run now". Пропущенный/
проваленный запуск **обязательно** триггерит `email.sendAlert` (§4.5e) —
иначе никто не узнает, что бэкап неделю не выполнялся.

### 5. Секреты — ротация без хаоса
```
app secrets rotate session-secret         # инвалидирует все текущие сессии — с явным подтверждением
app secrets rotate smtp-password --value <new>
app secrets list [--json]                 # какие секреты сконфигурированы, БЕЗ значений — только имена + "когда последний раз менялся"
```
`session-secret` ротация — деструктивная операция (все залогинены выйдут),
поэтому CLI требует `--yes`, а в UI — двойное подтверждение с явным текстом
последствия. Значения секретов никогда не отображаются ни в CLI, ни в UI —
только факт настроенности и дата последней смены.

**Admin-панель**: `Administration → Secrets` — список имён + даты, кнопка
"Rotate" с модалкой-предупреждением (используем `dialogs.confirm` из §5).

### 6. Метрики — решено: делаем, раз Grafana подтверждена как стек
Снимаю прошлое "отложено" — раз Grafana реально используется/будет
использоваться, строить `/metrics` обоснованно:
```
GET /metrics     Prometheus text format — RPS, latency (p50/p95/p99),
                  error rate, db pool, event loop lag, memory, активные SSE-соединения
```
Включается флагом `observability: { metrics: true }` в `app.config.js` —
не хардкод на все 4 приложения разом, потому что не всем может быть нужно
сразу (например, net-monitor и так пишет метрики в себя). **UI-страницу
графиков в Administration не делаем** — раз Grafana уже есть, дублировать
её дешёвым встроенным графиком бессмысленно; вместо этого `Administration
→ Metrics` — это просто iframe/ссылка на готовый Grafana-дашборд
приложения (конфигурируется `observability.grafanaDashboardUrl`), не
велосипед на графиках. `doctor` (категория Integrations) проверяет
доступность `/metrics` снаружи, если флаг включён.

### 7. Graceful shutdown / рестарт без обрыва запросов
```
app restart [--drain-timeout 30]
```
При `SIGTERM`/`app stop`: сервер перестаёт принимать новые соединения,
даёт активным HTTP-запросам и открытым SSE-стримам (`core/realtime`)
завершиться в течение `drain-timeout`, затем принудительно закрывает
оставшиеся. Реализуется один раз в `core/http`, все 4 приложения получают
это бесплатно — раньше у каждого был свой (или никакой) обработчик
`SIGTERM`.

**Admin-панель**: кнопка "Restart application" в `Administration → System`
с тем же drain-механизмом — UI не имеет права дёргать process.kill напрямую,
только вызывает тот же core-эндпоинт, что и CLI.

### 8. Health и Doctor — отдельный экран, не подпункт System

Изначально Health/Doctor были описаны только как CLI-команды (§4.5) —
это неправильно оставлять их без UI-эквивалента, раз весь остальной
операционный инструментарий (§1–7 выше) уже задуман парой CLI+UI. Health/
Doctor заслуживают своего пункта, а не строчки внутри "System", потому
что смотрят их чаще всего (в отличие от, например, secrets).

**`Administration → Health & Doctor`**:
- Верхний блок — живой статус из `GET /health` (§4.5): зелёный/жёлтый/
  красный индикатор, обновляется по SSE или поллингом каждые N секунд —
  то же самое, что видит внешний мониторинг, но глазами администратора
  внутри приложения.
- Ниже — кнопка **"Run diagnostics"**, вызывающая тот же `doctor.run()`,
  что и `app doctor` в CLI, с тем же выводом по категориям (Runtime,
  Configuration, Database, Storage, Security, Integrations, Application —
  §4.5), отрендеренным как список с ✓/⚠/✗ вместо текстовой консоли.
- Проваленные/предупреждающие пункты кликабельны там, где есть авто-фикс
  (`--fix` из CLI) — кнопка "Fix" рядом с конкретной строкой, вызывающая
  ту же fix-функцию, что и `app doctor --fix`, точечно для одной проверки,
  а не всего скопом.
- Historical view: последние N прогонов doctor (когда запускался — вручную
  или по расписанию, см. п.4 `core/scheduler`) и как менялся результат —
  полезно видеть "сертификат вчера был ✓, сегодня ⚠" без пролистывания логов.

Это **read-heavy, write-light** экран — в отличие от Secrets/Bans, тут
почти нет деструктивных действий, поэтому право на просмотр (`admin.health.view`)
может быть шире, чем на остальные разделы Administration — например,
выдано не только полным админам, но и дежурным/техподдержке.

### 9. Просмотр audit log
```
app audit tail [--follow]
app audit export --since <date> --actor <user> --out audit.ndjson
```
**Admin-панель**: `Administration → Audit Log` — таблица (кто/что/когда/
сущность), фильтры по actor/действию/дате, экспорт в тот же формат, что
и CLI-команда (то есть UI — не отдельная реализация экспорта, а кнопка,
вызывающая ту же функцию `audit.export()`).

### Сводка: новый раздел admin-панели
Всё это в UI живёт под одним пунктом навигации, который приложение
получает бесплатно вместе с AppShell (§5.7):
```
Administration
  ├── Health & Doctor
  ├── Logs
  ├── Security → Blocked (bans)
  ├── Scheduled Tasks (cron)
  ├── Secrets
  ├── Integrations (API keys, webhook delivery log) — если пакет установлен
  ├── Metrics (ссылка на Grafana-дашборд) — если observability.metrics включён
  ├── Privacy (export/erase, 152-ФЗ/GDPR)
  ├── Roles & Permissions
  ├── Audit Log
  └── System (restart, version)
```
Доступ к разделу целиком и к каждому пункту — через отдельные permissions
(`admin.logs.view`, `admin.security.manage`, ...), а не один общий
"isAdmin" флаг — это уже вытекает из `authorization.can()` (§3).

## 4.5j Zero-trust на границе клиент↔сервер — явный сквозной принцип

Формулирую как правило платформы, а не как разовую защиту: **клиент
(браузер) — недоверенная сторона всегда, в обе стороны**. Это не новая
фича, а склейка уже принятых решений (Zod, CSRF, RBAC) в один явный
принцип + несколько следствий, которые раньше не были проговорены.

### Клиент → сервер: ничему из присланного не верим на слово
- **Валидация на клиенте — только UX**, никогда не защита. Та же
  `ApplicationConfigSchema`/`UserSchema`-логика (Zod, §7.5) **обязательно**
  повторно прогоняется на сервере — изоморфность Zod здесь не "чтобы не
  дублировать код", а "чтобы дублирование правил не разъехалось", сама
  проверка выполняется дважды по определению zero-trust.
- **Права/роль пользователя никогда не берутся из тела запроса.** Если
  клиент прислал `{ role: 'admin' }` в payload — сервер это игнорирует,
  роль всегда читается из серверной сессии (`req.session.user`), не из
  того, что прислал браузер. Это уже подразумевалось RBAC-моделью (§3), но
  стоит явно: **никакое поле в body/query не может влиять на авторизацию**.
- **Вычисляемые значения (цены, суммы, итоги) не принимаются от клиента.**
  Прямое следствие для procure-it: если форма закупки присылает
  `totalPrice`, сервер игнорирует это поле и **пересчитывает сам** из
  `quantity × unitPrice` по серверным данным о ценах, а не доверяет
  готовому числу из формы — иначе это открытая дыра "поменяй число в
  devtools перед отправкой".
- **ID/версии для optimistic locking** (уже упоминалось для atlas) —
  клиент присылает `version`, сервер **проверяет** совпадение с текущей
  версией в БД (409 Conflict при расхождении), но не доверяет version
  как источнику правды ни для чего, кроме этой проверки конфликта.
- **Клиентское время не авторитетно.** Если фронт присылает `timestamp`
  события — в `audit.log()`/бизнес-логике использовать **серверное**
  время получения запроса, клиентский timestamp — максимум для отображения
  ("как видел это пользователь"), не для порядка событий или SLA-расчётов.

### Сервер → клиент: не отдаём лишнее, чтобы не полагаться на то, что UI это "просто не покажет"
Это обратная сторона, которую часто упускают: если сервер отдаёт **все**
поля сущности, а UI просто не рендерит некоторые (например, зарплату
сотрудника, закупочную цену) — это не защита, это скрытие в devtools на
одну вкладку "Network". Правило: **API отдаёт клиенту только то, что
этому клиенту разрешено видеть**, на уровне сериализации, а не рендеринга.
```js
// core/http/serialize.js
serialize(entity, { viewerPermissions })
  → убирает поля, на которые у permissions нет доступа,
    ДО того, как объект уйдёт в res.json()
```
Каждая сущность в приложении декларирует, какие поля требуют каких
permissions (например, `asset.purchasePrice` требует `assets.viewFinancials`)
— это часть контракта модуля (расширение `ModuleRegistrationSchema`, §7.5),
не решение "спрятать в UI", принимаемое на лету в каждом компоненте.

### Токены, которые уходят клиенту и возвращаются обратно
Reset-ссылки, invite-ссылки, email-verification-ссылки (§4.5e) — все уже
подразумевались как "ссылка с токеном", но явно: токен должен быть
**криптостойким случайным, подписанным и с истечением**, а не
предсказуемым (не `userId + timestamp`, не последовательный ID). Сервер
при приёме такого токена обратно **не доверяет** содержимому токена
напрямую — только смотрит его в своём хранилище (истёк? использован? для
кого выдан?), сам токен — просто ключ поиска, не источник правды о
пользователе/правах.

### Итог как единое правило для контракта модуля
Каждый роут в приложении, пишущий данные, должен отвечать на три вопроса
одинаково, независимо от того, что каким образом клиент попытался прислать:
"откуда взялась роль?" → из сессии. "откуда взялась цена?" → из БД/расчёта
на сервере. "откуда взялось разрешение показать это поле?" → из
`serialize()` по правам смотрящего. Ни один из трёх ответов никогда не
"из тела запроса".

## 4.5h Security-гигиена современного стека — что ещё не проговорено явно

Это то, что обычно не вспоминают, пока не прилетит инцидент. Разбиваю на
**обязательное в core с первого коммита** и **обсудить/решить осознанно**.

### Обязательное — закладываем в `core/security`/`core/http` сразу

**1. Request ID / correlation ID.**
Каждый запрос получает `X-Request-Id` (генерируется, если клиент не прислал),
прокидывается через весь `pino`-логгер и в `audit.log()`. Без этого
разбор инцидента по логам — это grep по времени и надежда, что ничего не
наложилось. Тривиально в реализации, критично для отладки в проде.

**2. Cookie flags и session fixation.**
`httpOnly`, `secure` (обязательно — у нас HTTPS-only, §4.5f), `sameSite: 'lax'`
по умолчанию — и **regenerate session ID при логине** (не просто выдать
права существующей анонимной сессии) — иначе сессия уязвима к fixation.
Это должно быть частью `auth.createSession()` (§3), не опцией, которую
можно забыть включить в конкретном приложении.

**3. Лимиты на входящий трафик (anti-DoS на уровне приложения).**
`express.json({ limit: '1mb' })` по умолчанию (переопределяемо на конкретных
эндпоинтах — например upload), request timeout (защита от slowloris),
лимит на глубину вложенности JSON. Сейчас в архитектуре только
`express-rate-limit` (по количеству запросов) — этого мало, нужен ещё
лимит на *размер и время* одного запроса.

**4. Безопасная загрузка файлов** (актуально для atlas/procure-it/it-assets —
все три работают с файлами/документами/изображениями):
- проверка **реального** MIME по содержимому (magic bytes), а не по
  расширению или `Content-Type` из запроса (его подделать тривиально);
- запрет path traversal в имени файла (`../../etc/passwd`) — генерировать
  собственное имя на диске, оригинальное имя хранить только в БД;
  жёсткий whitelist разрешённых типов на уровне `app.config.js` модуля.
- Это должно жить в `core/files` (или отдельно `@das-forge/files`, уже
  заявленном в §6) как обязательный слой перед записью на диск, а не
  проверяться (или не проверяться) в каждом приложении по-своему.

**4a. Magic bytes — необходимо, но недостаточно.** Файл, у которого
заголовок честно соответствует заявленному типу, всё равно может быть
вредоносным *внутри* — JS/TS не даёт типобезопасности на уровне байтов
файла точно так же, как не даёт её на уровне данных из запроса (§4.5j —
тот же принцип zero-trust, просто на уровень глубже). Конкретные риски,
которые magic-bytes не ловит:

- **ZIP-бомба под видом docx/xlsx/pptx.** Офисные форматы — это ZIP-архив
  внутри. Magic bytes скажут "да, это ZIP, всё ок", но внутри может быть
  архив с огромным коэффициентом сжатия (несколько КБ на диске → терабайты
  после распаковки), который положит `@das-forge/documents`/`@das-forge/exports`
  при попытке прочитать. Защита: явный лимит на **коэффициент сжатия** и
  **количество entries** при распаковке (например, отказ, если
  decompressed/compressed > 100 или entries > 1000), и проверка, что
  внутри реально ожидаемая структура (`[Content_Types].xml` для docx/xlsx),
  а не что угодно с правильным ZIP-заголовком.
- **PDF с активным содержимым.** PDF может содержать JavaScript-действия,
  встроенные файлы, launch-actions. Сервер никогда не должен *исполнять*
  или *рендерить с интерпретацией JS* загруженный PDF — только хранить и
  отдавать как opaque blob, либо явно санитизировать (вырезать `/JavaScript`,
  `/JS`, `/Launch` объекты) перед сохранением, если `@das-forge/documents`
  вообще заглядывает внутрь PDF, а не просто передаёт файл насквозь.
- **Полиглот-файлы** (валидны одновременно как два формата — например,
  ZIP-хвост, приклеенный к валидному JPEG). Здесь помогает не проверка
  байтов, а **пересборка, а не доверие оригинальным байтам**: для
  изображений `@das-forge/images` (§6, sharp) и так декодирует и
  перекодирует пиксели заново — это уже сильная защита *как побочный
  эффект*, потому что полиглот-хвост, не относящийся к самому изображению,
  физически не переживает decode→re-encode цикл. Стоит явно
  зафиксировать это как **обязательный шаг**, а не опциональную
  "конвертацию" — любое загруженное изображение проходит через
  sharp хотя бы раз, даже если формат на входе и выходе совпадает.
- **Antivirus-сканирование (опционально, не для всех инсталляций).** Для
  atlas/procure-it, где через загрузку проходит много документов от разных
  людей, имеет смысл опциональный слой — вызов ClamAV (демон, внешняя
  зависимость, поэтому именно опция, а не часть core по умолчанию):
  ```js
  // app.config.js
  files: { antivirus: { enabled: true, socket: '/var/run/clamav/clamd.ctl' } }
  ```
  Если демон недоступен, а `antivirus.enabled: true` — `app doctor`
  (категория Integrations) должен явно на это указать, не проглатывать
  молча.

**5. CSP (Content-Security-Policy) для `@das-forge/ui`.**
Раз UI — vanilla JS без бандлера, это даже проще сделать правильно, чем в
SPA-стеке: `script-src 'self'` (+ nonce на инлайн-скрипты, если понадобятся),
никакого `unsafe-inline`/`unsafe-eval`. `helmet` уже в core-зависимостях —
CSP настраивается через него, но сейчас в документе явно не зафиксирована
политика, только сам факт "helmet используется".

**6. Password policy + breach-check (опционально offline).**
Минимум — длина/энтропия через Zod-схему в `core/auth`. Дальше — вопрос:
подключать ли проверку по базе скомпрометированных паролей (k-anonymity
API вроде HaveIBeenPwned) — в LAN/изолированной сети это будет требовать
исходящего интернет-доступа, что не всегда приемлемо для внутренней
инфраструктуры компании. Предлагаю сделать **опциональным флагом**
(`auth.passwordPolicy.breachCheck: false` по умолчанию), а не обязательным.

**7. Clock skew / точность времени — новая проверка в `doctor`.**
Audit log и сертификаты (§4.5f) полагаются на корректное системное время.
Расхождение времени на сервере — тихая причина "сертификат уже
просрочен, хотя вчера был свежий" или "аудит-лог событий в неправильном
порядке". Добавить в doctor категорию Runtime: сверка с NTP (если есть
исходящий доступ) или хотя бы предупреждение, если системные часы сильно
разошлись с временем последнего успешного запроса к внешнему сервису.

### Пункты 8–10 — решено

**8. 2FA/TOTP — включаем, опционально.** `core/auth/totp.js` (RFC 6238,
совместим с Google Authenticator/Authy), `auth.require2fa: ['admin']` —
включается per-role через `ApplicationConfigSchema` (§7.5, поле уже
заложено), не для всех пользователей по умолчанию. Реализуется в Phase 2
вместе с остальным `core/auth`, не откладывается на потом.

**9. Шифрование БД at rest — уровень ОС.** Не усложняем core ради этого
(конфликтовало бы с решением "нативный `node:sqlite`"). `doctor`
(категория Security) выдаёт рекомендацию проверить шифрование диска
(BitLocker/LUKS), core сам ничего не шифрует.

**10. 152-ФЗ и GDPR — да, актуально, закладываем `core/privacy`.**

## 4.5k `core/privacy` — 152-ФЗ / GDPR-совместимость и cookie-уведомление

Раз it-assets/procure-it хранят ФИО и контакты сотрудников — это
персональные данные, и (а) по 152-ФЗ, и (б) если у компании есть связи с
ЕС (сотрудники/контрагенты-резиденты ЕС) — по GDPR. **Важная оговорка**:
дальше — техническая база, которая нужна в любом случае, но
финальное соответствие 152-ФЗ/GDPR (согласия, основания обработки,
трансграничная передача данных, DPO и т.д.) — вопрос юридический, не
архитектурный; технические возможности ниже нужно будет сверить с
юристом/комплаенсом компании, это не заменяет такую проверку.

### Модель: субъект данных = сотрудник, запрос обычно инициирует админ/HR
В отличие от публичного SaaS (где юзер сам жмёт "скачать мои данные"),
здесь чаще сценарий "сотрудник увольняется/просит удалить данные — HR/
admin выполняет запрос через систему". Оба пути поддерживаются:

```js
// core/privacy — каждый модуль регистрирует, как экспортировать/стереть
// данные конкретного пользователя (расширение ModuleRegistrationSchema, §7.5)
ui.register({
  ...,
  dataSubject: {
    export: async (userId) => ({ assets: [...] }),      // модуль отдаёт свой кусок данных
    erase: async (userId, { mode }) => { ... }           // mode: 'anonymize' | 'delete'
  }
});

privacy.exportUserData(userId)   // собирает export() со всех модулей в один JSON
privacy.eraseUserData(userId, { mode })
```
**По умолчанию `mode: 'anonymize'`, не `'delete'`** — потому что audit log
(§3) обязан сохранять целостность истории событий (кто/что/когда), а
жёсткое удаление сломало бы аудит. Анонимизация заменяет
идентифицирующие поля (ФИО, email) на `"Удалённый пользователь #<id>"`,
но оставляет сам факт события в истории. Полное `'delete'` — доступно
явным флагом, когда это действительно требуется юридически.

### CLI и Admin UI
```
app privacy export --user <email> --out export.json
app privacy erase --user <email> [--mode anonymize|delete] --yes
```
**`Administration → Privacy`** (или как раздел карточки пользователя в
Users): кнопки "Export data" / "Erase data" с тем же двойным
подтверждением, что и у Secrets rotation (§4.5g/п.5) — необратимое
действие, особенно в режиме `delete`. Каждое действие пишется в
`audit.log()` — сам факт запроса на приватность тоже часть аудита.

### Cookie-уведомление — в core, обязательно
Даже для внутренних приложений с одними только сессионными cookie
(никакой аналитики/рекламы) пользователей стоит **проинформировать**, что
куки используются — это встроено в `@das-forge/ui` как обязательный
лёгкий баннер (`ui/cookie-notice`), не полноценная consent-платформа:
```js
// defineAppUI
cookieNotice: {
  text: 'notice.cookies',   // i18n-ключ, платформенный дефолт на ru/en уже есть
  linkTo: '/privacy-policy'  // опционально
}
```
Баннер информативный ("мы используем куки для работы сессии"), не
gate-ит функциональность и не требует явного "Согласен" — потому что
единственные куки в системе строго необходимы для работы (сессия), а не
трекинг/реклама.

**Решено: аналитика внутренняя, сторонних cookie нет.** Это упрощает
картину до изначального варианта — события считаются на своей стороне
через `/metrics` + Grafana (п.6 выше), никакого стороннего SDK (Google
Analytics/Яндекс.Метрика и т.п.) не подключается, значит данные
сотрудников никуда не утекают третьей стороне, и cookie для аналитики
физически не появляется. Информационного `ui/cookie-notice` достаточно,
полноценный consent management (`cookieConsent`) **не нужен** — оставляю
этот абзац в документе как объяснение, почему было бы иначе, если бы
решение было другим, но для текущей архитектуры это закрытый вопрос.

### Retention policy — technical enabler, не решение "сколько хранить"
Архитектура не решает юридический вопрос "сколько хранить карточку
уволенного сотрудника" — это решает компания/юрист. Но должна дать
**механизм**, которым это решение потом исполняется автоматически, а не
руками:
```js
// расширение ModuleRegistrationSchema (§7.5)
dataSubject: {
  export: z.function(),
  erase: z.function(),
  retentionDays: z.number().int().positive().optional()   // NULL = бессрочно, решает приложение/юрист
}
```
`core/scheduler` (§4.5g/п.4) добавляет задачу `privacy.enforceRetention()`
— на каждую сущность с истёкшим `retentionDays` вызывает `erase(userId,
{ mode: 'anonymize' })` автоматически, или, если авто-анонимизация
рискованна для конкретного модуля, **флагует на ручной пересмотр**
(`app privacy review-queue`) вместо тихого действия. Конкретное число
дней — не наше архитектурное решение, только то, что оно **есть куда
положить** и **что-то с ним само происходит**, когда истекает.

### Breach notification — technical enabler для скорости, не замена процесса
72-часовое окно по GDPR (ст. 33) — это про то, что **человек (DPO/
ответственный) обязан уведомить регулятора**, архитектура это не делает
за него. Но может радикально сократить время до момента "человек узнал":
```
app security incident declare --severity critical --summary "..."
```
Триггерит `email.sendAlert()` (§4.5e) на список ответственных из
`app.config.js` (`security.incidentContacts`), **немедленно**, а не когда
кто-то случайно заметит аномалию в audit log. Сам `audit.log()` (§3) уже
даёт неизменяемую историю для последующего разбора "что произошло и когда"
— это уже часть архитектуры, просто не была явно привязана к процессу
breach notification. Дальнейшие юридические шаги (кого и как уведомлять) —
вне кода.

### Реестр обработки (ст. 30 GDPR) — генерируется из кода, не пишется руками
Раз каждый модуль уже декларирует `dataSubject`/`fieldPermissions` как
часть контракта (§7.5) — реестр обработки можно **вывести из этих
деклараций автоматически**, вместо того чтобы вести отдельный Word/Excel
документ, который неизбежно разъедется с реальным кодом:
```
app privacy registry [--json] [--out registry.md]
```
Обходит все зарегистрированные модули, печатает: какие данные (по
`fieldPermissions`), кто может видеть (по permission), есть ли
экспорт/удаление (`dataSubject`), retention (если задан). Это не
заменяет юридическую часть реестра (основание обработки, цели, сроки
хранения по закону) — те поля добавляются как **дополнительные
метаданные** в декларации модуля (`legalBasis`, `purpose` — строки,
которые заполняет разработчик по итогам согласования с юристом), но
структура и актуальность реестра теперь гарантированно не расходится с
кодом, потому что *является* кодом.

### DPIA и DPO — вне архитектуры, оставляю как есть
Не пытаюсь предложить "техническое решение" для них — DPIA требует
человеческого суждения о приемлемости риска, DPO — это назначение роли
в компании. Ни то ни другое не автоматизируется и не является частью
`@das-forge/*`.

Из всего списка §4.5h **пункты 1–10 теперь все зафиксированы как
решения**, ничего не осталось в подвешенном состоянии.

## 4.5i Защита доступа к CLI и Admin UI — сетевая изоляция важнее ещё одного пароля

Это два разных периметра, и решения для них разные.

### CLI
CLI по определению выполняется **на самой машине** (или внутри контейнера)
— это не сетевой сервис, у него нет "внешнего" доступа, который можно
перехватить по сети. Реальная защита CLI — это уже решённая ОС-задача,
core её не дублирует:
- права на файлы (`app.config.js`, `.env`, `data/`) — только владелец/
  сервисный пользователь;
- кто может зайти на сервер по SSH/RDP — вопрос инфраструктуры, не core;
- команды вроде `app user create-admin` (§4.5g) и так требуют локального
  shell-доступа — это уже достаточный барьер для serverless-класса угроз.

Единственное, что стоит добавить в core: команды, меняющие
security-критичные вещи (`app secrets rotate`, `app user reset-password`),
**пишут в audit log от имени "cli/<os-user>"**, а не анонимно — чтобы
при разборе инцидента было видно, что действие пришло с консоли, а не
через UI, и каким ОС-пользователем.

### Admin UI — три уровня защиты, не взаимоисключающие

**Уровень 1 (обязательный, дёшево): отдельный bind-адрес для Administration.**
`core/http` умеет поднимать `/administration/*` **на отдельном порту/
интерфейсе**, отличном от основного публичного трафика:
```js
// app.config.js
server: {
  port: 3000,                          // публичная часть приложения
  admin: { port: 3443, bindHost: '127.0.0.1' }  // Administration — только на loopback/внутреннем интерфейсе
}
```
По умолчанию `bindHost` для admin — **не `0.0.0.0`**. Это не "заменитель"
аутентификации, а снижение поверхности атаки: чтобы достучаться до
`/administration`, нужно либо быть на самой машине, либо иметь доступ к
внутреннему интерфейсу — а не просто знать URL. `doctor` (Security) уже
проверяет это как отдельный пункт: "admin interface bound to 0.0.0.0 —
consider restricting".

**Уровень 2 (рекомендуемый для LAN/офиса): VPN-оверлей, например Tailscale.**
Это ровно то, о чём ты думаешь, и это правильное направление — но это
**вопрос деплоя, не что-то, что core должен жёстко зашивать**. Core не
должен знать про конкретно Tailscale (это была бы лишняя зависимость и
vendor lock-in для тех, кто использует WireGuard/OpenVPN/просто
корпоративный VPN). Вместо интеграции — **core делает так, чтобы это
хорошо работало**:
- `admin.bindHost` (см. выше) можно указать как Tailscale-адрес машины
  (`100.x.x.x`) — тогда Administration физически недостижима вне
  Tailscale-сети, без единой строчки Tailscale-специфичного кода в core;
- в `docs/deployment/` — гайд "как повесить Administration за Tailscale/
  WireGuard", а не код в core.
- Плюс такого подхода: Tailscale/WireGuard уже дают identity (кто именно
  подключился по VPN) — это дополнительный слой поверх обычного логина,
  бесплатно, без реализации в приложении.

**Уровень 3 (задел на будущее, НЕ проектируем сейчас): mTLS клиентские
сертификаты на `/administration/*`.** Идея зафиксирована на случай, если
Уровней 1+2 когда-нибудь станет мало (например, внешний доступ к Atlas без
VPN) — тогда core уже умеет управлять сертификатами (§4.5f) и это
расширяется до клиентских. Но для текущего масштаба (4 внутренних
приложения, всё в LAN) это ощутимый operational overhead (выпуск/отзыв
сертификатов на каждого админа) ради угрозы, которая Уровнями 1+2 уже
достаточно снижена — **не проектируем детально, пока не понадобится**.

### Решение по умолчанию
**Уровень 1 включаем всегда** (это бесплатно и делается на уровне
`core/http` без доп. UX). **Уровень 2 (VPN/Tailscale)** — просто гайд в
`docs/deployment/`, ничего не пишем в коде. **Уровень 3 — не делаем**, пока
не появится конкретный сценарий, где 1+2 недостаточно.

## 5. `@das-forge/ui` — vanilla JS admin platform

Решено: без фреймворка. React-вариант из более ранней части обсуждения
отменён этим решением.

### 5.1 Технологический подход
- **Web Components** (`customElements.define`) как единица инкапсуляции —
  Shadow DOM даёт изоляцию стилей без CSS-in-JS и без сборщика.
- Загрузка нативными **ES-модулями** (`<script type="module">`), без
  бандлера в dev-режиме. Для production — лёгкий build step (esbuild)
  только для минификации/склейки, не обязателен для разработки.
- Состояние — простые ES-классы + `EventTarget`/CustomEvent, без Redux/MobX.
- Роутинг — тонкая обёртка над History API (`ui/router.js`), паттерн как
  в `express`: `router.register('/users/:id', handler)`.
- Данные с сервера — обычный `fetch` + тонкий `ApiClient` с обработкой 401/419
  (истекшая сессия) на уровне ядра, а не в каждом экране.

### 5.1a DOM — явно про рендеринг, не только разметку
Прямая манипуляция DOM (`innerHTML`, `appendChild` руками) на масштабе
таблицы из 500 активов — боль и источник XSS, если не экранировать строки
вручную. Используем **`lit-html`** — это не фреймворк, а отдельная
библиотека тегированных шаблонов (~5 КБ), именно то, что держит дух
"vanilla JS": пишешь `html\`<div>${value}</div>\``, библиотека сама
диффит и обновляет только изменившиеся узлы DOM, **автоматически
экранирует** интерполированные значения (защита от XSS "бесплатно", не
руками в каждом компоненте). Это единственная внешняя зависимость в
`@das-forge/ui`, и она осознанно выбрана как самая маленькая из
существующих, а не написана с нуля — DOM-диффинг с нуля это уже
reinventing a framework в чистом виде (сами предупреждали себя об этом
риске в критическом разборе).

### 5.2 Структура пакета

```
ui/
├── shell/           AppShell: layout, sidebar, header, breadcrumbs
├── router/           History API wrapper + guard'ы (permissions)
├── theme/            design tokens (CSS custom properties), light/dark/system
├── i18n/             загрузчик локалей + merge (platform + app + module)
│   ├── ru/{common,navigation,validation,auth,errors}.json
│   └── en/{...}
├── components/        <ds-dialog>, <ds-drawer>, <ds-toast>, <ds-table>,
│                       <ds-form-field>, <ds-button>, <ds-select>, ...
├── dialogs/           dialog manager (imperative API поверх <ds-dialog>)
├── notifications/     toast + notification center + unread counter
├── command-palette/   Ctrl+K, регистрация команд модулями
├── forms/             биндинг Zod-схемы к форме → авто-валидация в UI
├── auth/              login screen, session expiry handling
└── index.js           публичный API пакета
```

### 5.3 Публичный API (пример)

```js
import { AppShell, dialogs, notify, useTheme, i18n } from '@das-forge/ui';

dialogs.open({
  id: 'create-user',
  title: i18n.t('users.create'),
  component: 'app-create-user-form',   // custom element tag
  size: 'lg'
});

notify.success(i18n.t('assets.saved'));
```

### 5.4 UI Module Contract
Модуль (в т.ч. опциональные пакеты типа `@das-forge/ldap`) регистрирует
свою часть интерфейса так же, как регистрирует backend-routes:

```js
ui.register({
  navigation: [{ id: 'ldap-settings', label: 'settings.ldap', path: '/settings/ldap' }],
  routes: [{ path: '/settings/ldap', component: 'ldap-settings-page' }],
  permissions: ['settings.ldap.manage'],
  translations: { ru: {...}, en: {...} },
  widgets: []
});
```

Ядро UI не знает про LDAP/email/аудит — оно просто собирает то, что
зарегистрировали модули, в общий AppShell.

### 5.5 Темизация
Только через design tokens, жёстко запрещён хардкод цвета в компонентах
приложений:
```css
background: var(--ui-background);
color: var(--ui-foreground);
```
`theme/` поставляет `theme-light.css`, `theme-dark.css`, слушает
`prefers-color-scheme` и хранит выбор пользователя.

### 5.6 Локализация и темы — ОБЯЗАТЕЛЬНАЯ часть платформы, не опция

Это не "фича, если руки дойдут" — платформа физически не даёт приложению
обойтись без этого:

- **`ru` и `en` обязательны** для каждого приложения на DAS-Forge. Core
  валидирует `app.config.js` (`ui.locale.supported`) и **отказывается
  стартовать**, если в списке меньше двух локалей или отсутствует `ru`/`en`.
  Приложение может добавить третий/четвёртый язык, но не может уйти в
  моно-язык.
- Платформенные ключи (`common.*`, `navigation.*`, `validation.*`, `auth.*`,
  `errors.*`) поставляются на обоих языках самой платформой — приложению
  не нужно заново переводить "Сохранить"/"Отмена". Приложение обязано
  добавить свои ключи (`atlas.*`, `assets.*`, ...) минимум на `ru`+`en` —
  это проверяется на этапе `app doctor` (см. §4.4) и падает как ошибка
  конфигурации, а не варнинг.
- Приоритет определения языка пользователя:
  `user.locale (профиль) → application default → browser Accept-Language → en`.
- **Светлая/тёмная/системная тема обязательны** для каждого приложения —
  `theme.js` всегда регистрирует `light`, `dark`, `system`; отключить тёмную
  тему приложение не может, только задать свою палитру через design tokens
  (`theme: { primary: '#...' }` в `defineAppUI`). `system` слушает
  `prefers-color-scheme` и переключается автоматически без reload.
- Оба требования проверяются в `app doctor` как часть категории
  `Application` (пример вывода — §4.4).

### 5.7 Что каждое приложение получает бесплатно
Sidebar, header, user menu, breadcrumbs, theme switcher, language switcher,
notifications, command palette, dialogs/drawers/forms/tables — приложение
пишет только бизнес-экраны поверх контракта, задавая свой `brand`/`navigation`
через `defineAppUI({...})`, как и раньше обсуждалось.

## 6. Опциональные пакеты

Sharp и HEIC — на месте, в `@das-forge/images`, не в core. Причина
осознанная, не забывчивость: не каждому серверу (procure-it, it-assets,
net-monitor — они не обрабатывают изображения) нужно тащить `sharp`
(нативный биндинг с бинарниками под платформу) и `libheif-js`
(Emscripten/WASM). Если положить их в core — все 4 приложения получают
эту зависимость по умолчанию, хотя нужна она только Atlas. Вместо этого:

```
@das-forge/core         ← лёгкий, без sharp/libheif-js
      │
      └── @das-forge/images
              ├── sharp        (JPEG/PNG/WebP/AVIF)
              └── libheif-js   (HEIC/HEIF → сырые пиксели → sharp)
```

Публичный API пакета:
```js
await images.convert(input, { format: 'jpeg' })
await images.thumbnail(input, { width: 1200, height: 1200 })
```
Внутри: `HEIC → libheif-js → raw pixels → sharp → JPEG/WebP/PNG`. Atlas
подключает `modules: { images: true }` в своём `app.config.js` — остальные
три приложения этот пакет не устанавливают вовсе.

| Пакет | Зависимости | Кому нужен |
|---|---|---|
| `@das-forge/email` | nodemailer | procure-it, it-assets, net-monitor, atlas (регистрация/сброс пароля) |
| `@das-forge/images` | sharp, libheif-js | atlas |
| `@das-forge/ldap` | ldapts | it-assets, net-monitor |
| `@das-forge/network` | net-snmp, node-routeros, ssh2 | net-monitor |
| `@das-forge/documents` | docx | procure-it |
| `@das-forge/files` | — | procure-it, atlas |
| `@das-forge/exports` | xlsx-writer и т.п. | it-assets, procure-it |

API этих пакетов не протекает наружу конкретной библиотекой:
`email.send()`, `images.convert()`, а не `nodemailer.createTransport()` в
коде приложения — это позволяет менять реализацию, не трогая бизнес-код.

## 6.5 `@das-forge/integrations` — обмен данными между приложениями

Это ровно тот сценарий: procure-it закупил → it-assets должен получить
предзаполненную карточку (дата покупки, гарантия, тип устройства,
организация) → если это сетевое оборудование, net-monitor подхватывает
его на мониторинг → net-monitor знает актуальный IP/статус и должен
**писать это обратно** в it-assets. Три независимые БД (у каждого
приложения своя, это фича, не баг — единая БД на 4 приложения была бы
куда более хрупким решением), значит нужен явный слой интеграции, а не
"просто дёрнем таблицу соседнего приложения".

### Модель: webhooks наружу + Integration API внутрь, не общая шина

Учитывая масштаб (4 внутренних приложения, не сотни сервисов), полноценная
message-queue (Kafka/RabbitMQ) — избыточна и добавляет ещё один
инфраструктурный компонент, который надо администрировать. Вместо этого:

```
Producer (procure-it)                    Consumer (it-assets)
      │                                         │
      │  событие: purchase.completed            │
      ▼                                         │
core/integrations/webhooks.emit()               │
      │                                         │
      │  HTTP POST + HMAC-подпись               │
      └───────────────────────────────────────► /api/integrations/v1/webhooks/procure-it
                                                 │
                                          core/integrations/webhooks.receive()
                                                 │
                                          it-assets: создаёт ЧЕРНОВИК актива
```

- **Исходящая часть (webhooks)** — `core/integrations/webhooks.emit(event,
  payload)`. HMAC-подпись тела (общий секрет между парой приложений,
  управляется как ещё один тип секрета из §4.5g/п.5), retry с backoff при
  недоступности получателя, delivery log (кто, когда, статус, сколько
  попыток) — видно в Administration.
- **Входящая часть (Integration API)** — `/api/integrations/v1/*`,
  аутентификация **не** пользовательской сессией, а scoped API-ключом
  (`app integrations issue-key --for net-monitor --scopes assets.network.write`)
  — то есть net-monitor физически не может через этот ключ поменять,
  например, цену закупки актива, только те поля, на которые у ключа есть
  scope. Это тот же принцип наименьших привилегий, что и в RBAC (§3).
- Оба конца — **опциональный** пакет `@das-forge/integrations`, а не часть
  core: инсталляция с одним procure-it (без it-assets) не должна тащить
  этот слой вообще.

### Конкретные потоки для твоего кейса

**1. procure-it → it-assets: предзаполнение при закупке**
```
событие: purchase.completed
payload: { poNumber, itemType, purchaseDate, warrantyMonths, organization, vendor }
```
it-assets создаёт **черновик** актива (не сразу "боевую" запись) — кто-то
физически принимает оборудование и подтверждает совпадение с закупкой
(серийный номер и т.п. закупка ещё не знает). Это осознанное решение:
автоматически создавать подтверждённые записи по данным закупки — риск
получить в системе то, что по факту не приехало/приехало другое. Черновик
→ человек проверяет → confirm.

**2. it-assets → net-monitor: постановка на мониторинг**
```
событие: asset.created  (только если assetType relies on network, напр. категория "network equipment")
payload: { assetId, assetType, organization, sourceRef: { app: 'it-assets', id } }
```
net-monitor получает черновик устройства для мониторинга — MAC/начальный
IP, если известен на этом этапе, ещё не обязателен, discovery донаберёт.

**3. net-monitor → it-assets: обратная синхронизация "живых" данных**
```
PATCH /api/integrations/v1/assets/{id}/network-status
{ currentIp, lastSeenAt, status: 'online'|'offline'|'unreachable' }
```
Это периодический вызов (не событие "по факту изменения" — IP-мониторинг
опрашивает по расписанию через `core/scheduler`, §4.5g/п.4), с API-ключом,
у которого **только** scope на `network-status`, ничего больше в карточке
актива net-monitor трогать не может.

### `sourceRef` — простая cross-app трассируемость, без распределённых ID
Не строим единый генератор ID на 4 приложения (лишняя сложность и точка
отказа) — вместо этого каждая запись, пришедшая через интеграцию, хранит
происхождение:
```json
{ "sourceRef": { "app": "procure-it", "id": "PO-1234" } }
```
Этого достаточно, чтобы из it-assets кликнуть "открыть закупку" (ссылка
собирается из `sourceRef`), и чтобы при повторной обработке того же
webhook (retry) распознать дубликат — идемпотентность по `(app, id,
eventType)`, а не по времени получения.

### Admin-панель и CLI
```
app integrations keys {issue,list,revoke}
app integrations webhooks {list,retry,delivery-log}
```
**`Administration → Integrations`**: список настроенных пар приложений,
активные API-ключи (со scope, без самого значения ключа — тот же принцип,
что и Secrets в §4.5g/п.5), лог доставки webhook'ов с возможностью
"Retry" вручную на конкретном проваленном событии.

### Где в роадмапе
Раньше **Phase 6** (когда портированы минимум 2 приложения) смысла не
имеет — интеграцию не с чем тестировать до этого момента. Ставлю это
отдельной фазой сразу после того, как it-assets и procure-it оба на core
(после текущей Phase 6), до полного портирования net-monitor — так первую
связку (procure-it→it-assets) можно обкатать раньше, чем добавлять третью
сторону.

## 6.6 Паттерны, найденные в реальном коде, но ещё не в архитектуре

Прошёлся по всем 4 билдам грепом — вот что уже реализовано (в 2+ проектах
независимо друг от друга, то есть реальная повторяющаяся потребность, а
не гипотеза), но не попало в документ раньше.

### 1. Maintenance windows → обобщаем до `core/maintenance`
В net-monitor уже есть полноценный механизм: окна обслуживания, во время
которых мониторинг продолжает работать, но **алерты подавляются**
(`isInMaintenance()` проверяется прямо в scheduler перед отправкой алерта).
Паттерн шире одного net-monitor: та же идея нужна и остальным приложениям —
"идут плановые работы/restore из backup — не спамить email-алертами и не
писать лишний шум в audit как аномалию". Переносим в core:
```js
maintenance.declare({ name, startTs, endTs, scope: 'all'|['deviceIds'] })
maintenance.isActive(scope)
```
`@das-forge/email.sendAlert()` (§4.5e) и `core/audit` (аномальные события)
автоматически проверяют `maintenance.isActive()` перед тем, как шуметь.
CLI: `app maintenance {declare,list,cancel}`. Admin UI: баннер "Идут плановые
работы" в шапке (§5), пока активно окно — не отдельный экран, а часть
AppShell, потому что это должно быть видно на любой странице.

### 2. Единый источник версии + страница «О системе» → `core/version` + `ui/about`
В it-assets и net-monitor независимо изобретён **один и тот же** паттерн:
`VERSION` — единственный source of truth (plain text, не `package.json`,
чтобы не тащить валидный JSON ради одной строки), скрипт `sync-version.js`
раскидывает её по `package.json`/README-бейджу/`docker-compose.yml`/
Service Worker cache name. В procure-it — свой `changelog.js`, парсящий
`CHANGELOG.md` (формат Keep a Changelog) для страницы "О системе", с явным
комментарием в коде: "здесь нет дублирующего списка изменений вручную —
именно дублирование уже приводило к рассинхрону". Это ровно тот случай,
для которого и нужна платформа. Переносим в core:
```
core/version
  ├── VERSION file convention (не package.json.version)
  ├── version.sync()     — CLI: app version sync — раскидывает по местам,
  │                         которые задаёт app.config.js (README, compose, sw.js, ...)
  └── changelog.parse(CHANGELOG.md, { limit })   — Keep a Changelog формат
```
`@das-forge/ui` получает готовую страницу **About** (`ui/about`): версия,
список последних N релизов из `changelog.parse()`, ссылка на полный
CHANGELOG.md — доступна без прав (после логина, но не требует ролей выше
guest), и её же можно вывести без логина, если приложение решит (это
осознанное решение приложения через `ui.register`, не решение платформы).

### 3. Глобальный поиск и печатные виды → в `@das-forge/ui` Module Contract
it-assets реализовал cross-tab глобальный поиск (`global-search.js`,
debounce 280ms) с нуля, procure-it и it-assets — отдельные "печатные" виды
(`qr-print.js`, печать карточки заявки через `window.print()`). Оба паттерна
общеплатформенные, добавляем в `@das-forge/ui` (§5.4 UI Module Contract):
```js
ui.register({
  ...,
  search: {
    provider: async (query) => [...],   // модуль возвращает свои результаты
    label: 'assets.search'
  }
})
```
Общий search-box в AppShell агрегирует результаты всех зарегистрированных
провайдеров с одним debounce на уровне платформы (не по одному в каждом
модуле, как сейчас). Печать — `ui/print` даёт единый print-friendly
stylesheet + компонент `<ds-print-view>`, чтобы не писать `window.print()`
и вёрстку "для печати" в каждом приложении заново (QR-карточка актива,
печатная форма заявки — один и тот же механизм). Внутри `search.provider`
модуль обычно использует `db.createFtsIndex()` (полнотекстовый поиск,
выше) для нечёткого поиска по тексту, и/или `db.queryByExample()`
(точный поиск по заполненным полям формы фильтра) — оба уже готовые
примитивы `core/database`, провайдеру не нужно писать SQL-запрос с нуля.

### 4. `@das-forge/exports` — уточнение по опыту procure-it
Уже заявлен в §6 как опциональный пакет, но procure-it показал конкретный
паттерн, который стоит закрепить как часть контракта, а не оставить на
усмотрение каждого приложения: **имя файла экспорта включает применённые
фильтры и дату** (`Реестр_заявок [org, month, статус]_2026-09-30.xlsx`).
API пакета получает это как встроенную возможность:
```js
exports.toExcel(rows, { filenameContext: { org, month, status }, columns })
```
— а не оставляем каждому приложению собирать имя файла руками через
конкатенацию строк.

### 5. Пробел, а не паттерн: нет ни одной брендированной страницы ошибки
Ни в одном из 4 приложений нет отдельной human-readable страницы для
404/500 при прямой навигации в браузере (`core/errors`, §3, пока
подразумевает только JSON error-mapping для API). Если пользователь
руками вобьёт неправильный URL в адресную строку — сейчас, вероятно,
голый Express-дефолт или пустой JSON. Добавляем в `core/http`: для
запросов с `Accept: text/html` — рендерить `ui`-страницу ошибки
(единую, брендированную через тот же `defineAppUI({ brand })`, что и
остальной интерфейс), для остальных — как и раньше, JSON.

## 6.5a Внешние интеграции (Bitrix24, 1С) — опциональные адаптеры, не ядро

Это другое по природе, чем §6.5 (там — связь между *нашими* 4
приложениями). Здесь — связь с **внешними системами**, которые живут по
своим API и своим правилам, значит отдельные опциональные адаптеры поверх
той же `@das-forge/integrations`-инфраструктуры (scoped API keys,
delivery log — переиспользуются), а не новая подсистема:

```
@das-forge/integrations
      ├── core (webhooks, scoped keys, delivery log — §6.5)
      └── adapters/
          ├── bitrix24.js    REST API Битрикс24: задачи/хелпдеск, алерты в чат/канал
          └── 1c.js          обмен номенклатурой/артикулами с 1С:Бухгалтерия
```

**Bitrix24 — решено: входящий вебхук.** Нужен для procure-it/it-assets как
источник задач/хелпдеска (заявка в DAS-Forge-приложении ⇄ задача в
Bitrix) и как **канал алертов** (`email.sendAlert()`, §4.5e, получает ещё
один транспорт — сообщение в Bitrix-чат/канал, не только email).
Реализация — через **входящий вебхук Bitrix24** (`https://<портал>.bitrix24.ru/
rest/<user_id>/<webhook_code>/<метод>`), не OAuth-приложение — это проще
(один URL в конфиге, не нужен флоу авторизации/refresh-токенов) и
достаточно для серверного адаптера, который сам инициирует вызовы к
Bitrix, а не является Bitrix-приложением с UI внутри портала.
```js
// app.config.js
modules: {
  integrations: {
    bitrix24: { webhookUrl: 'https://portal.bitrix24.ru/rest/1/xxxxx/' }
  }
}
```
`app doctor` (Integrations) проверяет доступность вебхука так же, как SMTP/LDAP.

**1С:Бухгалтерия — ⚠️ BLOCKED, способ обмена пока не настроен в компании.**
Названия/артикулы товаров не бьются между 1С и it-assets/procure-it —
классическая проблема сопоставления справочников. Но протокол обмена
(HTTP-сервисы 1С / OData / выгрузка файлами — зависит от версии и
конфигурации 1С в конкретной компании) **сейчас не определён вообще**, не
просто "не выбран из вариантов". Это явный блокер для детального
проектирования `adapters/1c.js` — пока не настроен хоть какой-то способ
выгрузки/обмена на стороне 1С, здесь можно зафиксировать только общую
схему, не конкретный код:
```
core/scheduler → adapters/1c.js → fuzzy-match (артикул/название)
                                        → очередь на подтверждение человеком в UI
                                        → confirm → запись в it-assets/procure-it
```
**Сопоставление всегда с подтверждением человеком**, никогда не
автоматическое слепое — цена ошибки (спутать два разных товара) слишком
высокая. Как только появится рабочий способ обмена с 1С (сначала нужно
решить это на уровне компании/1С-программиста, не DAS-Forge) — протокол
подставляется в уже готовую схему выше, сам паттерн (периодический
импорт → fuzzy-match → подтверждение) не изменится независимо от
конкретного транспорта.

Оба адаптера — **опциональны**, не тянутся в core и не нужны net-monitor/
atlas, если там нет такой интеграции. Детальный контракт каждого адаптера
проектируется отдельно, когда понятен конкретный API/протокол на стороне
Bitrix24/1С в этой компании — сейчас фиксируем только место в архитектуре
и общий паттерн (REST/webhook адаптер поверх `@das-forge/integrations`,
сопоставление с подтверждением человеком для 1С).

## 7. Порядок портирования приложений

1. **it-assets** — ближе всех к целевому стеку (Express 5, Zod, частично argon2) → минимальный дифф, хороший первый кандидат на обкатку core.
2. **procure-it** — Express 4→5, PBKDF2→argon2 (миграция хэшей), добавить Zod-валидацию.
3. **net-monitor** — Express 4→5, добавить CSRF, session → auth-абстракция, LDAP/network модули уже готовая база для `@das-forge/ldap`/`@das-forge/network`.
4. **atlas** — самый насыщенный (sessions, uploads, backup scheduler, optimistic locking) → портировать последним, когда core уже обкатан на трёх других.

## 7.5 Контракты v1 (Phase 1, зафиксировано)

Важное разделение инструментов, прежде чем смотреть код: **Zod валидирует
данные** (конфиг, вход, сущности). **Поведенческие интерфейсы**
(`DatabaseAdapter`, `AuthProvider`, `SessionStore` — наборы методов) — не
данные, значит не Zod-схема, а лёгкий duck-typing assert + JSDoc. Смешивать
эти два инструмента — ложное чувство защищённости (`z.function()` в Zod
проверяет только "это функция", не сигнатуру и не поведение).

Ещё одно следствие того, что `@das-forge/ui` — vanilla JS в браузере:
**Zod изоморфен**, одна и та же схема валидирует форму и на клиенте (перед
отправкой), и на сервере (в Express-роуте) — без дублирования правил.

### `ApplicationConfigSchema` (данные → Zod)
```js
import { z } from 'zod';

const BackupDestinationSchema = z.object({
  type: z.enum(['local', 'network-share', 'directory']),
  path: z.string().min(1),
  primary: z.boolean().optional()
});

const LocaleSchema = z.array(z.string())
  .min(2)
  .refine(list => list.includes('ru') && list.includes('en'), {
    message: 'ru и en обязательны как платформенные локали (§5.6)'
  });

export const ApplicationConfigSchema = z.object({
  name: z.string().min(1),

  server: z.object({
    entry: z.string(),
    port: z.number().int().positive(),
    trustProxy: z.boolean().default(false),
    admin: z.object({
      port: z.number().int().positive().optional(),
      bindHost: z.string().default('127.0.0.1')   // §4.5i, Уровень 1 — не 0.0.0.0 по умолчанию
    }).default({})
  }),

  database: z.object({
    migrations: z.string(),
    seeds: z.string().optional()
  }),

  backup: z.object({
    destinations: z.array(BackupDestinationSchema).min(1),   // §4.5b
    schedule: z.string()   // cron-выражение
  }),

  ui: z.object({
    brand: z.object({
      name: z.string(),
      logo: z.string().optional(),
      favicon: z.string().optional()
    }),
    locale: z.object({
      default: z.enum(['ru', 'en']),
      supported: LocaleSchema
    }),
    theme: z.object({
      default: z.enum(['light', 'dark', 'system']).default('system'),
      allowSwitch: z.boolean().default(true)
    }).default({})
  }),

  modules: z.record(z.string(), z.union([z.boolean(), z.object({}).passthrough()])).default({}),

  security: z.object({
    csrf: z.boolean().default(true),          // §6.6/подтверждено — обязателен по умолчанию
    adminMtls: z.boolean().default(false)     // §4.5i Уровень 3 — задел, выключено
  }).default({}),

  auth: z.object({
    passwordPolicy: z.object({
      minLength: z.number().int().min(8).default(12),
      breachCheck: z.boolean().default(false)   // §4.5h п.6 — офлайн по умолчанию
    }).default({}),
    require2fa: z.array(z.string()).default([])  // роли, требующие 2FA; [] = выключено (§4.5h п.8, открытый вопрос)
  }).default({}),

  performance: z.object({
    budgets: z.record(z.string(), z.object({ p95: z.number().positive() })).default({})
  }).default({})
});
```

### `ModuleRegistrationSchema` (данные, которые модуль передаёт при регистрации → Zod)
```js
const NavigationItemSchema = z.object({
  id: z.string(),
  label: z.string(),          // i18n-ключ, не строка
  path: z.string(),
  icon: z.string().optional(),
  permission: z.string().optional()
});

export const ModuleRegistrationSchema = z.object({
  id: z.string(),
  navigation: z.array(NavigationItemSchema).default([]),
  routes: z.array(z.object({ path: z.string(), component: z.string() })).default([]),
  permissions: z.array(z.string()).default([]),
  fieldPermissions: z.record(z.string(), z.string()).default({}),   // §4.5j: "asset.purchasePrice" → "assets.viewFinancials"
  translations: z.record(z.enum(['ru', 'en']), z.record(z.string(), z.string())).optional(),
  cliCommands: z.array(z.object({ name: z.string(), handler: z.function() })).default([]),
  search: z.object({ provider: z.function(), label: z.string() }).optional(),
  dataSubject: z.object({
    export: z.function(),
    erase: z.function(),
    retentionDays: z.number().int().positive().optional(),   // §4.5k — NULL = бессрочно
    legalBasis: z.string().optional(),                        // ст. 30 GDPR — заполняется по итогам юр. согласования
    purpose: z.string().optional()
  }).optional()   // §4.5k core/privacy
});
```
`z.function()` здесь — осознанно слабая проверка ("это функция"), не
подмена тестов. Сама логика модуля тестируется юнит-тестами, не схемой.

### `UserSchema` / `SessionSchema` (данные → Zod)
```js
export const UserSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  role: z.enum(['guest', 'operator', 'admin']).or(z.string()),  // приложение может добавить свои роли поверх
  locale: z.enum(['ru', 'en']).default('ru'),
  mustChangePassword: z.boolean().default(false),
  createdAt: z.date()
});

export const SessionSchema = z.object({
  token: z.string(),
  userId: z.string(),
  createdAt: z.date(),
  expiresAt: z.date()
});
```

### Единый формат ошибки валидации (для `core/validation`, §3)
```js
// на выходе validate(schema, data) при ошибке — всегда эта форма,
// одинаковая что для API-ответа, что для клиентской формы в @das-forge/ui
{
  error: 'VALIDATION_ERROR',
  fields: [
    { path: 'email', message: 'Invalid email', code: 'invalid_string' }
  ]
}
```

### `DatabaseAdapter` / `AuthProvider` / `SessionStore` (поведение → НЕ Zod, duck-typing assert)
```js
// core/database/contract.js
export function assertDatabaseAdapter(adapter) {
  for (const m of ['connect', 'migrate', 'transaction', 'close']) {
    if (typeof adapter[m] !== 'function') {
      throw new Error(`DatabaseAdapter: отсутствует метод ${m}()`);
    }
  }
}

// core/auth/contract.js
export function assertAuthProvider(provider) {
  for (const m of ['createSession', 'destroySession', 'hashPassword', 'verifyPassword']) {
    if (typeof provider[m] !== 'function') {
      throw new Error(`AuthProvider: отсутствует метод ${m}()`);
    }
  }
}

export function assertSessionStore(store) {
  for (const m of ['get', 'set', 'destroy', 'touch']) {
    if (typeof store[m] !== 'function') {
      throw new Error(`SessionStore: отсутствует метод ${m}()`);
    }
  }
}
```
Эти assert-функции вызываются один раз при старте приложения (в `createApp()`,
§3) — если кто-то подключит кастомный `DatabaseAdapter`/`AuthProvider`
(например, для теста с in-memory реализацией), ошибка контракта всплывёт
сразу при старте, а не где-то в середине рантайма непонятным TypeError.

**Это и есть выход из Phase 1** — с этими схемами и assert-функциями можно
идти в Phase 2 писать `core/config`, `core/database`, `core/auth` без
домысливания на ходу.

## 8. Роадмап (фазы)

### Phase 0 — подготовка (пользователь, параллельно)
- Апгрейд всех 4 приложений на единые зависимости/версии (Express 5, Node 26, Zod, pino, Vitest+Supertest+Playwright)
- Замена легаси auth-схем на промежуточный слой, совместимый с будущей `core/auth` — конкретно по проектам:

  **procure-it (PBKDF2, ручной):**
  1. Не трогать существующую схему хэша как есть — она станет одной из
     веток multi-scheme `verifyPassword()` (§3) при портировании.
  2. Сейчас, до портирования: убедиться, что соль **уникальна на
     пользователя** (если сейчас общая/захардкоженная — это зафиксировать
     отдельно как баг безопасности, не ждать Phase 4).
  3. Задокументировать точный формат текущего хэша (алгоритм, итерации,
     длина соли) — это нужно для написания ветки распознавания формата в
     multi-scheme verify (§3).

  **atlas (scrypt, ручной) и net-monitor (scrypt, ручной):**
  1. Та же логика — задокументировать параметры (N/r/p, длина соли) для
     каждого из двух проектов отдельно (вероятно, параметры отличаются,
     раз реализации независимые).
  2. Сессии — у atlas/net-monitor уже `express-session`; при портировании
     заменяются на `core/auth/sessions.js` (своя таблица, §3) — users не
     разлогиниваются принудительно (session token не меняет формат,
     меняется только backend хранения, если грамотно спроектировать
     миграцию таблицы sessions).

  **it-assets (argon2/bcrypt, в процессе миграции):**
  1. Это ближе всего к целевой схеме — просто доносим существующую
     bcrypt→argon2 миграцию до конца **до** переноса на `core/auth`, чтобы
     не тащить тройную multi-scheme ветку (PBKDF2/scrypt/bcrypt/argon2)
     в core ради одного приложения, которое и так почти мигрировало.

  **Общее для всех 4**: ничего не хэшируется заново массово ("заставить
  всех сменить пароль") — миграция происходит lazy, при следующем
  успешном логине каждого пользователя (§3), поэтому Phase 0 — это
  **документирование** текущих форматов, не их замена прямо сейчас.

### Phase 1 — заморозка контрактов ✅ зафиксировано в §7.5
- `ApplicationConfigSchema`, `ModuleRegistrationSchema`, `UserSchema`/`SessionSchema` — конкретные Zod-схемы (§7.5)
- `DatabaseAdapter`/`AuthProvider`/`SessionStore` — duck-typing assert-функции, не Zod (§7.5)
- Единый формат ошибки валидации для `core/validation`
- 2FA/TOTP решено (§4.5h п.8) — включаем опционально per-role, реализация в Phase 2, схема уже несёт `require2fa: []` (выключено по умолчанию)
- Решение по UI-стеку — vanilla JS (раздел 5), уже принято

### Phase 2 — `@das-forge/core` v1 (минимальный рабочий)
- config, http, errors, logging, validation, security (+ CSRF), auth (сессии + argon2 + legacy-verify), database (node:sqlite adapter + migrations), audit, health
- `core/platform` (Linux/Windows абстракция) с первого коммита — не добавлять кроссплатформенность потом
- HTTPS-only + self-signed сертификаты для локального/LAN-режима (§4.5f) — с первого коммита, `http.createServer` для внешнего трафика в core физически отсутствует
- `core/scheduler` (единый cron-реестр), graceful shutdown в `core/http`, security bans store, secrets registry — операционные инструменты §4.5g закладываются вместе с остальным core, не патчем после портирования (`/metrics` — отложено, см. §4.5g п.6)
- Request ID, cookie flags + session regenerate on login, body size/timeout лимиты, safe file upload layer, CSP-политика для UI, doctor-проверка clock skew (§4.5h, п.1–7) — обязательный security-минимум с первого коммита
- `core/http/serialize()` (field-level permission filtering на выходе) + серверный пересчёт вычисляемых значений вместо доверия клиенту (§4.5j) — с первого коммита, не патчем после первого XSS/leak-инцидента
- `core/auth/totp.js` (2FA per-role, §4.5h п.8), `core/privacy` (export/erase данных субъекта, §4.5k) — реализуются в Phase 2, не откладываются
- `core/files`: помимо magic-bytes — лимит на коэффициент сжатия/entries для ZIP-based форматов (docx/xlsx/pptx), обязательный decode→re-encode для изображений через sharp, PDF как opaque blob без интерпретации JS (§4.5h п.4a)
- First-run bootstrap администратора (auto-generate admin + temp password при нуле пользователей) в `core/auth`
- Отдельный bind-адрес для `/administration/*` в `core/http` (§4.5i, Уровень 1) — включён по умолчанию
- `core/maintenance` (§6.6.1), `core/version` + `changelog.parse()` (§6.6.2), брендированные HTML error-страницы для 404/500 (§6.6.5)
- Backup с моделью нескольких destinations (§4.5b) сразу, не как локальный путь "на потом"
- Юнит-тесты на Vitest+Supertest **и perf-сценарии на autocannon** (§4.5c) с первого коммита
- CI-матрица `ubuntu-latest` + `windows-latest` с первого коммита

### Phase 3 — `@das-forge/cli` v1
- start/dev/stop, db {status,migrate,rollback,seed,integrity}, health, doctor, backup {create,list,verify,restore,destinations}
- `app.config.js` loader + валидация (в т.ч. обязательность `ru`+`en` — §5.6)
- `app deps {licenses,outdated,audit,check}` (§4.5d) — сразу, не как доработка после портирования
- `app test:perf` (§4.5c)
- `app cert {info,generate,renew,trust}` (§4.5f)
- `app logs {tail,export,config}`, `app user {create-admin,reset-password,unlock}`, `app security bans {list,unban,clear-all}`, `app cron {list,history,run}`, `app secrets {rotate,list}`, `app audit {tail,export}` (§4.5g)
- `app privacy {export,erase,registry,review-queue}`, `app security incident declare` (§4.5k)
- `app version sync`, `app maintenance {declare,list,cancel}` (§6.6.1–2)
- `--docker`-режим установки/доктора (§4.5a)

### Phase 4 — первое портирование (it-assets)
- Подключить `@das-forge/core` + `@das-forge/cli`, вынести auth/db/audit/backup на core
- Зафиксировать реальные баги контракта по факту использования

### Phase 5 — backup/health/realtime доводка + email/ldap модули
- `@das-forge/email` с полным набором сценариев (§4.5e: alert, password reset/changed, email verification, ban/unban, invite, system notice) — на основе того, что уже нужно it-assets
- `@das-forge/ldap` — на основе того, что уже нужно it-assets/net-monitor

### Phase 6 — второе и третье портирование (procure-it, net-monitor)
- Параллельно добавляются `@das-forge/documents`, `@das-forge/network`

### Phase 6.5 — `@das-forge/integrations` (§6.5)
- Стартует, как только procure-it и it-assets оба на core (не дожидаясь net-monitor)
- Поток 1: procure-it → it-assets (`purchase.completed` → черновик актива)
- Поток 2 и 3 (it-assets ↔ net-monitor) добавляются по готовности net-monitor из этой же Phase 6
- `Administration → Integrations` экран + `app integrations {keys,webhooks}` CLI

### Phase 7 — UI-платформа
- `@das-forge/ui` (стек — по итогам раздела 5), AppShell, i18n (ru/en), themes, dialogs, notifications, command palette
- Раздел `Administration` (Health & Doctor, Logs, Security/Blocked, Scheduled Tasks, Secrets, Audit Log, System) — §4.5g, как тонкая UI-обёртка над уже реализованными в Phase 2 core-API; `doctor.run()` и точечный fix по одной проверке переиспользуются из CLI один в один
- Страница `About` (§6.6.2), maintenance-баннер в AppShell (§6.6.1), единый search-provider контракт + print-view компонент (§6.6.3)
- Cookie-уведомление `ui/cookie-notice` (§4.5k), экран `Administration → Privacy` (export/erase)

### Phase 8 — atlas (последним)
- Самый сложный кейс: session-архитектура, uploads, optimistic locking, backup scheduler
- `@das-forge/images` (sharp + libheif-js)

### Phase 9 — service/CLI полировка
- `app service install/start/stop` через systemd/Windows Service для всех 4 приложений
- Docker-образы и compose-файлы для всех 4 приложений на базе эталонного `templates/node-express-app` (§4.5a)
- Финальная зачистка `.bat`/`.sh` до тонких launcher'ов

## 9. Зафиксированные решения по открытым вопросам
1. **UI-стек: vanilla JS** — Web Components + нативные ES-модули, без фреймворка и без обязательного бандлера в dev. Детали — раздел 5.
2. **Node `>=26` фиксируем уже сейчас** в `engines` каждого пакета — ядро пишется достаточно долго, что к релизу Node 26 успеет войти в LTS.
3. **WebSocket не добавляем на старте** — только SSE-транспорт в `core/realtime`; WebSocket остаётся местом расширения (`transports/websocket.js`), когда появится реальный двунаправленный кейс (chat/collaborative editing), которого сейчас ни у одного из 4 приложений нет.

## 10. Changelog Phase 2 (код ядра) — обновляется после каждого этапа

Формат: ✅ сделано / 🔜 следующее / ⏳ не начато. Ведётся здесь, чтобы
можно было продолжить работу в любой другой сессии, не теряя контекст.
Подробное описание конвенций — в `docs/index.html` внутри архива кода.
Архив кода на каждом этапе пересобирается целиком: `das-forge-core.zip`.

### core/config
- [x] `ApplicationConfigSchema` + под-схемы (server/database/backup/ui/modules/security/auth/performance)
- [x] `loadConfig()` — файл + дефолты схемы + env-override, в этом порядке приоритета
- [x] `env.js` — явная (не магическая) карта `ENV_VAR -> config.path`
- [x] Единый формат ошибки валидации (`ConfigValidationError`, `{error, fields}`)
- [x] Тесты (Vitest) + фикстуры valid/invalid app.config.js
- [ ] Прогон `npm test` на стороне пользователя (в контейнере разработки нет сети на npm registry)

### core/database
- [x] `createSqliteAdapter()` на `node:sqlite`, WAL mode для файловых БД, `foreign_keys=ON`
- [x] `assertDatabaseAdapter()` — duck-typing контракт (run/get/all/exec/transaction/createFtsIndex/queryByExample/close)
- [x] `createFtsIndex()` — FTS5 external-content + триггеры INSERT/UPDATE/DELETE
- [x] `queryByExample()` — безопасный параметризованный SELECT, защита идентификаторов regex'ом
- [x] Смоук-тест вживую против настоящего `node:sqlite` (CRUD, транзакции/rollback, FTS5, queryByExample) — все сценарии прошли
- [ ] Интеграционная проверка multi-process доступа (CLI-процесс + сервер на одном файле БД, WAL) — нужна перед заморозкой контракта в Phase 1

### core/branding
- [x] Vendor identity (неизменяемый, файловый): `resolveVendorLogo()`, `defineVendorIdentity()`, `CORE_IDENTITY`
- [x] Company branding (DB-backed, admin-editable): `CompanyBrandingSchema`, `getCompanyBranding()`/`setCompanyBranding()`/`getEffectiveBranding()`, таблица `app_settings` (generic key/value)
- [x] Решение: About зовёт vendor identity напрямую, company branding никогда его не подменяет
- [x] Решение: error-страницы 404/500 показывают своё лого + "Powered by DAS-Forge" с лого и ссылкой на ядро (реализация — в core/http, см. ниже)
- [x] Light/dark тема логотипов: конвенция `logo.svg`/`logo-dark.svg` (+ png/jpg фоллбэк), честный фоллбэк на светлый вариант; то же для company branding (`logoUrlDark`)
- [x] Draft-лого ядра получено (хексагон+наковальня), пока PNG — ждём SVG-экспорт и dark-вариант
- [ ] Получить и разложить логотипы 4 приложений (atlas-ao, net-monitor, it-assets, procure-it) по той же конвенции — логотипы пока не присланы

### core/auth 🔜 следующее
- [ ] `AuthProvider` behavioral-интерфейс + `assertAuthProvider()`
- [ ] argon2id хэширование + multi-scheme `verifyPassword()` (PBKDF2/scrypt×2/bcrypt legacy-ветки)
- [ ] Сессии — `auth.createSession()`, своя таблица, session regenerate on login
- [ ] `core/auth/totp.js` (2FA per-role, опционально, выключено по умолчанию)
- [ ] First-run bootstrap администратора (auto-generate admin + temp password)

### core/http ⏳ не начато
- Включает брендированные 404/500 (решение зафиксировано выше), `serialize()`/fieldPermissions, graceful shutdown, request ID, cookie flags, CSP

### Документация и процесс
- [x] `docs/index.html` заведён — подробная документация с навигацией, конвенции описываются отдельно от кода/README
- [x] Этот роадмап теперь обновляется после каждого этапа (этот раздел) — решение зафиксировано пользователем

### core/auth
- [x] `assertAuthProvider()` / `createAuthProvider()`
- [x] argon2id `hashPassword()`/`verifyPassword()` + multi-scheme legacy (`pbkdf2Scheme()`/`scryptScheme()`), lazy rehash (`needsRehash`)
- [x] Сессии: `createSession()`/`verifySession()`/`destroySession()`/`regenerateSession()` (fixation protection)
- [x] TOTP (RFC 6238) на чистом `node:crypto`
- [x] `firstRunBootstrap()` — admin + временный пароль при пустой БД
- [x] Смоук-тест вживую (sessions/users/TOTP/legacy password schemes) — всё прошло
- [ ] argon2-путь не прогнан локально (нативный пакет, нет сети) — прогонится у пользователя через `npm test`
- [ ] Получить документированные легаси-форматы паролей всех 4 приложений (соль/итерации/кодировка) для реальных `pbkdf2Scheme()`/`scryptScheme()` вызовов при портировании

### core/http
- [x] `serialize()` — server-side вырезание полей по fieldPermissions (zero-trust §4.5j)
- [x] `validateBody()`/`validateQuery()` — единый формат ошибки с core/config
- [x] `sessionMiddleware()`/`requireAuth()`/`requirePermission()` — мост к core/auth, права только из сессии
- [x] Брендированные 404/500 (`renderErrorPage()`) — своё лого + "Powered by DAS-Forge", light/dark, XSS-экранирование, самодостаточный HTML
- [x] `requestId()`, `securityHeaders()` (CSP same-origin), `registerGracefulShutdown()`
- [x] Смоук-тест вживую (serialize, error-pages, session middleware, permission-гейты, requestId) на моках req/res
- [ ] Реальный прогон с Express 5 (peerDependency, не установлен локально) — у пользователя через `npm test`/ручной запуск сервера

### core/realtime ⏳ не начато
- SSE-транспорт, `transports/websocket.js` как точка расширения (решение §9: WebSocket не добавляем на старте)

### core/files ⏳ не начато
- Magic-bytes проверка, sharp re-encode изображений

### core/realtime
- [x] `createEventBus()` — pub/sub (publish/subscribe/unsubscribe/subscriberCount), in-process, изоляция ошибок подписчика
- [x] `createSseHandler()` — SSE-эндпоинт для Express (заголовки, heartbeat, initialEvent snapshot, авто-отписка на close)
- [x] `transports/websocket.js` — заглушка-точка расширения, кидает понятную ошибку со ссылкой на §9 (решение: WebSocket не на старте)
- [x] Смоук-тест вживую (pub/sub, multi-subscriber, error isolation, SSE headers/snapshot/forwarding/cleanup) — всё прошло, без внешних зависимостей

### core/files
- [x] `detectFileType()`/`assertAllowedFileType()` — magic-bytes, клиентское расширение/Content-Type не доверяется
- [x] `parseZipEntries()`/`detectOfficeType()` — свой минимальный ZIP central-directory ридер, без внешней зависимости
- [x] `checkZipSafety()`/`assertSafeOfficeFile()` — zip-bomb guard (лимит записей, суммарного размера, коэффициента сжатия)
- [x] `generateSafeFilename()`/`storeUpload()` — имя на диске всегда генерируется сервером, path traversal невозможен по построению
- [x] `sanitizeSvg()` — изначально regex baseline, затем заменён на DOMPurify+jsdom (настоящий DOM-парсинг) по явному решению пользователя — "зачем полумеры"
- [x] `validateUpload()` — сводная точка входа (size → magic-bytes → zip-bomb guard → svg sanitize)
- [x] `reencodeImage()` на sharp — обязательный re-encode изображений
- [x] Смоук-тест вживую всего модуля кроме image-pipeline.js (sharp, нативный пакет, нет сети) — поймал и исправил реальный баг в тестовой ZIP-фикстуре по ходу (отсутствие local file header)
- [ ] image-pipeline.js (sharp) и svg-sanitize.js (jsdom/DOMPurify) — только синтаксис-чек (нативные/сетевые пакеты), прогонится у пользователя через `npm test`

### Документация — отложенная задача
- [x] Завести сводный раздел «Security» в `docs/index.html` — **сделано**, см. §18

### core/scheduler
- [x] `parseCron()`/`getNextRun()` — свой 5-полевой cron-парсер, без зависимости, с корректной OR-семантикой dom/dow
- [x] `createScheduler()` — setTimeout-based, overlap protection (skip, не queue), изоляция ошибок job'ов, `runNow()`
- [x] `createBackupJob()` — WAL checkpoint + copy в local destination + retention; s3/sftp/webdav — валидируются схемой, не реализованы (extension point по модели websocket.js)
- [x] Смоук-тест вживую целиком (cron включая OR-ловушку, overlap, error isolation, реальный backup на node:sqlite с retention)
- [x] По ходу: `node --check` поймал синтаксическую ошибку (`*/` внутри блочного комментария) до прогона

### cli
- [x] `parseArgs()` — минимальный разбор argv, без внешней зависимости
- [x] `createCli()` — longest-prefix matching команд, `run()` не вызывает `process.exit()` сам, error isolation, запрет дублей команд
- [x] `runMigrations()`/`migrationStatus()` — нумерованный мигратор, синхронный `up(db)` (задокументировано почему), идемпотентность, rollback при ошибке
- [x] Команды: `config check`, `user create-admin --force`, `migrate`/`migrate status`, `backup run`
- [x] **Попутный баг-фикс в core/auth**: `updatePasswordHash()`'s `clearMustChange` была инвертирована (true выставляла флаг в 1 вместо 0) — найдено при проектировании `user create-admin --force`, исправлено и проверено вживую
- [x] Смоук-тест вживую целиком на реальном `node:sqlite`

## Основные модули ядра реализованы
config, database, branding, auth, http, realtime, files, scheduler, cli — всё готово и прогнано (где возможно без сети) вживую.

### examples/workshop
- [x] `src/context.js` — единая точка bootstrap (config→database→branding→auth→backup job), переиспользуется сервером и CLI
- [x] `src/server.js` — полная Express-обвязка (requestId/securityHeaders/sessionMiddleware/роуты/branded error pages/graceful shutdown) + планировщик
- [x] `src/routes.js` — login+lazy rehash, serialize()+fieldPermissions, requirePermission(), SSE, validateUpload()
- [x] `migrations/001_init.js`, `bin/app.js` (CLI поверх того же контекста)
- [x] Прогнано вживую без сети: app.config.js парсится, миграция реально применена через настоящий мигратор на node:sqlite; все импорты из @das-forge/core сверены построчно с реальным кодом
- [ ] Полный `npm install && npm start`/`npm run cli` — у пользователя (нужна сеть: express/cookie-parser/zod/argon2)
- [x] Раздел "Пример приложения" в docs/index.html с реальными фрагментами кода из этого примера

### Открыто / отложено
- [x] Сводный раздел «Security» в `docs/index.html` — сделано, см. §18
- [ ] Интеграционный тест multi-process доступа к БД (core/database, WAL)
- [ ] Логотипы 4 приложений (atlas-ao/net-monitor/it-assets/procure-it) — ещё не присланы
- [ ] Документированные легаси-форматы паролей 4 приложений для реальных вызовов `pbkdf2Scheme()`/`scryptScheme()`
- [ ] Реальный прогон `npm install`, `npm test` (отдельными командами — `&&` не работает как разделитель в стандартной Windows PowerShell 5.1) — у пользователя (в контейнере разработки нет сети для нативных/внешних пакетов: argon2, sharp, dompurify/jsdom, express/cookie-parser)

## 11. Этапы Stage A–F (принято по предложению коллеги, обсуждено и утверждено)

Коллега прислал баг-репорт (ENOENT на `npm install` в корне — не было
корневого `package.json`; `&&` не работает в Windows PowerShell 5.1) и
предложение: нельзя считать ядро готовым к портированию IT Assets, пока
нет работающего эталонного приложения (**workshop**, было
`examples/app-example` — переименовано), которое реально собирает все
механизмы ядра вместе и проходит через негативные сценарии (не только
"админ может", но и "обычный юзер не может через голый HTTP-запрос,
даже если кнопка скрыта в UI").

Синтез двух вариантов структуры из его документа + решения, принятые в
обсуждении:

```
das-forge/
├── packages/        — core + будущие специализированные пакеты (ui, cli, email, ldap, images, files)
├── examples/
│   └── workshop/    — эталонное приложение (бывш. app-example)
├── templates/       — заготовка под будущий `das-forge create` — НЕ сейчас, backlog
├── apps/            — реальные приложения на ядре; it-assets переедет сюда на Stage F
├── docs/            — по темам: getting-started, core, recipes, testing, migration, decisions
└── package.json     — корневой, npm workspaces (packages/*, examples/*)
```

**Границы core vs приложение** (обсуждено отдельно): core — только
механизм (как хранить сессию, как проверить файл по магическим байтам),
приложение — смысл (что такое "актив", что значит permission
`asset:dispose`). Core не знает про предметную область ни одного из
4 приложений.

**core/audit — отдельный модуль** (не часть core/auth): audit — это
инфраструктура логирования событий, нужная одновременно auth (попытки
входа), http (request context) и database (хранение) — то есть
используется несколькими модулями, а не вложена в один из них. Та же
логика, что развела branding и http. "Security" остаётся сквозной темой
документации (сводный раздел — см. "Открыто / отложено"), а не модулем:
она не существует как отдельный пакет, через неё проходят auth+http+
files+audit.

### Статусы этапов
- **Stage A (запускаемый скелет)** — ✅ по факту уже есть: `examples/workshop` подключает config→database→branding→auth→http→realtime→files→scheduler→cli, есть bootstrap, роуты, миграция, CLI-команды
- **core/audit, core/health, CLI-обвязка (+ man-style help), core/modules, core/privacy, core/certs, core/ui, core/auth MFA-модель, реальный логотип, core/qr, Workshop Stage A–E (API+UI+QR+Demo Records+Audit+System & Maintenance+Realtime Lab)** — ✅ все реализованы (0.1.1–0.1.23), детали в §11a–§17.1 ниже; **структура репозитория и переводы/i18n как ведущиеся справочники** (0.1.15/0.1.16, §0.1, README.md) — тот же режим, что у CLI-таблицы. Первый и второй настоящие `npm test` по `routes.test.js` прогнаны пользователем (0.1.21 §11q, 0.1.22 §11r) — оба раза найден и исправлен баг тестового харнесса (не `routes.js`): сперва отсутствие `sessionMiddleware`, затем гонка между `dispatch()`'s промис-цепочкой и реальной async-работой за ней. С 27/37 провалов до 2/37, затем до чистого прохода. Решение по
Drizzle/мульти-БД абстракции (§17) пересмотрено и закрыто (0.1.23,
§17.1): контракт `DatabaseAdapter` уже достаточен, Postgres-адаптер
откладывается до реальной потребности — Stage F стартует на чистом
`node:sqlite`
- **Stage B–E (полный Workshop: Users & Access, Demo Records, Audit, System & Maintenance, Realtime Lab + негативные сценарии как критерий приёмки)** — ⏳ не начато; core/audit готов, Stage D можно начинать
- **Stage F (портирование IT Assets в `apps/`)** — ⏳ не начато, ждёт закрытия Stage B–E

### 11a. CLI-обвязка — расширена до покрытия §4.1 (0.1.3)

Реализовано там, где реально существует core-функциональность за
командой, вместо фасада без начинки:
- `core/scheduler/backup-ops.js`: `listBackups()`, `verifyBackupFile()`
  (readonly, не трогает живую БД), `restoreBackup()` — оркестрированный
  пайплайн §4.3 (verify → safety copy → restore → integrity → migration
  check → audit entry → health check), стоп на первой неудаче,
  файловая копия текущей БД перед перезаписью
  (`<file>.pre-restore-<ts>`)
- `cli backup {list,verify,restore}` (+ уже существовавший `run`);
  `restore` без `--yes` — явный отказ, не тихое выполнение
- `cli db {status,integrity}` — намеренно ОТДЕЛЬНО от `migrate`/
  `migrate status` (переименование сломало бы уже подключённую
  интеграцию в `examples/workshop`); `integrity --repair` делает только
  `VACUUM` и говорит об этом прямо — `node:sqlite` не умеет
  автоматически чинить структурную порчу
- `cli audit {tail,export}` (json/csv) — обёртка над уже готовым
  `core/audit`
- `cli user reset-password <username>` — в отличие от `create-admin`,
  никогда не создаёт пользователя
- `cli version [--json]`

**Осознанно НЕ реализовано** (у каждого пункта просто нет core-модуля с
реальной функциональностью за ним, а не забыли):
`user unlock` (нет механизма блокировок в core/auth вообще),
`backup destinations {add,remove,...}` (нужна запись в `app.config.js`
из работающего процесса — `core/config` только читает),
`cert`, `secrets`, `security bans/incident`, `maintenance`,
`privacy {export,erase,...}`, `integrations {keys,webhooks}`,
`logs {tail,export,config}`, `cron {list,history,run}` (как
персистентная история прогонов), `deps`, `test:perf`,
`dev/start/stop/restart/status`, `service install/...`, `version sync`.

Прогнано вживую целиком: `restoreBackup()` на реальной БД (мутация
после бэкапа откатывается именно к состоянию бэкапа, pending-миграция
не применяется автоматически) + весь CLI через `createCli()` end-to-end
(`migrate → db status/integrity → user create-admin/reset-password →
version → backup run/list/verify/restore → audit tail/export → doctor →
health`).

### 11b. core/health — `health` vs `doctor` (0.1.2)

Два инструмента под разную аудиторию, по §4.5:
- **`app health` / `GET /health`** — дёшево (`SELECT 1`, без integrity
  check), для частых пробников (мониторинг/балансировщик). Деградация
  → **503**, не 500.
- **`app doctor [--fix]`** — диагностика окружения по категориям,
  которые собирает ПРИЛОЖЕНИЕ (`categoryProviders`), не core (core —
  механизм, см. границу core vs app выше). Встроенные категории:
  `runtimeChecks` (версия Node/платформа), `databaseChecks` (connection
  + `PRAGMA integrity_check` + pending-миграции), `storageChecks`
  (директории существуют/доступны на запись, `fix()` = `mkdir -p`),
  `securityChecks` (session secret не заглушка/не короче 16 символов),
  `applicationChecks` (порт свободен — `warn`, не `fail`, doctor часто
  гоняют при уже запущенном сервере).
- Exit codes по §4.2: `health` — 0/1, `doctor` — 0/3.
- Чего нет сознательно: Integrations/сертификаты из полной §4.5-матрицы
  — ждут несуществующих пока `core/email`/`core/ldap`/`core/certs`.

Подключено в `examples/workshop`: `GET /health` без аутентификации,
`app health`/`app doctor` в `bin/app.js`.

### 11c. core/modules — контракт `Module` из §1/§7.5 (0.1.4, схема восстановлена до полной формы в 0.1.5)

Третий из трёх контрактов §1 (`ApplicationConfig` = `core/config`,
`DatabaseAdapter` = `core/database/adapter.js`, `Module` = новый
`core/modules`).

`ModuleRegistrationSchema` (Zod) — **полная §7.5-форма**:
`id`/`permissions`/`fieldPermissions`/`cliCommands`/`navigation`/
`routes`/`translations`/`search`/`dataSubject`. В 0.1.4 последние пять
полей были исключены как преждевременные — пользователь поправил: это
неверное решение, правильная граница другая. core/modules **принимает
и честно хранит** все поля §7.5 (`registry.getNavigation()`/
`getRoutes()`/`getTranslations()`/`getSearchProviders()`/
`getDataSubjectHandlers()`, с реальными функциями внутри — `search.
provider`, `dataSubject.export`/`erase` сохраняются и вызываемы, не
заглушки) — но core пока **не читает их обратно и не действует на их
основе**, потому что нет потребителя:
- `navigation`/`routes`/`translations`/`search` — поверхность
  регистрации `@das-forge/ui` (§5.4 UI Module Contract), которого нет
- `dataSubject` — поверхность регистрации `core/privacy` (§4.5k),
  которого нет

`dataSubject` подключён к `core/privacy` (§11d). `navigation`/
`translations`/`search` теперь тоже подключены — минимальным
`core/ui` (§11f). `routes[].component` остаётся нечем монтировать —
в core нет клиентского фреймворка/бандлера.

Найдена реальная проблема совместимости: `z.function()` из документа не
работает в Zod 4 как field-схема внутри `z.object()` (API полностью
переделан в standalone factory) — заменено на
`z.custom(v => typeof v === 'function')`.

`createModuleRegistry()`: `getFieldPermissions()` (единая карта для
`http.serialize()`), `getPermissions()`, `applyCliCommands(cli)`.
Конфликт `fieldPermissions` между двумя модулями на одном имени поля —
explicit throw при регистрации (как `assertDatabaseAdapter` — падать на
старте).

**Реальная замена, не демо в вакууме**: `examples/workshop/src/
routes.js` раньше хардкодил `ASSET_FIELD_PERMISSIONS = { cost:
'read:finance' }`. Теперь это `src/modules/reporting-module.js`,
зарегистрированный в `context.js` — `routes.js` берёт карту через
`moduleRegistry.getFieldPermissions()` и не знает, что такое "cost"/
"finance". Плюс CLI-команда `report summary` через
`moduleRegistry.applyCliCommands(cli)`.

Прогнано вживую на реальном, неподменённом коде: `reporting-module.js`
→ `createModuleRegistry()` → настоящий `core/http/serialize.js`
(оператор без `read:finance` не видит `cost`, финансист — видит) →
настоящий `createCli()` (`report summary` реально выполняется).

### 11d. core/privacy — export/erase данных субъекта (0.1.6)

§4.5k, техническая база под 152-ФЗ/GDPR (окончательное юридическое
соответствие — вопрос комплаенса, не архитектуры).

- `exportUserData({db, findUserByIdFn, moduleRegistry, userId,
  auditLogFn, actor})` — собирает запись пользователя (`core/auth`) +
  `dataSubject.export(userId)` каждого модуля, зарегистрированного
  через `core/modules`. Один упавший модуль не прячет данные остальных
  — его результат заменяется на `{ error: <message> }`, выполнение
  продолжается
- `eraseUserData({..., mode})` — по умолчанию `mode: 'anonymize'`, НЕ
  `'delete'`: `core/audit`'s `audit_log` append-only (нет `update()`
  вообще) и обязан сохранять целостность истории — анонимизация
  переписывает ТОЛЬКО запись пользователя (`core/auth`'s
  `anonymizeUser()`), прошлые audit-записи с оригинальным username не
  трогаются задним числом. `'delete'` (`core/auth`'s `deleteUser()`,
  настоящий hard delete) — только явным флагом, вызывающая сторона
  (CLI, в будущем — admin-panel) отвечает за подтверждение ДО вызова.
  Каждый модуль вызывается через `dataSubject.erase(userId, {mode})`
  **до** изменения записи пользователя — модуль может успеть
  прочитать ещё не тронутую запись, если это ему нужно. Каждое
  действие (export/erase) логируется в audit — "сам факт запроса на
  приватность тоже часть аудита"
- `core/auth`: `anonymizeUser(db, id)` — username → `deleted-user-<id>`,
  email/password_hash/totp обнулены, `disabled: true`, **строка
  остаётся** (id сохраняется для ссылочной целостности с другими
  таблицами); `deleteUser(db, id)` — реальный `DELETE`
- `cli privacy export --user <username> [--out <file>]`,
  `cli privacy erase --user <username> [--mode anonymize|delete]
  --yes` — `--user <username>`, не `<email>` как в примере документа
  (email nullable в `UserSchema`, username — гарантированный
  уникальный идентификатор, та же логика, что у `user reset-password`)
- **Явно НЕ реализовано**: cookie-уведомление из §4.5k — часть
  `@das-forge/ui`, которого нет; не фасад, а честная граница
- `examples/workshop`: `reporting-module.js` стал фабрикой
  (`createReportingModule`) — его `dataSubject.export()` честно
  возвращает число реальных audit-записей пользователя (не выдуманные
  данные), `erase()` — честный no-op (модулю нечего удалять в этом
  демо, у него нет своей таблицы)
- Прогнано вживую дважды: изолированно (zod-free stand-in для
  auth/audit/modules — полный цикл export/erase/delete + все отказные
  пути CLI: без `--user`, неизвестный юзер, без `--yes`, невалидный
  `--mode`) и **end-to-end на реальном, неподменённом коде
  `reporting-module.js`**: реальный пользователь с 3 реальными
  audit-записями → `privacy export` через настоящий CLI → модуль
  реально насчитал 3 → `privacy erase` → пользователь не резолвится по
  старому username, анонимизирован под новым → **прежние audit-записи
  с оригинальным username не тронуты** (append-only подтверждён на
  практике, не только декларацией)

### 11e. core/certs — self-signed сертификаты (0.1.7)

§4.5f. `readCertInfo()` — чистый `node:crypto` (`X509Certificate`,
доступен с Node 15.6+), без зависимостей: subject/subjectAltName/
self-signed (через `checkIssued(self)` — корректная криптографическая
проверка, не строковая эвристика "issuer === subject")/дни до
истечения. `generateSelfSignedCert()` — через `selfsigned` (npm
`^5.5.0`, проверено на npmjs.com по стоячему правилу свежести
зависимостей; v5 — async-only, переписан на нативный WebCrypto).
`writeCertFiles()` — `data/certs/{cert.pem,key.pem}`, приватный ключ —
права `0600`, переустанавливаются и при перезаписи (`--force`).
`certChecks()` — doctor-категория, закрывающая пробел, явно оставленный
открытым в `core/health` §11b ("ждут несуществующих пока core/certs").

`cli cert {info,generate,renew,trust}` — командный файл НЕ импортирует
`core/certs` напрямую (как и все остальные `commands/*.js`), получает
функции через параметры — поэтому `cert info`/`cert trust` работают
даже в сборке без установленного `selfsigned` (нужен только
`generate`/`renew`). `cert renew` честно извлекает тот же SAN из
текущего сертификата перед перевыпуском, не генерирует новый с нуля.

Прогнано вживую: весь read-путь (`readCertInfo`/`writeCertFiles`/
`certChecks`/CLI-команды `info`/`trust`/`generate`/`renew` с подменённым
`generateCertFn`) на реальном X.509-сертификате (`openssl` — только
тестовая фикстура, не часть реализации). `generateSelfSignedCert()` —
единственная часть, требующая `selfsigned` из npm, не прогнана вживую
(нет сети в контейнере) — честно помечено, та же методология, что у
argon2/sharp/dompurify.

`examples/workshop`: `cert {info,generate,renew,trust}` и doctor-
категория `Certificate` подключены в `bin/app.js`; путь к сертификату
берётся из `app.config.js`'s `server.https.certPath`/`keyPath` с
дефолтом `data/certs/`.

### 11f. core/ui — минимальный AppShell (0.1.7)

§5.4. Намеренно НЕ полный аспирационный UI-фреймворк документа — ровно
то, что честно можно построить над тем, что уже хранится в
`core/modules` (§11c). Это и есть потребитель, которого ждала TODO-метка
"navigation/routes/translations/search хранятся, потребителя нет".

- `renderAppShell()` — серверный рендер: `<nav>` из
  `registry.getNavigation()`, отфильтрованный по правам (та же
  fail-closed логика, что у `http.serialize()` — пункт без `permission`
  виден всем, пункт С `permission` скрыт без него у зрителя), переводы
  из `registry.getTranslations()` (честный fallback на сырой ключ, не
  на пустую строку), экранирование HTML (проверено на инъекции и в
  `label`, и в `path`)
- `translate()` — автономный i18n-лукап для обработчиков роутов
- `searchModules()` — агрегирует `search.provider()` каждого
  зарегистрированного модуля; падение одного провайдера не прячет
  результаты остальных (тот же принцип, что у `privacy.exportUserData`)
- **Честно НЕ реализовано**: `routes[].component` ничем не монтируется
  — в core нет клиентского фреймворка/бандлера; это серверный shell с
  `<nav>`, не SPA-хост. Полноценный AppShell с монтированием компонентов
  — реальная будущая работа, не подделана здесь

`examples/workshop`: `reporting-module.js` дополнен реальными
`navigation`/`translations`/`search` (поиск реально фильтрует настоящие
audit-записи по подстроке, не выдумывает результаты); `GET /ui`
(рендерит shell, требует auth), `GET /ui/search` в `routes.js`.

Прогнано вживую целиком на реальном `reporting-module.js`: фильтрация
навигации по правам (скрыт без `read:finance`, виден с ним), честный
i18n-fallback, переключение локали меняет текст, экранирование от XSS
(инъекция и в label, и в path — обе блокируются), реальный поиск по 3
настоящим audit-записям (2 матчат "asset", 1 — "backup", 0 — по
несуществующему термину), агрегация при падении одного провайдера.

### 11g. core/auth — многофакторная модель + recovery codes (0.1.8)

Принято по итогам обсуждения с пользователем общего security-документа
(TOTP+WebAuthn, RBAC+scope, step-up, см. вставку документа в диалоге) —
применён тот же принцип, что и везде в проекте: не строить недоказанное.

**Взято сейчас** (явная польза, низкая стоимость):
- Таблица `authenticators` (+ `totp_credentials`) вместо плоских
  `users.totp_secret`/`totp_enabled` — разблокирует несколько факторов
  на пользователя (в т.ч. будущий WebAuthn, без реализации сейчас).
  `type` ограничен `CHECK (type IN ('totp'))`, не оставлен открытым под
  `'webauthn'` — в отличие от `dataSubject` в `core/modules` (§11c,
  честное хранение данных под будущего потребителя), authenticator без
  функции проверки за ним — не безобидные данные, а дыра: пользователь
  может решить, что у него рабочий второй фактор, который никто не
  умеет проверить
- `startTotpEnrollment()`/`verifyTotpEnrollment()` — PENDING → (верный
  код) → ACTIVE, TTL на enrollment-окно,
  `purgeExpiredPendingAuthenticators()` для забытых (§5: "если
  пользователь бросил процесс — PENDING истекает и удаляется")
- `verifyTotpLogin()` — проверяет код против ВСЕХ активных
  TOTP-аутентификаторов пользователя (поддержка нескольких факторов
  одновременно — то, чего не позволяла плоская колонка)
- `removeAuthenticator()` — §18 ("нельзя удалить последний фактор, если
  policy требует MFA"), включается параметром `mfaRequired` — саму
  политику (обязателен MFA или нет) по-прежнему решает приложение, core
  только исполняет инвариант, когда ему об этом сказали
- Одноразовая идемпотентная миграция существующего `users.totp_secret`
  в новые таблицы при `ensureAuthTables()`; старые колонки не удаляются
  (аддитивно, не cutover)
- `core/auth/recovery-codes.js` (§22): `generateRecoveryCodes()`
  (полный сброс при каждом вызове, хеш через уже существующий
  `hashPassword()` — не новый криптопримитив), `verifyAndConsume
  RecoveryCode()` (одноразовое использование), `countRemaining
  RecoveryCodes()`
- `cli user {authenticators, authenticators-remove, recovery-codes}` —
  админский recovery-путь (потерян телефон/лист кодов) без self-service
  UI, которого пока нет (Workshop Stage B не начат).
  `authenticators-remove` защищён по умолчанию (`mfaRequired: true`),
  `--force` — осознанный override

**Отложено явно** (не пробел, осознанная граница по итогам
обсуждения):
- **WebAuthn** (`@simplewebauthn/server`+`browser`) — новая зависимость
  + браузерный код + своя сложность (challenge storage, counter,
  clone detection); ни разу не всплыла конкретная потребность ни в
  одном из 4 приложений
- **Замена своего TOTP на `otplib`** — своя реализация (чистый
  `node:crypto`, RFC 6238) уже работает без зависимости; менять без
  конкретного пробела (не хватает digits/period/algorithm?) —
  зависимость ради зависимости
- **Resource Scopes** (Site A/Site B) — домен конкретного приложения
  (какие сайты/организации существуют — знает только net-monitor/
  it-assets), не core
- **Отдельная таблица `security_events`** — дублирует уже готовый
  `core/audit`; события вроде `LOGIN_FAILED` — это просто новые
  `action`-строки в `audit.log()`, не новая таблица
- **Полный RBAC** (`roles`/`permissions`/`role_permissions` таблицы) —
  реальная миграция для всех 4 приложений разом; нужно подтвердить, что
  текущей модели (роль-строка + `permissionsForRole()` на уровне
  приложения) реально не хватает, прежде чем тащить это в core
- **Security Policies, Step-up authentication** — концептуально хорошо
  ложатся на уже существующие точки (`backup restore --yes`, `privacy
  erase --mode delete --yes` уже требуют явного подтверждения) — но
  полноценный step-up с переаутентификацией реализуется вместе с
  реальным сценарием, не отдельно

**Найден и исправлен реальный баг** при прогоне:
`purgeExpiredPendingAuthenticators()` сравнивал ISO-строку
(`new Date().toISOString()`, формат `"2026-10-07T12:34:56.789Z"`) с
SQL-вым `datetime('now')` (формат `"2026-10-07 12:34:56"` — пробел
вместо `T`, без миллисекунд и `Z`). Лексикографическое сравнение двух
разных форматов ненадёжно (`'T'` 0x54 сортируется после `' '` 0x20) и
могло не находить реально истёкшие pending-записи. Исправлено на
сравнение ISO-строки со значением, переданным из JS
(`new Date().toISOString()` на обеих сторонах). Отдельно проверено, что
больше нигде в кодовой базе нет такого же смешения форматов
(`sessions.js` сравнивает корректно — парсит `expires_at` через
`new Date()` перед сравнением, а не сырой строкой в SQL).

Прогнано вживую целиком (zod-free stand-in для `schema.js`): полный
цикл enrollment (неверный код не активирует, верный — активирует, TTL
истекает и не активируется даже верным кодом, purge удаляет истёкшую
запись), два одновременных TOTP-фактора у одного пользователя
(каждый проверяется своим секретом), все три исхода §18 (запрет с
одним активным фактором и `mfaRequired`, разрешение с двумя, разрешение
без `mfaRequired`, `not_found`), миграция legacy-секрета (включая
проверку, что смигрированный секрет реально проходит `verifyTotpLogin`,
и идемпотентность повторного `ensureAuthTables()`), полный цикл
recovery codes (формат, одноразовость, `regenerate` инвалидирует старый
набор целиком), и все три новые CLI-команды через реальный `createCli()`
на реальной БД.

### 11h. Первый настоящий `npm test` — найденные баги (0.1.9)

Первый реальный прогон тестов (Windows, настоящие `zod`/`argon2`/
`selfsigned`/`vitest`, не синтакс-чек в песочнице без сети):
**246 тестов, 229 прошли, 17 упали в 6 файлах**. Разобрано по одному:

1. **Реальный баг в коде** — `core/modules/schema.js`'s `translations`
   был `z.record(z.enum(['ru','en']), ...)`. В Zod 4 `z.record()` с
   enum-ключом строит точный тип, требующий ВСЕ значения enum как
   ключи — регистрация с одним `ru` (без `en`) падала с
   `"translations.en: expected record, received undefined"`.
   Исправлено на `z.object({ ru: ...optional(), en: ...optional() })`.
   **Методологическая находка**: мой zod-free stand-in для живых
   прогонов в песочнице эту ошибку не поймал — он не воспроизводит
   строгость настоящей Zod-валидации, только общую форму. Живое
   тестирование через stand-in ловит логические баги, но не
   схема-специфичные; граница этого подхода теперь явно
   задокументирована
2. **Устаревшие тесты** (`branding.test.js`) — `CORE_IDENTITY` всё ещё
   ждал черновой PNG без тёмного варианта; забыл обновить при добавлении
   плейсхолдер-`logo.svg`/`logo-dark.svg` в 0.1.7 (§11, плейсхолдер-
   эмблемы). Поправлено под актуальное поведение
3. **Баг в счёте теста** (`health.test.js`) — `runDoctor`-тест ждал
   `{ok: 1}`, но `runtimeChecks()` всегда возвращает ДВЕ проверки
   (версия Node + платформа). Тест ни разу не выполнялся по-настоящему
   раньше (только синтакс-чек), ошибка в подсчёте не всплывала.
   Исправлено на `{ok: 2}`
4. **Порядок операций** (`audit.test.js`, 2 теста) — сырой
   `db.run("INSERT INTO audit_log ...")` стоял перед первым вызовом
   `log()`, который создаёт таблицу (`ensureAuditTable()`). На чистой
   `:memory:` БД — `"no such table: audit_log"`. Переставлено: `log()`
   теперь первый в обоих тестах
5. **Тестовая fixture зависела от `openssl`** (`certs.test.js`, все 10
   падений) — на Windows-машине тестировщика `openssl` не в PATH, это
   проблема окружения, не кода. Переписано на уже реальный
   `generateSelfSignedCert()` (`selfsigned` теперь реально установлен) —
   не требует ничего от ОС на любой платформе, и заодно
   `generateSelfSignedCert()` впервые получает живую проверку — раньше
   это был единственный путь, который было невозможно прогнать в
   песочнице разработки без сети (см. §11e), теперь проверяется там,
   где `npm install` реально прошёл

### 11i. Второй настоящий `npm test` — найденные баги (0.1.10)

Второй реальный прогон тестов (Windows, теперь с `argon2`/`selfsigned`
реально установленными, не только `zod`): **266 тестов, 255 прошли, 11
упали в 3 файлах** (`auth.test.js` ×5, `authenticators.test.js` ×2,
`certs.test.js` ×4). Три разных реальных причины:

1. **`migrateLegacyTotpSecrets()` (`auth/schema.js`)** безусловно
   читала `users.totp_secret`, предполагая, что `CREATE TABLE IF NOT
   EXISTS users (...)` в этом же вызове всегда даёт полную схему — но
   `IF NOT EXISTS` ничего не делает, если `users` уже существует
   (ровно так и устроена `sessions`-fixture в `auth.test.js`: создаёт
   свою минимальную `users (id, username)` до первого вызова
   `ensureAuthTables()`). Запрос падал `"no such column:
   totp_secret"`. Исправлено: проверка `PRAGMA table_info(users)`
   перед миграцией, без легаси-колонки — миграции нечего делать, тихий
   выход
2. **Реальный security-баг** в `recovery-codes.js`'s
   `verifyAndConsumeRecoveryCode()`: `if (await verifyPassword(...))`
   проверял истинность ОБЪЕКТА `{ valid, scheme, needsRehash }`
   (`verifyPassword()` никогда не резолвится в `boolean`), который
   всегда truthy — первая непогашенная recovery-запись "совпадала"
   независимо от кода, так что неверный код принимался, а заодно
   гасилась чужая валидная запись. Исправлено на проверку `result.valid`
3. **`generateSelfSignedCert()` игнорировала `days`** — `selfsigned` v5
   не читает опцию `days` вообще (сверено с актуальным исходником на
   GitHub), только `notBeforeDate`/`notAfterDate` (объекты `Date`);
   без них — молчаливый дефолт 365 дней. Из-за этого `daysRemaining`
   всегда выходил ~365, валя и `readCertInfo`-тест, и `certChecks`'s
   warn/ok тест. Исправлено: `days` → `notAfterDate` перед вызовом
4. **Не баг кода** — 2 из 4 `certs.test.js` падений (`mode & 0o777 ===
   0o600`) оказались Windows/NTFS-ограничением: там нет POSIX
   permission bits, `chmod()` лишь переключает read-only атрибут,
   `Stats.mode` синтезирует `0o666`/`0o444`. `writeCertFiles()` как
   писала `0o600`, так и пишет — верно для POSIX. Точная
   mode-проверка вынесена в `it.skip` на `win32`, не ослаблена
   повсеместно

Как и в 0.1.9: все три кодовых бага были в точности там, где
no-network песочница не может поймать настоящее поведение реальных
библиотек (`node:sqlite`'s взаимодействие с предсуществующей таблицей,
`argon2`'s реальный тип результата, `selfsigned`'s v5 breaking change
в API валидности). Два из трёх (totp_secret-guard, recovery-code
логика) живо провалидированы вручную против настоящего `node:sqlite`
в этой сессии; `selfsigned`'s API сверен напрямую с актуальным
исходником на GitHub, а не по памяти.

### 11j. Workshop Stage B — Users & Access, API-слой (0.1.12)

Полный цикл логина с MFA-step-up в `examples/workshop/src/routes.js`,
целиком поверх уже существующих `core/auth` TOTP/recovery-code
примитивов — само Stage B и есть первое реальное доказательство, что
эти примитивы (готовые с 0.1.8) действительно достаточны для
приложения, не только для изолированных unit-тестов core:

- `/login` → при наличии активного TOTP-фактора выдаёт
  короткоживущую (5 мин) "pending"-сессию вместо полной —
  `session.data` без ключа `user`, поэтому `req.user` не
  выставляется и `requireAuth()` автоматически блокирует её на любом
  обычном роуте, без отдельной проверки на каждом роуте
- `/login/totp`, `/login/recovery` — step-up верным TOTP- или
  recovery-кодом; неверный код НЕ сжигает pending-сессию (повтор
  разрешён в пределах TTL), успех всегда выдаёт НОВЫЙ id сессии
  (анти-fixation, не промоция pending)
- `/password/change` (требует текущий пароль), `/totp/enroll/{start,
  verify}`, `/totp/authenticators`, `/totp/authenticators/:id/remove`
  (политика `mfaRequired` — app-уровня решение, ровно как и
  предполагает контракт `removeAuthenticator()` в core: admin не
  может удалить последний фактор, operator — может),
  `/recovery-codes/{generate,remaining}`
- `/admin/users` — ролевое ограничение проверено на реальном
  HTTP-уровне через `requirePermission('admin:write')`, не только
  спрятано в UI

**Тестирование**: `examples/workshop/test/routes.test.js` — новый
файл, полный HTTP-цикл через `registerRoutes()` с фейковым
Express-harness (та же мидлвар-цепочка, что в проде:
validateBody→requireAuth→requirePermission→handler) и фейковым
SHA-256-based authProvider вместо argon2. Существует и синтаксически
корректен, но не прогнан в этой сессии — барреля-импорт
`@das-forge/core` тянет весь граф разом (zod/argon2/sharp/...), так
что ни одна функция из `auth`/`http` не грузится без всех
зависимостей сразу. Вместо этого state-machine логика (enroll→pending→
active, pending-сессия без `user`, single-use после step-up, политика
`mfaRequired`) живо проверена отдельно против настоящего `node:sqlite`
через zod-free копии `sessions.js`/`authenticators.js`/`totp.js` —
**18 из 18 проверок прошли**. Полное подтверждение HTTP-слоя ждёт
`npm test` пользователя.

**Не сделано**: интерактивный UI (формы смены пароля, QR-рендер для
TOTP-enroll) — сознательно отложено, API-поверхность была приоритетом
как более рискованная и security-значимая часть.

### 11k. Workshop Stage B — интерактивный UI (0.1.13)

Закрывает единственный явно отложенный пункт §11j'а ("API-слой готов,
UI отложен"):

- `examples/workshop/src/pages.js` — server-rendered HTML без
  клиентского фреймворка и без сборки, та же "минимально реальное, не
  аспирационное" позиция, что у `core/ui`'s `renderAppShell()`:
  `renderLoginPage()` (двухшаговая форма — пароль, затем TOTP/
  recovery-код при ответе `mfaRequired`) и `renderAccountBody()`
  (смена пароля, список/enroll/remove аутентификаторов, генерация
  recovery-кодов)
- Новые роуты: `GET /login` (публичная страница) и `GET /ui/account`
  (`requireAuth()`, рендерит `renderAccountBody()` внутри
  `renderAppShell()`) — обе формы бьют исключительно в уже
  существующие JSON-эндпоинты §11j'а, ни одной новой бизнес-логики на
  сервере нет
- Изначально — сознательно без QR-картинки (нужен QR-кодек, ни
  `qrcode`, ни `jsqr` не входили в зависимости), показывался только
  `otpauth://` URI и секрет текстом для ручного ввода. Пользователь
  явно отменил это решение в том же обсуждении — см. §11l: реальный
  QR добавлен следующим патчем (0.1.14), ручной ввод остался как
  текст под картинкой, а не единственный способ

**Тестирование**: `pages.js` не импортирует `@das-forge/core` вообще
(чистые строковые функции без состояния) — единственный файл во всём
Stage B, который можно было живо прогнать прямо здесь без
zod-free/argon2-free копий. Проверено: HTML-экранирование (имя
пользователя с `<script>` в нём не исполняется), remove-кнопка
рендерится только для `active` аутентификаторов (не для `pending`),
подсказка про `mfaRequired` появляется для роли, которой это
действительно требуется. Сам HTTP-роутинг (`GET /login`, `GET
/ui/account`) наследует то же ограничение, что и весь остальной
Stage B (§11j) — ждёт `npm test`/`npm start` пользователя.

### 11l. Настоящий QR-кодек: core/qr (0.1.14)

Прямой разворот решения из §11k, по явному запросу пользователя: "QR
коды есть [нужны] IT ASSETS для инвентаризации, так что в любом случае
их придётся добавлять" — т.е. зависимость не опциональна, нужна
минимум двум реальным приложениям (TOTP-enroll здесь, инвентарные
QR-бирки в it-assets), поэтому решена на уровне ядра, а не как
одноразовый выбор примера.

Было запланировано ранее (§6.4) как отдельный будущий пакет
`@das-forge/qr`, но поскольку реальная потребность оказалась у одного
не-UI-специфичного метода кодирования, реализовано как модуль ядра
`core/qr`, а не отдельный пакет — тот же принцип, что и у остальных
core-модулей: добавлять пакет только когда нужда доказана, не заранее.

- **Зависимость**: `qrcode@^1.5.4` (soldair/node-qrcode) в
  `packages/core/package.json` — версия и API (`QRCode.toString(text,
  {type:'svg'}, cb)`, опции `errorCorrectionLevel`/`margin`/`color`)
  сверены с реальным README пакета и `registry.npmjs.org/qrcode/latest`
  через веб-поиск, не взяты по памяти (то же правило, что поймало
  баг с `selfsigned` в 0.1.10)
- **`packages/core/src/qr/index.js`**: `generateQrSvg(text, options)` —
  промис, возвращает строку `<svg>...</svg>`. SVG, не PNG/canvas —
  не тянет sharp/jsdom, подходит и для панели в браузере, и для
  печатной этикетки без растеризации
- **`examples/workshop`**: `POST /totp/enroll/qr.svg` (тело
  `{otpauthUri}`, не query — секрет не должен оседать в логах/Referer)
  рендерит QR для enrollment-панели; `GET /assets/:id/qr.svg` отдаёт
  `image/svg+xml` напрямую — инвентарный QR-тег для Demo Records
  (Stage C), тот самый сценарий IT Assets, который пользователь назвал
  явно
- `pages.js`: enrollment-панель теперь показывает настоящий `<svg>`
  QR (inline, через `innerHTML`), `otpauth://` URI и секрет остаются
  текстом под картинкой как резерв для приложений без камеры

**Честно про проверку**: `qrcode` физически не установить в этой
песочнице — отдельно проверено (`npm install qrcode` в чистой
временной папке, не только барреля-импорт ядра): `ENOTFOUND
registry.npmjs.org`, сети на npm-реестр нет вообще. Ни
`core/qr`, ни новые роуты не прогнаны вживую здесь — только
`node --check`. Полная проверка — на `npm install && npm test`/
`npm start` пользователя.

### 11m. Stage C доведён до конца: migrate-on-boot, uploadsDir, негативные тесты (0.1.17)

Закрывает три явно отложенных пункта §11l'а (`uploadsDir` не был
прокинут в `server.js`, миграции только вручную, негативных сценариев
для `/assets*` не было):

- `context.js`'s `buildContext()` теперь возвращает `uploadsDir`
  (рядом с `certDir`, та же "вывести из `database.file`" логика) и
  `migrationsDir` (раньше была отдельной константой в `bin/app.js` —
  теперь одна точка истины для HTTP-сервера и CLI одновременно)
- `server.js`: migrate-on-boot — `cliModule.runMigrations(db,
  migrationsDir)` перед `registerRoutes()`, идемпотентно (уже
  применённые миграции пропускает сам раннер — безопасно гонять на
  каждом старте, не только на первом), плюс `seedAssetsIfEmpty(db)`.
  `npm run cli -- migrate` остаётся доступным отдельно (например, перед
  rolling-деплоем отдельно от запуска сервера), но больше не
  ОБЯЗАТЕЛЕН перед `npm start`
- `test/routes.test.js`: полный блок негативных сценариев для Stage C
  — 401 без сессии на каждом `/assets*` роуте, 404 на несуществующем
  id (get/update/delete/cost), 400 на невалидном create/cost, create
  игнорирует подсунутый `cost` в теле (схема его не принимает вовсе),
  delete только для admin (403 у operator, реально удаляет у admin), и
  отдельный харнесс с НАСТОЯЩИМ `moduleRegistry` +
  `reporting-module.js` (не `moduleRegistry: null`, как в остальном
  файле) — подтверждает, что `cost` реально вырезается из ответа без
  `read:finance` (не просто `null`, а отсутствует как ключ) и что
  попытка его записать без этого права получает 403, не тихий игнор.
  Общий `beforeEach` файла тоже пришлось поправить: `assets`-таблица
  (в отличие от `users`, которую `core/auth` создаёт лениво сама) без
  явного `up()` из `002_assets.js` не существовала бы — без этого
  фикса уже существовавший тест "the existing field-permission
  scenario" упал бы на первом же `npm test` пользователя
- Upload логотипа (`express.raw()` поверх настоящего потока) в этот
  fake-express-харнесс принципиально не укладывается (фейковый `req` —
  не реальный `IncomingMessage`) — честно не тестируется здесь, этим
  ничего не скрывается, просто зафиксировано как граница метода

**Честно про проверку**: как и весь остальной HTTP-слой Stage B/C,
логика сверена построчно с реальным кодом (`serialize()`'s вырезание
поля по ключу, `requirePermission()`'s 403/`FORBIDDEN`,
`validateBody()`'s 400/`VALIDATION_ERROR`, `CreateAssetSchema`/
`SetCostSchema` — прочитаны заново из текущих файлов перед написанием
тестов, не по памяти), прошла `node --check`, но не прогнана — барреля-
импорт `@das-forge/core` тянет весь граф зависимостей разом. `npm
test` пользователя — единственное реальное подтверждение.

Workshop Stage A–C теперь закрыты целиком. Следующее по плану — Stage
D/E (Audit, System & Maintenance, Realtime Lab) или портирование IT
Assets (Stage F) — см. §0 таблицу текущего состояния.

### 11n. CLI help в духе man: механизм (0.1.18)

По прямому вопросу пользователя "а ты аналог man для cli в итоге
сделал?" — нет, не делал; это открытый пункт бэклога ниже по файлу
("CLI help в духе `man`"). Сделано сейчас:

- `cli.js`'s `command(path, opts)` принимает необязательные
  `usage`/`flags`/`examples` вдобавок к `description` — обратная
  совместимость, старые регистрации без этих полей не ломаются
- `printCommandHelp(path)` — развёрнутая карточка по одной команде:
  описание, `Usage:`, `Flags:`, `Examples:`, с честной заглушкой
  "(No detailed flag/example reference yet for this command.)" вместо
  пустого экрана, если поля не заполнены
- Два входа: `app help <command...>` (новое) и `app <command>
  --help`/`-h`. Раньше ЛЮБОЙ `--help` показывал общий список, даже
  после реального пути команды — `flags.help` проверялся до попытки
  матчинга команды вообще, так что `app migrate --help` не отличался
  от голого `app --help`. Матчинг "самого длинного префикса" работает
  и тут: `app migrate --help` не путается с `migrate status`'ом
- Попутно: `app --help` без команды теперь возвращает код `0`
  (реальный запрос помощи), а не `1` как раньше; голый `app` без
  аргументов по-прежнему `1` — другое поведение не затронуто
- Заполнено на реальных командах: `migrate`, `migrate status`, все
  пять `user *` — как доказательство, что механизм работает не только
  в тесте. **Осознанно не доделано**: оставшиеся ~18 команд
  (`backup *`, `cert *`, `audit *`, `privacy *`, `db *`, `config
  check`, `health`, `doctor`, `version`) — чисто текстовая работа,
  корректно оставить на потом, см. CHANGELOG Unreleased
- 7 новых тестов в `test/cli.test.js`

**Проверено вживую, не просто `node --check`**: `cli.js` сам по себе
не тянет zod/argon2/sharp ни напрямую, ни транзитивно — единственный
модуль в HTTP/CLI-слое этой сессии, для которого барреля-импорт не
является преградой. Весь механизм (все 7 тестовых сценариев, плюс
`registerMigrateCommands()`/`registerUserCommands()` с их настоящим,
не стендовым кодом) реально прогнан здесь через `node
--input-type=module -e`, вывод сверен построчно.

### 11o. Workshop Stage D — Audit & Activity (0.1.19)

`core/audit` существовал с 0.1.1 (§11), но до этого патча ни один
роут `examples/workshop` его не вызывал — `audit.log()` нигде не
стоял. Страница активности могла бы отрендериться, но показать было бы
нечего: это и была содержательная часть задачи, не только UI поверх
уже готового API.

- `routes.js`: новый `logAudit(req, {...})` — обёртка над
  `audit.log()`, сама достаёт `req.id`/`req.ip`, глотает собственные
  ошибки (логирование не должно ронять запрос, который пыталось
  записать). Расставлено на каждой значимой точке: `/login` (успех,
  неверный пароль, неизвестный username, отключённый аккаунт,
  pending-MFA отдельным action'ом `auth.login.pending`),
  `/login/totp`/`/login/recovery` (оба исхода), `/logout`,
  `/password/change` (оба исхода), `/totp/enroll/verify`,
  `/totp/authenticators/:id/remove`, `/recovery-codes/generate`, все
  мутации `/assets*`
- `GET /audit` — тот же порог, что у `/admin/users`
  (`requireAuth`+`requirePermission('admin:write')`): журнал аудита
  сам по себе чувствительные данные (кто логинился когда, у кого
  менялся пароль, каждая неудачная попытка логина с причиной), не
  казуальное чтение. Фильтры actor/action/entity/entityId/result/
  since/until идут напрямую в `audit.query()`/`audit.count()` —
  routes.js не изобретает собственную фильтрацию
- `GET /ui/audit` (`pages.js`'s `renderAuditBody()`): server-rendered
  таблица с plain `<form method="get">`-фильтром — страница работает
  без JS вообще, в отличие от account-страницы, где fetch() нужен по
  сути мутирующих действий. Ссылка на неё в `/ui` показывается только
  тем, у кого `admin:write` — то же "скрыто в UI И заблокировано на
  роуте" правило, что у finance-поля в Stage C
- `test/routes.test.js`: 7 негативных/позитивных сценариев — 401 без
  сессии, 403 не-admin, успешный логин реально виден через `GET
  /audit`, неудачный логин записан как `failure` с попыткой username
  в actor (включая логин несуществующего пользователя), запись на
  ДРУГОМ ресурсе (`asset.create`) тоже попадает в журнал, фильтр по
  action не цепляет соседние action'ы (`auth.login` ≠
  `auth.login.pending`)

**Честно про проверку**: `renderAuditBody()` (как весь `pages.js`) не
зависит от `@das-forge/core` — прогнано здесь напрямую через `node
--input-type=module -e`: HTML-экранирование подтверждено на
вредоносном `actor` со вставленным `<script>`, классы `audit-ok`/
`audit-fail` на правильных строках, пустое состояние, `(system)`
fallback для `actor: null`. Роуты и `logAudit()` сверены построчно с
кодом `core/audit`, но не прогнаны через реальный HTTP-слой — тот же
барреля-импорт блокирует это здесь, что и весь остальной Stage B/C/D.
`npm test` пользователя — единственное подтверждение целиком.

Workshop Stage A–D теперь закрыты. Следующее — Stage E (System &
Maintenance через UI, Realtime Lab) или Stage F (IT Assets).

### 11p. Workshop Stage E — System & Maintenance + Realtime Lab (0.1.20)

Последний пункт перед Stage F. Оба куска — тонкая HTTP/UI-обвязка над
уже готовыми core-модулями (core/scheduler, core/health, core/cli's
`migrationStatus()`, core/realtime), ничего нового в самом ядре не
понадобилось — ровно то же соотношение "core = механизм, уже готов;
app = решает, как его показать", что у Stage B/C/D.

**System & Maintenance**:
- `GET /system/status` (`requireAuth`+`requirePermission('admin:write')`,
  тот же порог, что у `/audit`/`/admin/users`) — один ответ:
  `health.checkHealth(db)` + `cliModule.migrationStatus()` + `scheduler.
  listBackups(appConfig.backup.destinations)` + `retentionDays`. Один
  round-trip для страницы вместо трёх отдельных
- `POST /system/backup/run` — вызывает тот же `runBackupJob` (из
  `context.js`, он же передан планировщику в `server.js`), что и `app
  backup run` в CLI — третий способ вызвать одну и ту же функцию, не
  третья реализация
- `POST /system/backup/verify` — **ключевое решение**: НЕ принимает
  произвольный путь от клиента. `verifyBackupFile()` открывает свой
  аргумент как sqlite-базу (`PRAGMA integrity_check`), поэтому путь
  сверяется со списком `scheduler.listBackups()`, снятым в тот же
  момент запроса — что угодно за пределами списка → `404`, а не
  попытка открыть файл. Тот же принцип "клиентский путь никогда не
  доверяется напрямую", что у `files.js`'s upload-хранилища (там имя
  на диске всегда генерируется сервером)
- **`backup restore` сознательно НЕ в UI** — перезаписывает живую базу;
  в CLI и так требует явного `--yes` (см. `commands/backup.js`), в вебе
  это не должно быть одной кнопкой на странице. Явно отмечено и в коде
  (`routes.js`), и на самой странице (`pages.js`), не молчаливый
  пропуск — тот же стиль, что у явного списка НЕ-реализованного в §11
  (WebAuthn, `backup destinations {add,remove}` и т.д.)
- `GET /ui/system` (`pages.js`'s `renderSystemBody()`) — health/
  миграции/бэкапы read-only + кнопка "Run backup now" + кнопка
  "Verify" на каждой строке таблицы, обе дергают JSON-роуты выше через
  `fetch()`
- Оба мутирующих действия идут через `logAudit()` (`system.backup_run`,
  `system.backup_verify`) — Stage E не исключение из правила Stage D

**Realtime Lab**:
- Второй SSE-канал (`lab`), независимый от `assets` — чтобы попробовать
  `core/realtime`'s pub/sub интерактивно, не завязываясь на создание/
  правку активов
- `POST /events/lab/broadcast` (`requireAuth`, БЕЗ admin-гейта —
  общая песочница, не чувствительная поверхность, в отличие от System
  & Maintenance) — `message` валидируется Zod (1–500 символов),
  `from` берётся ТОЛЬКО из `req.user.username` (сессия), никогда из
  тела запроса
- `GET /events/lab` — та же `realtime.createSseHandler()`, что и у
  `/events/assets`, просто `resolveChannel` возвращает `'lab'`
- `GET /ui/realtime` (`renderRealtimeBody()`) — форма + `EventSource`,
  живой лог сообщений; открыть в двух вкладках браузера — сообщение из
  одной видно в обеих

**`test/routes.test.js`**: 13 новых тестов, с явным акцентом на
негативные сценарии (критерий приёмки этапа, не "опционально"):
- System & Maintenance: 401 без сессии и 403 не-admin на
  `/system/status` И на `/system/backup/run` (с проверкой, что 403
  реально НЕ вызвал backup job — не просто код ответа), успешный `run`
  + его видимость в audit-трейле, `verify` с путём НЕ из списка
  известных бэкапов → 404 (а не попытка открыть произвольный файл —
  тест специально шлёт `/etc/passwd`), `verify` с пустым `file` → 400
  `VALIDATION_ERROR`
- Realtime Lab: 401 без сессии на broadcast, 400 на пустое и на
  >500-символьное сообщение, успешная отправка ЛЮБЫМ аутентифицированным
  пользователем (не только admin — тест на `alice`, обычный operator)
  с проверкой, что событие реально дошло до event bus на канале `lab`
  и что `from` равен именно сессионному username, а не тому, что можно
  было бы попытаться подставить в теле запроса
- Общий fake `eventBus` в файле дополнен — теперь реально записывает
  опубликованные события (`published: []`) вместо молчаливого
  отбрасывания, чтобы Realtime Lab-тесты могли проверить не только код
  ответа, но и что именно долетело до шины

**Честно про проверку**: `renderSystemBody()`/`renderRealtimeBody()`
(как весь `pages.js`) не зависят от `@das-forge/core` — прогнаны здесь
напрямую через `node --input-type=module -e`: XSS-экранирование на
вредоносных имени миграции и пути бэкапа, рендер строки с
неподдерживаемым типом destination (`supported: false`), классы `ok`/
`warn`, единственное/множественное число у "day/days", пустые
состояния для миграций и бэкапов — всё подтверждено построчно.
Роуты и тесты сверены построчно с реальными сигнатурами
`core/scheduler`'s `listBackups(destinations)`/`verifyBackupFile
(createAdapterFn, filePath)`, `core/health`'s `checkHealth(db, opts)`,
`core/cli`'s `migrationStatus(db, migrationsDir)`, `core/realtime`'s
`createSseHandler()` и event bus `publish(channel, event)` — но не
прогнаны через реальный HTTP-слой или настоящий `node:sqlite`-харнесс
здесь, тот же барреля-импорт блокирует это в песочнице, что и весь
остальной Stage B–E. `npm test` пользователя остаётся единственным
полным подтверждением.

Workshop Stage A–E теперь закрыты. Следующее — Stage F (портирование
IT Assets в `apps/`), после решения по Drizzle/мульти-БД абстракции
(раздел 17 — отложено намеренно до этого момента).

### 11q. Первый настоящий прогон `examples/workshop/test/routes.test.js` — найден и исправлен баг харнесса (0.1.21)

Пользователь впервые реально прогнал `npm test` на Windows с полным
набором зависимостей (argon2 включительно). `packages/core` —
277/279 (2 ожидаемых skip), зелено. `routes.test.js` — **27 из 37
упали**, и ВСЕ 27 — `401` там, где тест ожидал другой код (включая
косвенные провалы в TOTP-хелпере — `TypeError: ... toUpperCase` в
`base32Decode`, потому что `/totp/enroll/start` тоже вернул 401, а
хелпер читал `.secret` из тела 401-ответа).

**Диагноз**: баг не в `routes.js`, а в самом тестовом харнессе
(`createFakeApp()`). В реальном приложении `req.user` выставляется
ровно в одном месте — `http.sessionMiddleware({authProvider})`,
смонтированном ГЛОБАЛЬНО в `server.js`, перед любым роутом. Фейковый
`app` в тесте эмулировал только цепочку handler'ов КОНКРЕТНОГО роута
(то, что передано как аргументы `app.get(path, requireAuth(),
handler)`), но никогда не прогонял то, что в реальности монтируется
один раз глобально через `app.use()` — так что `req.user` оставался
`undefined` для каждого запроса, и `requireAuth()` закономерно всегда
возвращал 401, независимо от того, был ли в куках реально валидный
session-cookie. Этот харнесс существует с 0.1.12 (Stage B) — баг
дожил до первого реального запуска файла, не был пойман раньше
только потому, что раньше файл не выполнялся вообще (барреля-импорт
блокировал это в песочнице все эти версии).

**Исправление**:
- `createFakeApp()` получил настоящий `app.use()` — внутренний
  `dispatch()` теперь прогоняет зарегистрированные через него
  middlewares ПЕРЕД цепочкой конкретного роута, в том же порядке
  монтирования, что у Express/`server.js`
- `makeFakeAuthProvider()` получил реальный `verifySession: (id) =>
  auth.verifySession(db, id)` — чистая `node:sqlite`-логика, argon2 не
  нужен и стенд-ин не требуется (в отличие от hash/verify пароля,
  которые остаются SHA-256 стенд-ином по той же причине, что и раньше)
- Оба места, создающие харнесс (основной `beforeEach` и отдельный для
  "Demo Records (Stage C) — finance-gated cost, с реальным
  moduleRegistry"), теперь вызывают
  `harness.app.use(http.sessionMiddleware({authProvider}))` перед
  `registerRoutes()`

**Честно про проверку**: сам барреля-импорт `@das-forge/core`
по-прежнему блокирует прогон `routes.test.js` целиком здесь — но
механика фикса прогнана напрямую вживую: реальный
`session-middleware.js` (он ни от чего не зависит, не нужен даже
стенд-ин) + zod-free стенд-ин `createSession`/`verifySession`
(воспроизводящий `auth/sessions.js` построчно) против настоящего
`node:sqlite` — подтверждены все 4 сценария: валидная сессия → `200` с
заполненным `req.user`, отсутствие cookie → `401`, нехватка
permission → `403`, pending-сессия (`data` без ключа `user`, как у
MFA-step-up) по-прежнему блокируется `requireAuth()` → `401`.
Следующий `npm test` пользователя — единственное полное подтверждение,
что оставшиеся 27 тестов теперь зелёные.

### 11r. Второй настоящий прогон `routes.test.js` — гонка в `dispatch()` (0.1.22)

После 0.1.21 пользователь прогнал тесты второй раз: `routes.test.js`
с 27 провалов до **2**. Оба разобраны, ни один не в `routes.js`.

**Баг №1 — гонка в тестовом харнессе**: `recovery codes` тест падал с
`res.body === undefined`, хотя handler точно отработал. Корень:
реальные middleware ядра вызывают `next()` обычным statement'ом
(Express-стиль), никогда не `return next()`. Прежний `dispatch()` ждал
завершения через `await` возвращаемого значения каждого handler'а —
для синхронного middleware это `undefined` сразу же после того, как
он СИНХРОННО вызвал `next()` и вернулся, не дожидаясь того, что
`next()` в это время успел запустить асинхронно дальше по цепочке. Две
независимые "цепочки" получались: awaited-цепочка (быстро резолвится
в `undefined`) и реальная работа (резолвится позже). Пока терминальный
handler был синхронным или async-без-реального-ожидания — обе
успевали закончиться в один микротаск-тик, гонка не проявлялась.
`auth.generateRecoveryCodes()` делает 8 РЕАЛЬНЫХ argon2-хэшей —
настоящие обращения к пулу потоков libuv — и awaited-цепочка стабильно
финишировала раньше настоящей работы.

Исправление: `dispatch()` больше не доверяет промис-цепочке `next()`
как сигналу завершения — `res.json()`/`res.send()` сами резолвят
отдельный промис `finished` (так же, как Express следит за объектом
ответа, а не за промисами из middleware), и `dispatch()` ждёт именно
его. Ошибка в цепочке по-прежнему долетает — перехватывается на
ближайшем уровне `next()` и реджектит тот же `finished`.

**Баг №2 — баг в самом тесте**: `a write on another resource (asset
create)` падал на `expect(entry).toBeTruthy()`. Причина:
`core/audit`'s `entity_id` — колонка `TEXT` (`log.js` хранит её как
`String(entityId)` намеренно, entity id может быть UUID, не только
числом), `mapper.js` всегда возвращает `entityId` строкой. Тест
сравнивал её строгим `===` с числовым `id` ассета — никогда не
совпадёт. Поведение `core/audit` корректно; поправлен тест
(`String(created.res.body.id)`).

**Честно про проверку**: обе гонки прогнаны напрямую вживую —
отдельный скрипт воспроизвёл СТАРУЮ версию `dispatch()` (синхронные
middleware перед медленным async-терминальным handler'ом с реальной
`setTimeout`-задержкой) и показал тот же `res.body === undefined`; та
же сцена против НОВОЙ версии — тело корректно заполнено, ошибка из
handler'а по-прежнему долетает. Все 4 сценария `sessionMiddleware`/
`requireAuth`/`requirePermission` из 0.1.21 перепроверены против новой
механики `dispatch()` — по-прежнему верны, включая медленный
async-терминальный handler за `requireAuth()`. Барреля-импорт
по-прежнему блокирует прогон `routes.test.js` целиком здесь — третий
`npm test` пользователя остаётся единственным полным подтверждением
48/48.

### Инфраструктурные фиксы по баг-репорту коллеги
- [x] Корневой `package.json` с npm workspaces (`packages/*`, `examples/*`) — исправляет `ENOENT` при `npm install` в корне
- [x] `bin` в `examples/workshop/package.json` — npm сам сгенерирует кросс-платформенную обёртку (`.cmd` на Windows, симлинк на Unix) вместо `node bin/app.js ...`
- [x] Все упоминания `npm install && npm test`/`&& npm start` в README/доке заменены на раздельные команды (Windows PowerShell 5.1 не поддерживает `&&` как разделитель)
- [x] `examples/app-example` → `examples/workshop` (переименовано, все внутренние ссылки и имена пакета обновлены)
- [x] Заготовки `apps/README.md`, `templates/README.md` с пояснением будущего назначения

### Новые задачи, вскрытые этим обсуждением
- [x] `core/audit` — реализован (0.1.1), см. §11a–§11c выше
- [x] CLI help в духе `man` — механизм сделан (0.1.18, §11n): `app help <command>` / `app <command> --help` печатают Usage/Flags/Examples по одной команде. **Доработка**: `usage`/`flags`/`examples` заполнены пока только для `migrate`, `migrate status` и `user *` (6 команд) — остальные ~18 показывают честную заглушку вместо падения, но текст ещё не написан
- [ ] Error-страницы: полный каталог статус-кодов (не только 404/500) + билингвальность EN(основной)/RU(дублируется в теле) — решено делать EN primary, RU всегда дублируется, без завязки на GeoIP, т.к. пользователи интернациональные. Статус сведён в справочник, 0.1.16 — README.md "Переводы / i18n" + docs/index.html #i18n
- [ ] `docs/index.html` — переключалка EN/RU, EN как основной язык документации. Тот же справочник, 0.1.16
- [ ] Workshop: Users & Access, Demo Records, Audit, System & Maintenance, Realtime Lab (Stage B–E) + явные негативные тест-сценарии на каждый раздел
- [ ] Портирование IT Assets в `apps/it-assets` (Stage F) — после закрытия Stage B–E

## 12. Первый реальный прогон `npm install && npm test` (на стороне пользователя)

Пользователь прогнал полную установку и тесты на Windows — первый
настоящий прогон вне этого контейнера. Результат: **73 из 74 тестов
прошли**, 5 из 9 файлов тестов не запустились вовсе из-за
инфраструктурной проблемы (не бага в логике). Разобрано и исправлено:

### Найдено и исправлено
- [x] **`node:sqlite` не резолвился под Vitest** (`Failed to load url
  sqlite`) — ломало `database.test.js`, `auth.test.js`,
  `branding.test.js`, `cli.test.js`, `scheduler.test.js` (всё, что
  тянет `createSqliteAdapter`). Причина: `node:sqlite` слишком новый,
  Vite не узнаёт его как builtin и пытается резолвить как обычный
  пакет `sqlite`. Фикс — `packages/core/vitest.config.js`:
  `test.server.deps.external` с `node:sqlite`
- [x] **Реальный баг в тестовой фикстуре `files.test.js`**:
  `uncompressedSize: 5_000_000_000` — `RangeError`, превышает
  `writeUInt32LE` диапазон (max 4294967295). Поправлено на
  `2_000_000_000` (ratio всё ещё абсурдный: 2,000,000x). Единственный
  реально упавший тест (`checkZipSafety > rejects an entry with an
  absurd compression ratio`) — был именно из-за этого
- [x] **Задокументировано ограничение**: `zip-reader.js` не умеет
  ZIP64 (>4GB записи используют sentinel `0xFFFFFFFF` + доп. поле,
  которое мы не парсим). На практике не даёт тихий обход
  `checkZipSafety()` — sentinel читается как ~4.29GB, что больше
  дефолтного `maxUncompressedTotal` (500MB) и всё равно отклоняется,
  но это побочный эффект дефолта, не гарантия. Если появится легитимная
  потребность в офис-файлах около 4GB — нужен настоящий ZIP64-парсинг
  прежде чем поднимать лимит
- [x] Корневой `npm start` — алиас на `npm start --workspace=workshop`
  (пользователь интуитивно попробовал `npm start` из корня, скрипта не
  было)
- [x] В README добавлен обязательный шаг после `npm install`:
  **approve install-скриптов** для `argon2`/`sharp`/`esbuild` — npm по
  умолчанию блокирует их нативные/сборочные install-скрипты
  (supply-chain защита); без этого шага `argon2` не соберёт нативный
  биндинг, и вся аутентификация (`core/auth`) будет падать в рантайме,
  даже если тесты формально запускаются

### Известно, не требует действий
- `npm warn deprecated whatwg-encoding` — транзитивная зависимость
  `jsdom` (для DOMPurify в `core/files`), не наш код, чисто
  информационное предупреждение
- `6 vulnerabilities (3 moderate, 2 high, 1 critical)` по `npm audit` —
  вероятно, транзитивные (jsdom/sharp toolchain); `npm audit fix
  --force` **не выполнять не глядя** (может сломать breaking changes) —
  стоит разобрать отдельно, что именно уязвимо, прежде чем чинить

### Итог прогона
`files.test.js` зафиксирован — все 33/33 теста прошли, zip-bomb тест
больше не падает. `node:sqlite`-фикс в `vitest.config.js` **не
сработал** — второй реальный прогон (тот же набор команд) показал ту
же ошибку `Failed to load url sqlite` для тех же 5 файлов
(`database`/`auth`/`branding`/`cli`/`scheduler`), 74/74 отдельных тестов
всё равно зелёные (vitest считает упавший файл целиком, не отдельные
`it()` внутри), но файлы не запускались.

## 13. Второй реальный прогон — настоящая причина и фикс `node:sqlite`

`test.server.deps.external` в `vitest.config.js` не помогает, потому
что ошибка происходит на стадии **анализа импортов** Vite (плагин
import-analysis пытается резолвить `node:sqlite` как обычный пакет
`sqlite`, т.к. не узнаёт его в своём захардкоженном списке Node
builtins), а SSR-экстернализация — это следующая стадия, до которой
дело просто не доходит.

**Настоящий фикс** — `packages/core/src/database/sqlite-adapter.js`:
статический `import { DatabaseSync } from 'node:sqlite'` заменён на
`const { DatabaseSync } = await import(/* @vite-ignore */ 'node:sqlite')`
на верхнем уровне модуля (top-level await, API `createSqliteAdapter()`
остаётся синхронным — это внутренняя деталь загрузки модуля, не влияет
на сигнатуру). `/* @vite-ignore */` — официальный способ Vite сказать
"не трогай этот динамический импорт вообще", он доходит до нативного
загрузчика Node без вмешательства Vite/esbuild.

- [x] Заменён статический импорт `node:sqlite` на `@vite-ignore`
  dynamic import в `sqlite-adapter.js`
- [x] Прогнано вживую после фикса: сам адаптер (CRUD), а также
  `scheduler`/`cli`-модули, которые используют `database` внутри себя —
  регрессий нет, top-level await не ломает цепочку импортов
- [x] `vitest.config.js`'s `external`-запись оставлена как
  defense-in-depth с пометкой, что реальный фикс — в самом адаптере
- [x] Третий прогон — тот же результат (`Failed to load url sqlite`,
  те же 5 файлов). Фикс через `@vite-ignore` не сработал.

## 14. Третий прогон — тот же результат, фикс не сработал

`@vite-ignore` не помог. Разбор: Vitest выполняет тестовые файлы через
свой `vite-node`, который перехватывает `import()` **на рантайме**
(не только статическим анализом) — поэтому даже полностью
"невидимый для бандлера" импорт всё равно проходит через резолвер
Vite с этим багом. Дальше копать своими силами без проверки актуальной
документации/issues означало бы третий патч вслепую — вместо этого
проверил через поиск.

## 15. Найдена настоящая причина — баг в самом vite-node, не в нашем коде

Поиск дал прямое попадание: [vitest-dev/vitest#7179](https://github.com/vitest-dev/vitest/commit/b628464)
(7 января 2025) — `vite-node`'s внутренний список builtin-модулей с
**обязательным** префиксом `node:` (в отличие от `fs`/`path`, у которых
есть форма без префикса) содержал только `'node:test'`. `node:sqlite` в
этот список не попадал, поэтому нормализатор ошибочно срезал префикс и
пытался загрузить несуществующий пакет `sqlite`. Это баг инструмента,
**не обходимый никаким кодом на нашей стороне** — ни `external` в
конфиге, ни `@vite-ignore`, ни вычисляемый спецификатор импорта не
могли сработать в принципе, т.к. проблема на уровне резолвера
vite-node, который перехватывает `import()` независимо от того, как он
вызван.

### Настоящий фикс
- [x] `packages/core/package.json`: `"vitest": "^2.1.0"` →
  `"vitest": "^3.0.0"` — диапазон `^2.1.0` (`>=2.1.0 <3.0.0`)
  физически не мог получить фикс, выпущенный уже после релизов 2.x;
  именно поэтому каждый новый `npm install` подтягивал "последний"
  2.1.9, где бага ещё не было исправлено
- [x] `sqlite-adapter.js` возвращён к простому статическому импорту
  `import { DatabaseSync } from 'node:sqlite'` — все три обходных
  манёвра (external/vite-ignore/computed specifier) убраны как
  ненужное усложнение кода, раз настоящий фикс — в версии инструмента.
  История сохранена в комментарии в самом файле
- [x] `vitest.config.js` упрощён обратно до минимума — специальный
  конфиг для этого не нужен
- [x] Прогнано вживую (чистый `node`, без Vite) — адаптер по-прежнему
  работает после отката к простому импорту
- [ ] Четвёртый прогон (с `vitest@^3.0.0`, должен закрыть все 9/9
  файлов) — на стороне пользователя

### Урок на будущее
Прежде чем третий раз чинить вслепую одну и ту же проблему —
проверять актуальные issues/changelog зависимостей через поиск, а не
полагаться только на общие знания о том, как работают бандлеры.

## 16. Актуализация версий зависимостей (пользователь сверил вручную по npmjs.com)

Все версии в `package.json`, которые я проставлял раньше, были по общим
знаниям на момент обучения — то есть устаревшие на 1-2 года к моменту
реальной разработки (конец 2026). Пользователь сверил по npmjs.com и
прислал актуальные версии. Зафиксировано **новое правило процесса**:
**перед тем как зафиксировать версию любого пакета — заходить на
npmjs.com, смотреть актуальную версию и читать документацию**, не
полагаться на знания "из головы".

### Обновлённые версии (`packages/core/package.json`, `examples/workshop/package.json`)
| Пакет | Было | Стало |
|---|---|---|
| zod | ^3.23.8 | ^4.6.0 |
| argon2 | ^0.41.1 | ^0.45.0 |
| sharp | ^0.33.5 | ^0.35.0 |
| dompurify | ^3.1.6 | ^3.4.0 |
| jsdom | ^25.0.1 | ^30.0.0 |
| express | ^5.0.0 | ^5.2.1 |
| cookie-parser | ^1.4.6 | ^1.4.7 |
| vitest | ^2.1.0 → ^3.0.0 (предыдущий фикс) | ^5.0.0 |

### Реальный баг, пойманный обновлением zod 3→4 (прогон пользователя: 158/160 тестов)
`z.object({...}).default({})` в Zod 4 **больше не прогоняет** значение
по умолчанию через схему повторно — просто подставляет его как есть.
В Zod 3 `.default({})` на объектной схеме пересчитывал вложенные
дефолты (`port: 3000` и т.д.); в Zod 4 это сломалось бы молча —
`config.server.port` стал `undefined` вместо `3000`. Задокументированный
breaking change, фикс — новый метод `.prefault()` ("pre-parse default"),
сохраняющий старое поведение.
- [x] `core/config/schema.js`: все вложенные object-дефолты
  (`server`, `database`, `backup`, `ui`, `security`, `performance`,
  `https`, `admin`, `cors`, `rateLimit`, `argon2`, `totp`, `budgets`)
  переведены с `.default({})` на `.prefault({})`
- [x] Заодно найден и исправлен второй v4 breaking change в той же
  зоне поиска: `z.record(valueSchema)` (один аргумент) теперь требует
  явную схему ключа — `z.record(keySchema, valueSchema)`. Поправлено в
  `config/schema.js` (`BackupDestinationSchema.config`,
  `ModuleEntrySchema.options`) и `auth/schema.js` (`SessionSchema.data`)
- [x] **Четвёртый прогон — зелёный.** 9/9 файлов, 160/160 тестов, на
  актуальных зависимостях (zod 4.6.5, argon2 0.45.1, vitest 5.0.3 и
  т.д.). Вся цепочка расследований (node:sqlite/vite-node,
  zod 3→4 `.prefault()`/`z.record()`, устаревшие версии) закрыта.

### Пакеты "пока не используем, но пометить при внедрении"
Список от пользователя — заносится сюда как трекер на будущее, версии
актуальны на момент получения списка (сверить заново на npmjs.com
непосредственно перед внедрением каждого, по новому правилу):

| Пакет | Версия (на момент записи) | Статус |
|---|---|---|
| compression | ^1.8.2 | не используется |
| cors | ^2.8.6 | не используется |
| express-rate-limit | ^8.7.0 | не используется |
| express-session | ^1.19.0 | не используется |
| helmet | ^8.3.0 | не используется |
| libheif-js | ^1.23.2 | не используется |
| uuid | ^14.0.2 | не используется |
| pino | ^10.4.0 | не используется |
| pino-http | ^11.0.0 | не используется |
| selfsigned | ^5.5.0 | не используется |
| docx | ^9.8.1 | не используется |
| adm-zip | ^0.6.1 | не используется |
| nodemailer | ^10.0.11 | не используется |
| multer | ^2.4.0 | не используется |
| @playwright/test (dev) | ^1.63.0 | не используется |
| pino-pretty (dev) | ^13.1.3 | не используется |
| playwright (dev) | ^1.63.0 | не используется |
| supertest (dev) | ^7.3.0 | не используется |
| jsqr (dev) | ^1.4.0 | не используется (декодирование QR не нужно — ядро только кодирует) |

## 17. Решение: Drizzle / мульти-БД абстракция — когда делать

Идея пользователя: в будущем, возможно, перевести atlas-ao или
net-monitor на PostgreSQL через Drizzle ORM (сейчас 1.0-RC5, не
финальный релиз). `DatabaseAdapter` уже спроектирован как
duck-typing контракт (не завязан жёстко на конкретную БД), так что
технически под капотом можно будет подложить Drizzle-backed
Postgres-адаптер, не меняя сам контракт.

**Решение:** не делать сейчас (Drizzle ещё не вышел в стабильный 1.0,
множить нестабильные зависимости одновременно не нужно). Таймлайн:
**после завершения `examples/workshop` целиком (Stage A–E), но до
портирования `apps/*` (Stage F)** — то есть прямо перед переносом
первого реального приложения, если к тому моменту Drizzle 1.0 выйдет.
- [x] Drizzle/мульти-БД абстракция — backlog, таймлайн: после Workshop
  Stage E (готово, 0.1.20), до Stage F (IT Assets) — пересмотрено и
  закрыто решением ниже (0.1.23)

### 17.1 Пересмотр (0.1.23) — финальное решение перед Stage F

В песочнице по-прежнему нет сети (см. §12–§16), поэтому фактический
текущий номер версии `drizzle-orm` на npmjs.com здесь надёжно не
проверить: веб-поиск в этой сессии дал противоречивые данные (один
источник утверждает "стабильный 1.0 вышел в середине 2025", другой —
что последняя статически закэшированная версия страницы релизов
Drizzle показывает только `1.0.0-beta.2`). Раздувать решение по
непроверенному номеру версии — тот же риск, что уже один раз привёл
к находке с `vitest`/`node:sqlite` (см. §13–§15): сначала проверить
руками, потом доверять.

**Решение:** не добавлять `drizzle-orm` в зависимости `@das-forge/core`
сейчас, вне зависимости от того, вышел ли уже стабильный 1.0. Причина
важнее версии пакета: `DatabaseAdapter` (см. `packages/core/src/
database/adapter.js`) — это duck-typing контракт на 8 методов
(`run`/`get`/`all`/`exec`/`transaction`/`createFtsIndex`/
`queryByExample`/`close`), сознательно не завязанный на SQLite API, и
он уже сегодня, без единой строчки изменений, допускает
Drizzle-backed Postgres-адаптер — реализовать его можно будет позже,
в отдельном опциональном пакете (`@das-forge/db-postgres` или
аналогично, по аналогии с `@das-forge/email`, §4.5e), не трогая
`@das-forge/core`. Никакого архитектурного риска от задержки нет:
контракт — это и есть вся абстракция, которая требовалась.

Поэтому Stage F (портирование IT Assets) начинается на чистом
`node:sqlite`-адаптере как есть. Фактическая реализация
Postgres/Drizzle-адаптера откладывается до момента, когда одно из 4
реальных приложений (скорее всего atlas-ao или net-monitor, по
исходной идее пользователя) реально потребует Postgres — тогда и
версия `drizzle-orm` будет проверена вживую (`npm view drizzle-orm
version` на стороне пользователя, та же дисциплина, что и везде в
этом проекте), а не предположена по веб-поиску.
- [x] Drizzle/мульти-БД — архитектурное решение закрыто (0.1.23,
  §17.1): контракт `DatabaseAdapter` уже достаточен, реализация
  Postgres-адаптера отложена до реальной потребности в одном из 4
  приложений, Stage F стартует на `node:sqlite`

## Открыто / отложено (актуальный сводный список)
- [x] Сводный раздел «Security» в `docs/index.html` — сделано (§18); core/audit реализован и может быть включён в раздел
- [x] `core/audit`, `core/health`, CLI-обвязка (§4.1, man-style help §11n), `core/modules` (§1/§7.5), `core/privacy` (§4.5k), `core/certs` (§4.5f), `core/ui` (§5.4, минимальный), `core/auth` MFA-модель+recovery codes, `core/qr` (§11l) — все реализованы, 0.1.1–0.1.23, см. §11a–§17.1
- [x] Workshop Stage D (Audit & Activity) полностью реализован (0.1.19, §11o): все write-роуты пишут в журнал через `logAudit()`, `GET /audit`+`GET /ui/audit` (admin-only, фильтры), 7 тестов
- [x] Первый настоящий `npm test` по `examples/workshop/test/routes.test.js` прогнан пользователем (Windows) — 27/37 провалов, все от одной причины (тестовый харнесс не эмулировал глобальный `sessionMiddleware`, `req.user` никогда не выставлялся) — найдено и исправлено (0.1.21, §11q): `createFakeApp()` получил `app.use()`, оба харнесса теперь монтируют `http.sessionMiddleware()` перед `registerRoutes()`
- [x] Второй настоящий `npm test` прогнан пользователем (Windows) — 27/37 провалов сократились до 2/37 — оба разобраны и исправлены (0.1.22, §11r): гонка между `dispatch()`'s промис-цепочкой и реальной async-работой за ней (харнесс, не `routes.js`; `res.json()`/`res.send()` теперь сами резолвят завершение) + строгое `===` в самом тесте между строковым `entityId` (`core/audit`'s `entity_id` — колонка TEXT намеренно) и числовым id ассета
- [x] Workshop Stage E (System & Maintenance + Realtime Lab) полностью реализован (0.1.20, §11p): `/system/status`+`/system/backup/{run,verify}`+`GET /ui/system` (admin-only, `backup restore` сознательно CLI-only), отдельный SSE-канал `lab`+`POST /events/lab/broadcast`+`GET /ui/realtime` (любой аутентифицированный пользователь), 13 тестов с упором на негативные сценарии. Workshop Stage A–E теперь закрыты целиком
- [x] Структура репозитория переведена на ведущийся справочник (построчные таблицы, статус ✅/⚠️/∅), тем же способом, что и CLI-команды — 0.1.15, §0.1 + README.md
- [x] Первый настоящий `npm test` прогнан пользователем (Windows) — 17 падений из 246 разобраны и исправлены (§11h), включая один реальный баг в `core/modules/schema.js`
- [x] Второй настоящий `npm test` прогнан пользователем (Windows, argon2/selfsigned установлены) — 11 падений из 266 разобраны и исправлены (§11i), включая реальный security-баг в recovery-code верификации и `selfsigned` v5's `days`-опцию
- [x] Реальная beta-артворк логотипа внедрена (0.1.11, `logo.png`/`logo-dark.png`, SVG позже); два реальных HEIC-файла прогнаны живьём через `detectFileType()` — корректно отклоняются (null), но зафиксирована находка: prebuilt `sharp` вообще не декодирует HEIC/HEIF — решение (кастомная libvips-сборка vs. отдельный конвертер vs. явный отказ) сознательно отложено до Workshop Stage B/C
- [x] Workshop Stage B (Users & Access) полностью реализован (API — 0.1.12 §11j, UI — 0.1.13 §11k, реальный QR — 0.1.14 §11l): login/logout, TOTP+recovery-code step-up, смена пароля, enroll/remove аутентификаторов, ролевое ограничение на реальном HTTP-уровне, страницы логина/аккаунта без клиентского фреймворка, QR-код в enrollment-панели и QR-эндпоинт для инвентарных тегов (`GET /assets/:id/qr.svg`)
- [x] Workshop Stage C (Demo Records) полностью реализован (0.1.14–0.1.17, §11l–§11m): CRUD на `assets` (database+http+files), zero-trust `serialize()` end-to-end, migrate-on-boot, `uploadsDir` единой точкой из `context.js`, негативные тест-сценарии (401/404/400/403, finance-гейтинг cost через реальный `moduleRegistry`)
- [ ] WebAuthn, полный RBAC (roles/permissions таблицы), resource scopes, security policies как конфиг, step-up authentication — осознанно отложены по итогам обсуждения security-документа (§11g), ждут подтверждённой потребности в одном из 4 приложений
- [x] Плейсхолдер-эмблемы ядра и workshop (`logo.svg`/`logo-dark.svg`) — не финальная отрисовка, см. `assets/brand/README.md`. Логотипы 4 реальных приложений по-прежнему не присланы
- [ ] Интеграционный тест multi-process доступа к БД (core/database, WAL)
- [ ] Логотипы 4 приложений (atlas-ao/net-monitor/it-assets/procure-it) — ещё не присланы
- [ ] Документированные легаси-форматы паролей 4 приложений для реальных вызовов `pbkdf2Scheme()`/`scryptScheme()`
- [ ] Реальный прогон `npm install`/`npm test` на стороне пользователя (нет сети в контейнере разработки для нативных/внешних пакетов) — ожидается 4-й прогон после бампа vitest до 3.x+
- [ ] CLI-команды, для которых осознанно нет backing-модуля (полный список — §11a): `user unlock`, `backup destinations`, `cert`, `secrets`, `security bans/incident`, `maintenance`, `privacy`, `integrations`, `logs`, `cron` (персистентно), `deps`, `test:perf`, `dev/start/stop/restart/status`, `service`
- [ ] Аудит ядра перед Stage F проведён (0.1.24): 58 находок в [`docs/audit-findings.md`](audit-findings.md) — разбор и порядок доработки определяет пользователь; стадии E–J (UI/i18n, privacy, CLI целиком, требования 4 приложений, нагрузка, цепочка поставок) не проводились
- [x] Волна 1 аудита выполнена (0.1.25); не проверено вживую: `server.smoke.test.js` — ждёт ваш `npm test`
- [ ] Следующий шаг: волна 2 (данные: бэкап, restore, транзакции, миграции) → волны 3–4 → Stage F (IT Assets)

## 18. Сводный раздел «Security» — реализован

По явному запросу пользователя (сделать перед `core/audit`, а не после)
добавлен раздел `#security-overview` в `docs/index.html`, собирающий
воедино то, что раньше было разнесено по описаниям отдельных модулей:
пароли/сессии (core/auth), zero-trust client↔server (core/http),
загружаемые файлы (core/files), брендинг/error-страницы (core/branding).
Каждый пункт ссылается на полное описание в своём модуле — раздел не
дублирует детали, а даёт сводную карту "что где реализовано".

- [x] `docs/index.html`: секция `#security-overview` + пункт в навигации
  (группа "Security")
- [x] Место для `core/audit` в разделе зарезервировано — присоединится
  автоматически по смыслу после реализации модуля
- [x] Открытые пункты (multi-process БД, легаси-форматы паролей)
  вынесены в явный callout внутри раздела, не только в общем списке
  "Открыто/отложено"

Чисто документационная задача — код не менялся, поэтому обычное
правило "доки после кода" здесь неприменимо напрямую.

## Волна 1 аудита (0.1.25)
Закрыто: A01–A04, A05 (частично), A06, A08, A09, A14, A17, A18, C02
(частично), C05, D01 (частично). Подробности — `packages/core/CHANGELOG.md`
0.1.25 и пометки в [`audit-findings.md`](audit-findings.md). Осталось по
волне 1: второй уровень A05 (отзыв при смене роли), дальнейшие тесты
реального HTTP. Не проверено вживую: `server.smoke.test.js` (нужен ваш
`npm test`).
