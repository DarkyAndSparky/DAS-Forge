import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSession, verifySession } from './helpers/session-fixtures.js';

import { createSqliteAdapter } from '../src/database/index.js';
import { createCli } from '../src/cli/index.js';
import { registerUserCommands } from '../src/cli/commands/user-admin.js';
import * as auth from '../src/auth/index.js';

describe('CLI: account administration (user list/create/rename/set-role/set-email/disable/enable/delete)', () => {
  let db;
  let logs;
  let errors;
  let audited;

  beforeEach(() => {
    db = createSqliteAdapter({ file: ':memory:' });
    auth.createUser(db, { username: 'root', passwordHash: 'h', role: 'admin', email: 'root@example.com' });
    auth.createUser(db, { username: 'alice', passwordHash: 'h', role: 'operator' });
    logs = [];
    errors = [];
    audited = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(a.join(' ')));
  });
  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  function run(...argv) {
    const cli = createCli();
    registerUserCommands(cli, {
      db,
      hashPassword: async (plain) => `hashed:${plain}`,
      createUser: auth.createUser,
      findUserByUsername: auth.findUserByUsername,
      updatePasswordHash: auth.updatePasswordHash,
      countUsers: auth.countUsers,
      userAdmin: auth,
      roles: ['admin', 'operator'],
      auditLog: (entry) => audited.push(entry),
    });
    return cli.run(argv);
  }

  it('list prints accounts, filters, and --json never contains secrets', async () => {
    expect(await run('user', 'list')).toBe(0);
    expect(logs.some((l) => l.includes('root') && l.includes('admin'))).toBe(true);
    expect(logs.at(-1)).toBe('2 of 2');

    logs.length = 0;
    expect(await run('user', 'list', '--role', 'operator', '--json')).toBe(0);
    const out = JSON.parse(logs[0]);
    expect(out.items.map((u) => u.username)).toEqual(['alice']);
    expect(logs[0].includes('passwordHash')).toBe(false);
    expect(logs[0].includes('password_hash')).toBe(false);

    logs.length = 0;
    await run('user', 'list', '--search', 'nobody-here');
    expect(logs[0]).toBe('No matching users.');
  });

  it('create makes a must-change account, prints the temporary password once, and audits it as cli/<os user>"', async () => {
    expect(await run('user', 'create', 'carol', '--role', 'operator', '--email', 'carol@example.com')).toBe(0);
    const u = auth.findUserByUsername(db, 'carol');
    expect(u.mustChangePassword).toBe(true);
    expect(u.email).toBe('carol@example.com');
    const printed = /Temporary password: (\S+)/.exec(logs.join('\n'))[1];
    expect(u.passwordHash).toBe(`hashed:${printed}`);
    expect(audited[0].actor).toMatch(/^cli(\/.+)?$/);
    expect(audited[0].action).toBe('user.create');
    expect(JSON.stringify(audited[0]).includes(printed)).toBe(false);
  });

  it('create refuses bad input with exit code 1 and a coded message; a missing argument is exit 2', async () => {
    expect(await run('user', 'create', 'alice')).toBe(1);
    expect(errors.join('\n')).toContain('USERNAME_TAKEN');
    errors.length = 0;
    expect(await run('user', 'create', 'dave', '--role', 'wizard')).toBe(1);
    expect(errors.join('\n')).toContain('ROLE_INVALID');
    expect(await run('user', 'create')).toBe(2);
  });

  it('rename, set-role, set-email work and are audited; unknown users are exit 1', async () => {
    expect(await run('user', 'rename', 'alice', 'alicia')).toBe(0);
    expect(auth.findUserByUsername(db, 'alicia')).toBeTruthy();
    expect(await run('user', 'rename', 'ghost', 'phantom')).toBe(1);
    expect(await run('user', 'set-role', 'alicia', 'admin')).toBe(0);
    expect(auth.findUserByUsername(db, 'alicia').role).toBe('admin');
    expect(await run('user', 'set-email', 'alicia', 'a@example.com')).toBe(0);
    expect(await run('user', 'set-email', 'alicia', '--clear')).toBe(0);
    expect(auth.findUserByUsername(db, 'alicia').email).toBe(null);
    expect(audited.map((a) => a.action)).toEqual(['user.rename', 'user.set_role', 'user.set_email', 'user.set_email']);
  });

  it('the last active admin is protected from demotion, disabling and deletion', async () => {
    expect(await run('user', 'set-role', 'root', 'operator')).toBe(1);
    expect(await run('user', 'disable', 'root')).toBe(1);
    expect(await run('user', 'delete', 'root', '--yes')).toBe(1);
    expect(errors.filter((e) => e.includes('LAST_ADMIN')).length).toBe(3);
    expect(auth.findUserByUsername(db, 'root').role).toBe('admin');
  });

  it('disable ends sessions, enable restores; delete needs --yes, anonymises by default, --hard removes', async () => {
    const s = createSession(db, { userId: auth.findUserByUsername(db, 'alice').id, ttlMs: 60_000 });
    expect(await run('user', 'disable', 'alice')).toBe(0);
    expect(verifySession(db, s.id)).toBeNull();
    expect(auth.findUserByUsername(db, 'alice').disabled).toBe(true);
    expect(await run('user', 'enable', 'alice')).toBe(0);
    expect(auth.findUserByUsername(db, 'alice').disabled).toBe(false);

    expect(await run('user', 'delete', 'alice')).toBe(2);
    expect(auth.findUserByUsername(db, 'alice')).toBeTruthy();
    expect(await run('user', 'delete', 'alice', '--yes')).toBe(0);
    expect(auth.findUserByUsername(db, 'alice')).toBeNull();
    expect(db.get(`SELECT username FROM users WHERE username LIKE 'deleted-user-%'`)).toBeTruthy();

    auth.createUser(db, { username: 'temp_user', passwordHash: 'h' });
    expect(await run('user', 'delete', 'temp_user', '--yes', '--hard')).toBe(0);
    expect(auth.findUserByUsername(db, 'temp_user')).toBeNull();
  });

  it('reset-password stores a hash, forces a change, and signs the user out everywhere', async () => {
    const alice = auth.findUserByUsername(db, 'alice');
    const s = createSession(db, { userId: alice.id, ttlMs: 60_000 });
    expect(await run('user', 'reset-password', 'alice')).toBe(0);
    expect(verifySession(db, s.id)).toBeNull();
    const after = auth.findUserByUsername(db, 'alice');
    expect(after.mustChangePassword).toBe(true);
    expect(after.passwordHash.startsWith('hashed:')).toBe(true);
    expect(audited.at(-1).action).toBe('user.password_reset');
  });
});
