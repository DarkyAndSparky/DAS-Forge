import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { createSqliteAdapter } from '../src/database/index.js';
import { createUser } from '../src/auth/users.js';
import { destroyUserSessions, hashSessionId } from '../src/auth/sessions.js';
import { ensureAuthTables } from '../src/auth/schema.js';
import { createSession, verifySession } from './helpers/session-fixtures.js';

describe('session ids are stored hashed (audit A11)', () => {
  let db;
  let alice;
  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
    alice = createUser(db, { username: 'alice', passwordHash: 'h' });
  });
  afterEach(() => db.close());

  const rows = () => db.all('SELECT id FROM sessions').map((r) => r.id);

  it('the database never holds the cookie value; the caller still gets the raw id', () => {
    const s = createSession(db, { userId: alice.id, ttlMs: 60_000 });
    expect(rows()).toEqual([hashSessionId(s.id)]);
    expect(rows().includes(s.id)).toBe(false);
    expect(/^h1:[0-9a-f]{64}$/.test(rows()[0])).toBe(true);
    expect(verifySession(db, s.id).id).toBe(s.id);
  });

  it('presenting the stored hash as a cookie does not log anyone in', () => {
    const s = createSession(db, { userId: alice.id, ttlMs: 60_000 });
    expect(verifySession(db, rows()[0])).toBeNull();
    expect(verifySession(db, s.id)).toBeTruthy();
  });

  it('revoke-all-but-one works through the hash', () => {
    const a = createSession(db, { userId: alice.id, ttlMs: 60_000 });
    const b = createSession(db, { userId: alice.id, ttlMs: 60_000 });
    expect(destroyUserSessions(db, alice.id, { exceptSessionId: b.id })).toBe(1);
    expect(verifySession(db, a.id)).toBeNull();
    expect(verifySession(db, b.id)).toBeTruthy();
  });

  it('sessions stored under a raw id by an older version are dropped, not left readable', () => {
    db.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}')`);
    const old = createSqliteAdapter({ file: ':memory:' });
    old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, email TEXT, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'operator', must_change_password INTEGER NOT NULL DEFAULT 0, totp_secret TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    old.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}')`);
    old.run(`INSERT INTO users (username, password_hash) VALUES ('o','h')`);
    old.run(`INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ('rawid', 1, ?, ?)`, [new Date().toISOString(), new Date(Date.now() + 60_000).toISOString()]);
    ensureAuthTables(old);
    expect(old.all('SELECT id FROM sessions').length).toBe(0);
    old.close();
  });
});
