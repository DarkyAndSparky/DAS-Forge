import { describe, it, expect } from 'vitest';

import { createModuleRegistry } from '../src/modules/index.js';
import { renderAppShell } from '../src/ui/shell.js';
import { translate } from '../src/ui/translate.js';
import { searchModules } from '../src/ui/search.js';

function registryWith(registration) {
  const registry = createModuleRegistry();
  registry.registerModule(registration);
  return registry;
}

describe('translate', () => {
  it('returns the translated string for a known key/locale', () => {
    const registry = registryWith({ id: 'm', translations: { ru: { greet: 'Привет' }, en: { greet: 'Hello' } } });
    expect(translate(registry, 'ru', 'greet')).toBe('Привет');
    expect(translate(registry, 'en', 'greet')).toBe('Hello');
  });

  it('falls back to the raw key when missing, rather than blank or throwing', () => {
    const registry = createModuleRegistry();
    expect(translate(registry, 'ru', 'unknown.key')).toBe('unknown.key');
  });
});

describe('renderAppShell', () => {
  it('renders a permission-gated, translated navigation item', () => {
    const registry = registryWith({
      id: 'reporting',
      navigation: [{ id: 'r', label: 'nav.reports', path: '/reports', permission: 'read:finance' }],
      translations: { ru: { 'nav.reports': 'Отчёты' } },
    });

    const withoutPerm = renderAppShell({ moduleRegistry: registry, viewerPermissions: [], locale: 'ru' });
    expect(withoutPerm).not.toContain('Отчёты');
    expect(withoutPerm).toContain('навигация не задана');

    const withPerm = renderAppShell({ moduleRegistry: registry, viewerPermissions: ['read:finance'], locale: 'ru', activePath: '/reports' });
    expect(withPerm).toContain('Отчёты');
    expect(withPerm).toContain('href="/reports"');
    expect(withPerm).toContain('class="nav-item active"');
  });

  it('a navigation item with no permission is visible to everyone', () => {
    const registry = registryWith({ id: 'm', navigation: [{ id: 'x', label: 'home', path: '/' }] });
    const html = renderAppShell({ moduleRegistry: registry, viewerPermissions: [] });
    expect(html).toContain('href="/"');
  });

  it('switching locale changes the rendered text', () => {
    const registry = registryWith({
      id: 'm',
      navigation: [{ id: 'x', label: 'nav.x', path: '/x' }],
      translations: { ru: { 'nav.x': 'Русский' }, en: { 'nav.x': 'English' } },
    });
    expect(renderAppShell({ moduleRegistry: registry, locale: 'ru' })).toContain('Русский');
    expect(renderAppShell({ moduleRegistry: registry, locale: 'en' })).toContain('English');
  });

  it('escapes navigation label and path to prevent markup injection', () => {
    const registry = registryWith({ id: 'evil', navigation: [{ id: 'x', label: '<script>bad</script>', path: '/x"><script>bad2</script>' }] });
    const html = renderAppShell({ moduleRegistry: registry });
    expect(html).not.toContain('<script>bad</script>');
    expect(html).not.toContain('<script>bad2</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('searchModules', () => {
  it('aggregates results from every registered provider, tagged by moduleId/label', async () => {
    const registry = createModuleRegistry();
    registry.registerModule({ id: 'a', search: { label: 'A', provider: async (q) => [`a-result-for-${q}`] } });
    registry.registerModule({ id: 'b', search: { label: 'B', provider: async (q) => [`b-result-for-${q}`] } });

    const results = await searchModules(registry, 'x');
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.moduleId === 'a')).toMatchObject({ label: 'A', results: ['a-result-for-x'] });
    expect(results.find((r) => r.moduleId === 'b')).toMatchObject({ label: 'B', results: ['b-result-for-x'] });
  });

  it('reports a throwing provider as an error entry without failing the others', async () => {
    const registry = createModuleRegistry();
    registry.registerModule({ id: 'good', search: { label: 'Good', provider: async () => ['ok'] } });
    registry.registerModule({ id: 'bad', search: { label: 'Bad', provider: async () => { throw new Error('boom'); } } });

    const results = await searchModules(registry, 'x');
    expect(results.find((r) => r.moduleId === 'good').results).toEqual(['ok']);
    expect(results.find((r) => r.moduleId === 'bad').error).toBe('boom');
  });

  it('returns an empty array when no module registers a search provider', async () => {
    const registry = createModuleRegistry();
    expect(await searchModules(registry, 'x')).toEqual([]);
  });
});
