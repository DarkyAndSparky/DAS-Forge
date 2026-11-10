import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { ensureAuthTables } from '../src/auth/schema.js';
import * as audit from '../src/audit/index.js';
import { eraseSubjects } from '../src/audit/subjects.js';

function withUsers() {
  const db = createSqliteAdapter({ file: ':memory:' });
  ensureAuthTables(db);
  db.run("INSERT INTO users (username, password_hash, role) VALUES ('alice', 'x', 'operator')");
  return { db, id: db.get("SELECT id FROM users WHERE username = 'alice'").id };
}

describe('the object of an event is named at the time of the event', () => {
  it('a user event gets the login found by id, kept as a pseudonym, and it survives a rename', () => {
    const { db, id } = withUsers();
    audit.log(db, { actor: 'root', action: 'admin.user.force_logout', entity: 'user', entityId: id });
    db.run("UPDATE users SET username = 'alice2' WHERE id = ?", [id]);
    audit.log(db, { actor: 'root', action: 'admin.user.force_logout', entity: 'user', entityId: id });
    const names = audit.query(db, { entity: 'user' }).map((e) => e.meta.username); // newest first
    expect(names).toEqual(['alice2', 'alice']);
    expect(db.get('SELECT meta FROM audit_log ORDER BY id LIMIT 1').meta.includes('alice')).toBe(false); // only a pseudonym in the row
  });

  it('erasing the person turns the label into [erased], the chain stays valid', () => {
    const { db, id } = withUsers();
    audit.log(db, { actor: 'root', action: 'admin.user.disable', entity: 'user', entityId: id });
    eraseSubjects(db, { usernames: ['alice'] });
    expect(audit.query(db, { entity: 'user' })[0].meta.username).toBe('[erased]');
    expect(audit.verifyChain(db).ok).toBe(true);
  });

  it('what the caller wrote is kept; another object takes an explicit label as `target`', () => {
    const { db, id } = withUsers();
    audit.log(db, { action: 'admin.user.update', entity: 'user', entityId: id, meta: { username: 'someone-else' } });
    expect(audit.query(db, { entity: 'user' })[0].meta.username).toBe('someone-else');
    audit.log(db, { action: 'asset.update', entity: 'asset', entityId: 7, entityLabel: 'Станок №3', meta: { changes: 1 } });
    expect(audit.query(db, { entity: 'asset' })[0].meta).toEqual({ changes: 1, target: 'Станок №3' });
  });

  it('no such user, no users table, or a non-numeric id: no label and no error', () => {
    const { db } = withUsers();
    audit.log(db, { action: 'a', entity: 'user', entityId: 9999 });
    audit.log(db, { action: 'b', entity: 'user', entityId: 'abc' });
    expect(audit.query(db, { entity: 'user' }).every((e) => e.meta.username === undefined)).toBe(true);
    const bare = createSqliteAdapter({ file: ':memory:' });
    expect(() => audit.log(bare, { action: 'c', entity: 'user', entityId: 1 })).not.toThrow();
    expect(audit.query(bare, {})[0].meta).toEqual({});
  });
});
