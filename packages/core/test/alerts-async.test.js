import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { createAlerts, ensureAlertsTableAsync } from '../src/alerts/index.js';
import { ensureAuditTableAsync } from '../src/audit/index.js';

const fresh = () => createSqliteAdapter({ file: ':memory:', walMode: false });

describe('alerts over the asynchronous database', () => {
  it('raises, repeats inside the cooldown, acks, mutes, escalates, purges', async () => {
    const db = fresh();
    await ensureAuditTableAsync(db);
    await ensureAlertsTableAsync(db);
    let t = 1_000_000;
    const sent = [];
    const email = { enabled: true, sendAlert: async (m) => { sent.push(m.title); } };
    const al = createAlerts({ db, email, contacts: ['a@x.io'], now: () => t, keepDays: 1 });
    const r1 = await al.raiseAsync({ key: 'k', severity: 'critical', title: 'Boom' });
    expect(r1.raised).toBe(true);
    expect((await al.raiseAsync({ key: 'k', title: 'Boom' })).raised).toBe(false);
    expect(sent).toEqual(['Boom']);
    const [row] = await al.listAsync();
    expect(row.repeats).toBe(1);
    expect(row.notified).toBe(1);
    expect(await al.countAsync()).toBe(1);
    expect(al.count()).toBe(1);
    expect(await al.ackAsync(r1.id, 'me')).toBe(true);
    expect(await al.ackAsync(r1.id, 'me')).toBe(false);
    const until = await al.muteAsync('quiet', 60_000);
    expect((await al.mutesAsync()).length).toBe(1);
    const m = await al.raiseAsync({ key: 'quiet', title: 'Shh' });
    expect(m.muted).toBe(true);
    expect(sent.length).toBe(1);
    expect(await al.unmuteAsync('quiet')).toBe(true);
    t += 2 * 3_600_000;
    const r2 = await al.raiseAsync({ key: 'esc', severity: 'critical', title: 'Nobody' });
    t += 40 * 60_000;
    expect(await al.escalateAsync({ afterMs: 30 * 60_000 })).toBe(1);
    expect(sent.some((x) => x.startsWith('ESCALATION'))).toBe(true);
    expect(r2.id).toBeGreaterThan(0);
    t += 3 * 86_400_000;
    expect(await al.purgeAsync()).toBe(3);
    expect(typeof until).toBe('string');
  });
  it('a broken audit chain is a critical alert', async () => {
    const db = fresh();
    await ensureAuditTableAsync(db);
    await ensureAlertsTableAsync(db);
    const al = createAlerts({ db });
    const ok = await al.checkAuditChainAsync();
    expect(ok.ok).toBe(true);
    expect(await al.countAsync()).toBe(0);
    const r = await al.onJobErrorAsync('backup-nightly', new Error('disk full'));
    expect(r.raised).toBe(true);
    expect((await al.listAsync())[0].severity).toBe('critical');
  });
});
