/**
 * The application's own texts (i18next, namespace `app`), both languages side by side. A page asks for its words by
 * key (`t('login.title')`); the texts an inline browser script needs are handed over as JSON (`scriptTexts`), so no
 * script carries a hard-coded language. The core's own pages (errors, admin, policies) already speak ru and en.
 *
 * Rules: every text in both languages; no phrases glued from pieces; `missingMessages()` must stay empty
 * (test/messages.test.js checks it). To add a third language see the "Translations" guide.
 */
import i18next from 'i18next';
import { i18n as coreI18n } from '@das-forge/core';

export const MESSAGES = {
  ru: {
    home: {
      signedIn: 'Вы вошли как', signOut: 'Выйти',
      notesTitle: 'Заметки', notesText: 'Пример данных приложения: список, добавление и удаление (API /notes).',
      adminTitle: 'Администрирование', adminText: 'Обзор, пользователи, безопасность, копии, журналы, оформление.',
    },
    notes: {
      title: 'Заметки', placeholder: 'Текст заметки', add: 'Добавить', empty: 'Заметок пока нет.', remove: 'Удалить',
      by: 'автор', back: 'Назад', failed: 'Не удалось выполнить действие.',
    },
  },
  en: {
    home: {
      signedIn: 'Signed in as', signOut: 'Sign out',
      notesTitle: 'Notes', notesText: 'The example data of the application: list, add and delete (API /notes).',
      adminTitle: 'Admin panel', adminText: 'Overview, users, security, backups, logs, appearance.',
    },
    notes: {
      title: 'Notes', placeholder: 'Text of the note', add: 'Add', empty: 'No notes yet.', remove: 'Delete',
      by: 'by', back: 'Back', failed: 'The action failed.',
    },
  },
};

const i18n = coreI18n.createI18nSync({ i18next, namespaces: { app: MESSAGES } });

/** `const t = translator(locale); t('login.title')` */
export const translator = (locale) => i18n.translator(locale === 'en' ? 'en' : 'ru', 'app');

/** Keys that exist in one language only (the test asserts this stays empty). */
export const missingMessages = () => i18n.missingKeys();

/** A JSON literal that is safe inside an inline <script>: `</script>` and HTML comments cannot end it. */
export function scriptTexts(obj) {
  return JSON.stringify(obj).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}
