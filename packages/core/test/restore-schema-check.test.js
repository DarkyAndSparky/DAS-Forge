import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSqliteAdapter } from '../src/database/index.js';
import { createBackupJob, restoreBackup } from '../src/scheduler/index.js';
import * as auth from '../src/auth/index.js';
import * as audit from '../src/audit/index.js';

/** A live database, one backup of it made after `tweak(db)`, and the live file as it was. */
async function setup(tweak) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'das-rs-'));
  const dbPath = path.join(root, 'app.db');
  const db = createSqliteAdapter({ file: dbPath });
  auth.createUser(db, { username: 'root', passwordHash: 'h', role: 'admin' });
  audit.log(db, { actor: 'root', action: 'x.y', meta: {} });
  audit.log(db, { actor: 'root', action: 'x.z', meta: {} });
  tweak?.(db);
  await createBackupJob({ db, destinations: [{ id: 'l', type: 'local', path: path.join(root, 'b') }], retentionDays: 7 })();
  db.close();
  const dir = path.join(root, 'b');
  return { root, dbPath, backup: path.join(dir, readdirSync(dir).find((f) => f.endsWith('.zip'))) };
}
const restore = (s, extra = {}) => restoreBackup({ dbFilePath: s.dbPath, backupFilePath: s.backup, createAdapterFn: createSqliteAdapter, ...extra });

describe('restore inspects the backup database first (audit R-02)', () => {
  it('accepts an ordinary backup and reports the schema check', async () => {
    const s = await setup();
    const r = await restore(s);
    expect(r.ok).toBe(true);
    expect(r.steps.find((x) => x.name === 'Schema check').message).toMatch(/match the live database.*verified/);
    r.db.close(); rmSync(s.root, { recursive: true, force: true });
  });

  it('refuses a backup that carries a trigger the live database does not have, and changes nothing', async () => {
    const s = await setup((db) => db.exec("CREATE TRIGGER evil AFTER INSERT ON users BEGIN UPDATE users SET role = 'admin' WHERE id = NEW.id; END"));
    // the live file at restore time is the one before the trigger: make it so by restoring onto a database without it
    const live = createSqliteAdapter({ file: s.dbPath }); live.exec('DROP TRIGGER evil'); live.close();
    const r = await restore(s);
    expect(r.ok).toBe(false);
    const step = r.steps.find((x) => x.name === 'Schema check');
    expect(step.ok).toBe(false);
    expect(step.message).toMatch(/trigger:evil is not in the live database/);
    expect(step.message).toMatch(/nothing was changed/);
    const after = createSqliteAdapter({ file: s.dbPath });
    expect(after.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'evil'").n).toBe(0);
    after.close(); rmSync(s.root, { recursive: true, force: true });
  });

  it('refuses a backup whose audit chain was rewritten, unless an administrator allows it', async () => {
    const s = await setup((db) => db.exec('DROP TRIGGER IF EXISTS audit_log_no_update'));
    const tamper = createSqliteAdapter({ file: s.dbPath });
    tamper.close();
    // rewrite one row in the BACKUP: do it by making a second backup after tampering the live database
    const live = createSqliteAdapter({ file: s.dbPath });
    live.exec('DROP TRIGGER IF EXISTS audit_log_no_update');
    live.run("UPDATE audit_log SET action = 'forged' WHERE id = 1");
    live.close();
    const dir = path.join(s.root, 'b2');
    const db2 = createSqliteAdapter({ file: s.dbPath });
    await createBackupJob({ db: db2, destinations: [{ id: 'l', type: 'local', path: dir }], retentionDays: 7 })();
    db2.close();
    const backup = path.join(dir, readdirSync(dir).find((f) => f.endsWith('.zip')));
    const r = await restoreBackup({ dbFilePath: s.dbPath, backupFilePath: backup, createAdapterFn: createSqliteAdapter });
    expect(r.ok).toBe(false);
    expect(r.steps.find((x) => x.name === 'Schema check').message).toMatch(/audit chain in the backup is broken/);
    const ok = await restoreBackup({ dbFilePath: s.dbPath, backupFilePath: backup, createAdapterFn: createSqliteAdapter, allowBrokenAuditChain: true });
    expect(ok.ok).toBe(true);
    expect(ok.steps.find((x) => x.name === 'Schema check').message).toMatch(/BROKEN but allowed/);
    ok.db.close(); rmSync(s.root, { recursive: true, force: true });
  });
});
