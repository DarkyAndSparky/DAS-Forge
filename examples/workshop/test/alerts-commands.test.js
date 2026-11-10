import { describe, it, expect, vi, afterEach } from 'vitest';
import { database } from '@das-forge/core';
import { registerAlertsCommands } from '../src/alerts-commands.js';

function fakeCli() {
  const commands = new Map();
  return { command: (name, spec) => commands.set(name, spec), run: (name, flags = {}) => commands.get(name).handler({ positionals: [], flags }), commands };
}

function setup({ enabled = true, mail = true } = {}) {
  const db = database.createSqliteAdapter({ file: ':memory:' });
  const sent = [];
  const ctx = {
    appConfig: {
      alerts: { enabled, cooldownMinutes: 60, keepDays: 90, lockouts: { threshold: 10, windowMinutes: 10 } },
      security: { incidentContacts: mail ? ['ops@example.com'] : [] },
      email: { locale: 'en' },
    },
    emailService: { enabled: mail, sendAlert: async (m) => { sent.push(m); } },
  };
  const cli = fakeCli();
  registerAlertsCommands(cli, { ctx, getDb: () => db });
  return { cli, db, sent };
}

const logs = () => {
  const lines = [];
  vi.spyOn(console, 'log').mockImplementation((l) => lines.push(String(l)));
  vi.spyOn(console, 'error').mockImplementation((l) => lines.push(String(l)));
  return lines;
};
afterEach(() => vi.restoreAllMocks());

describe('alerts test / alerts list', () => {
  it('registers both commands with help text', () => {
    const { cli } = setup();
    for (const name of ['alerts test', 'alerts list']) {
      expect(cli.commands.get(name).description.length).toBeGreaterThan(10);
      expect(cli.commands.get(name).examples.length).toBeGreaterThan(0);
    }
  });

  it('test raises a real alert, mails the contacts and list shows it', async () => {
    const { cli, sent } = setup();
    const lines = logs();
    expect(await cli.run('alerts test', { severity: 'critical', message: 'disk is full' })).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: ['ops@example.com'], severity: 'critical', message: 'disk is full' });
    expect(lines.join('\n')).toContain('Mail queued');
    lines.length = 0;
    expect(await cli.run('alerts list')).toBe(0);
    expect(lines.join('\n')).toContain('critical');
    expect(lines.join('\n')).toContain('disk is full');
  });

  it('says plainly when nobody would be mailed', async () => {
    const { cli, sent } = setup({ mail: false });
    const lines = logs();
    expect(await cli.run('alerts test')).toBe(0);
    expect(sent).toHaveLength(0);
    expect(lines.join('\n')).toContain('No mail');
  });

  it('refuses an unknown severity and reports switched-off alerts', async () => {
    const { cli } = setup();
    logs();
    expect(await cli.run('alerts test', { severity: 'loud' })).toBe(2);
    const off = setup({ enabled: false });
    expect(await off.cli.run('alerts test')).toBe(1);
    expect(off.cli.run('alerts list')).toBe(1);
  });

  it('list is empty before anything was raised and supports --json', async () => {
    const { cli } = setup();
    const lines = logs();
    expect(await cli.run('alerts list')).toBe(0);
    expect(lines.join('\n')).toContain('No alerts.');
    lines.length = 0;
    await cli.run('alerts test');
    await cli.run('alerts list', { json: true });
    expect(JSON.parse(lines.at(-1))[0]).toMatchObject({ title: 'Test alert', severity: 'warning' });
  });
});
