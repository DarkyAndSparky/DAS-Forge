import { describe, it, expect } from 'vitest';
import { createCli } from '../src/cli/cli.js';
import { createScheduler } from '../src/scheduler/scheduler.js';
import { createSqliteAdapter } from '../src/database/index.js';
import { log, query } from '../src/audit/index.js';
import { registerTasksCommands } from '../src/cli/commands/tasks.js';

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
  const scheduler = createScheduler({});
  const ran = [];
  scheduler.registerJob('sessions-gc', '*/10 * * * *', () => { ran.push('sessions-gc'); });
  scheduler.registerJob('broken', '0 3 * * *', () => { throw new Error('boom'); });
  const cli = createCli({ name: 'app' });
  registerTasksCommands(cli, { scheduler, auditLog: (e) => log(db, e) });
  return { db, cli, ran, scheduler };
}

describe('tasks commands (G-13)', () => {
  it('lists the tasks without starting any of them', async () => {
    const { cli, ran } = setup();
    const r = await run(cli, ['tasks', 'list']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('sessions-gc');
    expect(r.out).toContain('*/10 * * * *');
    expect(r.out).toContain('last: never');
    expect(ran).toEqual([]);
    const j = JSON.parse((await run(cli, ['tasks', 'list', '--json'])).out);
    expect(j.map((x) => x.name)).toEqual(['sessions-gc', 'broken']);
  });

  it('runs a task now and writes it to the audit trail as the console user', async () => {
    const { cli, db, ran } = setup();
    const r = await run(cli, ['tasks', 'run', 'sessions-gc']);
    expect(r.code).toBe(0);
    expect(ran).toEqual(['sessions-gc']);
    const e = query(db, { action: 'cli.tasks.run' })[0];
    expect(e.entityId).toBe('sessions-gc');
    expect(e.result).toBe('success');
    expect(String(e.actor)).toMatch(/^cli/);
  });

  it('a failing task exits 1, says why and is audited as a failure', async () => {
    const { cli, db } = setup();
    const r = await run(cli, ['tasks', 'run', 'broken']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('boom');
    expect(query(db, { action: 'cli.tasks.run' })[0].result).toBe('failure');
  });

  it('refuses a missing or unknown name with the usage exit code and the known names', async () => {
    const { cli } = setup();
    expect((await run(cli, ['tasks', 'run'])).code).toBe(2);
    const u = await run(cli, ['tasks', 'run', 'nope']);
    expect(u.code).toBe(2);
    expect(u.err).toContain('sessions-gc');
  });

  it('needs a scheduler', () => {
    expect(() => registerTasksCommands(createCli({ name: 'app' }), {})).toThrow(/scheduler/);
  });
});
