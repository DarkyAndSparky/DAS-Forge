import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createSqliteAdapter } from '../src/database/index.js';
import { createUser, findUserById } from '../src/auth/users.js';
import { anonymizeUser, deleteUser } from '../src/auth/users.js';
import { listAuthenticators } from '../src/auth/authenticators.js';
import { ensureAuthTables } from '../src/auth/schema.js';
import { log, query, eraseSubjects } from '../src/audit/index.js';
import { exportUserData, eraseUserData, createErasureLedger } from '../src/privacy/index.js';

const registry = { getDataSubjectHandlers: () => [] };

describe('F06: subject export includes core data', () => {
  it('sessions (no ids), authenticators and the person\'s audit entries', async () => {
    const db = createSqliteAdapter({ file: ':memory:' });
    ensureAuthTables(db);
    const u = createUser(db, { username: 'ann', passwordHash: 'h', role: 'operator' });
    db.run(`INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ('SECRETHASH', ?, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')`, [u.id]);
    log(db, { actor: 'ann', action: 'auth.login' });
    log(db, { actor: 'bob', action: 'other' });
    const out = await exportUserData({ db, findUserByIdFn: findUserById, moduleRegistry: registry, userId: u.id, auditQueryFn: query, listAuthenticatorsFn: listAuthenticators });
    expect(out.core.sessions.length).toBe(1);
    expect(JSON.stringify(out)).not.toContain('SECRETHASH');
    expect(out.core.audit.map((e) => e.action)).toContain('auth.login');
    expect(out.core.audit.map((e) => e.action)).not.toContain('other');
    expect(Array.isArray(out.core.authenticators)).toBe(true);
  });
});

describe('F08: erasure ledger survives a restore', () => {
  const ledgerFile = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'ledger-')), '.erasures.jsonl');

  it('stores a salted hash, never the login; file is owner-only', () => {
    const f = ledgerFile();
    const l = createErasureLedger(f);
    l.record({ userId: 7, username: 'Carol', mode: 'anonymize' });
    expect(readFileSync(f, 'utf8')).not.toMatch(/carol/i);
    if (process.platform !== 'win32') expect(statSync(f).mode & 0o077).toBe(0);
    expect(l.entries().length).toBe(1);
  });

  it('erase records to the ledger; reapply erases the person again in an older database and leaves others', async () => {
    const f = ledgerFile();
    const ledger = createErasureLedger(f);
    // the "backup": two users exist
    const make = () => {
      const db = createSqliteAdapter({ file: ':memory:' });
      ensureAuthTables(db);
      createUser(db, { username: 'carol', passwordHash: 'h', role: 'operator', email: 'c@example.com' });
      createUser(db, { username: 'dave', passwordHash: 'h', role: 'operator' });
      return db;
    };
    const live = make();
    const carol = live.get(`SELECT id FROM users WHERE username = 'carol'`).id;
    const erase = (db, extra = {}) => eraseUserData({ db, findUserByIdFn: findUserById, anonymizeUserFn: anonymizeUser, deleteUserFn: deleteUser, moduleRegistry: registry, eraseAuditSubjectsFn: eraseSubjects, erasureLedger: ledger, userId: carol, ...extra });
    await erase(live);
    expect(ledger.entries().length).toBe(1);
    expect(findUserById(live, carol).username).not.toBe('carol');

    const restored = make(); // older database: carol is back
    expect(findUserById(restored, carol).username).toBe('carol');
    const r = await ledger.reapply({ db: restored, findUserByIdFn: findUserById, erase: (o) => erase(restored, { ...o, erasureLedger: null }) });
    expect(r).toMatchObject({ checked: 1, skipped: 0 });
    expect(r.reapplied).toEqual([carol]);
    expect(findUserById(restored, carol).username).not.toBe('carol');
    expect(restored.get(`SELECT username FROM users WHERE username = 'dave'`).username).toBe('dave');
    expect(ledger.entries().length).toBe(1); // reapply does not add entries
    const again = await ledger.reapply({ db: restored, findUserByIdFn: findUserById, erase: () => { throw new Error('must not run'); } });
    expect(again.reapplied.length).toBe(0); // idempotent
  });

  it('a different account that now has the same id is not touched (login hash must match)', async () => {
    const f = ledgerFile();
    const ledger = createErasureLedger(f);
    ledger.record({ userId: 1, username: 'oldname', mode: 'anonymize' });
    const db = createSqliteAdapter({ file: ':memory:' });
    ensureAuthTables(db);
    createUser(db, { username: 'someone-else', passwordHash: 'h', role: 'operator' });
    const r = await ledger.reapply({ db, findUserByIdFn: findUserById, erase: () => { throw new Error('must not run'); } });
    expect(r).toMatchObject({ checked: 1, skipped: 1 });
  });
});

describe('L04: server.trustProxy hops and lists', () => {
  it('schema accepts bool, hop count and subnet list, rejects junk', async () => {
    const { ServerConfigSchema } = await import('../src/config/index.js');
    const ok = (v) => ServerConfigSchema.safeParse({ trustProxy: v }).success;
    expect(ok(false)).toBe(true);
    expect(ok(true)).toBe(true);
    expect(ok(2)).toBe(true);
    expect(ok(['10.0.0.0/8', 'loopback', '::1'])).toBe(true);
    expect(ok(0)).toBe(false);
    expect(ok(11)).toBe(false);
    expect(ok([])).toBe(false);
    expect(ok(['not a proxy'])).toBe(false);
  });

  it('env DAS_TRUST_PROXY: yes/1 = one hop, 2 = hops, list = subnets', async () => {
    const { applyEnvOverrides } = await import('../src/config/env.js');
    const get = (v) => applyEnvOverrides({}, { DAS_TRUST_PROXY: v }).server.trustProxy;
    expect(get('yes')).toBe(true);
    expect(get('1')).toBe(true);
    expect(get('0')).toBe(false);
    expect(get('2')).toBe(2);
    expect(get('10.0.0.0/8, loopback')).toEqual(['10.0.0.0/8', 'loopback']);
    expect(get('loopback')).toEqual(['loopback']);
    expect(() => get('maybe')).toThrow();
  });

  it('applyServerSettings turns them into Express settings (true = ONE hop, never Express true)', async () => {
    const { applyServerSettings } = await import('../src/http/server.js');
    const run = (trustProxy) => {
      const s = {};
      applyServerSettings({ set: (k, v) => { s[k] = v; }, disable() {} }, { trustProxy, https: { mode: 'standalone' } });
      return s['trust proxy'];
    };
    expect(run(false)).toBe(false);
    expect(run(true)).toBe(1);
    expect(run(2)).toBe(2);
    expect(run(['10.0.0.0/8'])).toEqual(['10.0.0.0/8']);
  });
});

describe('B16: one destination resolver', () => {
  it('resolves local/mount paths and sftp key files against the app root, leaves the rest', async () => {
    const { resolveDestinations } = await import('../src/scheduler/destinations.js');
    const base = path.resolve(os.tmpdir(), 'approot');
    const out = resolveDestinations([
      { id: 'a', type: 'local', path: 'data/backups' },
      { id: 'b', type: 'mount', path: '../share' },
      { id: 'c', type: 'sftp', host: 'h', privateKeyFile: 'keys/id' },
      { id: 'd', type: 'local', path: path.resolve(base, 'abs') },
    ], base);
    expect(out[0].path).toBe(path.resolve(base, 'data/backups'));
    expect(out[1].path).toBe(path.resolve(base, '../share'));
    expect(out[2].privateKeyFile).toBe(path.resolve(base, 'keys/id'));
    expect(out[3].path).toBe(path.resolve(base, 'abs'));
    expect(resolveDestinations(undefined, base)).toEqual([]);
  });
});
