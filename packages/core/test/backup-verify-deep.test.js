import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createSqliteAdapter } from '../src/database/index.js';
import { createBackupJob, verifyBackupFile } from '../src/scheduler/index.js';
import { log } from '../src/audit/log.js';

describe('backup verify goes as far as a restore would', () => {
  it('passes a healthy copy, with the audit chain in the message, and refuses one whose audit chain was rewritten', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'das-deep-'));
    try {
      const make = async (tamper) => {
        const file = path.join(dir, `live-${tamper ? 'bad' : 'ok'}.db`);
        const db = createSqliteAdapter({ file });
        log(db, { actor: 'a', action: 'test.one', entity: 'x', entityId: '1' });
        log(db, { actor: 'a', action: 'test.two', entity: 'x', entityId: '2' });
        if (tamper) { db.exec('DROP TRIGGER IF EXISTS audit_log_no_update'); db.run("UPDATE audit_log SET action = 'test.forged' WHERE id = 1"); }
        const out = path.join(dir, `out-${tamper ? 'bad' : 'ok'}`);
        const job = createBackupJob({ db, destinations: [{ id: 'l', type: 'local', path: out }], retentionDays: 30 });
        const res = await job();
        db.close();
        return res;
      };
      const good = await make(false);
      const bad = await make(true);
      const pathOf = (r) => (Array.isArray(r) ? r[0] : r.results[0]).backupPath;
      const ok = await verifyBackupFile(createSqliteAdapter, pathOf(good));
      expect(ok.ok).toBe(true);
      expect(ok.message).toMatch(/audit chain verified \(2 row/);
      const no = await verifyBackupFile(createSqliteAdapter, pathOf(bad));
      expect(no.ok).toBe(false);
      expect(no.message).toMatch(/audit chain/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
