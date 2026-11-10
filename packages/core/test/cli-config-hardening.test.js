import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { parseArgs } from '../src/cli/arg-parser.js';
import { createCli } from '../src/cli/cli.js';
import { applyEnvOverrides } from '../src/config/env.js';
import { loadConfig } from '../src/config/index.js';
import { isPlaceholderSecret } from '../src/config/secrets.js';
import { securityChecks } from '../src/health/checks/security.js';

/** Audit wave 3b: C07 (config env/secrets) and C09 (CLI argument parsing). */

describe('parseArgs (C09)', () => {
  it('a boolean flag does not swallow the next positional: `backup restore --yes file.db`', () => {
    const { positionals, flags } = parseArgs(['backup', 'restore', '--yes', 'file.db']);
    expect(flags.yes).toBe(true);
    expect(positionals).toEqual(['backup', 'restore', 'file.db']);
  });

  it('the usual switches (json/force/fix/repair/verbose/quiet) are boolean by default', () => {
    for (const f of ['json', 'force', 'fix', 'repair', 'verbose', 'quiet']) {
      const { positionals, flags } = parseArgs(['cmd', `--${f}`, 'arg']);
      expect(flags[f]).toBe(true);
      expect(positionals).toEqual(['cmd', 'arg']);
    }
  });

  it('extra boolean flags can be declared; undeclared flags still take a value', () => {
    expect(parseArgs(['--dry', 'x'], { booleanFlags: ['dry'] }).positionals).toEqual(['x']);
    expect(parseArgs(['--out', 'x']).flags.out).toBe('x');
  });

  it('"--" ends flag parsing: later tokens are positional even with dashes', () => {
    const { positionals, flags } = parseArgs(['restore', '--force', '--', '--weird.db', '-h']);
    expect(flags).toEqual({ force: true });
    expect(positionals).toEqual(['restore', '--weird.db', '-h']);
  });

  it('-h means --help, other single letters are booleans', () => {
    expect(parseArgs(['-h']).flags).toMatchObject({ help: true, h: true });
    expect(parseArgs(['-v', 'x']).flags.v).toBe(true);
    expect(parseArgs(['-v', 'x']).positionals).toEqual(['x']);
  });

  it('a lone "-" (stdin) stays a value/positional', () => {
    expect(parseArgs(['--out', '-']).flags.out).toBe('-');
    expect(parseArgs(['-']).positionals).toEqual(['-']);
  });
});

describe('createCli flag handling (C09)', () => {
  let errors;
  beforeEach(() => {
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(a.join(' ')));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('passes `--yes file.db` through correctly end to end', async () => {
    const cli = createCli({ name: 'app' });
    let seen;
    cli.command('backup restore', { description: 'x', handler: (ctx) => { seen = ctx; return 0; } });
    expect(await cli.run(['backup', 'restore', '--yes', 'file.db'])).toBe(0);
    expect(seen.positionals).toEqual(['file.db']);
    expect(seen.flags.yes).toBe(true);
  });

  it('a command-declared booleanFlags entry is honoured', async () => {
    const cli = createCli({ name: 'app' });
    let seen;
    cli.command('sync', { description: 'x', booleanFlags: ['dry'], handler: (ctx) => { seen = ctx; return 0; } });
    await cli.run(['sync', '--dry', 'target']);
    expect(seen.positionals).toEqual(['target']);
  });

  it('warns (but still runs) on an unknown flag when the command declares its flags', async () => {
    const cli = createCli({ name: 'app' });
    let ran = false;
    cli.command('user reset', {
      description: 'x',
      flags: [{ name: '--force', description: 'skip prompt' }, { name: '--user <name>', description: 'who' }],
      handler: () => { ran = true; return 0; },
    });
    expect(await cli.run(['user', 'reset', '--forse'])).toBe(0);
    expect(ran).toBe(true);
    expect(errors.join('\n')).toMatch(/unknown flag --forse/);
    errors.length = 0;
    await cli.run(['user', 'reset', '--force', '--user', 'bob']);
    expect(errors).toEqual([]);
  });

  it('does not warn for commands that declare no flags', async () => {
    const cli = createCli({ name: 'app' });
    cli.command('x', { description: 'x', handler: () => 0 });
    await cli.run(['x', '--anything']);
    expect(errors).toEqual([]);
  });

  it('`app cmd -h` shows that command\'s help', async () => {
    const cli = createCli({ name: 'app' });
    let ran = false;
    cli.command('x', { description: 'does x', usage: '', handler: () => { ran = true; return 0; } });
    expect(await cli.run(['x', '-h'])).toBe(0);
    expect(ran).toBe(false);
  });
});

describe('env overrides (C07)', () => {
  it('accepts yes/on/no/off in addition to true/false/1/0, case-insensitively', () => {
    for (const [v, expected] of [['true', true], ['1', true], ['yes', true], ['ON', true], ['false', false], ['0', false], ['No', false], ['off', false]]) {
      expect(applyEnvOverrides({}, { DAS_TRUST_PROXY: v }).server.trustProxy).toBe(expected);
    }
  });

  it('rejects an unrecognised boolean instead of silently treating it as false', () => {
    expect(() => applyEnvOverrides({}, { DAS_TRUST_PROXY: 'maybe' })).toThrow(/Invalid boolean/);
  });

  it('reads <NAME>_FILE (Docker secrets), trims one trailing newline, and plain env wins', () => {
    const read = (p) => ({ '/run/secrets/s': 'file-secret-0123456789\n' })[p] ?? (() => { throw new Error('ENOENT'); })();
    expect(applyEnvOverrides({}, { DAS_SESSION_SECRET_FILE: '/run/secrets/s' }, { readFile: read }).auth.sessionSecret).toBe('file-secret-0123456789');
    expect(applyEnvOverrides({}, { DAS_SESSION_SECRET: 'plain-wins-0123456789', DAS_SESSION_SECRET_FILE: '/run/secrets/s' }, { readFile: read }).auth.sessionSecret).toBe('plain-wins-0123456789');
    expect(() => applyEnvOverrides({}, { DAS_SESSION_SECRET_FILE: '/nope' }, { readFile: read })).toThrow(/DAS_SESSION_SECRET_FILE.*could not be read/);
  });

  it('works with a real file', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'das-secret-'));
    try {
      const f = path.join(dir, 'secret');
      writeFileSync(f, 'real-file-secret-0123456789\r\n');
      expect(applyEnvOverrides({}, { DAS_SESSION_SECRET_FILE: f }).auth.sessionSecret).toBe('real-file-secret-0123456789');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('container env vars', () => {
  it('DAS_HTTPS_MODE and DAS_LOG_LEVEL map to server.https.mode and logLevel', () => {
    const cfg = applyEnvOverrides({}, { DAS_HTTPS_MODE: 'reverse-proxy', DAS_LOG_LEVEL: 'warn' });
    expect(cfg.server.https.mode).toBe('reverse-proxy');
    expect(cfg.logLevel).toBe('warn');
  });
});

describe('placeholder secrets (C07)', () => {
  it('recognises the known list and "change me"-style prefixes, not real secrets', () => {
    for (const s of ['changeme', 'CHANGE-ME', 'password', 'change_me_please_123', 'replace-me-with-something', 'your-secret-here']) {
      expect(isPlaceholderSecret(s)).toBe(true);
    }
    expect(isPlaceholderSecret('k3j9-very-real-random-value')).toBe(false);
  });

  it('loadConfig refuses env=production with a placeholder secret, but allows it in development', async () => {
    const base = { appName: 'x', auth: { sessionSecret: 'changeme-changeme-changeme' } };
    await expect(loadConfig({ cwd: os.tmpdir(), overrides: { ...base, env: 'production' }, env: {} })).rejects.toThrow(/placeholder/);
    const dev = await loadConfig({ cwd: os.tmpdir(), overrides: { ...base, env: 'development' }, env: {} });
    expect(dev.env).toBe('development');
    const ok = await loadConfig({ cwd: os.tmpdir(), overrides: { appName: 'x', env: 'production', auth: { sessionSecret: 'a-real-random-secret-0123456789' } }, env: {} });
    expect(ok.env).toBe('production');
  });

  it('doctor and loader share one list', () => {
    const r = securityChecks({ auth: { sessionSecret: 'changeme' }, env: 'development' });
    expect(r.find((c) => c.name === 'Session secret').status).toBe('fail');
  });
});
