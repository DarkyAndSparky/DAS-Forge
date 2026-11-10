import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSqliteAdapter } from '../src/database/index.js';
import { ensureAuthTables } from '../src/auth/schema.js';
import { createUser } from '../src/auth/users.js';
import { hardeningChecks } from '../src/health/index.js';

const by = (r, name) => r.find((c) => c.name === name);

function mem() {
  const db = createSqliteAdapter({ file: ':memory:' });
  ensureAuthTables(db);
  db.run('CREATE TABLE IF NOT EXISTS scheduler_state (name TEXT PRIMARY KEY, last_run_at TEXT NOT NULL)');
  return db;
}

describe('hardeningChecks', () => {
  it('warns about group/other readable secret files and fine modes pass', async () => {
    if (process.platform === 'win32') return; // no POSIX mode bits
    const dir = mkdtempSync(path.join(os.tmpdir(), 'das-hard-'));
    const loose = path.join(dir, 'key.pem');
    const tight = path.join(dir, 'app.db');
    writeFileSync(loose, 'x'); chmodSync(loose, 0o644);
    writeFileSync(tight, 'x'); chmodSync(tight, 0o600);
    const r = await hardeningChecks({ secretFiles: { 'certificate key': loose, database: tight } });
    expect(by(r, 'Permissions: certificate key').status).toBe('warn');
    expect(by(r, 'Permissions: database').status).toBe('ok');
  });

  it('counts administrators without a second factor', async () => {
    const db = mem();
    createUser(db, { username: 'a', passwordHash: 'h', role: 'admin' });
    createUser(db, { username: 'b', passwordHash: 'h', role: 'admin' });
    db.run('UPDATE users SET totp_enabled = 1 WHERE username = ?', ['a']);
    let r = await hardeningChecks({ db });
    expect(by(r, 'Administrators: second factor').status).toBe('warn');
    expect(by(r, 'Administrators: second factor').message).toContain('1 of 2');
    db.run('UPDATE users SET totp_enabled = 1');
    r = await hardeningChecks({ db });
    expect(by(r, 'Administrators: second factor').status).toBe('ok');
  });

  it('judges the age of the last backup and of the audit-chain check', async () => {
    const db = mem();
    const now = Date.parse('2026-10-30T12:00:00Z');
    let r = await hardeningChecks({ db, now: () => now });
    expect(by(r, 'Last backup').status).toBe('warn'); // never ran
    expect(by(r, 'Audit chain check')).toBeUndefined();
    db.run('INSERT INTO scheduler_state VALUES (?, ?)', ['backup', '2026-10-30T03:00:00Z']);
    db.run('INSERT INTO scheduler_state VALUES (?, ?)', ['alerts-audit-chain', '2026-10-20T03:00:00Z']);
    r = await hardeningChecks({ db, now: () => now });
    expect(by(r, 'Last backup').status).toBe('ok');
    expect(by(r, 'Audit chain check').status).toBe('warn');
    db.run(`UPDATE scheduler_state SET last_run_at = '2026-10-20T03:00:00Z' WHERE name = 'backup'`);
    expect(by(await hardeningChecks({ db, now: () => now }), 'Last backup').status).toBe('warn');
  });

  it('flags a proxy trusted too widely or inconsistently with the HTTPS mode', async () => {
    const cfg = (trustProxy, mode) => ({ server: { trustProxy, https: { mode } } });
    expect(by(await hardeningChecks({ appConfig: cfg(true, 'reverse-proxy') }), 'Proxy trust').status).toBe('warn');
    expect(by(await hardeningChecks({ appConfig: cfg(['10.0.0.0/8'], 'reverse-proxy') }), 'Proxy trust').status).toBe('ok');
    expect(by(await hardeningChecks({ appConfig: cfg(false, 'reverse-proxy') }), 'Proxy trust').status).toBe('warn');
    expect(by(await hardeningChecks({ appConfig: cfg(['loopback'], 'self-signed') }), 'Proxy trust').status).toBe('warn');
    expect(by(await hardeningChecks({ appConfig: cfg(false, 'self-signed') }), 'Proxy trust').status).toBe('ok');
  });

  it('always reports heap and event-loop state', async () => {
    const r = await hardeningChecks({});
    expect(by(r, 'Heap')).toBeDefined();
    expect(['ok', 'warn', 'fail']).toContain(by(r, 'Event loop').status);
  });
});

describe('last backup seen by the diagnostics', () => {
  it('counts the newest backup file together with the scheduler record, so a hand-made backup is seen', async () => {
    const { hardeningChecks } = await import('../src/health/checks/hardening.js');
    const { createSqliteAdapter } = await import('../src/database/index.js');
    const db = createSqliteAdapter({ file: ':memory:' });
    const now = Date.parse('2026-11-01T12:00:00Z');
    const find = async (opts) => (await hardeningChecks({ db, now: () => now, ...opts })).find((c) => c.name === 'Last backup');
    expect((await find({})).status).toBe('warn'); // nothing recorded, no file
    const byHand = await find({ lastBackupAt: () => '2026-11-01T11:00:00Z' });
    expect(byHand).toMatchObject({ status: 'ok', message: '1 h ago' });
    db.run(`CREATE TABLE scheduler_state (name TEXT PRIMARY KEY, last_run_at TEXT NOT NULL)`);
    db.run(`INSERT INTO scheduler_state VALUES ('backup', '2026-10-20T00:00:00Z')`);
    expect((await find({ lastBackupAt: () => '2026-11-01T11:00:00Z' })).message).toBe('1 h ago'); // the file is newer than the job record
    expect((await find({ lastBackupAt: () => { throw new Error('unreadable'); } })).status).toBe('warn'); // the old record alone is stale
  });
});
