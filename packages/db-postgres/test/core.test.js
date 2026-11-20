import { describe, it, expect, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { openTestDb, pgConfigured } from './support/pg-test-db.js';
import { ensureAuthTablesAsync, createUserAsync, findUserByUsernameAsync } from '@das-forge/core/auth';
import { logAsync, queryAsync, verifyChainAsync, ensureAuditTableAsync } from '@das-forge/core/audit';
import { createNotifications, ensureNotificationsTableAsync } from '@das-forge/core/notifications';
import { createAlerts, ensureAlertsTableAsync } from '@das-forge/core/alerts';
import { createEmailQueue, ensureEmailQueueTableAsync } from '@das-forge/core/email';
import { createIncidentRegister, ensureIncidentTableAsync } from '@das-forge/core/privacy';
import { createRegistrationStore, ensureRegistrationsTableAsync } from '@das-forge/core/accounts';
import { createDbLastRunStore, ensureSchedulerStateTableAsync } from '@das-forge/core/scheduler';
import { ensureMetricsTableAsync, createMetrics } from '@das-forge/core/admin';
import { runMigrationsAsync, migrationStatusAsync } from '@das-forge/core/cli';

describe.skipIf(!pgConfigured)('core modules on PostgreSQL', () => {
  let db;
  const ready = async () => { db ??= await openTestDb(); return db; };
  afterAll(async () => { await db?.close(); });

  it('auth: tables, a user, the UNIQUE rule', async () => {
    const d = await ready();
    await ensureAuthTablesAsync(d);
    const u = await createUserAsync(d, { username: 'ann', email: 'Ann@Example.com', passwordHash: 'h', role: 'admin' });
    expect(u.id).toBeGreaterThan(0);
    expect((await findUserByUsernameAsync(d, 'ann')).username).toBe('ann');
    await expect(createUserAsync(d, { username: 'ann', passwordHash: 'x' })).rejects.toThrow(/UNIQUE/);
  });

  it('audit: hash chain stays valid, the table is append-only', async () => {
    const d = await ready();
    await ensureAuditTableAsync(d);
    for (let i = 0; i < 4; i += 1) await logAsync(d, { actor: `u${i}`, action: 'auth.login', meta: { n: i } });
    await Promise.all([1, 2, 3].map((i) => logAsync(d, { actor: 'p', action: 'auth.logout', meta: { n: i } })));
    const v = await verifyChainAsync(d);
    expect(v.ok).toBe(true);
    expect(v.checked).toBe(7);
    expect((await queryAsync(d, { limit: 20 })).length).toBe(7);
    await expect(d.run('UPDATE audit_log SET action = ?', ['x'])).rejects.toThrow(/append-only/);
  });

  it('notifications, alerts, incidents, registrations, scheduler state, metrics', async () => {
    const d = await ready();
    await d.exec('ALTER TABLE users ADD COLUMN IF NOT EXISTS dummy INTEGER');
    await ensureNotificationsTableAsync(d);
    const n = createNotifications({ db: d });
    const id = await n.notifyAsync({ userId: 1, title: 'Hello', severity: 'warning' });
    expect(id).toBeGreaterThan(0);
    expect(await n.unreadCountAsync(1)).toBe(1);
    expect(await n.markReadAsync(1, id)).toBe(1);
    expect(await n.notifyRoleAsync('admin', { title: 'to admins' })).toBe(1);

    await ensureAlertsTableAsync(d);
    const al = createAlerts({ db: d, cooldownMs: 1000 });
    expect((await al.raiseAsync({ key: 'k', severity: 'critical', title: 'Boom' })).raised).toBe(true);
    expect((await al.raiseAsync({ key: 'k', title: 'Boom' })).raised).toBe(false);
    expect((await al.listAsync())[0].repeats).toBe(1);

    await ensureIncidentTableAsync(d);
    const reg = createIncidentRegister(d);
    const inc = await reg.declareAsync({ title: 'Leak', personalData: true, severity: 'high', actor: 'dpo' });
    expect(inc.status).toBe('open');
    expect((await reg.updateAsync(inc.id, { status: 'closed' })).closedAt).not.toBeNull();

    await ensureRegistrationsTableAsync(d);
    const regs = createRegistrationStore(d);
    const token = await regs.addAsync({ username: 'bob', email: 'b@x.io', passwordHash: 'h', ip: '1.1.1.1' });
    expect(await regs.recentAsync({ email: 'B@x.io', sinceMs: 60_000 })).toBe(1);
    expect((await regs.consumeAsync(token)).username).toBe('bob');
    expect(await regs.consumeAsync(token)).toBeNull();

    await ensureSchedulerStateTableAsync(d);
    const store = createDbLastRunStore(d);
    await store.setAsync('job', '2026-01-01T00:00:00.000Z');
    expect(await store.getAsync('job')).toBe('2026-01-01T00:00:00.000Z');
    await store.setAsync('job', '2026-02-01T00:00:00.000Z');
    expect(await store.getAsync('job')).toBe('2026-02-01T00:00:00.000Z');

    await ensureMetricsTableAsync(d);
    const m = createMetrics(d, { synchronous: false });
    m.inc('http.requests', 3);
    expect(await m.flushAsync()).toBeGreaterThan(0);
    expect((await m.seriesAsync('http.requests', { hours: 2 })).at(-1).value).toBe(3);
  });

  it('e-mail queue sends, retries and keeps the order', async () => {
    const d = await ready();
    await ensureEmailQueueTableAsync(d);
    const sent = [];
    const q = createEmailQueue({ db: d, send: async (m) => { sent.push(m.subject); } });
    await q.enqueueAsync({ to: ['alice@example.com'], subject: 'Hi' }, { scenario: 'reset' });
    expect((await q.listAsync())[0].recipients).toEqual(['a***@example.com']);
    expect(await q.processDueAsync()).toEqual({ sent: 1, retried: 0, failed: 0 });
    expect(sent).toEqual(['Hi']);
    expect((await q.statsAsync()).sent).toBe(1);
  });

  it('migrator: applies in order inside transactions, rolls back a failure, refuses an edited one', async () => {
    const d = await ready();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'das-pgmig-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '001_a.js'), 'export async function up(db) { await db.exec("CREATE TABLE mig_a (x INTEGER)"); }');
    writeFileSync(path.join(dir, '002_b.js'), 'export async function up(db) { await db.exec("CREATE TABLE mig_b (x INTEGER)"); if (globalThis.failMigration) throw new Error("boom"); }');
    globalThis.failMigration = true;
    await expect(runMigrationsAsync(d, dir)).rejects.toThrow('boom');
    globalThis.failMigration = false;
    expect((await migrationStatusAsync(d, dir)).map((m) => m.applied)).toEqual([true, false]);
    expect(await d.get("SELECT 1 AS x FROM information_schema.tables WHERE table_name = 'mig_b'")).toBeUndefined();
    expect((await runMigrationsAsync(d, dir)).applied.map((m) => m.version)).toEqual([2]);
    writeFileSync(path.join(dir, '001_a.js'), '// edited\nexport async function up() {}');
    await expect(runMigrationsAsync(d, dir)).rejects.toThrow(/modified after being applied/);
  });
});
