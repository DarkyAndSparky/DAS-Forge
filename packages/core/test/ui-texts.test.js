import { describe, it, expect, afterEach } from 'vitest';
import { UI_TEXTS, uiTexts } from '../src/ui/texts.js';
import { modalScript } from '../src/ui/modal.js';
import { langSwitchHtml } from '../src/ui/lang-switch.js';
import { themeToggleHtml } from '../src/ui/theme.js';
import { renderAppShell } from '../src/ui/shell.js';
import { setTextOverrides, coreNamespaces } from '../src/i18n/index.js';

const registry = { getNavigation: () => [], getTranslations: () => ({ ru: {}, en: {} }) };

afterEach(() => setTextOverrides({}));

describe('ui texts', () => {
  it('has the same keys in ru and en and is listed in the core namespaces', () => {
    expect(Object.keys(UI_TEXTS.ru).sort()).toEqual(Object.keys(UI_TEXTS.en).sort());
    expect(coreNamespaces().ui).toBe(UI_TEXTS);
  });

  it('the shell takes skip link, nav label and empty-navigation text from the catalogue', () => {
    const en = renderAppShell({ moduleRegistry: registry, locale: 'en' });
    expect(en).toContain('Skip to content');
    expect(en).toContain('aria-label="Main"');
    expect(en).toContain('(no navigation registered)');
    const ru = renderAppShell({ moduleRegistry: registry, locale: 'ru' });
    expect(ru).toContain('К содержимому');
    expect(ru).toContain('(навигация не задана)');
  });

  it('an app override reaches the shell, the switch, the toggle and the dialogs', () => {
    setTextOverrides({ ui: { en: { skip: 'Jump to <main>', themeToggle: 'Mode', dialogCancel: 'Never mind' }, ru: { switchToEn: 'EN' } } });
    expect(renderAppShell({ moduleRegistry: registry, locale: 'en' })).toContain('Jump to &lt;main&gt;');
    expect(themeToggleHtml('en')).toContain('title="Mode"');
    expect(langSwitchHtml('ru')).toContain('title="EN"');
    expect(modalScript()).toContain('Never mind');
    expect(uiTexts('en').back).toBe('Back');
  });

  it('the dialog script stays valid JavaScript and keeps markup characters out of the embedded texts', () => {
    setTextOverrides({ ui: { en: { dialogOk: '</script><b>' } } });
    const code = modalScript();
    expect(() => new Function(code)).not.toThrow();
    expect(code).not.toContain('</script>');
  });
});
