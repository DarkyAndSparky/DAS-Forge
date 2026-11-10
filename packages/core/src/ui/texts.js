import { pickTexts } from '../i18n/overrides.js';

/**
 * Texts of the shared UI pieces (shell, language switch, theme toggle, modal dialogs, public pages).
 * Namespace `ui` in `i18n.coreNamespaces()`; an app overrides single keys with `i18n.setTextOverrides({ ui: ... })`.
 * `switchToEn` / `switchToRu` are deliberately the same in both languages: the label names the TARGET language
 * in that language, so a person who cannot read the current one still finds the button.
 */
export const UI_TEXTS = {
  ru: {
    skip: 'К содержимому', mainNav: 'Основное', noNav: '(навигация не задана)', back: 'Назад',
    switchToEn: 'Switch to English', switchToRu: 'Переключить на русский',
    themeToggle: 'Тема: светлая / тёмная',
    dialogOk: 'OK', dialogCancel: 'Отмена', dialogYes: 'Да', dialogClose: 'Закрыть',
    poweredBy: 'Powered by', signOut: 'Выйти', signOutFailed: 'Не удалось выйти. Проверьте соединение и повторите.',
  },
  en: {
    skip: 'Skip to content', mainNav: 'Main', noNav: '(no navigation registered)', back: 'Back',
    switchToEn: 'Switch to English', switchToRu: 'Переключить на русский',
    themeToggle: 'Theme: light / dark',
    dialogOk: 'OK', dialogCancel: 'Cancel', dialogYes: 'Yes', dialogClose: 'Close',
    poweredBy: 'Powered by', signOut: 'Sign out', signOutFailed: 'Could not sign out. Check the connection and try again.',
  },
};

/** The `ui` texts for one locale, with app overrides applied. */
export const uiTexts = (locale) => pickTexts(UI_TEXTS, undefined, locale, 'ui');
