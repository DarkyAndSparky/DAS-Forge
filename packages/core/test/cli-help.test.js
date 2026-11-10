import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { createCli } from '../src/cli/index.js';
import { CLI_HELP, helpFor, resolveCliLang } from '../src/cli/help.js';

const dir = new URL('../src/cli/commands/', import.meta.url);
const paths = new Set();
for (const f of readdirSync(dir)) for (const m of readFileSync(new URL(f, dir), 'utf8').matchAll(/cli\.command\('([a-z][a-z -]+)'/g)) paths.add(m[1]);

describe('CLI help', () => {
  it('every command has a Russian description and a detailed reference', () => {
    expect(paths.size).toBeGreaterThan(40);
    for (const p of paths) {
      const h = CLI_HELP[p];
      expect(h, p).toBeTruthy();
      expect(/[а-яё]/i.test(h.ru), p).toBe(true);
    }
  });

  it('commands without their own text get usage and examples from the catalog', () => {
    for (const p of paths) {
      if (p.startsWith('user ') || p.startsWith('migrate')) continue;
      const meta = helpFor(p, { description: 'x' }, 'en');
      expect(meta.usage, p).toBeDefined();
      expect(meta.examples?.length, p).toBeGreaterThan(0);
    }
  });

  it('prints the list and one command in Russian with --lang ru, in English otherwise', async () => {
    const out = [];
    const orig = console.log;
    console.log = (...a) => out.push(a.join(' '));
    try {
      const cli = createCli({ name: 'app' });
      cli.command('cert info', { description: 'Show the certificate', handler: () => 0 });
      await cli.run(['help', 'cert', 'info', '--lang', 'ru']);
      expect(out.join('\n')).toContain('Использование: app cert info [--json]');
      expect(out.join('\n')).toContain('Параметры:');
      out.length = 0;
      await cli.run(['help', 'cert', 'info', '--lang', 'en']);
      expect(out.join('\n')).toContain('Usage: app cert info [--json]');
      expect(out.join('\n')).toContain('Flags:');
      out.length = 0;
      await cli.run(['--help', '--lang', 'ru']);
      expect(out.join('\n')).toContain('Команды:');
    } finally { console.log = orig; }
  });

  it('language: --lang wins, then the system language', () => {
    expect(resolveCliLang({ lang: 'en' }, { LANG: 'ru_RU.UTF-8' })).toBe('en');
    expect(resolveCliLang({}, { LANG: 'ru_RU.UTF-8' })).toBe('ru');
    expect(resolveCliLang({}, {})).toBe('en');
  });
});
