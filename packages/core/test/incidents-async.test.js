import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { ensureAuditTableAsync } from '../src/audit/index.js';
import { createIncidentRegister, ensureIncidentTableAsync, IncidentError } from '../src/privacy/incidents.js';

const fresh = () => createSqliteAdapter({ file: ':memory:', walMode: false });

describe('incident register over the asynchronous database', () => {
  it('declares, updates, lists, counts and finds overdue ones; shares rows with the sync methods', async () => {
    const db = fresh();
    await ensureAuditTableAsync(db);
    await ensureIncidentTableAsync(db);
    let t = Date.parse('2026-01-01T00:00:00Z');
    const reg = createIncidentRegister(db, { now: () => t });
    const inc = await reg.declareAsync({ title: 'Leak', personalData: true, severity: 'high', actor: 'dpo' });
    expect(inc.status).toBe('open');
    expect(reg.get(inc.id).title).toBe('Leak');
    t += 25 * 3600 * 1000;
    expect((await reg.overdueAsync()).length).toBe(1);
    const upd = await reg.updateAsync(inc.id, { firstNoticeAt: new Date(t).toISOString(), measures: 'rotated keys', actor: 'dpo' });
    expect(upd.firstNoticeDue.done).toBe(true);
    expect((await reg.updateAsync(inc.id, {})).measures).toBe('rotated keys');
    const closed = await reg.updateAsync(inc.id, { status: 'closed' });
    expect(closed.closedAt).not.toBeNull();
    expect(await reg.countAsync({ status: 'closed' })).toBe(1);
    expect((await reg.listAsync({ status: 'open' })).length).toBe(0);
    expect((await reg.listAsync()).length).toBe(1);
  });
  it('rejects bad input with an IncidentError code and leaves the row alone', async () => {
    const db = fresh();
    await ensureAuditTableAsync(db);
    await ensureIncidentTableAsync(db);
    const reg = createIncidentRegister(db);
    const code = async (fn) => { try { await fn(); } catch (e) { return e.code; } return null; };
    expect(await code(() => reg.declareAsync({ title: '' }))).toBe('TITLE_INVALID');
    expect(await code(() => reg.updateAsync(99, { status: 'closed' }))).toBe('NOT_FOUND');
    const i = await reg.declareAsync({ title: 'x' });
    expect(await code(() => reg.updateAsync(i.id, { status: 'bogus' }))).toBe('STATUS_INVALID');
    expect((await reg.getAsync(i.id)).status).toBe('open');
    expect(IncidentError).toBeDefined();
  });
});
