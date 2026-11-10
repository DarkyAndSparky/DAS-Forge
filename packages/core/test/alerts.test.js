import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { createAlerts } from '../src/alerts/index.js';
import { createFailureTracker } from '../src/http/rate-limit.js';
import { createAdmin } from '../src/admin/index.js';
import { ensureAuthTables } from '../src/auth/schema.js';
import { log as auditLog } from '../src/audit/index.js';

function setup(extra = {}) {
  const db = createSqliteAdapter({ file: ':memory:' });
  ensureAuthTables(db);
  const sent = [];
  const email = { enabled: true, sendAlert: async (m) => { sent.push(m); return { sent: true }; } };
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const logger = { warn: () => {}, error: () => {} };
  const alerts = createAlerts({ db, email, contacts: ['ops@example.com'], logger, cooldownMs: 60_000, now: clock.now, ...extra });
  return { db, sent, email, clock, alerts };
}

describe('alerts', () => {
  it('stores an alert, mails the contacts once and counts repeats inside the cooldown', async () => {
    const { alerts, sent, clock } = setup();
    const a = await alerts.raise({ key: 'k', severity: 'critical', title: 'Backup failed', message: 'disk full' });
    expect(a.raised).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: ['ops@example.com'], title: 'Backup failed', severity: 'critical' });
    const b = await alerts.raise({ key: 'k', title: 'Backup failed', message: 'disk full' });
    expect(b.raised).toBe(false);
    expect(sent).toHaveLength(1);
    expect(alerts.list()[0]).toMatchObject({ repeats: 1, notified: 1 });
    clock.advance(61_000);
    expect((await alerts.raise({ key: 'k', title: 'Backup failed' })).raised).toBe(true);
    expect(sent).toHaveLength(2);
    expect(alerts.list()).toHaveLength(2);
  });

  it('keeps the alert and records the error when the mail fails, and never throws', async () => {
    const { alerts, email } = setup();
    email.sendAlert = async () => { throw Object.assign(new Error('smtp down'), { code: 'EMAIL_SEND_FAILED' }); };
    const r = await alerts.raise({ key: 'x', title: 'T' });
    expect(r.raised).toBe(true);
    expect(alerts.list()[0]).toMatchObject({ notified: 0, notifyError: 'EMAIL_SEND_FAILED' });
  });

  it('does not mail without contacts or with mail off, but still records', async () => {
    const off = setup({ contacts: [] });
    await off.alerts.raise({ key: 'x', title: 'T' });
    expect(off.sent).toHaveLength(0);
    expect(off.alerts.list()).toHaveLength(1);
  });

  it('cleans control characters, clips long text and normalises the severity', async () => {
    const { alerts } = setup();
    await alerts.raise({ key: 'x', severity: 'bogus', title: `a\u0000b${'t'.repeat(500)}`, message: 'm'.repeat(5000) });
    const row = alerts.list()[0];
    expect(row.severity).toBe('warning');
    expect(row.title.startsWith('a b')).toBe(true);
    expect(row.title.length).toBe(200);
    expect(row.message.length).toBe(2000);
  });

  it('purge removes only old alerts', async () => {
    const { alerts, clock } = setup({ keepDays: 1 });
    await alerts.raise({ key: 'old', title: 'old' });
    clock.advance(2 * 86_400_000);
    await alerts.raise({ key: 'new', title: 'new' });
    expect(alerts.purge()).toBe(1);
    expect(alerts.list().map((a) => a.key)).toEqual(['new']);
  });

  it('onJobError: a failed backup is critical, any other job is a warning', async () => {
    const { alerts } = setup();
    await alerts.onJobError('backup', new Error('no space'));
    await alerts.onJobError('uploads-gc', new Error('boom'));
    const rows = alerts.list();
    expect(rows.find((r) => r.key === 'job:backup')).toMatchObject({ severity: 'critical', message: 'no space' });
    expect(rows.find((r) => r.key === 'job:uploads-gc').severity).toBe('warning');
  });

  it('lockoutWatcher raises one critical alert after the threshold and starts over', async () => {
    const { alerts, sent, clock } = setup();
    const onLock = alerts.lockoutWatcher({ threshold: 3, windowMs: 60_000 });
    const tracker = createFailureTracker({ maxFailures: 1, onLock });
    tracker.recordFailure('a'); tracker.recordFailure('b');
    await Promise.resolve();
    expect(alerts.list()).toHaveLength(0);
    tracker.recordFailure('c');
    await new Promise((r) => setTimeout(r, 0));
    expect(alerts.list()[0]).toMatchObject({ key: 'lockouts', severity: 'critical' });
    expect(sent).toHaveLength(1);
    clock.advance(1);
  });

  it('onLock fires once per lock-out and a throwing callback does not break the tracker', () => {
    let n = 0;
    const tracker = createFailureTracker({ maxFailures: 2, onLock: () => { n += 1; throw new Error('x'); } });
    tracker.recordFailure('k');
    expect(tracker.recordFailure('k').locked).toBe(true);
    tracker.recordFailure('k');
    expect(n).toBe(1);
  });

  it('checkAuditChain raises a critical alert for a tampered log and stays quiet for a clean one', async () => {
    const { alerts, db } = setup();
    auditLog(db, { action: 'a.one' });
    auditLog(db, { action: 'a.two' });
    expect((await alerts.checkAuditChain()).ok).toBe(true);
    expect(alerts.list()).toHaveLength(0);
    db.exec('DROP TRIGGER audit_log_no_update'); // what an intruder with file access would do first
    db.run(`UPDATE audit_log SET action = 'tampered' WHERE id = 1`);
    expect((await alerts.checkAuditChain()).ok).toBe(false);
    expect(alerts.list()[0]).toMatchObject({ key: 'audit-chain', severity: 'critical' });
  });

  it('checkDoctor raises one alert per failed check and ignores the port check', async () => {
    const { alerts } = setup();
    const report = { categories: [
      { name: 'Application', checks: [{ name: 'Port availability', status: 'fail', message: 'in use' }] },
      { name: 'Storage', checks: [{ name: 'data', status: 'fail', message: 'not writable' }, { name: 'ok', status: 'ok', message: '' }, { name: 'warn', status: 'warn', message: '' }] },
    ] };
    await alerts.checkDoctor(async () => report);
    const rows = alerts.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'doctor:Storage:data', message: 'not writable' });
    await alerts.checkDoctor(async () => { throw new Error('cannot run'); });
    expect(alerts.list()[0].key).toBe('doctor:run');
  });
});

describe('admin alerts section', () => {
  it('lists alerts, escapes their text and hints when mail is not configured', async () => {
    const { alerts, db } = setup();
    await alerts.raise({ key: 'x', severity: 'critical', title: '<b>T</b>', message: '<script>1</script>' });
    const routes = {};
    const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: () => {} };
    createAdmin({ db, alerts }).mount(app, { requireAuth: () => (q, s, n) => n(), requirePermission: () => (q, s, n) => n() });
    const chain = routes['GET /admin/alerts'];
    const res = await new Promise((resolve) => {
      const r = { body: '', locals: {}, set() { return this; }, type() { return this; }, status() { return this; }, send(b) { r.body = b; resolve(r); return r; } };
      let i = 0; const next = () => { const h = chain[i++]; if (h) h({ query: { lang: 'en' }, user: { permissions: [] }, headers: {} }, r, next); }; next();
    });
    expect(res.body).toContain('&lt;b&gt;T&lt;/b&gt;');
    expect(res.body).not.toContain('<script>1</script>');
    expect(res.body).toContain('security.incidentContacts');
    expect(res.body).toContain('critical');
  });
});
