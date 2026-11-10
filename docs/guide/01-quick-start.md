# Быстрый старт

## Требования

| Что | Версия |
|---|---|
| Node.js | ≥ 26 (`node:sqlite` встроен) |
| npm | с поддержкой workspaces; нативные пакеты (argon2, cpu-features, ssh2) нужно одобрить: `npm install-scripts approve argon2 cpu-features ssh2` из корня репозитория |
| Express | 5 (peer-зависимость ядра) |

## Запуск эталонного приложения

```bash
npm install
npm install-scripts approve argon2 cpu-features ssh2   # один раз, из корня
cd examples/workshop
npm run cli -- config check
npm run cli -- user create-admin      # пароль (24 символа) показывается один раз
npm start                             # https://127.0.0.1:9002 (http://127.0.0.1:9001 перенаправляет на него), сертификат самоподписанный
```

Вход под созданным администратором; при первом входе система потребует сменить пароль. Раздел «Администрирование» — `/admin`.

**Команды при работающем сервере.** Окно с `npm start` занято сервером, в него команды не вводятся. Откройте второе окно консоли, перейдите в `examples/workshop` и запускайте `npm run cli -- <команда>` (например, `npm run cli -- help`). Подробнее — в главе «Командная строка».

Тесты: `npm test` из корня (ядро и workshop), только ядро — `npm run test:core`.

## Минимальное приложение

```js
import { config, database, auth, http, scheduler } from '@das-forge/core';

const appConfig = await config.loadConfig();             // app.config.js + DAS_* переменные
const db = await database.createSqliteAdapter(appConfig.database);
```

Порядок сборки в `examples/workshop/src/context.js` (единая точка для сервера и CLI): конфигурация → база и миграции → брендинг → авторизация → планировщик с копиями. Затем `src/server.js`: `requestId()` → `securityHeaders()` → сессии → маршруты → `notFoundHandler()` и `errorPageHandler()` **последними** → `registerGracefulShutdown()`.

## Что дальше

| Задача | Раздел |
|---|---|
| Настроить приложение | «Конфигурация» |
| Понять, что даёт ядро | «Модули ядра» |
| Безопасность и роли | «Безопасность» |
| Админка и управление | «Администрирование» |
| Языки и тема | «Переводы», «Темы и оформление» |
| Командная строка | «CLI» |
| Разобрать эталон | «Workshop» |
| Начать новое приложение | «Workshop» → «Шаблон приложения» (`templates/app`) |
| Выкатка и сопровождение | «Эксплуатация» |

## Внимание

- Секрет сессии в `examples/workshop/app.config.js` — только для локального примера; в `production` запуск с заглушкой отклоняется.
- Не вызывайте `npm install` из папки приложения вместо корня: workspaces ставятся из корня.

**См. также:** [Модули ядра](02-modules.md), [Конфигурация](03-configuration.md), [Пример workshop](09-workshop.md).
