<p align="center">
  <img src="examples/workshop/assets/brand/logo.svg" width="96" alt="DAS-Forge">
</p>

<h1 align="center">DAS-Forge</h1>

<p align="center">
  Общая платформа для внутренних приложений: безопасность, администрирование, переводы и оформление — один раз, в ядре.<br>
  Документация для версии ядра <b><!--core-version-->0.1.283<!--/core-version--></b>
</p>

<p align="center">
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D26-5fa06a?style=flat-square">
  <img alt="express" src="https://img.shields.io/badge/express-5-444?style=flat-square">
  <img alt="zod" src="https://img.shields.io/badge/zod-4-3068b7?style=flat-square">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square">
</p>

<p align="center">
  <img alt="stack" src="https://skillicons.dev/icons?i=nodejs,express,sqlite,docker,vitest&perline=5">
</p>

## Что это

Монорепозиторий: ядро `@das-forge/core` (`packages/core`), эталонное приложение `examples/workshop` и приложения платформы в `apps/`. Ядро даёт рабочее поведение по умолчанию; приложения настраивают его через опции и коннекторы (темы, переводы, роли, проверки).

## Быстрый старт

```bash
npm install
npm install-scripts approve argon2 cpu-features ssh2
cd examples/workshop
npm run cli -- user create-admin
npm start            # https://127.0.0.1:9002 (HTTP на 9001 перенаправляет)
```

Требуется Node.js ≥ 26. Тесты: `npm test` из корня.

## Документация

Источник — `docs/guide/`, страница с навигацией — `docs/index.html` (`npm run docs`).

| Раздел | О чём |
|---|---|
| [Быстрый старт](docs/guide/01-quick-start.md) | запуск, минимальное приложение |
| [Модули ядра](docs/guide/02-modules.md) | что даёт каждый модуль, API, примеры |
| [Конфигурация](docs/guide/03-configuration.md) | все ключи, переменные окружения |
| [Безопасность](docs/guide/04-security.md) | модель угроз, защиты, ограничения |
| [Администрирование](docs/guide/05-administration.md) | разделы админки, требования, функции по умолчанию |
| [Переводы](docs/guide/06-translations.md) | i18next, словари, добавление языка |
| [Темы и оформление](docs/guide/07-themes-and-branding.md) | тема, логотип, акценты |
| [Командная строка](docs/guide/08-cli.md) | все команды |
| [Workshop](docs/guide/09-workshop.md) | эталонное приложение |
| [Эксплуатация](docs/guide/10-operations.md) | Docker, копии, журналы, обновление |
| [Разработка ядра](docs/guide/11-development.md) | версия, документация, тесты |

Прочее: [CHANGELOG](packages/core/CHANGELOG.md) · [находки аудита](docs/audit-findings.md) · [внешний аудит ядра](docs/audit-core-external.md) · [пробелы документации](docs/doc-audit.md) · [сверка с планом](docs/roadmap-gaps.md) · [целевые зависимости](docs/dependencies-target.md) · [roadmap](docs/roadmap.md) (исторический).

## Участие и поддержка

[Как участвовать](CONTRIBUTING.md) · [кодекс поведения](CODE_OF_CONDUCT.md) · [поддержка](SUPPORT.md) · [сообщить об уязвимости](SECURITY.md).

## Версия

Единственный источник — `packages/core/package.json`; в коде — `CORE_VERSION`. Смена: `npm run version:set -- X.Y.Z`, проверка: `npm run version:check`.

## Лицензия

[MIT](LICENSE).
