import { describe, it, expect } from 'vitest';
import { createModuleRegistry } from '../src/modules/index.js';
import { buildProcessingRegistry, formatProcessingRegistry } from '../src/privacy/index.js';

const cfg = { audit: { retentionDays: 365 }, backup: { retentionDays: 30 }, auth: { sessionTtlMs: 8 * 3600 * 1000 } };
const mod = (extra = {}) => ({ id: 'reports', dataSubject: { export: async () => ({}), erase: async () => {}, ...extra } });

describe('processing registry', () => {
  it('lists the platform entries with retention taken from the configuration', () => {
    const { entries, gaps } = buildProcessingRegistry({ config: cfg });
    expect(gaps).toEqual([]);
    const audit = entries.find((e) => e.id === 'core.audit');
    expect(audit.ru.retention).toBe('365 дн.');
    expect(audit.en.retention).toBe('365 days');
    expect(entries.find((e) => e.id === 'core.sessions').en.retention).toBe('8 h');
    expect(entries.find((e) => e.id === 'core.backups').ru.retention).toBe('30 дн.');
    expect(buildProcessingRegistry({ config: { audit: { retentionDays: 0 } } }).entries.find((e) => e.id === 'core.audit').en.retention).toBe('unlimited');
  });

  it('adds what modules declare and reports the ones that declare too little', () => {
    const modules = createModuleRegistry();
    modules.registerModule(mod({ purpose: 'Reports', legalBasis: 'Contract', retentionDays: 90 }));
    let r = buildProcessingRegistry({ moduleRegistry: modules, config: cfg });
    const m = r.entries.find((e) => e.id === 'module.reports');
    expect(m).toMatchObject({ source: 'module', en: { purpose: 'Reports', legalBasis: 'Contract', retention: '90 days' } });
    expect(r.gaps).toEqual([]);
    const bare = createModuleRegistry();
    bare.registerModule(mod());
    r = buildProcessingRegistry({ moduleRegistry: bare, config: cfg });
    expect(r.gaps).toEqual(['module.reports']);
    expect(r.entries.at(-1).en.legalBasis).toBe('not declared by the module');
  });

  it('formats markdown, csv and json in both languages, and keeps spreadsheet formulas inert', () => {
    const modules = createModuleRegistry();
    modules.registerModule(mod({ purpose: '=HYPERLINK("http://x")', legalBasis: 'a|b' }));
    const r = buildProcessingRegistry({ moduleRegistry: modules, config: cfg });
    const md = formatProcessingRegistry(r, { format: 'md', lang: 'en' });
    expect(md).toContain('# Register of personal-data processing');
    expect(md).toContain('a\\|b');
    expect(formatProcessingRegistry(r, { format: 'md', lang: 'ru' })).toContain('# Реестр обработки персональных данных');
    const csv = formatProcessingRegistry(r, { format: 'csv', lang: 'ru' });
    expect(csv).toContain(`"'=HYPERLINK`);
    expect(csv.split('\n')[0]).toContain('"Основание"');
    const json = JSON.parse(formatProcessingRegistry(r, { format: 'json', lang: 'en' }));
    expect(json.entries.find((e) => e.id === 'module.reports').legalBasis).toBe('a|b');
  });
});

describe('privacy registry command', () => {
  it('prints the register, warns about gaps, and refuses unknown formats', async () => {
    const { registerPrivacyCommands } = await import('../src/cli/commands/privacy.js');
    const { privacy } = { privacy: await import('../src/privacy/index.js') };
    const cmds = {};
    const modules = createModuleRegistry();
    modules.registerModule(mod());
    registerPrivacyCommands({ command: (n, c) => { cmds[n] = c; } }, {
      registryFn: () => privacy.buildProcessingRegistry({ moduleRegistry: modules, config: cfg }),
      formatRegistryFn: privacy.formatProcessingRegistry,
    });
    const logs = []; const errs = [];
    const l = console.log; const e = console.error;
    console.log = (m) => logs.push(m); console.error = (m) => errs.push(m);
    try {
      expect(await cmds['privacy registry'].handler({ flags: { format: 'json', lang: 'en' } })).toBe(0);
      expect(JSON.parse(logs[0]).gaps).toEqual(['module.reports']);
      expect(errs.join('\n')).toContain('module.reports');
      expect(await cmds['privacy registry'].handler({ flags: { format: 'xml' } })).not.toBe(0);
    } finally { console.log = l; console.error = e; }
  });
});
