import { describe, it, expect } from 'vitest';
import { createSqliteAdapter, asyncDb } from '../src/database/index.js';
import * as auth from '../src/auth/index.js';

const fresh = () => createSqliteAdapter({ file: ':memory:', walMode: false });
const addSession = (db, userId, id, exp = Date.now() + 3600_000) =>
  db.run('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', [auth.hashSessionId(id), userId, new Date().toISOString(), new Date(exp).toISOString()]);

describe('asynchronous users, sessions and password history', () => {
  it('creates and finds users like the synchronous functions; same rows', async () => {
    const db = fresh();
    expect(await auth.countUsersAsync(db)).toBe(0);
    const u = await auth.createUserAsync(db, { username: 'ann', email: 'Ann@Example.com', passwordHash: 'h1', role: 'admin', mustChangePassword: true });
    expect(u).toMatchObject({ username: 'ann', role: 'admin', mustChangePassword: true, disabled: false });
    expect(await auth.findUserByUsernameAsync(db, 'ann')).toEqual(auth.findUserByUsername(db, 'ann'));
    expect((await auth.findUserByEmailAsync(db, 'ann@example.com')).id).toBe(u.id);
    expect(await auth.findUserByEmailAsync(db, '')).toBeNull();
    await auth.createUserAsync(db, { username: 'ann2', email: 'ANN@example.com', passwordHash: 'h' });
    expect(await auth.findUserByEmailAsync(db, 'ann@example.com')).toBeNull(); // shared address: nobody
    expect(await auth.findUserByIdAsync(db, 999)).toBeNull();
    expect(await auth.countUsersAsync(db)).toBe(2);
    await expect(auth.createUserAsync(db, { username: 'ann', passwordHash: 'x' })).rejects.toThrow(/UNIQUE/);
  });

  it('a real password change keeps history and age; a silent re-hash does not', async () => {
    const db = fresh();
    const u = await auth.createUserAsync(db, { username: 'bob', passwordHash: 'h0', mustChangePassword: true });
    await auth.updatePasswordHashAsync(db, u.id, 'h-silent');
    expect(await auth.recentPasswordHashesAsync(db, u.id, 5)).toEqual([]);
    await auth.updatePasswordHashAsync(db, u.id, 'h-new', { clearMustChange: true });
    await auth.updatePasswordHashAsync(db, u.id, 'h-newer', { clearMustChange: true });
    expect(await auth.recentPasswordHashesAsync(db, u.id, 5)).toEqual(['h-newer', 'h-new']);
    expect(auth.recentPasswordHashes(db, u.id, 5)).toEqual(['h-newer', 'h-new']);
    expect((await auth.findUserByIdAsync(db, u.id)).mustChangePassword).toBe(false);
    expect(await auth.recentPasswordHashesAsync(db, u.id, 0)).toEqual([]);
    const t = Date.now();
    expect(await auth.passwordExpiredAsync(db, u.id, 0, t)).toBe(false);
    expect(await auth.passwordExpiredAsync(db, u.id, 30, t + 10 * 86_400_000)).toBe(false);
    expect(await auth.passwordExpiredAsync(db, u.id, 30, t + 40 * 86_400_000)).toBe(true);
    expect(await auth.passwordExpiredAsync(db, 12345, 30)).toBe(false);
  });

  it('a role change revokes sessions in one step, except the caller’s own', async () => {
    const db = fresh();
    const u = await auth.createUserAsync(db, { username: 'cy', passwordHash: 'h' });
    await auth.ensureAuthTablesAsync(db);
    addSession(db, u.id, 's1'); addSession(db, u.id, 's2');
    expect(await auth.setUserRoleAsync(db, u.id, 'operator')).toEqual({ changed: false, revokedSessions: 0 });
    expect(await auth.setUserRoleAsync(db, u.id, 'admin', { exceptSessionId: 's1' })).toEqual({ changed: true, revokedSessions: 1 });
    expect(db.all('SELECT id FROM sessions').map((r) => r.id)).toEqual([auth.hashSessionId('s1')]);
    await expect(auth.setUserRoleAsync(db, u.id, ' ')).rejects.toThrow(/role/);
    expect(await auth.setUserRoleAsync(db, 777, 'x')).toEqual({ changed: false, revokedSessions: 0 });
  });

  it('purges expired and idle sessions', async () => {
    const db = fresh();
    const u = await auth.createUserAsync(db, { username: 'di', passwordHash: 'h' });
    addSession(db, u.id, 'live'); addSession(db, u.id, 'dead', Date.now() - 1000);
    expect(await auth.purgeExpiredSessionsAsync(db)).toBe(1);
    db.run("UPDATE sessions SET last_seen_at = ?", [new Date(Date.now() - 7200_000).toISOString()]);
    expect(await auth.purgeExpiredSessionsAsync(db, { idleTimeoutMs: 3600_000 })).toBe(1);
    expect(await auth.destroyUserSessionsAsync(db, u.id)).toBe(0);
  });

  it('anonymize removes everything that belongs to the account; delete removes the row', async () => {
    const db = fresh();
    const u = await auth.createUserAsync(db, { username: 'ed', email: 'e@x.io', passwordHash: 'h' });
    addSession(db, u.id, 'a');
    db.run("INSERT INTO authenticators (user_id, type, status) VALUES (?, 'totp', 'active')", [u.id]);
    db.run("INSERT INTO totp_credentials (authenticator_id, secret) VALUES (1, 'S')");
    db.run("INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, 'c')", [u.id]);
    const an = await auth.anonymizeUserAsync(db, u.id);
    expect(an).toMatchObject({ username: `deleted-user-${u.id}`, email: null, disabled: true });
    for (const t of ['sessions', 'authenticators', 'totp_credentials', 'recovery_codes']) expect(db.get(`SELECT COUNT(*) AS c FROM ${t}`).c).toBe(0);
    expect(await auth.anonymizeUserAsync(db, 999)).toBeNull();
    expect(await auth.deleteUserAsync(db, u.id)).toBe(true);
    expect(await auth.deleteUserAsync(db, u.id)).toBe(false);
  });

  it('TOTP secret is stored; schema creation is idempotent and migrates the flat TOTP columns once', async () => {
    const db = fresh();
    db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, email TEXT, password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'operator', must_change_password INTEGER NOT NULL DEFAULT 0, totp_secret TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0,
      disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    db.run("INSERT INTO users (username, password_hash, totp_secret, totp_enabled) VALUES ('old', 'h', 'LEGACY', 1)");
    await auth.ensureAuthTablesAsync(db);
    await auth.ensureAuthTablesAsync(db);
    expect(db.all("SELECT status FROM authenticators").map((r) => r.status)).toEqual(['active']);
    expect(db.get('SELECT secret FROM totp_credentials').secret).toBe('LEGACY');
    await auth.setTotpSecretAsync(db, 1, 'NEW', { enabled: true });
    expect(db.get('SELECT totp_secret AS s, totp_enabled AS e FROM users WHERE id = 1')).toEqual({ s: 'NEW', e: 1 });
  });

  it('works inside an asynchronous transaction and rolls back with it', async () => {
    const db = fresh();
    await auth.ensureAuthTablesAsync(db);
    await expect(asyncDb(db).transaction(async (tx) => { await auth.createUserAsync(tx, { username: 'tx', passwordHash: 'h' }); throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await auth.countUsersAsync(db)).toBe(0);
  });
});
