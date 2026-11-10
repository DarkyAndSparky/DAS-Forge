import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSqliteAdapter } from '../src/database/index.js';
import { createBackupJob } from '../src/scheduler/backup-job.js';

const mode = (f) => (fs.statSync(f).mode & 0o777).toString(8);
const posix = process.platform !== 'win32';

describe.skipIf(!posix)('database and backup file permissions (B17)', () => {
  it('creates the db, its WAL sidecars and backups owner-only; chmods an existing db; fileMode:null opts out', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-'));
    const f = path.join(root, 'a.db');
    const db = createSqliteAdapter({ file: f });
    db.exec('CREATE TABLE t (x)');
    db.run('INSERT INTO t VALUES (1)');
    expect(mode(f)).toBe('600');
    for (const e of fs.readdirSync(root).filter((n) => /-(wal|shm)$/.test(n))) expect(mode(path.join(root, e))).toBe('600');
    const [r] = await createBackupJob({ db, destinations: [{ id: 'l', type: 'local', path: path.join(root, 'bk') }], retentionDays: 1 })();
    expect(mode(r.backupPath)).toBe('600');
    db.close();
    fs.chmodSync(f, 0o644);
    createSqliteAdapter({ file: f }).close();
    expect(mode(f)).toBe('600');
    fs.chmodSync(f, 0o644);
    createSqliteAdapter({ file: f, fileMode: null }).close();
    expect(mode(f)).toBe('644');
  });
});
