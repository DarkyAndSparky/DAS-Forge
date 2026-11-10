import { describe, it, expect } from 'vitest';

import { createModuleRegistry } from '../src/modules/index.js';
import { createCli } from '../src/cli/cli.js';
import { serialize } from '../src/http/serialize.js';

describe('createModuleRegistry', () => {
  it('registers a module and exposes its permissions/fieldPermissions/cliCommands', () => {
    const registry = createModuleRegistry();
    const handler = () => 0;

    registry.registerModule({
      id: 'reporting',
      permissions: ['read:finance'],
      fieldPermissions: { cost: 'read:finance' },
      cliCommands: [{ name: 'report summary', description: 'demo', handler }],
    });

    expect(registry.listModuleIds()).toEqual(['reporting']);
    expect(registry.getFieldPermissions()).toEqual({ cost: 'read:finance' });
    expect(registry.getPermissions()).toEqual(['read:finance']);
    expect(registry.getCliCommands()).toEqual([{ name: 'report summary', description: 'demo', handler, moduleId: 'reporting' }]);
  });

  it('applies defaults for an otherwise-empty registration', () => {
    const registry = createModuleRegistry();
    const parsed = registry.registerModule({ id: 'bare' });
    expect(parsed).toEqual({ id: 'bare', permissions: [], fieldPermissions: {}, cliCommands: [], navigation: [], routes: [] });
    expect(registry.getNavigation()).toEqual([]);
    expect(registry.getSearchProviders()).toEqual([]);
    expect(registry.getDataSubjectHandlers()).toEqual([]);
  });

  it('rejects a registration with no id', () => {
    const registry = createModuleRegistry();
    expect(() => registry.registerModule({})).toThrow();
  });

  it('rejects a cliCommands handler that is not a function', () => {
    const registry = createModuleRegistry();
    expect(() => registry.registerModule({ id: 'x', cliCommands: [{ name: 'x', handler: 'not-a-function' }] })).toThrow();
  });

  it('rejects registering the same module id twice', () => {
    const registry = createModuleRegistry();
    registry.registerModule({ id: 'dup' });
    expect(() => registry.registerModule({ id: 'dup' })).toThrow(/already registered/);
  });

  it('merges field permissions from independent modules that do not overlap', () => {
    const registry = createModuleRegistry();
    registry.registerModule({ id: 'a', fieldPermissions: { cost: 'read:finance' } });
    registry.registerModule({ id: 'b', fieldPermissions: { serialNumber: 'read:inventory' } });
    expect(registry.getFieldPermissions()).toEqual({ cost: 'read:finance', serialNumber: 'read:inventory' });
  });

  it('rejects a conflicting field permission from a second module', () => {
    const registry = createModuleRegistry();
    registry.registerModule({ id: 'a', fieldPermissions: { cost: 'read:finance' } });
    expect(() => registry.registerModule({ id: 'b', fieldPermissions: { cost: 'admin:write' } })).toThrow(/conflict/);
  });

  it('allows two modules to declare the identical field permission (no real conflict)', () => {
    const registry = createModuleRegistry();
    registry.registerModule({ id: 'a', fieldPermissions: { cost: 'read:finance' } });
    expect(() => registry.registerModule({ id: 'b', fieldPermissions: { cost: 'read:finance' } })).not.toThrow();
  });

  it('applyCliCommands wires every registered command onto a real createCli() instance', async () => {
    const registry = createModuleRegistry();
    let ran = false;
    registry.registerModule({
      id: 'reporting',
      cliCommands: [{ name: 'report summary', handler: () => { ran = true; return 0; } }],
    });

    const cli = createCli({ name: 'test' });
    registry.applyCliCommands(cli);
    const code = await cli.run(['report', 'summary']);

    expect(code).toBe(0);
    expect(ran).toBe(true);
  });

  it('end-to-end: a registered fieldPermissions map actually gates core/http.serialize() output', () => {
    const registry = createModuleRegistry();
    registry.registerModule({ id: 'reporting', fieldPermissions: { cost: 'read:finance' } });

    const assets = [{ id: 1, name: 'Laptop', cost: 950 }];
    const fieldPermissions = registry.getFieldPermissions();

    const operatorView = serialize(assets, { viewerPermissions: ['read:basic'], fieldPermissions });
    expect(operatorView[0]).not.toHaveProperty('cost');

    const financeView = serialize(assets, { viewerPermissions: ['read:basic', 'read:finance'], fieldPermissions });
    expect(financeView[0]).toHaveProperty('cost', 950);
  });

  // navigation/routes/translations/search/dataSubject are accepted and
  // stored - see schema.js's module doc comment for why nothing in core
  // consumes them yet (no @das-forge/ui, no core/privacy). These tests
  // only cover "the data survives registration and comes back out
  // correctly", not "something renders a nav item" - there is nothing
  // to render it yet.
  it('stores navigation/routes and exposes them with moduleId attached', () => {
    const registry = createModuleRegistry();
    registry.registerModule({
      id: 'reporting',
      navigation: [{ id: 'reporting-home', label: 'reporting.nav.home', path: '/reporting' }],
      routes: [{ path: '/reporting', component: 'reporting-page' }],
    });

    expect(registry.getNavigation()).toEqual([
      { id: 'reporting-home', label: 'reporting.nav.home', path: '/reporting', moduleId: 'reporting' },
    ]);
    expect(registry.getRoutes()).toEqual([{ path: '/reporting', component: 'reporting-page', moduleId: 'reporting' }]);
  });

  it('merges translations from multiple modules and rejects a conflicting key', () => {
    const registry = createModuleRegistry();
    registry.registerModule({ id: 'reporting', translations: { ru: { 'reporting.title': 'Отчёты' }, en: { 'reporting.title': 'Reports' } } });
    registry.registerModule({ id: 'inventory', translations: { ru: { 'inventory.title': 'Склад' } } });

    expect(registry.getTranslations()).toEqual({
      ru: { 'reporting.title': 'Отчёты', 'inventory.title': 'Склад' },
      en: { 'reporting.title': 'Reports' },
    });

    expect(() => registry.registerModule({ id: 'other', translations: { ru: { 'reporting.title': 'Другое' } } })).toThrow(
      /Translation conflict/
    );
  });

  it('stores a search provider and dataSubject export/erase as real, callable functions', () => {
    const registry = createModuleRegistry();
    const provider = () => [];
    const exportFn = () => ({});
    const eraseFn = () => {};

    registry.registerModule({
      id: 'reporting',
      search: { provider, label: 'Reports' },
      dataSubject: { export: exportFn, erase: eraseFn, retentionDays: 365 },
    });

    expect(registry.getSearchProviders()).toEqual([{ provider, label: 'Reports', moduleId: 'reporting' }]);
    expect(registry.getDataSubjectHandlers()).toEqual([
      { export: exportFn, erase: eraseFn, retentionDays: 365, moduleId: 'reporting' },
    ]);
  });

  it('rejects a dataSubject registration missing export or erase', () => {
    const registry = createModuleRegistry();
    expect(() => registry.registerModule({ id: 'x', dataSubject: { export: () => {} } })).toThrow();
  });
});
