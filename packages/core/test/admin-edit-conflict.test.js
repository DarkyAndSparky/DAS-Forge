import { describe, it, expect } from 'vitest';
import { createSqliteAdapter } from '../src/database/index.js';
import { ensureAuthTables } from '../src/auth/schema.js';
import { createUser, findUserByUsername } from '../src/auth/users.js';
import { userVersion } from '../src/admin/sections-users.js';

describe('userVersion (G-03: lost update between two administrators)', () => {
  const base = { username: 'ann', email: 'ann@example.com', role: 'operator', disabled: 0 };

  it('is stable for the same account and changes with every editable field', () => {
    expect(userVersion(base)).toBe(userVersion({ ...base }));
    expect(userVersion(base) !== userVersion({ ...base, username: 'anna' })).toBe(true);
    expect(userVersion(base) !== userVersion({ ...base, email: 'x@example.com' })).toBe(true);
    expect(userVersion(base) !== userVersion({ ...base, role: 'admin' })).toBe(true);
    expect(userVersion(base) !== userVersion({ ...base, disabled: 1 })).toBe(true);
  });

  it('treats a missing e-mail as null and disabled as 0/1, so database and form agree', () => {
    expect(userVersion({ ...base, email: undefined })).toBe(userVersion({ ...base, email: null }));
    expect(userVersion({ ...base, disabled: true })).toBe(userVersion({ ...base, disabled: 1 }));
  });

  it('matches the fingerprint of a row read back from the database', () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    ensureAuthTables(db);
    createUser(db, { username: 'bob', email: 'bob@example.com', passwordHash: 'h', role: 'operator' });
    const u = findUserByUsername(db, 'bob');
    expect(userVersion(u)).toBe(userVersion({ username: 'bob', email: 'bob@example.com', role: 'operator', disabled: 0 }));
  });
});
