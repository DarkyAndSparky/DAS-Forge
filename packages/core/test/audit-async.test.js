import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import * as audit from '../src/audit/index.js';

const fresh = () => createSqliteAdapter({ file: ':memory:', walMode: false });

describe('asynchronous audit', () => {
  it('logAsync writes the same row shape as log and keeps ONE hash chain with it', async () => {
    const db = fresh();
    const a = audit.log(db, { actor: 'alice', action: 'x.one', ip: '10.0.0.1', meta: { password: 'p', username: 'bob' } });
    const b = await audit.logAsync(db, { actor: 'alice', action: 'x.two', ip: '10.0.0.1', entity: 'thing', entityId: 7, entityLabel: 'Box' });
    expect(a.actor).toBe('alice');
    expect(b.actor).toBe('alice');
    expect(b.ip).toBe('10.0.0.1');
    expect(a.meta.password).toBe('[REDACTED]');
    expect(b.meta.target).toBe('Box');
    expect(db.get('SELECT actor FROM audit_log WHERE id = ?', [b.id]).actor).toMatch(/^~a:/);
    audit.log(db, { action: 'x.three' });
    expect(audit.verifyChain(db)).toMatchObject({ ok: true, checked: 3 });
    expect(await audit.verifyChainAsync(db)).toMatchObject({ ok: true, checked: 3 });
  });

  it('rejects bad input and tells the subscribers', async () => {
    const db = fresh();
    await expect(audit.logAsync(db, {})).rejects.toThrow(/action/);
    await expect(audit.logAsync(db, { action: 'a', result: 'weird' })).rejects.toThrow(/result/);
    const seen = [];
    const off = audit.onEntry((e) => seen.push(e.entry.action));
    await audit.logAsync(db, { action: 'seen.me' });
    off();
    expect(seen).toEqual(['seen.me']);
  });

  it('tail / query / page / count give what the synchronous ones give', async () => {
    const db = fresh();
    for (let i = 0; i < 5; i++) await audit.logAsync(db, { actor: i % 2 ? 'bob' : 'alice', action: i === 4 ? 'z.last' : 'a.b', entity: 'e', entityId: i });
    expect(await audit.tailAsync(db, { limit: 2 })).toEqual(audit.tail(db, { limit: 2 }));
    expect(await audit.queryAsync(db, { actor: 'bob' })).toEqual(audit.query(db, { actor: 'bob' }));
    expect(await audit.countAsync(db, { actor: 'alice' })).toBe(3);
    const p1 = await audit.pageAsync(db, { limit: 2 });
    expect(p1.items.length).toBe(2);
    const p2 = await audit.pageAsync(db, { limit: 2, beforeId: p1.nextBeforeId });
    expect(p2.items[0].id < p1.items[1].id).toBe(true);
    expect((await audit.queryAsync(db, { actionPrefix: 'z.' })).length).toBe(1);
  });

  it('detects a modified row, and an anchor detects a truncated tail', async () => {
    const db = fresh();
    for (let i = 0; i < 3; i++) await audit.logAsync(db, { action: `n.${i}` });
    const anc = await audit.anchorAsync(db);
    expect(anc.count).toBe(3);
    db.exec('DROP TRIGGER audit_log_no_update');
    db.run("UPDATE audit_log SET action = 'hacked' WHERE id = 2");
    expect(await audit.verifyChainAsync(db)).toMatchObject({ ok: false, brokenAtId: 2 });
    db.run('DELETE FROM audit_log WHERE id = 3');
    expect((await audit.verifyChainAsync(db, { anchor: anc })).ok).toBe(false);
  });

  it('erasing a subject makes the rows read [erased]; the chain stays valid', async () => {
    const db = fresh();
    await audit.logAsync(db, { actor: 'carol', action: 'q.a', ip: '1.2.3.4' });
    await audit.logAsync(db, { actor: 'dave', action: 'q.b', ip: '5.6.7.8' });
    const r = await audit.eraseSubjectsAsync(db, { usernames: ['carol'] });
    expect(r).toEqual({ actors: 1, ips: 1 });
    const rows = await audit.queryAsync(db, {});
    expect(rows.find((x) => x.action === 'q.a')).toMatchObject({ actor: '[erased]', ip: '[erased]' });
    expect(rows.find((x) => x.action === 'q.b')).toMatchObject({ actor: 'dave', ip: '5.6.7.8' });
    expect((await audit.verifyChainAsync(db)).ok).toBe(true);
  });

  it('purgeOlderThanAsync removes old rows in batches and can record itself; purgePersonalDataAsync checks days', async () => {
    const db = fresh();
    for (let i = 0; i < 5; i++) await audit.logAsync(db, { action: `old.${i}` });
    const removed = await audit.purgeOlderThanAsync(db, new Date(Date.now() + 1000).toISOString(), { batchSize: 2, record: true });
    expect(removed).toBe(5);
    expect((await audit.queryAsync(db, {})).map((e) => e.action)).toEqual(['audit.purge']);
    await expect(audit.purgePersonalDataAsync(db, 0)).rejects.toThrow(/days/);
    expect(await audit.purgePersonalDataAsync(db, 1)).toBe(0);
  });

  it('works inside an asynchronous transaction and rolls back with it', async () => {
    const db = fresh();
    const { asyncDb } = await import('../src/database/index.js');
    await audit.ensureAuditTableAsync(db); // the table is made at start-up, not inside a transaction that may roll back
    await expect(asyncDb(db).transaction(async (tx) => { await audit.logAsync(tx, { action: 'tx.in' }); throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await audit.countAsync(db)).toBe(0);
  });
});
