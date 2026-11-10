import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSqliteAdapter } from '../src/database/index.js';
import { dependencyChecks, nodeVersionChecks, lockPackages, fetchErrorText } from '../src/health/index.js';

const LOCK = {
  lockfileVersion: 3,
  packages: {
    '': { name: 'app' },
    'node_modules/leftpad': { version: '1.0.0' },
    'node_modules/devtool': { version: '2.0.0', dev: true },
    'node_modules/a/node_modules/leftpad': { version: '1.0.0' },
    'node_modules/@scope/pkg': { version: '3.1.0' },
    'packages/core': { version: '0.1.0' },
    'node_modules/linked': { link: true, resolved: 'packages/core' },
  },
};

function lockFile(obj = LOCK) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'deps-'));
  const f = path.join(dir, 'package-lock.json');
  writeFileSync(f, JSON.stringify(obj));
  return f;
}

const advisory = (over = {}) => ({ id: 1, url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', title: 'Bad thing', severity: 'high', vulnerable_versions: '<1.2.0', ...over });
const answer = (data, status = 200) => async () => ({ ok: status < 400, status, json: async () => data });

describe('lockPackages', () => {
  it('lists installed packages once, without dev packages, workspace members and links', () => {
    expect(lockPackages(JSON.stringify(LOCK)).map((p) => `${p.name}@${p.version}`).sort()).toEqual(['@scope/pkg@3.1.0', 'leftpad@1.0.0']);
    expect(lockPackages(JSON.stringify(LOCK), { omitDev: false }).length).toBe(3);
  });
  it('refuses a lockfile without the packages map', () => {
    expect(() => lockPackages('{"lockfileVersion":1}')).toThrow(/unsupported/);
  });
});

describe('dependencyChecks', () => {
  it('fails on a high advisory that matches the installed version and ignores one that does not', async () => {
    const seen = [];
    const fetchFn = async (url, init) => { seen.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ leftpad: [advisory(), advisory({ url: 'https://github.com/advisories/GHSA-zzzz-0000-1111', vulnerable_versions: '<0.5.0', title: 'Old' })] }) }; };
    const r = await dependencyChecks({ lockFile: lockFile(), fetchFn });
    expect(seen[0].url).toBe('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk');
    expect(seen[0].body).toEqual({ leftpad: ['1.0.0'], '@scope/pkg': ['3.1.0'] });
    expect(r[0].status).toBe('fail');
    expect(r[0].message).toContain('1 high');
    expect(r[1]).toMatchObject({ name: 'leftpad@1.0.0', status: 'fail' });
    expect(r[1].message).toContain('ghsa-aaaa-bbbb-cccc');
    expect(r.length).toBe(2);
  });

  it('maps moderate to warn, low to ok, and reports a clean tree as ok', async () => {
    let r = await dependencyChecks({ lockFile: lockFile(), fetchFn: answer({ leftpad: [advisory({ severity: 'moderate' })] }) });
    expect(r[0].status).toBe('warn');
    r = await dependencyChecks({ lockFile: lockFile(), fetchFn: answer({ leftpad: [advisory({ severity: 'low' })] }) });
    expect(r[0].status).toBe('ok');
    expect(r[0].message).toContain('1 low');
    r = await dependencyChecks({ lockFile: lockFile(), fetchFn: answer({}) });
    expect(r).toEqual([{ name: 'Dependency vulnerabilities', status: 'ok', message: '2 packages checked: no known vulnerabilities' }]);
  });

  it('leaves out accepted advisories until their date passes', async () => {
    const fetchFn = answer({ leftpad: [advisory()] });
    const ignore = [{ id: 'GHSA-AAAA-BBBB-CCCC', reason: 'not reachable', until: '2026-12-01' }];
    let r = await dependencyChecks({ lockFile: lockFile(), fetchFn, ignore, now: () => Date.parse('2026-10-29') });
    expect(r[0].status).toBe('ok');
    expect(r[0].message).toContain('1 accepted');
    r = await dependencyChecks({ lockFile: lockFile(), fetchFn, ignore, now: () => Date.parse('2026-12-02') });
    expect(r[0].status).toBe('fail');
  });

  it('offline: warns, logs the reason, and falls back to the last good result with its date', async () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    const warnings = [];
    const logger = { warn: (m) => warnings.push(m) };
    const down = async () => { throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org'); };
    let r = await dependencyChecks({ lockFile: lockFile(), db, fetchFn: down, logger });
    expect(r[0]).toMatchObject({ status: 'warn' });
    expect(r[0].message).toContain('no earlier result');
    expect(warnings.length).toBe(1);
    await dependencyChecks({ lockFile: lockFile(), db, fetchFn: answer({ leftpad: [advisory()] }), now: () => Date.parse('2026-10-28T10:00:00Z') });
    r = await dependencyChecks({ lockFile: lockFile(), db, fetchFn: down, logger });
    expect(r[0].status).toBe('fail'); // the earlier finding is not forgotten because the network is gone
    expect(r[0].message).toContain('2026-10-28');
    expect(r[0].message).toContain('could not refresh');
    await dependencyChecks({ lockFile: lockFile(), db, fetchFn: answer({}), now: () => 1 });
    r = await dependencyChecks({ lockFile: lockFile(), db, fetchFn: down, logger });
    expect(r[0].status).toBe('warn'); // clean but stale is a warning, not a pass
  });

  it('a registry error and a missing lockfile are "not checked", never a crash', async () => {
    expect((await dependencyChecks({ lockFile: lockFile(), fetchFn: answer({}, 503) }))[0].status).toBe('warn');
    const r = await dependencyChecks({ lockFile: '/nonexistent/package-lock.json' });
    expect(r[0].status).toBe('warn');
    expect(r[0].message).toContain('not found');
  });
});

describe('nodeVersionChecks', () => {
  const index = [
    { version: 'v26.2.0', security: true }, { version: 'v26.1.0', security: false },
    { version: 'v26.0.0', security: false }, { version: 'v24.9.0', security: true },
  ];
  it('warns when a newer release of the same line carries security fixes', async () => {
    const r = await nodeVersionChecks({ version: 'v26.0.0', fetchFn: answer(index) });
    expect(r[0].status).toBe('warn');
    expect(r[0].message).toContain('v26.2.0');
  });
  it('is ok on the newest security release and ignores other lines', async () => {
    expect((await nodeVersionChecks({ version: 'v26.2.0', fetchFn: answer(index) }))[0].status).toBe('ok');
    expect((await nodeVersionChecks({ version: 'v26.1.0', fetchFn: answer([{ version: 'v24.9.0', security: true }]) }))[0].status).toBe('ok');
  });
  it('offline it warns "not checked" and logs', async () => {
    const warnings = [];
    const r = await nodeVersionChecks({ fetchFn: async () => { throw new Error('offline'); }, logger: { warn: (m) => warnings.push(m) } });
    expect(r[0].status).toBe('warn');
    expect(r[0].message).toContain('not checked: offline');
    expect(warnings.length).toBe(1);
  });

  it('finds the lockfile in a parent directory (workspace app)', async () => {
    const root = path.dirname(lockFile());
    const sub = path.join(root, 'examples', 'app');
    mkdirSync(sub, { recursive: true });
    const r = await dependencyChecks({ lockFile: path.join(sub, 'package-lock.json'), fetchFn: answer({}) });
    expect(r[0].message).not.toContain('not found');
  });

  it('shows the real cause of a failed request, with a hint for proxies', () => {
    const e = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND registry.npmjs.org'), { code: 'ENOTFOUND' }) });
    expect(fetchErrorText(e)).toContain('ENOTFOUND');
    expect(fetchErrorText(e)).toContain('NODE_USE_ENV_PROXY');
    const tls = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }) });
    expect(fetchErrorText(tls)).toContain('NODE_EXTRA_CA_CERTS');
    expect(fetchErrorText(new Error('boom'))).toBe('boom');
  });
});
