# workshop

Рабочий эталон того, как приложение подключается к ядру DAS-Forge: все модули на минимальном, но реальном коде. Подробное описание — `docs/guide/09-workshop.md`.

## Запуск
```bash
cd examples/workshop
npm install
npm run cli -- config check
npm run cli -- user create-admin
npm start             # https://127.0.0.1:9002, сертификат создаётся при первом старте
npm test
```
Пока сервер работает, его окно консоли занято: для команд откройте второе окно, перейдите в эту папку и запускайте `npm run cli -- <команда>`.

Миграции применяются при каждом старте сервера; отдельно — `npm run cli -- migrate`.

## Что где подключено

| Файл | Что показывает |
|---|---|
| `app.config.js` | Реальный `app.config.js`, который читает `core/config` |
| `src/context.js` | **Единая точка bootstrap** — config → database → branding → auth → backup job, в этом порядке (каждый следующий шаг нуждается в результате предыдущего). И HTTP-сервер, и CLI используют один и тот же `buildContext()`, чтобы не было двух слегка разных способов инициализации |
| `src/server.js` | Express-обвязка: `requestId()` → `securityHeaders()` → `sessionMiddleware()` → роуты → `notFoundHandler()`/`errorPageHandler()` **последними** → `registerGracefulShutdown()`. Планировщик с бэкап-джобом стартует рядом с сервером |
| `src/routes.js` | `/login` (verify + lazy legacy rehash + session cookie) + TOTP/recovery-code step-up login, смена пароля, enroll/remove аутентификаторов, QR для enroll (`POST /totp/enroll/qr.svg`), admin-only роут. `/assets` CRUD (`serialize()` с `fieldPermissions` — zero-trust), `/assets/:id/cost` (`requirePermission()`, не флаг в теле запроса), `/assets/:id/qr.svg` (инвентарный QR-тег), `/events/assets` (SSE), `/assets/:id/logo` (`validateUpload()` — magic-bytes, не доверяет имени файла) |
| `src/pages.js` | Server-rendered HTML без клиентского фреймворка: `renderLoginPage()` (двухшаговая форма), `renderAccountBody()` (смена пароля, enroll/remove аутентификаторов с реальным QR, recovery-коды) |
| `src/records.js` | CRUD для таблицы `assets` — чистый SQL, без ORM; `seedAssetsIfEmpty()` для demo-данных на свежей БД |
| `test/routes.test.js` | полный HTTP-цикл через `registerRoutes()` — login/logout, TOTP step-up (успех/неверный код/нет pending-сессии), recovery-коды, смена пароля, enroll/remove аутентификатора (политика `mfaRequired` для admin), роль-ограничение `/admin/users`, негативные сценарии везде |
| `migrations/001_init.js`, `002_assets.js` | Формат миграции: **синхронный** `up(db)`. Применяются автоматически при `npm start` и вручную через `npm run cli -- migrate` |
| `bin/app.js` | CLI-бинарник — просто регистрирует готовые команды из `core/cli` поверх того же `buildContext()` |
| `assets/brand/logo.svg` | Vendor identity этого примера (неизменяемый, из `core/branding`) |
