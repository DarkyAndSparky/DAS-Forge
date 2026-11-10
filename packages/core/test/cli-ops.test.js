import { describe, it, expect } from 'vitest';
import { createCli } from '../src/cli/cli.js';
import { createSqliteAdapter } from '../src/database/index.js';
import { createUser, findUserByUsername } from '../src/auth/users.js';
import { query } from '../src/audit/index.js';
import { createMaintenance } from '../src/maintenance/index.js';
import { registerOpsCommands } from '../src/cli/commands/ops.js';

async function run(cli, argv) {
  const logs = []; const errs = [];
  const l = console.log; const e = console.error;
  console.log = (...a) => logs.push(a.join(' ')); console.error = (...a) => errs.push(a.join(' '));
  let code;
  try { code = await cli.run(argv); } finally { console.log = l; console.error = e; }
  return { code, out: logs.join('\n'), err: errs.join('\n') };
}
function setup() {
  const db = createSqliteAdapter({ file: ':memory:' });
  const cli = createCli({ name: 'app' });
  registerOpsCommands(cli, { db });
  return { db, cli };
}

describe('operations commands (R-09)', () => {
  it('maintenance on/off/status: the mode is shared with the server through the database, and audited', async () => {
    const { db, cli } = setup();
    expect((await run(cli, ['maintenance', 'status'])).out).toBe('off');
    const on = await run(cli, ['maintenance', 'on', '--message', 'Updating', '--until', '2030-01-01T10:00:00Z']);
    expect(on.code).toBe(0);
    const server = createMaintenance({ db }); // what the running server uses
    expect(server.get({ fresh: true })).toMatchObject({ enabled: true, message: 'Updating', until: '2030-01-01T10:00:00.000Z' });
    expect((await run(cli, ['maintenance', 'status'])).out).toContain('ON since');
    expect(JSON.parse((await run(cli, ['maintenance', 'status', '--json'])).out).enabled).toBe(true);
    expect((await run(cli, ['maintenance', 'off'])).out).toContain('OFF');
    expect(server.get({ fresh: true }).enabled).toBe(false);
    expect((await run(cli, ['maintenance', 'off'])).out).toContain('already off');
    expect(query(db, { action: 'admin.maintenance.enable' })).toHaveLength(1);
    expect(query(db, { action: 'admin.maintenance.disable' })).toHaveLength(2);
  });

  it('maintenance on refuses a bad date or a too long message and changes nothing', async () => {
    const { db, cli } = setup();
    expect((await run(cli, ['maintenance', 'on', '--until', 'not-a-date'])).code).toBe(2);
    expect((await run(cli, ['maintenance', 'on', '--message', 'x'.repeat(5000)])).code).toBe(2);
    expect(createMaintenance({ db }).get({ fresh: true }).enabled).toBe(false);
  });

  it('sessions list shows counts without ids; revoke signs a user out and is audited', async () => {
    const { db, cli } = setup();
    createUser(db, { username: 'ann', passwordHash: 'h', role: 'operator' });
    const id = findUserByUsername(db, 'ann').id;
    const future = new Date(Date.now() + 3600_000).toISOString();
    for (const sid of ['secret-session-id-1', 'secret-session-id-2']) db.run('INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)', [sid, id, new Date().toISOString(), future, new Date().toISOString()]);
    const list = await run(cli, ['sessions', 'list']);
    expect(list.out).toContain('ann');
    expect(list.out).toContain('2 session(s)');
    expect(list.out).not.toContain('secret-session-id');
    expect((await run(cli, ['sessions', 'revoke', 'ann'])).out).toContain('Revoked 2');
    expect((await run(cli, ['sessions', 'list'])).out).toBe('No active sessions.');
    expect((await run(cli, ['sessions', 'revoke', 'nobody'])).code).toBe(1);
    expect((await run(cli, ['sessions', 'revoke'])).code).toBe(2);
    expect(query(db, { action: 'admin.user.force_logout' })[0].meta).toMatchObject({ revokedSessions: 2, via: 'cli' });
  });
});

describe('operations commands, part 2 (R-09)', () => {
  it('announcement set/show/clear shares the banner with the server and is audited', async () => {
    const { db, cli } = setup();
    expect((await run(cli, ['announcement', 'show'])).out).toBe('none');
    expect((await run(cli, ['announcement', 'set', 'Work', 'at', '22:00', '--level', 'warning'])).code).toBe(0);
    expect((await run(cli, ['announcement', 'show'])).out).toContain('[warning] Work at 22:00');
    expect((await run(cli, ['announcement', 'set', 'x', '--level', 'bad'])).code).not.toBe(0);
    expect((await run(cli, ['announcement', 'set'])).code).not.toBe(0);
    await run(cli, ['announcement', 'clear']);
    expect((await run(cli, ['announcement', 'show'])).out).toBe('none');
    expect(query(db, { action: 'admin.announcement.set' })).toHaveLength(1);
  });

  it('mail queue lists counters without bodies; mail purge removes old finished rows', async () => {
    const { db, cli } = setup();
    const r0 = await run(cli, ['mail', 'queue']);
    expect(r0.out).toContain('pending 0');
    db.run(`INSERT INTO email_queue (scenario, recipients, status, attempts, next_attempt_at, created_at) VALUES ('welcome', '["a***@x.com"]', 'sent', 1, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`);
    expect((await run(cli, ['mail', 'queue', '--json'])).out).toContain('welcome');
    expect((await run(cli, ['mail', 'queue', '--status', 'nope'])).code).not.toBe(0);
    expect((await run(cli, ['mail', 'purge', '--days', '7'])).out).toContain('Removed 1');
  });

  it('audit purge needs a date and --yes, then deletes only older entries', async () => {
    const { db, cli } = setup();
    expect((await run(cli, ['audit', 'purge'])).code).not.toBe(0);
    expect((await run(cli, ['audit', 'purge', '--before', '2999-01-01'])).err).toContain('--yes');
    const before = query(db, {}).length;
    expect((await run(cli, ['audit', 'purge', '--before', '2000-01-01', '--yes'])).out).toContain('Removed 0');
    expect(query(db, {}).length).toBeGreaterThanOrEqual(before);
  });
});
