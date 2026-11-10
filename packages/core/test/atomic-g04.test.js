import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { atomic } from '../src/database/atomic.js';
import { ensureAuthTables } from '../src/auth/schema.js';
import { createUser } from '../src/auth/users.js';
import { changeUserRole, setUserDisabled, removeUser, requirePasswordChangeForAll } from '../src/auth/user-admin.js';
import { createBans } from '../src/security/bans.js';
import { pseudonymize, ensureSubjectsTable } from '../src/audit/subjects.js';

function setup() {
  const db = createSqliteAdapter({ file: ':memory:' });
  ensureAuthTables(db);
  createUser(db, { username: 'root', passwordHash: 'h', role: 'admin' });
  createUser(db, { username: 'op', passwordHash: 'h', role: 'operator' });
  const id = (n) => db.get('SELECT id FROM users WHERE username = ?', [n]).id;
  return { db, id };
}

describe('atomic()', () => {
  it('commits together, rolls back together, nests, and falls back for an adapter without transaction', () => {
    const { db } = setup();
    atomic(db, () => { db.run("UPDATE users SET email = 'a@x' WHERE username = 'op'"); });
    expect(db.get("SELECT email FROM users WHERE username = 'op'").email).toBe('a@x');
    expect(() => atomic(db, () => { db.run("UPDATE users SET email = 'b@x' WHERE username = 'op'"); throw new Error('boom'); })).toThrow();
    expect(db.get("SELECT email FROM users WHERE username = 'op'").email).toBe('a@x');
    expect(atomic(db, () => atomic(db, () => 7))).toBe(7);
    expect(atomic({ marker: 1 }, (d) => d.marker)).toBe(1);
  });
});

describe('last administrator: the check and the change are one transaction (G-04)', () => {
  it('cannot be demoted, disabled or removed; with two administrators one can be demoted', () => {
    const { db, id } = setup();
    for (const f of [
      () => changeUserRole(db, id('root'), 'operator', { adminRole: 'admin' }),
      () => setUserDisabled(db, id('root'), true),
      () => removeUser(db, id('root')),
    ]) {
      let code = null;
      try { f(); } catch (e) { code = e.code; }
      expect(code).toBe('LAST_ADMIN');
    }
    changeUserRole(db, id('op'), 'admin', { adminRole: 'admin' });
    expect(changeUserRole(db, id('op'), 'operator', { adminRole: 'admin' }).changed).toBe(true);
  });

  it('requirePasswordChangeForAll is all-or-nothing when the surrounding transaction fails', () => {
    const { db, id } = setup();
    expect(() => db.transaction(() => { requirePasswordChangeForAll(db, { exceptId: id('root') }); throw new Error('boom'); })).toThrow();
    expect(db.get("SELECT must_change_password AS m FROM users WHERE username = 'op'").m).toBe(0);
    expect(requirePasswordChangeForAll(db, { exceptId: id('root') }).affected).toBe(1);
  });
});

describe('bans: check, insert and audit line together', () => {
  it('a second ban of the same value reports `already`; lifting is audited once', () => {
    const { db } = setup();
    const bans = createBans(db);
    const b1 = bans.ban({ kind: 'ip', value: '10.0.0.1', reason: 't', by: 'root' });
    const b2 = bans.ban({ kind: 'ip', value: '10.0.0.1', by: 'root' });
    expect(b1.already).toBe(false);
    expect(b2.already).toBe(true);
    expect(b2.id).toBe(b1.id);
    expect(db.get('SELECT COUNT(*) AS c FROM security_bans').c).toBe(1);
    expect(db.get("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'security.ban'").c).toBe(1);
    expect(bans.lift({ id: b1.id, by: 'root' })).toBe(1);
    expect(bans.lift({ id: b1.id, by: 'root' })).toBe(0);
    expect(db.get("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'security.unban'").c).toBe(1);
  });
});

describe('pseudonymize: another process added the value between SELECT and INSERT', () => {
  it('uses the other pseudonym instead of failing on UNIQUE (kind, value)', () => {
    const { db } = setup();
    ensureSubjectsTable(db);
    const real = db.get.bind(db);
    let raced = false;
    const racing = {
      ...db,
      run: db.run.bind(db),
      get: (sql, p) => {
        if (!raced && /FROM audit_subjects WHERE kind = \? AND value = \?/.test(sql) && p[1] === '10.2.2.2') {
          raced = true;
          db.run("INSERT INTO audit_subjects (pseudonym, kind, value, created_at, last_seen_day) VALUES ('~i:other', 'ip', '10.2.2.2', 'x', 'x')");
          return undefined;
        }
        return real(sql, p);
      },
    };
    expect(pseudonymize(racing, 'ip', '10.2.2.2')).toBe('~i:other');
    expect(pseudonymize(db, 'ip', '10.2.2.2')).toBe('~i:other');
  });
});
