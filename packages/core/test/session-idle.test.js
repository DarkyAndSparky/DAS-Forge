import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { createSqliteAdapter } from '../src/database/index.js';
import { createUser, setUserRole } from '../src/auth/users.js';
import { hashSessionId, purgeExpiredSessions } from '../src/auth/sessions.js';
import { ensureAuthTables } from '../src/auth/schema.js';
import { createSession, verifySession } from './helpers/session-fixtures.js';

const MIN = 60_000;

describe('sessions table migration (audit A12)', () => {
  it('old databases without last_seen_at are migrated; legacy rows fall back to created_at', () => {
    const legacy = createSqliteAdapter({ file: ':memory:' });
    legacy.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, email TEXT, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'operator', must_change_password INTEGER NOT NULL DEFAULT 0, totp_secret TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    legacy.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}')`);
    legacy.run(`INSERT INTO users (username, password_hash) VALUES ('old','h')`);
    const created = new Date(Date.now() - 2 * 60 * MIN).toISOString();
    legacy.run(`INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)`, [
      hashSessionId('s1'),
      created,
      new Date(Date.now() + 60 * MIN).toISOString(),
    ]);
    ensureAuthTables(legacy);
    expect(legacy.all('PRAGMA table_info(sessions)').some((c) => c.name === 'last_seen_at')).toBe(true);
    // purge with an idle window treats the legacy row as last seen at creation (2 h ago)
    expect(purgeExpiredSessions(legacy, { idleTimeoutMs: 30 * MIN })).toBe(1);
    legacy.close();
  });
});

describe('role change revokes sessions (audit A05)', () => {
  let db;
  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
  });
  afterEach(() => db.close());

  it('setUserRole changes the role and kills that user\'s sessions only', () => {
    const a = createUser(db, { username: 'a', passwordHash: 'h', role: 'admin' });
    const b = createUser(db, { username: 'b', passwordHash: 'h' });
    const sa = createSession(db, { userId: a.id, ttlMs: 60_000 });
    const sb = createSession(db, { userId: b.id, ttlMs: 60_000 });
    expect(setUserRole(db, a.id, 'operator')).toEqual({ changed: true, revokedSessions: 1 });
    expect(db.get('SELECT role FROM users WHERE id = ?', [a.id]).role).toBe('operator');
    expect(verifySession(db, sa.id)).toBeNull();
    expect(verifySession(db, sb.id)).toBeTruthy();
  });

  it('exceptSessionId keeps the caller\'s own session', () => {
    const a = createUser(db, { username: 'a', passwordHash: 'h' });
    const keep = createSession(db, { userId: a.id, ttlMs: 60_000 });
    const other = createSession(db, { userId: a.id, ttlMs: 60_000 });
    expect(setUserRole(db, a.id, 'admin', { exceptSessionId: keep.id }).revokedSessions).toBe(1);
    expect(verifySession(db, keep.id)).toBeTruthy();
    expect(verifySession(db, other.id)).toBeNull();
  });

  it('same role or unknown user: nothing changes, nothing revoked', () => {
    const a = createUser(db, { username: 'a', passwordHash: 'h' });
    const s = createSession(db, { userId: a.id, ttlMs: 60_000 });
    expect(setUserRole(db, a.id, 'operator')).toEqual({ changed: false, revokedSessions: 0 });
    expect(setUserRole(db, 9999, 'admin')).toEqual({ changed: false, revokedSessions: 0 });
    expect(verifySession(db, s.id)).toBeTruthy();
  });

  it('rejects an empty role', () => {
    const a = createUser(db, { username: 'a', passwordHash: 'h' });
    expect(() => setUserRole(db, a.id, ' ')).toThrow(TypeError);
  });
});
