import { describe, it, expect } from 'vitest';
import { describeSources } from '../src/config/sources.js';
import { createCli } from '../src/cli/cli.js';
import { registerConfigCheckCommand } from '../src/cli/commands/config-check.js';

async function run(cli, argv) {
  const logs = []; const l = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  let code;
  try { code = await cli.run(argv); } finally { console.log = l; }
  return { code, out: logs.join('\n') };
}

describe('config sources (R-17)', () => {
  const rows = [['server.port', 9000], ['server.host', '127.0.0.1'], ['logLevel', 'info'], ['auth.sessionSecret', null]];
  const defaults = { server: { port: 3000, host: '127.0.0.1' }, logLevel: 'info', auth: { sessionSecret: 'x' } };
  it('says where each value comes from and whether it differs from the default', () => {
    const r = Object.fromEntries(describeSources(rows, { fileConfig: { server: { port: 9000 }, logLevel: 'info' }, envPaths: ['server.host'], defaults }).map((x) => [x.path, x]));
    expect(r['server.port']).toMatchObject({ source: 'file', changed: true });
    expect(r['server.host']).toMatchObject({ source: 'env', changed: false });
    expect(r.logLevel).toMatchObject({ source: 'file', changed: false });
    expect(r['auth.sessionSecret']).toMatchObject({ value: null, changed: null });
  });
  it('without defaults the comparison is unknown, not false', () => {
    expect(describeSources([['a', 1]], { fileConfig: { a: 1 } })[0].changed).toBe(null);
  });
});

describe('config show', () => {
  const config = { appName: 'x', env: 'development', server: { port: 9000 }, auth: { sessionSecret: 'super-secret-value-123456' } };
  const make = () => {
    const cli = createCli({ name: 'app' });
    registerConfigCheckCommand(cli, { loadConfigFn: async ({ report }) => { report.fileConfig = { server: { port: 9000 } }; report.envPaths = []; return config; }, cwd: '.' });
    return cli;
  };
  it('lists values with their source and never prints a secret', async () => {
    const r = await run(make(), ['config', 'show']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('server.port');
    expect(r.out).toContain('file');
    expect(r.out).not.toContain('super-secret-value');
    expect(r.out).toContain('(hidden)');
  });
  it('filters by text and with --changed; --json is parseable', async () => {
    const t = await run(make(), ['config', 'show', 'server']);
    expect(t.out).toContain('server.port');
    expect(t.out).not.toContain('appName');
    const j = JSON.parse((await run(make(), ['config', 'show', '--json'])).out);
    expect(j.find((x) => x.path === 'server.port').source).toBe('file');
    expect(JSON.stringify(j)).not.toContain('super-secret-value');
  });
});
