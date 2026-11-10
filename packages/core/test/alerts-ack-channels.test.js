import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { createAlerts, webhookChannel } from '../src/alerts/index.js';

function setup(extra = {}) {
  const db = createSqliteAdapter({ file: ':memory:' });
  let t = Date.parse('2030-01-01T00:00:00Z');
  const sent = [];
  const email = { enabled: true, sendAlert: async (a) => { if (extra.mailFails) throw Object.assign(new Error('x'), { code: 'SMTP_DOWN' }); sent.push(['mail', a.title]); } };
  const hook = { name: 'hook', send: async (a) => { sent.push(['hook', a.title]); } };
  const alerts = createAlerts({ db, email, contacts: ['a@example.com'], channels: extra.noHook ? [] : [hook], cooldownMs: 1000, now: () => t, ...extra.opts });
  return { db, alerts, sent, tick: (ms) => { t += ms; } };
}

describe('alerts: ack, mute, channels, escalation (R-11, R-12)', () => {
  it('goes to every channel; one working channel is enough when mail is down', async () => {
    const { alerts, sent } = setup({ mailFails: true });
    await alerts.raise({ key: 'k', severity: 'critical', title: 'T' });
    expect(sent).toEqual([['hook', 'T']]);
    const a = alerts.list()[0];
    expect(a.notified).toBe(1);
    expect(a.notifyError).toContain('mail:SMTP_DOWN');
  });

  it('ack marks once; a muted key is recorded but not announced; unmute restores', async () => {
    const { alerts, sent, tick } = setup();
    const { id } = await alerts.raise({ key: 'k', title: 'T' });
    expect(alerts.ack(id, 'ann')).toBe(true);
    expect(alerts.ack(id, 'bob')).toBe(false);
    expect(alerts.list()[0]).toMatchObject({ ackedBy: 'ann' });
    alerts.mute('quiet', 3_600_000, 'ann');
    sent.length = 0;
    const r = await alerts.raise({ key: 'quiet', title: 'Q' });
    expect(r.muted).toBe(true);
    expect(sent).toEqual([]);
    expect(alerts.list()[0].muted).toBe(1);
    expect(alerts.mutes()).toHaveLength(1);
    tick(2 * 3_600_000);
    expect(alerts.mutes()).toHaveLength(0);
    await alerts.raise({ key: 'quiet', title: 'Q2' });
    expect(sent.length).toBeGreaterThan(0);
  });

  it('maintenance mode silences announcements', async () => {
    const { alerts, sent } = setup({ opts: { maintenance: { get: () => ({ enabled: true }) } } });
    const r = await alerts.raise({ key: 'm', title: 'M' });
    expect(r.muted).toBe(true);
    expect(sent).toEqual([]);
  });

  it('escalates unacknowledged critical alerts once, skips acknowledged ones', async () => {
    const { alerts, sent, tick } = setup();
    const a = await alerts.raise({ key: 'a', severity: 'critical', title: 'A' });
    await alerts.raise({ key: 'b', severity: 'critical', title: 'B' });
    alerts.ack(a.id, 'ann');
    sent.length = 0;
    expect(await alerts.escalate({ afterMs: 60_000 })).toBe(0); // too early
    tick(120_000);
    expect(await alerts.escalate({ afterMs: 60_000 })).toBe(1);
    expect(sent.map((x) => x[1])).toEqual(['ESCALATION: B', 'ESCALATION: B']);
    expect(await alerts.escalate({ afterMs: 60_000 })).toBe(0); // only once
  });

  it('webhook and heartbeat accept only https and do not follow redirects', async () => {
    expect(() => webhookChannel({ url: 'http://example.com/x' })).toThrow();
    const calls = [];
    const fetchImpl = async (u, o) => { calls.push([String(u), o.redirect]); return { ok: true }; };
    await webhookChannel({ url: 'https://example.com/h', fetchImpl }).send({ title: 'x' });
    expect(calls[0]).toEqual(['https://example.com/h', 'error']);
    const { alerts } = setup();
    await expect(alerts.heartbeat('http://example.com/p')).rejects.toThrow();
    expect(await alerts.heartbeat('https://example.com/p', { fetchImpl })).toBe(true);
  });
});
