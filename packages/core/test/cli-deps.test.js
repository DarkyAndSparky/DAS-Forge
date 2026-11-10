import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createCli } from '../src/cli/cli.js';
import { registerDepsCommands, judgeLicense, lockLicenses, DEFAULT_ALLOWED_LICENSES } from '../src/cli/commands/deps.js';

const allowed = new Set(DEFAULT_ALLOWED_LICENSES);

describe('judgeLicense', () => {
  it('accepts permissive licenses and SPDX expressions satisfied by them', () => {
    expect(judgeLicense('MIT', allowed)).toBe('ok');
    expect(judgeLicense('(MIT OR GPL-3.0-only)', allowed)).toBe('ok');
    expect(judgeLicense('(MIT AND Zlib)', allowed)).toBe('ok');
    expect(judgeLicense('MIT AND (GPL-2.0 OR Apache-2.0)', allowed)).toBe('ok');
  });
  it('flags copyleft and unlisted licenses for review, and missing ones as unknown', () => {
    expect(judgeLicense('GPL-3.0-only', allowed)).toBe('review');
    expect(judgeLicense('MIT AND GPL-3.0-only', allowed)).toBe('review');
    expect(judgeLicense('MPL-2.0', allowed)).toBe('review');
    expect(judgeLicense(null, allowed)).toBe('unknown');
    expect(judgeLicense('UNLICENSED', allowed)).toBe('unknown');
    expect(judgeLicense('MPL-2.0', new Set([...allowed, 'MPL-2.0']))).toBe('ok');
  });
});

describe('app deps', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'deps-'));
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': { name: 'app' },
      'node_modules/a': { version: '1.0.0', license: 'MIT' },
      'node_modules/b': { version: '2.0.0', license: 'GPL-3.0-only' },
      'node_modules/c': { version: '1.2.0' },
      'node_modules/d': { version: '3.0.0', license: 'GPL-3.0-only', dev: true },
      'node_modules/a/node_modules/e': { version: '0.1.0', license: 'ISC' },
    },
  };
  writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'app', dependencies: { a: '^1.0.0', b: '^2.0.0' } }));
  for (const [n, v] of [['a', '1.0.0'], ['b', '1.5.0']]) {
    mkdirSync(path.join(dir, 'node_modules', n), { recursive: true });
    writeFileSync(path.join(dir, 'node_modules', n, 'package.json'), JSON.stringify({ name: n, version: v }));
  }

  function run(argv, opts = {}) {
    const logs = [];
    const orig = [console.log, console.error];
    console.log = (...a) => logs.push(a.join(' '));
    console.error = (...a) => logs.push(a.join(' '));
    const cli = createCli({ name: 'app' });
    registerDepsCommands(cli, { lockFile: path.join(dir, 'package-lock.json'), packageJsonPath: path.join(dir, 'package.json'), ...opts });
    return cli.run(argv).then((code) => ({ code, out: logs.join('\n') })).finally(() => { [console.log, console.error] = orig; });
  }
  const fetchOk = (map) => async (url, init) => {
    if (String(url).endsWith('/advisories/bulk')) return { ok: true, json: async () => map.advisories ?? {} };
    const name = decodeURIComponent(String(url).split('/').slice(-2, -1)[0]);
    return { ok: true, json: async () => ({ version: map.latest?.[name] ?? '1.0.0' }) };
  };

  it('lists production packages from the lock, dev ones only with --dev', () => {
    const rows = lockLicenses(JSON.stringify(lock));
    expect(rows.map((r) => r.name)).toEqual(['a', 'b', 'c', 'e']);
    expect(lockLicenses(JSON.stringify(lock), { omitDev: false }).map((r) => r.name)).toContain('d');
  });

  it('licenses: exit 3 and names the packages to look at; --allow clears them', async () => {
    let r = await run(['deps', 'licenses']);
    expect(r.code).toBe(3);
    expect(r.out).toContain('REVIEW');
    expect(r.out).toContain('b@2.0.0');
    expect(r.out).toContain('UNKNOWN');
    expect(r.out).toContain('c@1.2.0');
    expect(r.out).not.toContain('d@3.0.0');
    r = await run(['deps', 'licenses', '--allow', 'GPL-3.0-only']);
    expect(r.out).not.toContain('b@2.0.0');
  });

  it('audit: exit 0 without findings, 3 with an open one, 0 when accepted', async () => {
    let r = await run(['deps', 'audit'], { fetchFn: fetchOk({}) });
    expect(r.code).toBe(0);
    const adv = { advisories: { a: [{ url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'high', title: 'Bad thing', vulnerable_versions: '<2.0.0' }] } };
    r = await run(['deps', 'audit'], { fetchFn: fetchOk(adv) });
    expect(r.code).toBe(3);
    expect(r.out).toContain('a@1.0.0');
    r = await run(['deps', 'audit'], { fetchFn: fetchOk(adv), ignore: [{ id: 'ghsa-aaaa-bbbb-cccc' }] });
    expect(r.code).toBe(0);
  });

  it('audit: a registry that cannot be reached is a failure, not "all clear"', async () => {
    const r = await run(['deps', 'audit'], { fetchFn: async () => { throw new Error('fetch failed'); } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('Could not ask the registry');
  });

  it('outdated: shows newer versions, marks a major one, fails only with --fail', async () => {
    const f = fetchOk({ latest: { a: '1.0.0', b: '2.3.0' } });
    let r = await run(['deps', 'outdated'], { fetchFn: f, nodeModulesDir: path.join(dir, 'node_modules') });
    expect(r.code).toBe(0);
    expect(r.out).toContain('b  1.5.0 -> 2.3.0  (major)');
    expect(r.out).not.toContain('a  ');
    r = await run(['deps', 'outdated', '--fail'], { fetchFn: f, nodeModulesDir: path.join(dir, 'node_modules') });
    expect(r.code).toBe(3);
  });

  it('check: licenses and vulnerabilities together', async () => {
    const r = await run(['deps', 'check', '--json'], { fetchFn: fetchOk({}) });
    expect(r.code).toBe(3);
    expect(JSON.parse(r.out).licenses.length).toBe(2);
  });
});
