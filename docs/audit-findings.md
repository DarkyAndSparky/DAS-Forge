# Аудит ядра перед Stage F — находки, требующие доработки

Версия ядра на момент аудита: **0.1.23**. Аудит проведён по коду, без
запуска сервера (в песочнице нет сети: argon2/sharp/zod недоступны).

## Как читать этот файл

- **Стадии** — разные фокусы: A безопасность и auth, B данные и
  надёжность, C runtime и операции, D контракты/тесты/репозиторий/готовность
  к портированию. Каждая стадия прогонялась независимо, затем дубли
  объединены (в находке указано «см. также»).
- **Статус проверки**: `✔ проверено` — я лично перечитал указанный код
  после отчёта аудитора; `○ по отчёту` — найдено при аудите чтением кода,
  но не перепроверено вторым проходом. Ни одна находка не подтверждена
  запуском. Находки про поведение Node/SQLite/браузера (отмечены «не
  проверено запуском») — гипотезы, пока их не воспроизвели.
- **Серьёзность**: critical / high / medium / low / info.
- Статусы работ: см. раздел «Статус исправлений на 0.1.70» ниже сводной
  таблицы; тексты находок в стадиях сохранены как были при аудите (0.1.23).
- Пути относительно корня репозитория; `core/` = `packages/core/src/`,
  `ws/` = `examples/workshop/src/`.

## Вывод одной строкой

Портировать рано. Не потому, что ядро плохое, а потому, что
**обещанное в конфиге и roadmap местами не подключено** (CSRF, rate-limit,
HTTPS, trust proxy, лимиты тела — только поля схемы), **единственный
HTTP-тест — фейковый Express**, а **бэкап/restore небезопасны для живой
WAL-базы**. Из четырёх приложений технически начать можно только
it-assets; остальным не хватает пакетов (`email`, `ldap`, `network`,
`documents`).

## Сводная таблица

| ID | Серьёзность | Заголовок | Стадия | Проверка |
|----|-------------|-----------|--------|----------|
| A01 | high | CSP `script-src 'self'` ломает все inline-скрипты workshop | A/C | ✔ |
| A02 | high | Нет rate-limit/lockout на логин, TOTP, recovery-коды | A/C | ✔ (отсутствие кода) |
| A03 | high | CSRF-защиты нет, хотя `security.csrf` по умолчанию `true` | A/D | ✔ (отсутствие кода) |
| A04 | high | HTTPS не поднимается, `trust proxy` не выставляется, `Secure` зависит от `req.secure` | A/C | ✔ |
| A05 | medium | Сессии не отзываются при смене пароля/блокировке/смене роли | A | ○ |
| A06 | medium | `mustChangePassword` не принуждается сервером | A | ✔ |
| A07 | medium | TOTP-код можно использовать повторно (нет `last_used_step`) | A | ○ |
| A08 | medium | IDOR: `verifyTotpEnrollment` не проверяет владельца | A | ✔ |
| A09 | medium | Энумерация логинов по времени ответа | A | ✔ |
| A10 | medium | TOTP-секреты хранятся открытым текстом | A | ○ |
| A11 | medium | `auth.sessionSecret` обязателен, но не используется | A | ✔ |
| A12 | low | Нет idle-timeout/last_seen, нет отзыва сессий | A | ○ |
| A13 | low | Логин не уничтожает прежнюю сессию | A | ○ |
| A14 | low | `req.user.username` не экранируется в `/ui` | A/C | ✔ |
| A15 | low | Политики паролей нет (только `min(8)`, нет max) | A | ○ |
| A16 | low | Временный пароль админа печатается в stdout | A | ○ |
| A17 | low | `X-Request-Id` берётся от клиента без валидации | A/C | ○ |
| A18 | low | `securityHeaders` неполон (HSTS, `object-src`, `base-uri`, `form-action`…) | A | ○ |
| A19 | info | `serialize()` — allow по умолчанию, нет allowlist-режима | A | ○ |
| B01 | **critical** | Бэкап — `copyFileSync` живой WAL-базы | B | ✔ |
| B02 | high | Сбой одного destination обрывает остальные; retention без верификации | B | ○ |
| B03 | high | Retention по mtime, без нижней границы по числу копий | B | ○ |
| B04 | high | Restore не атомарен, нет автоотката, остаются старые `-wal`/`-shm` | B | ○ |
| B05 | high | Миграции: нет checksum, лока, контроля порядка/дублей, async-`up()` | B | ○ |
| B06 | high | `transaction()`: нет вложенности (savepoints), async-колбэк теряет атомарность | B | ✔ |
| B07 | medium | Нет `busy_timeout`/`synchronous`; многопроцессный доступ не протестирован | B/C | ✔ |
| B08 | medium | FTS: идентификаторы без валидации, пользовательский ввод в `MATCH` ломает запрос, `limit` не нормализуется | B | ○ |
| B09 | medium | FTS: нет rebuild при создании, нет tokenizer-опций (русский язык) | B | ○ |
| B10 | high | `reencodeImage` не подключён к пайплайну загрузки | B | ✔ |
| B11 | medium | SVG: чёрный список, пустой результат сохраняется, нет хелпера заголовков отдачи | B | ○ |
| B12 | medium | `maxBytes` необязателен; zip-guard доверяет заголовкам, нет zip-slip/ZIP64 | B | ○ (закрыто в 0.1.46) |
| B13 | medium | Orphan-файлы при откате БД, старый логотип не удаляется, нет квот | B | ○ |
| B14 | medium | Audit не tamper-evident, схема создаётся на лету, нет retention/редакции PII | B | ○ |
| B15 | low | Scheduler/cron: `*/0` зависает, `setTimeout` > 2³¹, нет catch-up | B/C | ○ |
| B16 | low | Пути backup destinations резолвятся по-разному (job vs CLI) | B | ○ |
| B17 | medium | Нет в core: пагинации, soft delete, upsert, кэша prepared statements, бэкапа `uploads/` | B | ○ |
| C01 | high | Graceful shutdown не закрывает SSE/keep-alive → всегда `forceExit` | C | ○ |
| C02 | medium | `process.exit(0)` в `finally` маскирует сбой; нет `unhandledRejection`/`uncaughtException`; job не ждётся | C | ○ |
| C03 | high | Нет логгера вообще; `errorPageHandler` не логирует ошибку | C | ○ |
| C04 | medium | Error handler: нет `headersSent`, статус не валидируется, всегда HTML | C | ○ |
| C05 | high | Параметры server-конфига объявлены, но не применяются (`host`, `bodyLimit`, timeouts, https, admin) | C | ✔ частично |
| C06 | medium | SSE: нет лимитов, авторизации канала, backpressure | C | ○ |
| C07 | medium | Валидация конфига слабая (`.strict()`, `toBool`, `backup.enabled` не читается) | C | ○ |
| C08 | medium | `/health` публично отдаёт version/uptime; нет readiness при shutdown | C | ○ |
| C09 | medium | CLI-парсер: `-h` не парсится, булевы флаги поглощают positional, нет отказа от неизвестных флагов | C | ○ |
| C10 | high | Windows/Docker (обязательное свойство §4.5a): нет Dockerfile, CI-матрицы, `core/platform` | C/D | ✔ (отсутствие файлов) |
| C11 | high | Обещанные модули/CLI-команды существуют только в roadmap (email, logs, maintenance, secrets…) | C | ○ |
| D01 | high | Ни один тест не поднимает реальный `server.js` по HTTP | D | ○ |
| D02 | high | Не покрыты тестами: `reencodeImage`, `registerGracefulShutdown`, `errorPageHandler`, `backup-ops` | D | ○ |
| D03 | high | Barrel `index.js` тянет все нативные зависимости при любом импорте | D | ○ |
| D04 | high | «Контракты v1» и §3 roadmap не соответствуют коду | D | ○ |
| D05 | medium | Противоречия внутри roadmap/README/index.html (версии, статусы, нумерация) | D | ○ |
| D06 | medium | `package.json` ядра: peer-зависимости, `files`, `types`, `.nvmrc`, license | D | ✔ частично |
| D07 | medium | Старые форматы паролей: формат scrypt atlas/net-monitor подтверждён по коду и покрыт схемой; bcrypt не нужен | D | ✔ 0.1.90 |
| D08 | medium | Блокеры портирования: пакеты `email`, `ldap`, `network`, `documents`, `exports`, `integrations`; 1С заблокирован | D | ○ |
| D09 | medium | `das-forge-core.zip` лежит в корне репозитория, не в `.gitignore` | D | ✔ |
| D10 | medium | Нет lockfile, CI, линтера, LICENSE, `.nvmrc`, `.editorconfig` | D | ✔ |
| D11 | low | Три копии справочника (README / roadmap / index.html) расходятся | D | ○ |

Итого **58 находок**: 1 critical, 19 high, 27 medium, 10 low, 1 info. Детали по
каждой — в разделах ниже.

---

## Статус исправлений на 0.1.70 (актуальный статус — в «Повторный аудит на 0.1.77» ниже)

Таблица ниже — рабочий статус (колонка `✔`/`○` в сводной таблице говорит о
том, перепроверена ли находка при аудите, а не о том, исправлена ли она).
Последний подтверждённый вашим прогоном — **0.1.61** (Windows и Docker:
все тесты зелёные). Версии **0.1.62–0.1.70** вашим `npm test` ещё не
проверены; в среде разработки проверялось только то, что не требует пакетов
(zod, express, argon2, jsdom, sharp, multer, express-session и др. там не
установлены). Замены своего кода пакетами (0.1.41–0.1.69) —
`docs/dependencies-target.md`.

| Статус | Находки |
|---|---|
| **Закрыто** | A01 A02 A03 A04 A05 A06 A07 A08 A09 A10 A11 A12 A13 A14 A15 A16 A17 A18 A19 · B01 B02 B03 B04 B05 B06 B07 B08 B09 B10 B11 B12 B13 B14 · C01 C02 C03 C04 C05 C06 C07 C08 C09 C10 · D01 D03 D09 |
| **Частично** | B15 (закрыто: шаг 0, таймер, воскресенье, stop(), TZ/DST, catch-up, lock; DST-«повтор часа» запускает дважды) · B17 (закрыто: бэкап одним zip с `uploads/`, upsert, addColumnIfMissing, права 0600, soft delete, `updated_at`-триггеры, кэш prepared statements, пагинация/IN/LIKE и операторы в QBE; открыто: шифрование бэкапов, нормализация Date/boolean, `rebuildTable`) · C11 (есть `core/logs` на pino и `core/email` на nodemailer; maintenance, secrets и др. — нет) · D02 (тесты на ops/backup-ops/errorPage/shutdown добавлены; coverage не измерялся) · D06 (subpath exports, peerDependenciesMeta, `.nvmrc`; license — заглушка `UNLICENSED`) · D10 (Dockerfile, CI, `.nvmrc`, `.editorconfig`; нет lockfile, LICENSE, линтера) |
| **Открыто** | D07 · D08 (частично) · D04 · D05 · D11 (см. «Статус на 0.1.100») |

B16 закрыт в 0.1.98 (`scheduler.resolveDestinations`).

**Что изменилось по ключевым находкам после 0.1.48.**
- **A05 / A12 (сессии).** Роль меняется через `setUserRole` с отзывом сессий
  (0.1.51); idle-timeout `auth.sessionIdleTimeoutMs` (по умолчанию 1 час).
  Управление учётными записями (0.1.68) отзывает сессии при переименовании,
  смене роли, отключении и сбросе пароля.
- **A11 (`sessionSecret`).** С 0.1.64 в БД лежит только `h1:`+SHA-256 от id
  сессии; с 0.1.65–0.1.66 сессии ведёт `express-session` (подписанная
  HttpOnly/SameSite=Lax cookie, хранилище SQLite), ключ подписи выводится из
  `sessionSecret` через HKDF, `previousSessionSecrets` только проверяют.
- **A13 / A15.** `/login` уничтожает пришедшую сессию; политика паролей
  `checkPasswordPolicy`, предел 1024 символа для argon2 (0.1.52).
- **A19.** `serialize(..., {strict: true})` — allowlist (0.1.57).
- **B09 / B11 / B13.** FTS с автозаполнением, токенайзером и `ё/е` (0.1.53);
  безопасная отдача файлов и усиленный `sanitizeSvg` (0.1.55); квоты и сборка
  сиротских файлов (0.1.54).
- **C07.** Все объекты схемы конфига строгие (0.1.56, дополнено в 0.1.61).
- **Новое вне аудита.** `core/email` (0.1.59), сброс пароля по почте
  (0.1.60), compression (0.1.58), cors (0.1.50), multer/uuid/pino-pretty
  (0.1.67), HEIC через libheif-js и отчёты `.docx` (0.1.69), управление
  учётными записями в CLI и админ-панели (0.1.68), e2e на Playwright (0.1.70).

Что ещё не сделано и блокирует портирование: D07 (нужны реальные образцы
хэшей паролей четырёх приложений, bcrypt), D08 (блокеры — пакеты `ldap`,
`network`, `documents`, `exports`, `integrations`; пакет `email` теперь есть),
D04/D05/D11 (выравнивание roadmap/README/index.html: README и index.html
синхронизированы в 0.1.70, `docs/roadmap.md` по решению заморожен, поэтому
«Контракты v1» и §3 roadmap по-прежнему расходятся с кодом).

## Стадия A — аутентификация и безопасность

### A01 · high · CSP `script-src 'self'` ломает все страницы workshop с inline-скриптами

> **Статус: исправлено в 0.1.25.**
- **Доказательство** ✔: `core/http/bootstrap.js:24-37` (`script-src 'self'`, без nonce);
  `ws/server.js:46` подключает `securityHeaders()` глобально;
  `ws/pages.js:78,149,191,370,418` — inline `<script>` на login/account/system/realtime.
- **Почему важно**: в браузере с CSP эти страницы не работают, включая
  логин и TOTP. Реальные приложения будут ослаблять CSP до `unsafe-inline`
  и потеряют обещание §4.5h п.5. Тесты это не ловят (см. D01).
- **Исправление**: вынести скрипты в `assets/*.js` под `'self'` либо
  nonce на запрос (`res.locals.cspNonce` + `pageShell`). Добавить e2e-тест
  на заголовок и отсутствие inline-скриптов.

### A02 · high · Нет защиты от перебора (rate-limit, lockout)

> **Статус: исправлено в 0.1.25.**
- **Доказательство** ✔: `rateLimit` встречается только в `core/config/schema.js`;
  `/login*` в `ws/routes.js:157,226,250` без ограничений;
  `app user unlock` не реализован (`core/cli/commands/user-admin.js:95-97`);
  `docs/roadmap.md:3516` прямо пишет, что `express-rate-limit` не используется. ○ по
  отчёту: pending-MFA сессия не сжигается после неверного кода
  (`ws/routes.js:233-236`); окно TOTP ±1 (`core/auth/totp.js:75-88`).
- **Почему важно**: пароль и 6-значный TOTP перебираются без лимита;
  recovery-код — 40 бит, тоже без лимита.
- **Исправление**: rate-limit по IP и по логину; счётчик неудач +
  экспоненциальная пауза в `core/auth`; сжигать pending-сессию после 3–5
  неверных кодов; реализовать `user unlock`.

### A03 · high · CSRF-защиты нет, хотя `security.csrf` по умолчанию `true`

> **Статус: исправлено в 0.1.25.**
- **Доказательство** ✔: `core/config/schema.js:85` (`csrf: true`); других
  упоминаний CSRF в `core/` и `ws/` нет, кроме тестов и CLI. Защита —
  только `SameSite=Lax` (`core/http/session-middleware.js:35`). ○ `POST
  /assets/:id/logo` принимает любой Content-Type через `express.raw({type:()=>true})`
  (`ws/routes.js:698`).
- **Почему важно**: Lax не закрывает same-site атаки (поддомены); конфиг
  создаёт ложное чувство защищённости.
- **Исправление**: CSRF-токен в сессии + проверка Origin/Sec-Fetch-Site на
  всех не-GET; для `/logo` требовать конкретный Content-Type. Либо убрать поле из
  схемы до реализации.

### A04 · high · HTTPS не реализован, `trust proxy` не выставляется

> **Статус: исправлено в 0.1.25.**
- **Доказательство** ✔: `ws/server.js:66` — голый `app.listen(port)` без `host`;
  `trust proxy` нигде не вызывается; cookie ставится с `secure: req.secure`
  (`ws/routes.js:207,217,244,265`); `config/schema.js:32` (`trustProxy`) читается
  и не применяется.
- **Почему важно**: за reverse-proxy `req.secure === false` → cookie без
  `Secure`; ломаются `req.ip`, аудит и будущий rate-limit; нарушено
  «никакого голого HTTP» (§4.5f); HSTS нет.
- **Исправление**: `core/http.createServer(app, config)` — учитывает host,
  https-режим (certs), `trust proxy`, timeouts; `Secure` принудительно в
  production; редирект на HTTPS + HSTS.

### A05 · medium · Сессии не отзываются при смене пароля, disable, смене роли

> **Статус: частично исправлено (пароль/disable; смена роли — позже) в 0.1.25.**
- **Доказательство** ○: `ws/routes.js:293-311` не уничтожает сессии;
  `sessionMiddleware` берёт `req.user` из снимка `session.data.user` и не
  перечитывает `users.disabled`/роль; нет `destroyUserSessions`
  (`core/auth/sessions.js`); `anonymizeUser` сессии не гасит.
- **Исправление**: `destroyUserSessions(userId, exceptId)` при смене пароля/
  disable/erase/роли; проверка актуального пользователя в middleware.

### A06 · medium · `mustChangePassword` не принуждается

> **Статус: исправлено в 0.1.25.**
- **Доказательство** ✔: флаг только возвращается в JSON (`ws/routes.js:209,246,267`);
  блокирующего middleware нет; `core/auth/bootstrap.js:22` обещает «nothing
  else works until it's changed».
- **Исправление**: флаг в сессию, проверка в `requireAuth`, разрешены только
  `/password/change`, `/logout`, `/me`.

### A07 · medium · TOTP-код переиспользуется
- **Доказательство** ○: `core/auth/totp.js:75-88`, `authenticators.js:104-121` не хранят
  последний принятый шаг. RFC 6238 §5.2.
- **Исправление**: `last_used_step` в `totp_credentials`, атомарный UPDATE.

### A08 · medium · IDOR при подтверждении TOTP-enrollment

> **Статус: исправлено в 0.1.25.**
- **Доказательство** ✔: `ws/routes.js:344` передаёт только `authenticatorId`;
  `core/auth/authenticators.js:78-96` ищет по `a.id` и `status='pending'`, без
  `user_id` (в `removeAuthenticator` проверка владельца есть).
- **Исправление**: параметр `userId` и условие `AND a.user_id = ?`.

### A09 · medium · Энумерация логинов по времени

> **Статус: исправлено в 0.1.25.**
- **Доказательство** ✔: `ws/routes.js:158-165` — для неизвестного логина ответ без
  вызова argon2; для известного — `verifyPassword` (десятки мс).
- **Исправление**: `verifyPassword` против заранее посчитанного dummy-хэша.

### A10 · medium · TOTP-секреты в БД открытым текстом
- **Доказательство** ○: `core/auth/authenticators.js:67`; устаревшее поле
  `users.totp_secret` (`core/auth/users.js:12,69-76`).
- **Почему важно**: утечка файла БД/бэкапа = все TOTP-секреты.
- **Исправление**: AES-GCM ключом из отдельного секрета; удалить `users.totp_secret`.

### A11 · medium · `auth.sessionSecret` обязателен, но ничего не защищает
- **Доказательство** ✔: использован только в схеме, env и doctor-проверке
  (`health/checks/security.js`); `cookie-parser` без секрета (`ws/server.js:43`).
- **Исправление**: использовать (шифрование TOTP, HMAC) либо убрать из обязательных.

### A12–A18 · low

> **Статус: A14, A17, A18 исправлены в 0.1.25.**
- **A12** ○ нет `last_seen_at`/idle-timeout/списка и отзыва сессий (`core/auth/sessions.js:26-57`); только ленивая чистка.
- **A13** ○ `issueFullSession` (`ws/routes.js:102-109`) не уничтожает прежнюю сессию; `regenerateSession` не вызывается.
- **A14** ✔ `ws/routes.js:595` — `${req.user.username}` без `escapeHtml`; `renderAppShell` принимает сырой `bodyHtml` (контракт стоит зафиксировать в документации).
- **A15** ○ пароль: только `min(8)` (`ws/routes.js:22`); нет max (мегабайтный пароль в argon2), нет проверки «новый ≠ старый»; `auth.passwordPolicy` из §4.5h не реализован.
- **A16** ○ `ws/context.js:42-45` печатает временный пароль админа в stdout (логи контейнера); `bodyLimit`/`requestTimeoutMs` не применяются (см. C05).
- **A17** ○ `core/http/bootstrap.js:11` принимает `X-Request-Id` без проверки длины/символов; `requestId` стоит после `express.json()` (`ws/server.js:44-45`), ошибки парсинга тела остаются без id. Исправление: `^[A-Za-z0-9._-]{8,64}$`, иначе генерировать; поставить первым.
- **A18** ○ `securityHeaders`: нет HSTS, `object-src 'none'`, `base-uri`, `form-action 'self'`, `Cross-Origin-*`, `Permissions-Policy`; `helmet` из §4.5h не используется.

### A19 · info · `serialize()`: allow по умолчанию
- ○ `core/http/serialize.js:25-39`: поле без записи в `fieldPermissions` отдаётся всем; `/admin/users` читает `db.all(SELECT …)` в обход serialize (`ws/routes.js:467`, колонки безопасные). Предложение: allowlist-режим для новых сущностей и тест покрытия карты.

### Стадия A — проверено и в порядке
Идентификатор сессии 256 бит; HttpOnly/SameSite=Lax; pending-MFA сессия
5 минут и одноразовая; argon2id по OWASP (19456/2/1); `timingSafeEqual` в
legacy-схемах и TOTP; recovery-коды хэшируются и одноразовые; запросы
параметризованы; mass-assignment закрыт Zod-схемами, `cost` вынесен на
отдельный роут с `read:finance`; `/system/backup/verify` сверяет путь со списком
известных; загрузки: magic bytes, серверное имя файла, SVG через DOMPurify;
open redirect не найден; приватный ключ cert — `0o600`.

---

## Стадия B — данные и надёжность

### B01 · CRITICAL · Бэкап — `copyFileSync` живой WAL-базы
- **Доказательство** ✔: `core/scheduler/backup-job.js:25` (`copyFileSync(dbFilePath, backupPath)`),
  `:67` (`PRAGMA wal_checkpoint(FULL)`, результат не проверяется).
- **Почему важно**: копия большого файла не атомарна; между checkpoint и
  копированием возможна запись; бэкап может оказаться «рваным», и это
  выяснится только при restore. Особенно важно для многопроцессного
  сценария (CLI + сервер). Не проверено запуском.
- **Исправление**: `VACUUM INTO 'tmp'` или `sqlite backup API` → запись во
  временный файл → `rename` → `integrity_check` готового файла; проверять
  результат checkpoint.

### B02 · high · Сбой одного destination обрывает остальные, retention без верификации
- ○ `backup-job.js:72-83` цикл без try/catch; `:75` бросает для не-`local`;
  `:81` retention сразу после записи. Нет `primary`, `--destination`, типов
  `network-share`/`directory` (§4.5b выполнен частично).
- **Исправление**: изоляция destination (`{ok, error}`), агрегированная ошибка в конце,
  retention только после успешной верификации новой копии.

### B03 · high · Retention по mtime без нижней границы
- ○ `backup-job.js:30,40,43`. Если job не работал месяц, следующий запуск
  удалит все старые копии, оставив одну; `retentionDays ≤ 0` не валидируется;
  ошибка `statSync`/`unlinkSync` роняет весь retention.
- **Исправление**: возраст из timestamp в имени; всегда хранить ≥ K последних; try/catch на файл; `retentionDays ≥ 1`.

### B04 · high · Restore не атомарен
- ○ `core/scheduler/backup-ops.js:127,137,143-164`: копирование поверх живого файла,
  при сбое integrity/health — без автоотката; старые `-wal`/`-shm` рядом с
  подменённым файлом (откроется «чужой» WAL — повреждение или откат
  данных); safety-copy живой WAL-базы без checkpoint; шага «stop writes» (§4.3)
  нет — защиты от запущенного сервера нет (см. также `ws/bin/app.js:103`: CLI закрывает `activeDb`, но живой сервер не останавливается и не блокируется).
- **Исправление**: удалять `-wal`/`-shm`; копировать во временный файл → `rename`;
  автооткат pre-restore копии; lock-файл/PID-проверка; safety-copy через `VACUUM INTO`.

### B05 · high · Миграции небезопасны
- ○ `core/cli/migrator.js:23-31,55-76`: нет checksum (правка применённой
  миграции незаметна); нет защиты от конкурентного запуска (сервер на старте + CLI
  `migrate`; applied читается вне транзакции); дубли версий и «дыры в порядке» не
  отвергаются; `down` не поддерживается; async-`up()` не детектируется
  (COMMIT до завершения работы); перед миграцией нет автобэкапа.
- **Исправление**: sha256-checksum, `BEGIN IMMEDIATE`, перечитывание applied внутри
  транзакции, отказ на дублях/дырах, проверка thenable, автобэкап.

### B06 · high · `transaction()` без вложенности и без защиты от async
- **Доказательство** ✔: `core/database/sqlite-adapter.js:81-91` — `BEGIN`/`COMMIT`/`ROLLBACK`
  без счётчика глубины; `fn(adapter)` получает тот же адаптер, комментарий
  утверждает, что вызовы «вкладываются естественно», но вложенный `BEGIN`
  упадёт; async-`fn` вернёт Promise, `COMMIT` пройдёт сразу; сбой `ROLLBACK`
  в `catch` маскирует исходную ошибку; `BEGIN` по умолчанию DEFERRED.
- **Исправление**: SAVEPOINT по глубине; проверка `result?.then`; опция
  `{ mode: 'immediate' }`; try/catch вокруг `ROLLBACK`.

### B07 · medium · Нет `busy_timeout`, `synchronous`; многопроцессный доступ не протестирован
- **Доказательство** ✔: `sqlite-adapter.js:50-55` — только `journal_mode=WAL` (и
  вызов `PRAGMA journal_mode` на read-only соединении обходится флагом
  `walMode:false`) и `foreign_keys=ON`. В roadmap §3 пункт о многопроцессности
  не закрыт (`[ ]`).
- **Почему важно**: CLI параллельно серверу получит `SQLITE_BUSY` сразу; на Windows
  блокировки файлов строже.
- **Исправление**: `busy_timeout=5000`, `synchronous=NORMAL`, `wal_autocheckpoint`;
  интеграционный тест с двумя процессами.

### B08–B09 · medium · FTS
- **B08** ○ `core/database/fts.js:12-22`: `table`/`columns`/`rowidColumn` без
  `assertSafeIdentifier` (он есть только в QBE); пользовательский ввод в `MATCH ?`
  без экранирования (`C++`, `foo-bar` → `fts5: syntax error` → 500);
  `limit: 'abc'` → `LIMIT NaN`, отрицательный = без лимита
  (`fts.js:56`, `query-by-example.js:43`). Исправление: общий
  `assertSafeIdentifier`, `ftsEscape(userInput)`, нормализация `limit` в `[1, MAX]`.
- **B09** ○ нет `rebuild` для уже существующих данных; триггер UPDATE срабатывает на
  любое обновление; стандартный `unicode61` без опций токенизатора (русский язык).

### B10 · high · `reencodeImage` не подключён к пайплайну загрузки
- **Доказательство** ✔: `core/files/index.js:7` экспортирует `reencodeImage`, но ни
  `validate-upload.js`, ни `ws/routes.js:703-704` его не вызывают; в `files/` и
  `ws/` других вызовов нет.
- **Почему важно**: PNG/JPEG-полиглоты (HTML/ZIP в хвосте) сохраняются как есть;
  EXIF/GPS не вычищаются (PII); `sharp(buffer)` без `limitInputPixels`
  уязвим к decompression bomb.
- **Исправление**: единый вход `files.acceptUpload()` (detect → validate → re-encode →
  store); `limitInputPixels`; `.rotate()`.

### B11–B13 · medium · Загрузки
- **B11** ○ SVG: DOMPurify по профилю — чёрный список; `<use href>` на внешние ресурсы,
  `<style>@import>` не проверены; пустой результат санитайзинга всё равно сохраняется;
  SVG с BOM/комментарием в начале отвергается; в core нет хелпера заголовков отдачи
  (`Content-Type` из детекта, `nosniff`, `CSP: sandbox`, `Content-Disposition`);
  маршрута раздачи в workshop нет — stored XSS сейчас недостижим, но будет в реальных
  приложениях.
- **B12** ○ **(закрыто: `maxBytes` обязателен в `acceptUpload` с 0.1.26; 0.1.46 — `verifyZipData` распаковывает потоком и проверяет реальный размер, CRC и имена; `checkZipSafety` отвергает усечённый каталог и zip-slip; `parseZipArchive` читает ZIP64.)** `maxBytes` необязателен (`validate-upload.js:25`); zip-guard доверяет размерам из
  central directory (`zip-reader.js:165-198`); усечённый central dir молча проходит;
  ZIP64 не поддерживается; имена `../` (zip-slip) не проверяются; `odt` → mime
  `application/zip`; сигнатура BMP из двух байт — ложные срабатывания.
- **B13** ○ файл пишется до DB-операции (`ws/routes.js:704-705`, `ws/records.js:57-59`) —
  сиротский файл при откате; старый логотип не удаляется; `writeFileSync` без atomic
  `rename`/`mode`; нет квот и GC; `POST /assets/:id/logo` только под `requireAuth()`
  без `requirePermission` — любой вошедший меняет логотип любого актива.

### B14 · medium · Audit не tamper-evident
- ○ `core/audit/schema.js:45-63` — обычная таблица без триггеров `BEFORE UPDATE/DELETE`
  и хеш-цепочки; схема создаётся на лету (`ensureAuditTable` в каждом `log()` —
  `audit/log.js:39`), обходя систему миграций; `purgeOlderThan` не пишет собственную
  запись и нигде не вызывается по расписанию — таблица растёт бесконечно; формат
  `created_at` смешивается (ISO vs `datetime('now')`) — ломает `since/until`; битый JSON
  в `meta` роняет весь `query()`; `meta/ip/actor` без редакции ключей
  (`password`, `token`) — вопрос для §4.5k; `limit/offset` без верхней границы в модуле
  (200 стоит только в маршрутах); нет индекса `(action, created_at)`.
- **Исправление**: триггеры `RAISE(ABORT)` + `prev_hash/hash`; схема в миграцию core;
  `redactKeys`; keyset-пагинация; `audit.retention` в конфиг + cron-задача.

### B15–B17
- **B15** ○ `core/scheduler/cron-parse.js:51` шаг `0` → бесконечный цикл на старте; `scheduler.js:29-31`
  `setTimeout` > 2³¹ мс срабатывает немедленно (например `0 0 29 2 *`); день недели `7`
  отвергается; нет TZ-опции/DST; пропущенные запуски не нагоняются (бэкап в 03:00 при
  выключенном сервере просто не происходит); `stop()` не ждёт выполняющийся job; нет
  lock-файла между server-job и CLI.
- **B16** ○ `ws/context.js:57-62` передаёт `appConfig.backup.destinations` без `path.resolve`;
  `ws/bin/app.js:34` резолвит для doctor, а `listBackups` (`bin/app.js:100`) получает
  сырой конфиг — при запуске из другого каталога пути расходятся.
- **B17** ○ чего реальным приложениям не хватает: пагинация (offset/keyset, `count`), QBE без
  `limit/offset/IN/LIKE/OR`, soft delete, upsert/`RETURNING`, хелперы миграций
  (`addColumnIfMissing`, `rebuildTable`), кэш prepared statements, `updated_at`-триггеры,
  **бэкап каталога `uploads/`** (восстановленная БД будет ссылаться на отсутствующие файлы),
  шифрование бэкапов (в них хэши паролей и PII), права `0600` на БД/бэкапы, нормализация
  `Date`/`boolean`, собственные миграции у модулей registry.

### Стадия B — проверено и в порядке
QBE: идентификаторы по regexp, значения параметризованы; audit: запросы
параметризованы, индексы по времени/актору/сущности есть; базовый откат
транзакции при исключении; `foreign_keys=ON`; серверное имя загружаемого файла
(UUID), расширение из детекта, проверка нахождения пути внутри каталога; тип по
содержимому; restore проверяет integrity до замены и делает safety-copy;
каждая миграция в своей транзакции вместе с записью в `schema_migrations`;
изоляция ошибок и overlap-skip в scheduler; HTTP-`verify` бэкапа сверяет путь
со списком.

---

## Стадия C — runtime и операции

### C01 · high · Graceful shutdown не закрывает SSE и keep-alive
- ○ `core/http/bootstrap.js:44-84`: `server.close(cb)` без `closeIdleConnections()`/
  `closeAllConnections()` и без реестра SSE-ответов; `sse-transport.js:119-125` чистит
  ресурсы только на `close`. Гипотеза (не проверено запуском): открытый
  `/events/assets` не даёт `server.close` вернуться → срабатывает `forceExit` →
  `exit(1)` — каждый деплой/`docker stop` проходит как аварийный (§4.5g п.7 обещает
  обратное).
- **Исправление**: `Set` активных SSE-ответов; при shutdown — `event: shutdown` и
  `res.end()`; затем `closeIdleConnections()`, по таймауту `closeAllConnections()`;
  штатный drain → код 0.

### C02 · medium · Shutdown: `exit(0)` в `finally`, нет обработчиков фатальных ошибок

> **Статус: частично исправлено в 0.1.25.**
- ○ `bootstrap.js:29-36`; нет `uncaughtException`/`unhandledRejection`; в
  `ws/server.js:78-84` порядок `jobScheduler.stop()` → `db.close()` не ждёт выполняющийся
  backup; на Windows `SIGTERM` не доставляется, `core/platform/` отсутствует.
- **Исправление**: `catch` → лог + `exit(1)`; `scheduler.stop({wait:true})`; подписка на
  фатальные события.

### C03 · high · Нет логгера вообще
- ○ в `core/` нет модуля логирования (список директорий: audit, auth, branding, certs, cli,
  config, database, files, health, http, modules, privacy, qr, realtime, scheduler, ui);
  `errorPageHandler` (`http/error-pages.js:117-132`) ошибку не логирует — 500 видит
  только клиент, а `req.id` нигде не пишется; разбросанные `console.*`
  (`event-bus.js:46`, `scheduler.js:34,47`, `server.js:33,68`); нет access-лога, уровней,
  JSON, редакции секретов.
- **Исправление**: `core/logs` — JSON, уровни, redaction (`authorization`, `cookie`,
  `password`, `sessionSecret`), child-logger с `req.id`, access-log middleware.

### C04 · medium · Error handler
- ○ `error-pages.js:120,126-128`: статус `err.statusCode ?? 500` без валидации диапазона;
  нет `res.headersSent` → `ERR_HTTP_HEADERS_SENT` после начала SSE/стрима; всегда HTML
  (API-клиенты получают страницу); `err.message` отдаётся для любого не-500.
- **Исправление**: `if (res.headersSent) return next(err)`; статус 400–599; JSON по
  `Accept`/пути; сообщение только при `expose: true`.

### C05 · high · Параметры server-конфига объявлены, но не применяются

> **Статус: исправлено в 0.1.25.**
- **Доказательство** ✔ частично: `config/schema.js:29-49` объявляет `host`, `bodyLimit`,
  `requestTimeoutMs`, `https.mode`, `admin.*`, `security.*`; `ws/server.js:44`
  `express.json()` без `limit` (дефолт 100 KB, а не `bodyLimit`); `ws/server.js:66`
  `app.listen(port)` без `host` — слушает все интерфейсы при дефолте схемы
  `127.0.0.1`. ○ `requestTimeout/headersTimeout/keepAliveTimeout` не заданы.
- **Почему важно**: админ ставит `host: 127.0.0.1` и получает открытый порт.
- **Исправление**: одна фабрика сервера в core (см. A04), покрыть тестом.

### C06–C09 · medium
- **C06** ○ SSE: `sse-transport.js:89-126` нет лимита подписчиков и авторизации канала
  (`resolveChannel` синхронный, права проверяет только роут); `res.write()` backpressure
  игнорируется; исключение в `initialEvent` после `writeHead` оставляет ответ висеть;
  нет `id:`/`Last-Event-ID`. Исправление: `authorize(req, channel)`, лимиты на пользователя
  и общий, закрытие медленных клиентов.
- **C07** ○ конфиг: схема не `.strict()` (опечатки молча игнорируются); `toBool`
  считает любую строку кроме `true`/`1` за `false` (`DAS_TRUST_PROXY=yes` → false);
  `backup.enabled` не читается (`ws/server.js:75` регистрирует job всегда); типы
  `s3/sftp/webdav` разрешены схемой без реализации; проверка плейсхолдера секрета —
  только в doctor, не на старте; нет `*_FILE` для Docker secrets.
- **C08** ○ `/health` публично отдаёт `version`/`uptime` (fingerprinting); нет
  readiness-режима — при shutdown отвечает 200 до выхода процесса; doctor в контейнере
  проверяет порт (ложное warn при работающем сервере), `inContainer()` из §4.5a нет.
- **C09** ○ `core/cli/arg-parser.js:30-37`: `--foo bar` поглощает следующий токен
  (`backup restore --yes file.db` → `file` теряется); `-h` не парсится (проверяется
  `flags.h`); нет `--`; неизвестные флаги молча игнорируются; единого соглашения о
  кодах выхода (§4.2) нет (1/2/3 по-разному); `ws/bin/app.js:159` `main()` без `.catch`.

### C10 · high · Windows/Docker — обязательное свойство §4.5a не выполнено
- **Доказательство** ✔ по `ls`: нет `Dockerfile`, `docker-compose.yml`, `.dockerignore`,
  `.gitattributes`, `.github/`; `templates/` и `apps/` — только README; `core/platform/`
  отсутствует; единственное `process.platform` — вывод в `health/checks/runtime.js:26`.
  Предупреждение: `argon2` и `sharp` — нативные (prebuilt на Alpine/Windows не проверялись).
- **Исправление**: multi-stage Dockerfile (non-root, `HEALTHCHECK`, `STOPSIGNAL SIGTERM`,
  tini), compose с volume для `data/uploads/backups`, `.gitattributes` (`eol=lf`), CI-матрица
  ubuntu + windows.

### C11 · high · Обещано в roadmap, но кода нет
Существует: config, database (SQLite), branding, auth, audit, health/doctor, modules,
privacy (export/erase), certs, ui (минимальный), http (requestId, CSP, error pages,
shutdown), realtime (SSE), files, scheduler (cron+backup), cli, qr.

Только проза: `@das-forge/email` (§4.5e, нужен всем четырём приложениям);
`logs` и `app logs` (§4.5g п.1); maintenance mode; secrets (`app secrets rotate/list`);
integrations; `deps`; perf-тесты (бюджеты объявлены в схеме и не читаются); service install и
`start/stop/restart/status`; Dockerfile/`install`/`update`/`dev`; `app cron {list,history,run}`;
`security bans/incident`, `user reset-password/unlock`, `db rollback/seed`,
`backup destinations/create`; метрики; rate-limit, CSRF, CORS, admin-listener и mTLS
(§4.5i); cookie-уведомление и реестр обработки (§4.5k — в `privacy/` только
`export.js`/`erase.js`); админ-панель «парная к CLI» как свойство ядра.
(`realtime/transports` пуст сознательно, §9.)

---

## Стадия D — контракты, тесты, репозиторий, готовность к портированию

### D01 · high · Ни один тест не поднимает реальный `server.js` по HTTP

> **Статус: частично исправлено (smoke-тест написан, не запускался) в 0.1.25.**
- ○ по `grep`: `listen|supertest|fetch(` в тестах есть только в `health.test.js:190`
  (`net.createServer` для проверки занятости порта). `examples/workshop/test/routes.test.js`
  (931 строка) работает на фейковом `createFakeApp()` с самописным `dispatch()` и SHA-256
  вместо argon2.
- **Не ловится**: реальный порядок middleware и Express 5 routing; `cookie-parser`;
  `Set-Cookie`; лимит и ошибки `express.json()`; порядок `notFoundHandler`/
  `errorPageHandler` и async-ошибки; SSE flush/close; shutdown; migrate-on-boot; реальные
  заголовки (A01), `Secure` (A04).
- **Подтверждение**: два бага харнесса (0.1.21, 0.1.22) найдены только реальным
  прогоном — фейк уже один раз разошёлся с Express дважды.
- **Исправление**: вынести `createServer()` из `main()`, smoke-тест на порту 0 через
  `fetch` (login → cookie → защищённый роут → 404 → 500 → `/health` → SSE → закрытие).

### D02 · high · Белые пятна в покрытии
- ○ `reencodeImage` (B10) не встречается в тестах; `registerGracefulShutdown` — 0
  вхождений в `http.test.js`; `errorPageHandler` не импортируется, тестируется только
  `notFoundHandler`; `scheduler/backup-ops.js` (`listBackups`, `verifyBackupFile`,
  `restoreBackup`) без прямого теста. Единственный `it.skip` — `certs.test.js:49`
  (win32), нормальный.

### D03 · high · Barrel `index.js` тянет все нативные зависимости
- ○ `core/index.js` реэкспортирует 16 модулей; статические импорты: `argon2`
  (`auth/password.js:1`), `sharp` (`files/image-pipeline.js:1`), `jsdom`/`dompurify`
  (`files/svg-sanitize.js:1-2`), `qrcode` (`qr/index.js:24`), `selfsigned`
  (`certs/generate.js:1`). `exports` — только `.` и `./config`.
- **Почему важно**: `import { database } from '@das-forge/core'` падает, если не собрался
  `sharp`; в песочнице это же блокирует любой прогон; roadmap §6 требовал, чтобы `sharp`
  не попадал в core.
- **Исправление**: subpath exports на каждый модуль (`./auth`, `./files`, `./database`…);
  тяжёлые зависимости — динамический `import()`/optional peer; рассмотреть вынос
  `files` и `qr` в отдельные пакеты.

### D04 · high · «Контракты v1» (§7.5) и состав §3 не совпадают с кодом
- ○ по `grep` в `src/` нет: `assertSessionStore`, `createApp()`, `defineRoute`,
  `generateOpenApiSpec`, модулей `errors/`, `logging/`, `validation/`, `security/`,
  `platform/`, `backup/`, `maintenance/`, `version/`; в зависимостях нет `helmet`, `cors`,
  `pino`, `otplib` (TOTP — собственная реализация); `assertDatabaseAdapter` лежит в
  `database/adapter.js`, а не `contract.js`; `assertAuthProvider` — в `auth/adapter.js`.
- **Исправление**: либо реализовать, либо пометить §3/§7.5 как плановые/исторические.

### D05 · medium · Противоречия внутри документов
- ○ дерево §0.1 пишет `0.1.19`; шкала §0.4 обрывается на 0.1.10; §0.2 без `selfsigned` и
  `qrcode`, хотя они в `package.json`; §11 одновременно «Stage A–E ✅» и «B–E ⏳ не начато»;
  §10 с заголовками «🔜 следующее/⏳ не начато» для давно готового; нумерация разделов
  перемешана (§4.5 после §4.5f, §6.5a после §6.6); ссылки на «§22» указывают на
  несуществующий раздел (нумерация заканчивается на §18); версии корневого и
  workshop `package.json` — 0.1.0.

### D06 · medium · `package.json` ядра
- ✔ частично: `express` и `cookie-parser` — peer-зависимости, но `core/` их не
  импортирует (читает `req.cookies`, зовёт `res.cookie`) — нужен `peerDependenciesMeta`
  или документация; нет `files`, `main`, `types`, `sideEffects`, `repository`, `license`;
  `.nvmrc` нет (`engines.node >=26`, а в README сказано, что в песочнице гонялось на
  Node 22). Версии `zod`, `vitest`, `jsdom`, `sharp`, `argon2` сверялись пользователем
  вручную — из песочницы не проверить.

### D07 · medium · Старые форматы паролей
- ○ есть шаблоны `pbkdf2Scheme`/`scryptScheme` (`auth/password.js:39,63`) с тестом
  (`auth.test.js:47-50`); нет `bcrypt` (it-assets — «argon2/bcrypt-микс»); реальные
  форматы четырёх приложений (соль, итерации, кодировка) не документированы
  (пункт roadmap не закрыт); `verifyPassword` молча глотает ошибки парсера
  (`password.js:~106`) — сбой выглядит как неверный пароль и не логируется.
- **Исправление**: получить реальные образцы хэшей из четырёх БД, написать на них
  тесты; добавить bcrypt (optional peer); логировать сбои парсера.

### D08 · medium · Блокеры портирования
- ○ порядок по §7: it-assets → procure-it → net-monitor → atlas-ao. Не существуют
  пакеты, нужные приложениям: `email` (всем четырём), `ldap` (it-assets, net-monitor),
  `network` (net-monitor), `documents` (procure-it), `exports`, `integrations`, `images`.
  Bitrix24: способ решён (входящий вебхук), адаптера нет. 1С — «BLOCKED», протокол обмена не
  определён (внешний блокер). RBAC сверх базовой матрицы, расширенный i18n, §4.5k целиком
  — не реализованы. Postgres для atlas-ao/net-monitor отложен (§17.1). Логотипы четырёх
  приложений не присланы.
- **Вывод**: стартовать можно только it-assets, и только после A02–A04, B01/B04, D01.

### D09–D11 · гигиена
- **D09** ✔ `das-forge-core.zip` лежит в корне репозитория (≈413 КБ, 188 файлов),
  не в `.gitignore`; дублирует исходники и расходится с ними при каждом патче.
  `.gitignore` не покрывает `*.zip`, `coverage/`, `.DS_Store`.
- **D10** ✔ нет `package-lock.json`, `LICENSE*`, `.github/`, `.nvmrc`, `.editorconfig`,
  конфигурации ESLint/Prettier, скриптов `lint/format/coverage`; в коде встречается
  `// eslint-disable-next-line` (`ws/server.js`) при ненастроенном ESLint; нет `.d.ts`/
  `types`/`checkJs`. Без lockfile воспроизводимость сборки нулевая (нативные
  `argon2`, `sharp`, тяжёлый `jsdom`).
- **D11** ○ три копии справочника (README ≈108 КБ, `docs/index.html`, `roadmap.md`)
  ведутся параллельно и расходятся (метки версий справочников в index.html — 0.1.15/0.1.16
  при ядре 0.1.23); `[Unreleased]` в CHANGELOG перечисляет ≈18 CLI-команд без help-текста.

---

## Рекомендуемый порядок доработки

Это предложение, не решение — порядок и состав определяете вы.

**Волна 1 — «ядро не врёт» (блокирует всё остальное)**
1. D01 реальный HTTP smoke-тест + вынос `createServer()` — без него остальные исправления
   нечем проверять (A01, A04, C05, C01).
2. C05/A04 фабрика сервера: host, https, trust proxy, timeouts, bodyLimit.
3. A02/A03 rate-limit + lockout + CSRF — или убрать поля из схемы, пока не реализованы.
4. A01 CSP: nonce/внешние скрипты.

**Волна 2 — данные не теряются**
5. B01/B04/B02/B03 бэкап и restore (VACUUM INTO, atomic rename, автооткат, изоляция
   destination, нижняя граница retention) + бэкап `uploads/` (B17).
6. B06/B07/B05 транзакции (savepoint), pragma, миграции (checksum, lock, автобэкап).
7. B10 единый `acceptUpload()`; B13 связка файла с транзакцией.

**Волна 3 — эксплуатация**
8. C03 `core/logs`; C01/C02 shutdown; C04 error handler; C08 `/health`.
9. A05–A11 сессии, TOTP (replay, IDOR, шифрование), `mustChangePassword`, `sessionSecret`.
10. C10 Dockerfile + CI-матрица + lockfile + LICENSE + `.nvmrc` (D10, D09).

**Волна 4 — границы и документы**
11. D03 subpath exports; D06 `package.json`.
12. D04/D05/D11 привести roadmap/README/index.html в соответствие с кодом; решить судьбу
    `core/email`.
13. D07 собрать реальные образцы хэшей четырёх приложений; D08 решить, какие недостающие
    пакеты нужны ПЕРЕД портированием первого приложения.

## Повторный аудит на 0.1.77 (2026-10-19)

Пересмотр по этапам, по чтению кода (серверы и тесты не запускались). Пометки:
**БЛОКЕР** — исправить до портирования четырёх приложений в прод; **не блокер** — можно
после. Пересмотрены A, B, C, D (статус), E–J; этап H (требования приложений) невозможен
без их исходников.

**Исправлено в 0.1.90:** D07 (scrypt-схема atlas/net-monitor; bcrypt не нужен), этап H разобран, проект админ-раздела `docs/admin-panel.md`; сверка документов.
**Исправлено в 0.1.89:** J01 (lock-файл в репозитории; требует проверки `npm ci` у владельца).
**Исправлено в 0.1.88:** D07 (bcrypt-схема; реальных образцов хешей нет — решено унифицировать через миграцию на argon2id).
**Исправлено в 0.1.87:** I07 (лимит параллельной обработки изображений, 503 при перегрузке).
**Исправлено в 0.1.86:** I05 (индекс по ISO-выражению времени аудита).
**Исправлено в 0.1.85:** I02, K07 (вытеснение блокировок, IPv6-ключ), I04 (`verifyChain` постранично).
**Исправлено в 0.1.84:** G02 — `backup restore` не работает при запущенном сервере (замок с pid, взаимное исключение).
**Исправлено в 0.1.83:** L01 — приёмники бэкапов `mount` и `sftp` (проверка, шифрование обязательно, хеш-сверка, retention по приёмнику).
**Исправлено в 0.1.82:** F03 — псевдонимы в журнале аудита (логин/IP/meta), стирание через `audit.eraseSubjects` и `eraseUserData`; старые строки (до 0.1.82) стереть нельзя.
**Исправлено в 0.1.81:** приёмники логов (stdout/file/syslog/HTTP, буфер, локальный резерв), зеркало аудита и якорь цепочки наружу, `audit verify`/`audit anchor`. F03 — ждёт решения владельца.
**Исправлено в 0.1.80:** синхронизация документов (README, index.html, dependencies-target.md, этот файл).
**Исправлено в 0.1.79:** F02, F05, F09, I06, I01, K02 (F03 — см. проект журнала/логов ниже).
**Исправлено в 0.1.78:** G01, G03, G04, G05, G06, G08, K01, K08, F01, F04, F07, J02, L02, L03.
Остаётся к исправлению по плану: 0.1.80 (готово) — синхронизация
документов; 0.1.81 (готово) — приёмники логов (stdout/file/syslog/HTTP); 0.1.82 — удалённые приёмники
бэкапов (смонтированный путь и SFTP, L01). Замечание: номера строк в таблицах выше
приблизительны (часть взята из отчётов), по файлам и функциям находки перепроверены.

### Этап A (безопасность/вход) — готово

Все A01–A19 перепроверены по коду: закрыты (сессии на express-session + SQLite-хранилище,
CSRF по заголовкам, rate-limit + lockout, TOTP с `last_used_step` и шифрованием AES-GCM,
CSP/HSTS, валидированный `X-Request-Id`, allowlist-`serialize`, политика паролей).
Новые находки (код 0.1.68–0.1.77 и общий пересмотр):

| ID | Серьёзность | Блокер? | Суть | Где | Исправление |
|---|---|---|---|---|---|
| K01 | medium | **БЛОКЕР** | Recovery-код можно использовать дважды при параллельных запросах: между `SELECT` и `UPDATE` стоит `await argon2.verify`, а `UPDATE` не проверяет `used_at IS NULL`. | `auth/recovery-codes.js` (`verifyAndConsumeRecoveryCode`) | `UPDATE … WHERE id=? AND used_at IS NULL`, успех только при `changes===1`. |
| K02 | medium | **БЛОКЕР** | Ключ шифрования TOTP = `auth.sessionSecret`. Ротация секрета (даже с `previousSessionSecrets`) делает все sealed-секреты нечитаемыми: `openSecret` бросает, вход по TOTP падает 500, пользователи заблокированы. | `examples/workshop/src/routes.js:187`, `auth/secret-box.js` | Отдельный `auth.totpEncryptionKey` (+ список предыдущих ключей для перешифровки), версия ключа в формате `enc:v2:<kid>:…`; ошибка расшифровки → управляемый ответ, а не 500. |
| K03 | low | не блокер | Lockout по имени позволяет намеренно блокировать чужую учётку (5 неверных попыток на 30 с–15 мин): DoS на админа. | routes.js (`loginUserFailures`) | Лимит по паре (имя, IP) плюс общий по IP; для админа — алерт, а не молчаливая блокировка. |
| K04 | low | не блокер | Сессия, изменяемая параллельным запросом (`save` в конце ответа), может «воскресить» строку, только что удалённую `destroyUserSessions`. | `auth/session-store.js` `set` | В `set` вставлять только если `user_id` существует и не `disabled`, либо проверять версию учётки. |
| K05 | low | не блокер | `attachUser` доверяет снимку пользователя в сессии; роль/disabled проверяются только через отзыв сессий. Пропущенный вызов отзыва в приложении оставляет права. | `http/session.js` `attachUser` | Опция `revalidate(userId)` с кэшем на 30–60 с (disabled/role из БД). |
| K06 | low | не блокер | Логин-CSRF: запрос без Origin и без cookie проходит (нужен для curl/API). | `http/csrf.js` шаг 5 | Документировать; для `/login` из браузера требовать `Sec-Fetch-Site`. |
| K07 | low | **ИСПРАВЛЕНО 0.1.85** | Исключение блокировки при заполнении: вытеснение самых старых ключей удаляет и заблокированные (см. I02). `loginIpFailures` использует сырой `req.ip` без группировки IPv6. | `http/rate-limit.js:128-135`, routes.js | Вытеснять только разблокированные; `ipKeyGenerator` для ключа. |
| K08 | low | не блокер | `generateRecoveryCodes`: удаление старых и вставка новых не в одной транзакции (хеши считаются с `await`) — сбой оставляет пустой/неполный набор. | `auth/recovery-codes.js` | Считать хеши заранее, вставлять в одной транзакции. |

### Этапы E–J — результаты глубокого аудита (2026-10-19), статус «открыто»

**F — privacy (152-ФЗ/GDPR)**

| ID | Серьёзность | Блокер? | Суть | Где |
|---|---|---|---|---|
| F01 | high | **БЛОКЕР** | `anonymize` обновляет только `users`; секреты TOTP, аутентификаторы, recovery-коды и токены сброса остаются (каскад только при `DELETE`). | `auth/users.js:126-141` |
| F02 | high | **БЛОКЕР** | Retention аудита не подключён (`purgeOlderThan` не вызывается), PII (логин, IP, `meta`) хранится бессрочно. Нет `audit.retentionDays`. | `audit/retention.js`, `workshop/server.js` |
| F03 | high | **ИСПРАВЛЕНО 0.1.82** (старые строки не стираются) | Erase не затрагивает `audit_log`; хеш-цепочка не даёт обезличить задним числом. Нужны `actor_id` + стираемая таблица псевдонимов (crypto-shredding). | `audit/chain.js`, `privacy/erase.js` |
| F04 | medium | не блокер | Неудачные логины пишут в аудит всё введённое в «username» без лимита длины. | `routes.js:272,287` |
| F05 | medium | не блокер | Письма в очереди не отзываются при erase; `payload` содержит адрес и ссылку; нет TTL для `pending`. | `email/queue.js`, `privacy/erase.js` |
| F06 | medium | не блокер | Экспорт по субъекту неполон (нет аудита, сессий, аутентификаторов). | `privacy/export.js` |
| F07 | medium | не блокер | `privacy export --out` пишет с правами 0644 и без защиты от перезаписи. | `cli/commands/privacy.js:46` |
| F08 | medium | не блокер | Erase не переприменяется после `backup restore`. | `privacy/erase.js` |
| F09 | low | не блокер | `purgePasswordResetTokens` нигде не вызывается. | `auth/password-reset.js` |
| F10 | low | не блокер | SSE-канал `lab` отдаёт логины; access-log без срока хранения и усечения IP. | `routes.js:890`, `logs/logger.js` |

**E — UI/i18n/доступность** (все не блокеры): E01 i18n почти не используется (medium); E02 `lang` документа не соответствует содержимому (medium); E03 `label` провайдера поиска вне словаря (low); E04 формы без `<label>`, ошибки без `role="alert"`, `prompt()/alert()` (medium); E05 `logoUrl` не валидируется (low); E06 `vendorIdentity.name` без экранирования в `alt` (low); E07 `dict[key] ?? key` на объекте-прототипе, нет skip-ссылки (low).

**G — CLI**

| ID | Серьёзность | Блокер? | Суть |
|---|---|---|---|
| G01 | high | **БЛОКЕР** | `--yes=false` даёт строку `"false"` = истина; деструктивные команды выполняются (`cli/arg-parser.js:50-52`). |
| G02 | high | **ИСПРАВЛЕНО 0.1.84** | `backup restore` не проверяет, запущен ли сервер; запись в отвязанный inode, удаление живого `-wal`. |
| G03 | medium | не блокер | `audit export` молча режет до 1000 записей. |
| G04 | medium | не блокер | Файлы экспорта пишутся с 0644; `--out` без значения роняет команду. |
| G05 | medium | не блокер | Значения флагов не валидируются по типу (`--days abc` → NaN). |
| G06 | medium | не блокер | `cert generate --force` перезаписывает ключ без копии. |
| G07–G10 | low | не блокер | Нет предупреждения о неизвестных флагах у большинства команд; `catch` печатает только `message`; временный пароль в stdout; нет алиаса `-y`, help неполный. |

**I — нагрузка**

| ID | Серьёзность | Блокер? | Суть |
|---|---|---|---|
| I01 | high | **БЛОКЕР** | Нет общего лимита параллельных argon2 и `UV_THREADPOOL_SIZE`; распределённый перебор вешает сервер. |
| I02 | medium | **ИСПРАВЛЕНО 0.1.85** | Вытеснение ключей в failure-tracker снимает блокировки; IPv6 без группировки. |
| I03 | medium | не блокер | `VACUUM INTO` и `integrity_check` блокируют event loop. |
| I04 | medium | **ИСПРАВЛЕНО 0.1.85** | `verifyChain` грузит весь `audit_log` в память. |
| I05 | medium | **ИСПРАВЛЕНО 0.1.86** (частично: см. CHANGELOG) | Фильтры аудита по датам не используют индекс. |
| I06 | medium | не блокер | `purgeOlderThan` — один `DELETE` без пакетов. |
| I07 | medium | **ИСПРАВЛЕНО 0.1.87** | Нет ограничения параллелизма обработки изображений/HEIC, возможен OOM. |
| I08–I11 | low | не блокер | JSDOM на каждый SVG без лимита размера; квота читает каталог на каждую загрузку; SSE без лимита на пользователя и без перепроверки авторизации; устаревание lock-файла. |

**J — зависимости/цепочка поставок**

| ID | Серьёзность | Блокер? | Суть |
|---|---|---|---|
| J01 | high | **ИСПРАВЛЕНО 0.1.89** (проверить `npm ci`) | Нет `package-lock.json`; `npm ci` в CI падает, Docker собирает разные версии. Сгенерировать у себя и закоммитить. |
| J02 | medium | не блокер | `secrets/` не в `.gitignore`/`.dockerignore`. |
| J03 | medium | не блокер | Образ Node не закреплён digest-ом; установка argon2 зависит от версии npm. |
| J04 | low | не блокер | CI без `permissions:` и без SHA-пинов. |
| J05 | low | перепроверить | Лицензия `libheif-js` (LGPL) — юридическая оценка; `license-checker` у вас. |
| J06 | info | — | `cookie-parser` объявлен как peer, но не импортируется ядром; расхождение версий jsdom в списке. |

### Этапы B и C (данные, runtime) — готово

Перепроверены по коду: B01 (бэкап через `VACUUM INTO` + `integrity_check` + атомарный rename),
B02/B03 (независимые destinations, retention по имени файла с `minKeep`), B04 (откат restore,
чистка `-wal/-shm`), B05 (checksum, дубли, порядок), шифрование бэкапов (`backup-crypto.js`:
AES-256-GCM, заголовок в AAD, расшифровка в 0600-файл с удалением при ошибке — без замечаний),
C01–C10 (`server.js` применяет host/timeouts/https, trust proxy на один хоп, обработчики
`unhandledRejection`, graceful shutdown). B01–B14 и C01–C10 остаются закрытыми. Новые находки:

| ID | Серьёзность | Блокер? | Суть | Где | Исправление |
|---|---|---|---|---|---|
| L01 | high | **ИСПРАВЛЕНО 0.1.83** (mount + sftp; s3/webdav по-прежнему нет) | Реализован только `local`-приёмник бэкапов: `s3`/`sftp`/`webdav` падают с «not implemented». Взлом хоста стирает и базу, и все бэкапы (та же угроза, что с логами). | `scheduler/backup-job.js` | Реализовать удалённый приёмник (минимум SFTP/S3-совместимый или «копия на смонтированный путь» + проверка, что путь на другом устройстве); см. проект приёмников в этапе логов. |
| L02 | medium | не блокер | После `restore` оживают строки `sessions` и `password_resets` из бэкапа: украденные до инцидента сессии снова валидны. | `scheduler/backup-ops.js` (`runRestore`) | После восстановления выполнять `DELETE FROM sessions` и гасить неиспользованные токены сброса. |
| L03 | low | не блокер | Страховочная копия `*.pre-restore-<ts>` — нешифрованная БД (хеши, PII) рядом с боевой, права по umask (0644), никогда не удаляется. | `snapshotFile` | `chmod 0600`, предупреждение в выводе, опция/команда очистки старых копий. |
| L04 | low | **ИСПРАВЛЕНО 0.1.98** (`trustProxy`: false / true / хопы 1–10 / список подсетей; env `DAS_TRUST_PROXY`) | `server.trustProxy` — булево (один хоп). Схема CDN + nginx (два хопа) не настраивается: IP клиента будет неверным, лимитер групп. | `http/server.js:applyServerSettings` | Принимать число хопов или список подсетей. |
| L05 | low | не блокер | Ошибка восстановления `uploads` после успешной БД оставляет рассогласование (БД новая, файлы старые); описано в сообщении, откат БД не делается. | `backup-ops.js` | Документировать; опционально откат БД при сбое uploads. |
| B16 | low | **ИСПРАВЛЕНО 0.1.98** | Пути destinations резолвятся по-разному (job и CLI). Общий `scheduler.resolveDestinations(destinations, baseDir)`. | | Общий резолвер в ядре. |

### Этап D (контракты, тесты, репозиторий) — статус

D01, D03, D09 закрыты; D02, D06, D10 частично; D04, D05, D07, D08, D11 открыты
(подтверждено по таблице статусов 0.1.70, `docs/roadmap.md` заморожен по решению владельца).
Блокеры портирования остаются прежними: **D07** (реальные образцы хешей паролей четырёх
приложений, bcrypt), **D08** (пакеты `ldap`, `network`, `documents`, `exports`,
`integrations`), **J01** (lock-файл). Не блокеры: D04/D05/D11 (расхождение документов),
D06 (лицензия-заглушка), D02 (coverage не измерен).

### Новое требование: отправка логов за пределы машины (проект)

Владелец хочет задавать, куда уходят логи: при взломе хоста локальные логи удаляют.
**Сейчас:** `core/logs` (pino) пишет JSON-строки в stdout/stderr (`logs/logger.js:defaultDestination`)
или в любой переданный `stream`; приёмников, буфера и доставки нет. Хеш-цепочка аудита уже
умеет `anchor(db)` и `verifyChain(db, {anchor})` (`audit/chain.js`), но никто не отправляет
«голову» цепочки наружу.

**Предложение (без новых зависимостей, поверх `pino.multistream` и встроенных `node:net`,
`node:tls`, `node:dgram`, `fetch`):**

```json
"logging": {
  "level": "info",
  "sinks": [
    { "type": "stdout" },
    { "type": "syslog", "host": "logs.example.com", "port": 6514, "protocol": "tls", "ca": "/etc/ca.pem", "streams": ["app","access","audit","security"] },
    { "type": "http", "url": "https://loki.example.com/loki/api/v1/push", "format": "loki", "headers": { "Authorization": "env:LOKI_TOKEN" } },
    { "type": "file", "path": "/mnt/logs-share/das.log" }
  ],
  "buffer": { "maxLines": 10000, "maxAgeSec": 300, "onFull": "drop-oldest" },
  "localFallback": { "path": "data/logs/fallback.ndjson", "maxBytes": 52428800 }
}
```

- **Приёмники:** `stdout` (для Docker log driver — лучший вариант: драйвер сам отправляет
  на удалённый сервер), `syslog` (RFC 5424 по UDP/TCP/TLS), `http` (JSON/NDJSON, Loki/Elastic/
  Splunk HEC/Vector), `file` (на смонтированный сетевой путь).
- **Поведение при сбое:** запись логов никогда не блокирует запрос; ограниченный буфер в
  памяти, повторные попытки с экспоненциальной паузой, при переполнении — отбрасывание старых
  строк со счётчиком `droppedLogLines` в `/health`; локальный резервный файл с лимитом размера
  (0600).
- **Секреты** в конфиге — только ссылками на переменные окружения (`env:NAME`);
  редакция секретов выполняется до отправки (общая для всех приёмников).
- **Маршрутизация по потокам:** `app`, `access`, `audit`, `security` (входы, отказы, смена
  ролей) — у каждого приёмника список `streams`.
- **Аудит:** событие `audit` дублируется в приёмник в момент записи; плюс периодическая
  задача отправляет `anchor(db)` (id + хеш головы цепочки) наружу; CLI-команда
  `audit verify --anchor <из удалённого лога>` проверяет, что хвост не усечён и история не
  переписана.
- **Бэкапы:** та же угроза (L01) — удалённый приёмник бэкапов (SFTP/S3-совместимый или
  копия на отдельный смонтированный диск) выбирается тем же решением владельца.
- **Тесты:** локальный TCP/UDP/HTTP-сервер в тесте, симуляция отказа приёмника (буфер,
  отбрасывание, восстановление), редакция до отправки, форматы RFC 5424 и Loki.
- **Оценка:** 0.1.7x — `sinks` + stdout/file + буфер; следующая версия — syslog/TLS;
  следующая — http (Loki/NDJSON) и отправка anchor.

## Статус на 0.1.100 (2026-10-23)

Сверка с кодом 0.1.91–0.1.99; тексты находок выше не переписывались.

| Находка | Статус |
|---|---|
| F06 экспорт данных субъекта | **закрыто 0.1.98** (сессии без id, способы входа без секретов, записи аудита) |
| F08 повтор стирания после restore | **закрыто 0.1.98** (`.erasures.jsonl`, `privacy reapply-erasures`, повтор при старте workshop) |
| L04 trust proxy | **закрыто 0.1.98** |
| B16 резолвер destinations | **закрыто 0.1.98** |
| I08 размер SVG | **закрыто 0.1.99** (`svgMaxBytes`, 1 МиБ, `SVG_TOO_LARGE`) |
| I09 кэш квоты загрузок | **закрыто 0.1.99** (`quota.cacheMs`, 2 с) |
| I10 SSE после отзыва прав | **закрыто 0.1.99** (`reauthorize`, 60 с) |
| D08 пакеты | `ldap` закрыт (0.1.95); открыто: `network`, `documents`, `exports`, `integrations` |
| D04 / D05 / D11 | расхождение с `docs/roadmap.md`; он заморожен владельцем и объявлен **историческим** (README → «Документация»). Источник правды: CHANGELOG, README, index.html, этот файл. Требует подтверждения владельца |
| D07 | открыто: нужны образцы хешей паролей четырёх приложений |
| Открыто без изменений | I03, I11, E01–E07, J03–J05, K03–K06, L05, B17 (остатки), F05/F07/F09/F10 |

Новый функционал 0.1.91–0.1.97 (админ-раздел, баны, политики, LDAP, errorResponder) аудиту не подвергался.
Не проверено в реальной среде: SFTP, SMTP, LDAP/AD, e2e, страницы в браузере, `npm ci` на lock-файле с правкой вручную.

## Что ещё не аудировано

Этапы E, F, G, I, J пройдены (2026-10-19, см. «Повторный аудит на 0.1.77»); A–D
пересмотрены. Остаётся:

- **Стадия H — требования четырёх приложений:** построчное сопоставление реальных
  приложений с ядром (модель данных, роли, интеграции, объёмы, нагрузка) — нужны их
  исходники, у меня их нет.
- Глубокие нагрузочные измерения (реальные цифры p95, SQLite под конкурентной
  записью, SSE на тысячи подписчиков) — требуют запуска на вашей машине.
- Проверка лицензий зависимостей (`npx license-checker --production`) и
  `npm audit` — у вас (в песочнице нет сети).

## Ограничения аудита

- Серверы и тесты не запускались; всё по чтению кода. Поведение Node
  (`server.close` с SSE, `setTimeout` > 2³¹, `-h` в парсере) и SQLite (WAL-копия, `COMMIT` при
  async-колбэке) — по документированному поведению, не по воспроизведению.
- Реальные приложения (procure-it, atlas-ao, net-monitor, it-assets) в репозитории
  отсутствуют; блокеры портирования взяты из roadmap, а не из их кода.
- Находки с пометкой `○` стоит перепроверить перед исправлением (первым делом
  открыть указанную строку).


## Этап H — требования приложений (разбор присланных сборок, 21.10.2026)
Разобраны: atlas `v26w42-12`, it-assets `beta-1-26w41-01`, procure-it `26w43-b01`, net-monitor `26w42-b01`
(все — Node ≥ 26, Express 5, SQLite, argon2id, express-session, helmet, pino, zod 4).

| Приложение | Пароли | Админка | Нужно сверх ядра |
|---|---|---|---|
| atlas | argon2id (PHC) + старый scrypt: хеш 128 hex в `users.hash`, соль в `users.salt` (используется как строка), `crypto.scrypt(…, 64)`, параметры Node по умолчанию | «О системе» (версия, окружение, технологии, проверка обновлений зависимостей по npm, лицензии, CHANGELOG), аудит, пользователи, бэкап/restore (БД и полный zip) | `adm-zip` (ядро — yauzl/yazl), otplib (есть), комментарии/правки читателей |
| it-assets | только argon2id (`@node-rs/argon2`); bcrypt и plaintext уже удалены; **пустой PIN = вход без пароля** (осознанная функция для viewer) | настройки: общие, справочники, типы, пользователи, бэкап, конфиг, журнал аудита, оповещения; health-бар (БД/бэкап/сертификат/диск) с проактивными уведомлениями; `/api/metrics` для внешнего мониторинга; API-ключи; PWA | `ldapts ^9.2.0`, `pino-roll`, `pngjs`, QR (есть), CSV |
| procure-it | только argon2id (старые форматы удалены); аварийный вход по общему секрету `LEGACY_PASSWORD` (сравнение через `timingSafeEqual`) | дашборд, бэкап-сервис, настройки, сброс пароля | `docx` (есть), `pdf-lib`, XLSX в браузере |
| net-monitor | argon2id + старый scrypt (колонка `hash_algo`, соль в `users.salt`, тот же формат, что у atlas); блокировка входа по IP на 5 минут **в памяти** | мониторинг, устройства, обслуживание, интеграции, трафик, логи, SSE | `ldapts ^9.0`, `net-snmp`, `node-routeros`, `ssh2` (есть), `pino-roll`, агент |

Выводы:
- **D07 закрыт по коду**: реальные образцы хешей не нужны для argon2id (формат общий). Единственный старый
  формат — scrypt у atlas и net-monitor: в 0.1.90 добавлена `auth.scryptSaltColumnScheme()` (точный формат,
  соль через `legacyContext`). bcrypt в приложениях не используется — схема из 0.1.88 удалена.
  Не проверено на реальных строках БД: формат взят из кода приложений, проверен тестом на `crypto.scryptSync`.
- **D08**: `ldapts` уже используют it-assets и net-monitor (подтверждает выбор для `core/ldap`); `pino-roll` — ротация
  файловых логов (у ядра своя ротация файлового приёмника — решение: оставить свою, пакет не брать);
  прочее (`net-snmp`, `node-routeros`, `pdf-lib`, `pngjs`) — прикладные пакеты приложений, в ядро не переносятся.
- **Бан/разбан** в приложениях отсутствует (только блокировка по IP в памяти у net-monitor) → делаем в ядре
  (см. `docs/guide/05-administration.md`).
- **Фишки для админ-раздела**: «О системе» с проверкой обновлений и скачиванием лицензий (atlas), health-бар и
  `/api/metrics` (it-assets), SSE-обновления (net-monitor), дашборд (procure-it).
- Различие `argon2` (atlas, procure-it, net-monitor) и `@node-rs/argon2` (it-assets): формат строки одинаковый
  (`$argon2id$…`), проверка в ядре через `argon2` работает для обоих.


## Актуализация при синхронизации документации

Закрыты в коде: **F05** (письма в очереди: TTL `pendingTtlHours`, тело очищается), **F07** (`privacy export --out` с правами 0600 и без перезаписи), **F09** (чистка токенов сброса пароля), **K04**, **K05** (`attachUser` кэширует по сессии и сверяет снимок; отзыв блокировки обрывает сессии). J04 закрыт частично (`permissions: contents: read`, `concurrency`, таймаут; SHA-пины и digest образа — на вашей стороне, нужен доступ к реестрам), L05 описан в «Эксплуатации». I03 закрыт для резервного копирования (`snapshotToAsync` в рабочем потоке; `db integrity` и `health` остаются синхронными — быстрые проверки). E06 закрыт (название в `alt` логотипа экранируется), E07 закрыт (поиск перевода только по собственным ключам, ссылка «К содержимому» в оболочке), E04 для оболочки закрыт (диалоги `admDialog` вместо `prompt()/alert()`, `<main>` как ориентир); остальное по E (E01 переводы на `t()`, E02, E03, E05) — в линии переводов. B17 закрыт: добавлена keyset-пагинация `pageByExample` (остальное из списка было сделано раньше). I11 закрыт (`npm run lock:check`, шаг CI). Остаются открытыми: E01–E03, E05, J03, J05. F10 закрыт (`ipMode` в `accessLog`, канал `lab` без логинов; срок хранения access-log задаётся ротацией приёмника `keep`). K03 закрыт (блокировка по паре логин+адрес), K06 закрыт опцией `strictPaths`. Письма, уже стоящие в очереди, ядро при удалении человека не отменяет — это записано в разделе «Безопасность».
