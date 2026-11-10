import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import * as audit from '../src/audit/index.js';
import { eraseUserData } from '../src/privacy/erase.js';

const mem = () => createSqliteAdapter({ file: ':memory:' });

describe('audit pseudonyms (F03)', () => {
  it('stores pseudonyms, returns real values', () => {
    const db = mem();
    const e = audit.log(db, { actor: 'alice', action: 'a.b', ip: '10.0.0.5', meta: { username: 'alice', n: 1 } });
    expect(e.actor).toBe('alice');
    expect(e.ip).toBe('10.0.0.5');
    const raw = db.get('SELECT actor, ip, meta FROM audit_log');
    expect(raw.actor).toMatch(/^~a:[0-9a-f]{16}$/);
    expect(raw.ip).toMatch(/^~i:/);
    expect(raw.meta.includes('alice')).toBe(false);
    expect(audit.tail(db)[0].meta.username).toBe('alice');
    expect(audit.query(db, { actor: 'alice' }).length).toBe(1);
    expect(audit.log(db, { actor: 'system', action: 'x' }).actor).toBe('system');
    expect(db.get("SELECT actor FROM audit_log WHERE action = 'x'").actor).toBe('system');
  });

  it('same value, same pseudonym', () => {
    const db = mem();
    audit.log(db, { actor: 'bob', action: 'a' });
    audit.log(db, { actor: 'bob', action: 'b' });
    expect(db.all('SELECT DISTINCT actor FROM audit_log').length).toBe(1);
  });

  it('erase keeps the chain valid and reads [erased]', () => {
    const db = mem();
    audit.log(db, { actor: 'carol', action: 'a', ip: '1.1.1.1', meta: { login: 'carol' } });
    audit.log(db, { actor: 'dave', action: 'b', ip: '2.2.2.2' });
    audit.log(db, { actor: 'carol', action: 'c', ip: '2.2.2.2' });
    const r = audit.eraseSubjects(db, { usernames: ['carol'] });
    expect(r.actors).toBe(1);
    expect(r.ips).toBe(1); // 1.1.1.1 only carol's; 2.2.2.2 is shared with dave
    const rows = audit.query(db, { limit: 10 });
    expect(rows.filter((x) => x.actor === '[erased]').length).toBe(2);
    expect(rows.find((x) => x.action === 'a').ip).toBe('[erased]');
    expect(rows.find((x) => x.action === 'a').meta.login).toBe('[erased]');
    expect(rows.find((x) => x.action === 'b').actor).toBe('dave');
    expect(rows.find((x) => x.action === 'c').ip).toBe('2.2.2.2');
    expect(audit.verifyChain(db).ok).toBe(true);
    expect(audit.query(db, { actor: 'carol' }).length).toBe(0);
  });

  it('listeners get the raw (pseudonymized) entry', () => {
    const db = mem();
    let seen;
    const off = audit.onEntry(({ entry }) => { seen = entry; });
    audit.log(db, { actor: 'erin', action: 'a', ip: '3.3.3.3' });
    off();
    expect(seen.actor.startsWith('~a:')).toBe(true);
    expect(seen.ip.startsWith('~i:')).toBe(true);
  });

  it('privacy erase removes the login from the audit trail', async () => {
    const db = mem();
    audit.log(db, { actor: 'frank', action: 'a' });
    const res = await eraseUserData({
      db, userId: 1,
      findUserByIdFn: () => ({ id: 1, username: 'frank' }),
      anonymizeUserFn: () => true, deleteUserFn: () => true,
      moduleRegistry: { getDataSubjectHandlers: () => [] },
      auditLogFn: audit.log, eraseAuditSubjectsFn: audit.eraseSubjects,
    });
    expect(res.auditSubjects.actors).toBe(1);
    expect(audit.query(db, { action: 'a' })[0].actor).toBe('[erased]');
  });

  it('retention drops stale mappings; legacy plain rows still read', () => {
    const db = mem();
    audit.log(db, { actor: 'gina', action: 'a' });
    db.run("UPDATE audit_subjects SET last_seen_day = '2020-01-01'");
    audit.purgeOlderThan(db, '2021-01-01T00:00:00.000Z');
    expect(db.get('SELECT COUNT(*) AS c FROM audit_subjects').c).toBe(0);
    db.run("INSERT INTO audit_log (actor, action, ip) VALUES ('old', 'legacy', '9.9.9.9')");
    const e = audit.query(db, { action: 'legacy' })[0];
    expect(e.actor).toBe('old');
    expect(e.ip).toBe('9.9.9.9');
  });
});
