/**
 * Texts of the workshop pages (i18next, namespace `workshop`): every page asks for its words by key.
 *
 * Page code asks for a text with `t('login.title')`; for the browser scripts of a page the texts it needs
 * are embedded as JSON (`scriptTexts`), so the script never carries a hard-coded language.
 */
import i18next from 'i18next';
import { i18n as coreI18n } from '@das-forge/core';

export const MESSAGES = {
  ru: {
    realtime: {
      title: 'Лаборатория реального времени', back: 'Назад',
      hint: 'Server-sent events в действии: откройте страницу в двух вкладках, отправьте сообщение в одной и увидите его сразу в обеих.',
      message: 'Сообщение', send: 'Отправить', connected: '[подключено]',
      lost: '[соединение потеряно: браузер повторит попытку сам]', failed: 'Не удалось отправить.',
    },
    home: {
      signedIn: 'Вы вошли как',
      intro: 'Workshop — пробный стенд ядра DAS-Forge. Здесь каждая возможность ядра подключена так, как её подключит настоящее приложение: можно нажимать, ломать и смотреть, что остаётся в журнале.',
      statsTitle: 'Сейчас в системе', statAssets: 'Активов', statUsers: 'Пользователей', statSessions: 'Сессий', statVersion: 'Версия ядра',
      tryTitle: 'Что попробовать',
      try1: 'Откройте Realtime Lab в двух вкладках и отправьте сообщение: оно придёт в обе сразу.',
      try2: 'В «Аккаунте» включите двухфакторный вход и сохраните коды восстановления.',
      try3: 'В админке откройте «Аудит», отфильтруйте входы и выгрузите их в CSV.',
      try4: 'Запишите тестовый инцидент и посмотрите, как считаются сроки уведомления.',
      try5: 'Включите режим обслуживания и откройте приложение из другого браузера.',
      try6: 'Скачайте реестр обработки персональных данных и проверьте, какие модули не заполнили основание.',
      accountTitle: 'Вход и учётная запись', accountText: 'Пароли с политикой, второй фактор, коды восстановления, письмо о входе с нового устройства, блокировки при переборе.',
      accountLink: 'Аккаунт',
      realtimeTitle: 'Живые обновления', realtimeText: 'События сервера в реальном времени с проверкой прав и лимитами на подключения.',
      realtimeLink: 'Realtime Lab',
      dataTitle: 'Данные и права', dataText: 'Поля, которые видит только роль с нужным правом: стоимость активов открыта лишь тем, кому разрешены финансы. Поиск по модулям доступен из строки поиска вверху.',
      dataLink: 'Отчёты (нужно право на финансы)',
      adminTitle: 'Администрирование', adminText: 'Обзор с графиками, безопасность и блокировки, пользователи, парольная политика, резервные копии, задачи, диагностика.',
      adminAudit: 'Аудит', adminUsers: 'Пользователи', adminPolicy: 'Парольная политика', adminBackups: 'Резервные копии', adminTasks: 'Задачи', adminAbout: 'О системе', adminLink: 'Обзор',
      privacyTitle: 'Приватность и инциденты', privacyText: 'Реестр обработки персональных данных, реестр инцидентов со сроками уведомления, обезличивание и повторное применение удалений.',
      privacyRegistry: 'Реестр обработки', privacyIncidents: 'Инциденты',
      publicTitle: 'Открытые страницы', publicText: 'Политика, cookie, лицензионное соглашение и перечень компонентов доступны без входа; согласие на cookie запоминается.',
      publicPolicy: 'Политика', publicCookies: 'Cookie', publicLicense: 'Лицензия', publicComponents: 'Компоненты',
      opsTitle: 'Эксплуатация', opsText: 'Проверка состояния, диагностика на двух языках, метрики для Prometheus, копии с проверкой, плановые задачи, тревоги.',
      opsHealth: 'Состояние',
    },
    reports: { title: 'Отчёты', assets: 'Активы', totalCost: 'Общая стоимость' },
  },
  en: {
    realtime: {
      title: 'Realtime Lab', back: 'Back',
      hint: 'Server-sent events, interactively: open this page in two tabs, send a message in one and watch it appear live in both.',
      message: 'Message', send: 'Send', connected: '[connected]',
      lost: '[connection lost - the browser will retry automatically]', failed: 'Could not send.',
    },
    home: {
      signedIn: 'Signed in as',
      intro: 'Workshop is the proving ground of the DAS-Forge core. Every capability of the core is wired in the way a real application would wire it: click, break and see what lands in the log.',
      statsTitle: 'In the system now', statAssets: 'Assets', statUsers: 'Users', statSessions: 'Sessions', statVersion: 'Core version',
      tryTitle: 'Things to try',
      try1: 'Open the Realtime Lab in two tabs and send a message: it arrives in both at once.',
      try2: 'In "Account" turn on two-factor sign-in and keep the recovery codes.',
      try3: 'In the admin panel open "Audit", filter the sign-ins and export them as CSV.',
      try4: 'Record a test incident and see how the notice deadlines are counted.',
      try5: 'Turn on maintenance mode and open the application from another browser.',
      try6: 'Download the register of personal-data processing and see which modules left the legal basis empty.',
      accountTitle: 'Sign-in and account', accountText: 'Password policy, second factor, recovery codes, a letter about a sign-in from a new device, lockouts on guessing.',
      accountLink: 'Account',
      realtimeTitle: 'Live updates', realtimeText: 'Server events in real time with permission checks and connection limits.',
      realtimeLink: 'Realtime Lab',
      dataTitle: 'Data and permissions', dataText: 'Fields that only a role with the right permission can see: the cost of an asset is open only to those allowed to see finance. Search across modules is in the search box at the top.',
      dataLink: 'Reports (needs the finance permission)',
      adminTitle: 'Administration', adminText: 'Overview with charts, security and bans, users, password policy, backups, tasks, diagnostics.',
      adminAudit: 'Audit', adminUsers: 'Users', adminPolicy: 'Password policy', adminBackups: 'Backups', adminTasks: 'Tasks', adminAbout: 'About', adminLink: 'Overview',
      privacyTitle: 'Privacy and incidents', privacyText: 'Register of personal-data processing, register of incidents with notice deadlines, anonymisation and re-applying erasures.',
      privacyRegistry: 'Processing register', privacyIncidents: 'Incidents',
      publicTitle: 'Public pages', publicText: 'The policy, cookies, licence agreement and the list of components are open without signing in; the cookie consent is remembered.',
      publicPolicy: 'Policy', publicCookies: 'Cookies', publicLicense: 'Licence', publicComponents: 'Components',
      opsTitle: 'Operations', opsText: 'Health check, diagnostics in two languages, Prometheus metrics, verified backups, scheduled tasks, alerts.',
      opsHealth: 'Health',
    },
    reports: { title: 'Reports', assets: 'Assets', totalCost: 'Total cost' },
  },
};

const i18n = coreI18n.createI18nSync({ i18next, namespaces: { workshop: MESSAGES } });

/** `const t = translator(locale); t('login.title')` - texts come back HTML-escaped only for interpolated values. */
export const translator = (locale) => i18n.translator(locale, 'workshop');

/** Keys that exist in one language only (the test asserts this stays empty). */
export const missingMessages = () => i18n.missingKeys();

/**
 * A JSON object literal that is safe inside an inline <script>: `</script>` and HTML comments cannot end it.
 * Used to hand the texts a page's script needs to the browser.
 */
export function scriptTexts(obj) {
  return JSON.stringify(obj).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}
