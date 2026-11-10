/**
 * Default texts (mini-markup, see render.js). They are a TEMPLATE for the platform itself and say nothing
 * legally binding: each application replaces them in the admin section ("Политики") with its approved text.
 * `{{app}}` is replaced by the application name.
 */
export const DEFAULT_TEXTS = {
  ru: {
    usage: `# Политика использования {{app}}

Этот текст — шаблон платформы DAS-Forge. Владелец приложения заменяет его своим утверждённым текстом в разделе администрирования.

## Назначение
{{app}} — рабочая система организации. Доступ предоставляется только уполномоченным пользователям для служебных задач.

## Учётные записи и доступ
- Учётная запись личная; не передавайте пароль и коды подтверждения другим людям.
- О подозрении на компрометацию учётной записи сообщайте администратору.
- Администратор может ограничить доступ учётной записи или адреса при нарушении правил или угрозе безопасности.

## Допустимое использование
- Используйте систему только для служебных целей.
- Не пытайтесь получить доступ к данным и функциям, которые вам не выданы, и не нарушайте работу системы.

## Журнал действий
Система ведёт журнал действий пользователей (вход, изменение данных, административные операции). Имена и сетевые адреса в журнале хранятся в виде псевдонимов; соответствие хранится отдельно и может быть удалено по обоснованному запросу.

## Cookie
Подробности — на странице [Cookie](/policy/cookies).

## Сторонние компоненты и лицензии
Система построена на открытых компонентах. Перечень компонентов и их лицензий — на странице [Компоненты и лицензии](/policy/components). Тексты лицензий: [GNU GPL v3](https://www.gnu.org/licenses/gpl-3.0.html), [GNU LGPL v3](https://www.gnu.org/licenses/lgpl-3.0.html), [GNU AGPL v3](https://www.gnu.org/licenses/agpl-3.0.html), [MIT](https://spdx.org/licenses/MIT.html), [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0).

## Изменения
Текст может обновляться. Актуальная версия всегда доступна по адресу /policy.
`,
    cookies: `# Cookie

Этот текст — шаблон платформы DAS-Forge; владелец приложения может заменить его.

## Какие cookie использует {{app}}
- **Сессия** (\`das_session\`) — нужна для входа в систему. Без неё сайт не работает; хранится до выхода или окончания сессии.
- **Узнавание устройства** (\`das_device\`) — случайный номер браузера, по которому мы замечаем вход с нового устройства и сообщаем вам об этом; хранится до 400 дней.
- **Выбор по cookie** (\`das_consent\`) — запоминает ваш ответ на уведомление (на 180 дней).

## Что значит «Принять» и «Отказаться»
Необходимые cookie используются всегда, они не требуют согласия. «Принять» разрешает приложению дополнительные cookie, если оно их использует (платформа сама их не ставит); «Отказаться» оставляет только необходимые.

Изменить выбор можно, удалив cookie \`das_consent\` в браузере — уведомление появится снова.

Подробнее — в [Политике использования](/policy).
`,
    license: `# Лицензионное соглашение {{app}}

Это заглушка. Текст лицензионного соглашения ещё не утверждён: владелец приложения заменяет его своим текстом в разделе администрирования «Политики».

## Предмет соглашения
(будет заполнено владельцем приложения)

## Права и ограничения
(будет заполнено владельцем приложения)

## Ответственность сторон
(будет заполнено владельцем приложения)

## Срок и расторжение
(будет заполнено владельцем приложения)
`,
  },
  en: {
    usage: `# {{app}} usage policy

This text is a DAS-Forge platform template. The application owner replaces it with their approved text in the administration section.

## Purpose
{{app}} is an organisation's working system. Access is given to authorised users for work tasks only.

## Accounts and access
- An account is personal; do not share your password or verification codes.
- Report any suspected compromise of your account to an administrator.
- An administrator may restrict an account or an address for breaking the rules or for security reasons.

## Acceptable use
- Use the system for work purposes only.
- Do not try to reach data or functions you were not granted, and do not disrupt the system.

## Activity log
The system keeps a log of user actions (sign-in, data changes, administrative operations). Names and network addresses in the log are stored as pseudonyms; the mapping is kept separately and can be deleted on a justified request.

## Cookies
Details are on the [Cookies](/policy/cookies) page.

## Third-party components and licences
The system is built on open-source components. The list of components and their licences is on the [Components and licences](/policy/components) page. Licence texts: [GNU GPL v3](https://www.gnu.org/licenses/gpl-3.0.html), [GNU LGPL v3](https://www.gnu.org/licenses/lgpl-3.0.html), [GNU AGPL v3](https://www.gnu.org/licenses/agpl-3.0.html), [MIT](https://spdx.org/licenses/MIT.html), [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0).

## Changes
This text may be updated. The current version is always at /policy.
`,
    cookies: `# Cookies

This text is a DAS-Forge platform template; the application owner may replace it.

## Cookies used by {{app}}
- **Session** (\`das_session\`) — needed to sign in. The site does not work without it; kept until sign-out or session expiry.
- **Device recognition** (\`das_device\`) — a random browser number that lets us notice a sign-in from a new device and tell you; kept up to 400 days.
- **Cookie choice** (\`das_consent\`) — remembers your answer to the notice (180 days).

## What "Accept" and "Decline" mean
Necessary cookies are always used and need no consent. "Accept" allows additional cookies if the application uses any (the platform sets none itself); "Decline" keeps only the necessary ones.

You can change your choice by deleting the \`das_consent\` cookie in your browser — the notice will appear again.

More in the [Usage policy](/policy).
`,
    license: `# {{app}} licence agreement

This is a placeholder. The licence agreement text has not been approved yet: the application owner replaces it with their own text in the "Policies" administration section.

## Subject of the agreement
(to be filled in by the application owner)

## Rights and restrictions
(to be filled in by the application owner)

## Liability
(to be filled in by the application owner)

## Term and termination
(to be filled in by the application owner)
`,
  },
};

export const KINDS = ['usage', 'cookies', 'license'];

/**
 * The platform's own licence notice. It is NOT editable and not stored: the licence page shows it first, and the
 * application owner's agreement (the editable `license` text) follows. The MIT text itself is the original English
 * wording in both languages (a translation of a licence is not the licence). `{{holder}}` is the copyright holder
 * (createPolicy's `platformCopyright`).
 */
export const PLATFORM_LICENSE = {
  ru: `# Лицензия платформы DAS-Forge

Это приложение построено на платформе DAS-Forge, которая распространяется по лицензии MIT. Эта часть страницы одинакова во всех приложениях платформы и не редактируется; соглашение владельца приложения идёт ниже. Перечень сторонних компонентов и их лицензий — на странице [Компоненты и лицензии](/policy/components).

## Текст лицензии MIT (оригинал)
`,
  en: `# DAS-Forge platform licence

This application is built on the DAS-Forge platform, which is distributed under the MIT licence. This part of the page is the same in every application of the platform and cannot be edited; the application owner's agreement follows below. The list of third-party components and their licences is on the [Components and licences](/policy/components) page.

## MIT licence text
`,
};

export const MIT_TEXT = `MIT License

Copyright (c) 2026 {{holder}}

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
`;
