import { readdirSync, statSync, existsSync, copyFileSync, renameSync, unlinkSync, rmSync, mkdtempSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { migrationStatus } from '../cli/migrator.js';
import { decryptBackupFile, isEncryptedBackup } from './backup-crypto.js';
import { acquireFileLock, readLockOwner } from './file-lock.js';
import { openBackupArchive, checkArchiveData, extractBackupDatabase, extractBackupUploads } from './backup-archive.js';

/**
 * Lists backup files across 'local' destinations - the read-side
 * counterpart to backup-job.js's createBackupJob() (the write side).
 * Non-local destination types are reported but not scanned (same
 * "only local is implemented" boundary as backup-job.js - no silent
 * pretending there are backups where upload isn't even built yet).
 *
 * @param {Array} destinations - BackupConfigSchema.destinations
 * @returns {Array<{destinationId, file, path, sizeBytes, createdAt}|{destinationId, type, supported:false}>}
 */
export function listBackups(destinations) {
  const results = [];

  for (const destination of destinations) {
    if (destination.type !== 'local' && destination.type !== 'mount') {
      if (destination.type === 'sftp') continue; // remote: see listRemoteBackups()
      results.push({ destinationId: destination.id, type: destination.type, supported: false });
      continue;
    }

    let entries;
    try {
      entries = readdirSync(destination.path);
    } catch {
      entries = []; // destination directory doesn't exist yet - no backups, not an error
    }

    for (const entry of entries) {
      if (!entry.startsWith('backup-') || !(entry.endsWith('.zip') || entry.endsWith('.zip.enc'))) continue;
      const fullPath = path.join(destination.path, entry);
      const stat = statSync(fullPath);
      results.push({
        destinationId: destination.id,
        file: entry,
        path: fullPath,
        sizeBytes: stat.size,
        encrypted: entry.endsWith('.enc'),
        createdAt: stat.mtime.toISOString(),
      });
    }
  }

  results.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return results;
}

function integrityCheckFile(createAdapterFn, filePath) {
  let db;
  try {
    db = createAdapterFn({ file: filePath, walMode: false, readonly: true });
    const rows = db.all('PRAGMA integrity_check');
    const ok = rows.length === 1 && Object.values(rows[0])[0] === 'ok';
    return { ok, message: ok ? 'integrity OK' : rows.map((r) => Object.values(r)[0]).join('; ') };
  } catch (err) {
    return { ok: false, message: err.message };
  } finally {
    db?.close();
  }
}

/**
 * Verifies a backup archive without touching the live database: the zip
 * must be a well-formed backup (manifest, `database.db`, safe names),
 * every entry must pass its CRC check, and the database inside is
 * extracted to a private temporary file and opened READ-ONLY for
 * `PRAGMA integrity_check`. This is step 1 of restoreBackup() below, and
 * is also exposed standalone as `backup verify <file>` so an operator can
 * sanity-check a backup at any time, not only mid-restore.
 *
 * @param {(opts:object) => import('../database/adapter.js')} createAdapterFn - core/database's createSqliteAdapter
 * @returns {Promise<{ok: boolean, message: string}>}
 */
async function verifyPlainBackupFile(createAdapterFn, filePath) {
  if (!existsSync(filePath)) {
    return { ok: false, message: `${filePath} does not exist` };
  }
  let tmpDir;
  let opened;
  try {
    opened = await openBackupArchive(filePath);
    const { files } = await checkArchiveData(opened);
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'das-forge-verify-'));
    const dbCopy = path.join(tmpDir, 'database.db');
    await extractBackupDatabase(opened, dbCopy);
    const integrity = integrityCheckFile(createAdapterFn, dbCopy);
    if (!integrity.ok) return integrity;
    return { ok: true, message: `integrity OK (${files} file(s) in archive, CRC verified)` };
  } catch (err) {
    return { ok: false, message: err.message };
  } finally {
    await opened?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Orchestrated restore pipeline, per the architecture doc §4.3:
 *   verify backup → restore → integrity check → migration check
 *   → audit entry → health check
 * stopping at the first failing step.
 *
 * "stop writes" (the doc's step between verify and restore) has no
 * separate implementation here: this runs as a one-shot CLI command,
 * not inside a live server request cycle, so there's nothing to drain.
 * What DOES matter is that the CALLER has already closed its connection
 * to `dbFilePath` before calling this - restoreBackup() only deals with
 * files and a fresh connection it opens itself, never the caller's live
 * handle, which is why there's no `db` parameter.
 *
 * Atomicity (audit B04): the backup is first copied to a temporary file
 * beside the live one and moved into place with a single rename, after
 * the stale `-wal`/`-shm` sidecars of the OLD database are removed (a
 * leftover WAL would otherwise be replayed onto the restored file and
 * corrupt it). If the sidecars cannot be removed - typically because
 * another process still has the database open - the restore stops BEFORE
 * touching anything. A consistent safety copy of the pre-restore database
 * (VACUUM INTO, so it includes un-checkpointed WAL content) is kept at
 * `${dbFilePath}.pre-restore-<timestamp>`, and if reopening, integrity or
 * the health check fail after the swap, it is put back automatically
 * (a 'Rollback' step is recorded).
 *
 * Not covered: there is still no lock/PID check against a running server
 * on platforms where deleting an open `-wal` succeeds (POSIX) - stop the
 * server before restoring.
 *
 * @param {object} opts
 * @param {string} opts.dbFilePath - path to the LIVE database file (already closed by the caller)
 * @param {string} opts.backupFilePath - the backup archive (`backup-<ts>.zip`) to restore
 * @param {string} [opts.migrationsDir]
 * @param {(opts:object) => import('../database/adapter.js')} opts.createAdapterFn
 * @param {(db, entry:object) => void} [opts.auditLogFn] - core/audit's log(), optional
 * @param {string|null} [opts.actor]
 * @param {string|null} [opts.uploadsDir] - live uploads directory; if the archive contains uploads they replace this directory (the old one is kept as `<uploadsDir>.pre-restore-<ms>`)
 * @returns {Promise<{ok: boolean, steps: Array<{name,ok,message}>, db?: object, preRestorePath?: string|null}>}
 *   `db` (when present) is a connection to the now-restored database,
 *   left OPEN for the caller to use/close - restoreBackup() doesn't
 *   close it itself since the caller usually wants to use it right away
 *   (e.g. to keep serving the health-check result).
 */
async function restorePlainBackup({ dbFilePath, backupFilePath, migrationsDir, createAdapterFn, auditLogFn, actor = null, uploadsDir = null }) {
  const steps = [];
  const recordOk = (name, message) => steps.push({ name, ok: true, message });
  const fail = (name, message, extra = {}) => {
    steps.push({ name, ok: false, message });
    return { ok: false, steps, ...extra };
  };

  const verify = await verifyBackupFile(createAdapterFn, backupFilePath);
  if (!verify.ok) return fail('Verify backup', verify.message);
  recordOk('Verify backup', verify.message);

  let archive;
  try {
    archive = await openBackupArchive(backupFilePath);
  } catch (err) {
    return fail('Verify backup', err.message);
  }
  try {
    return await runRestore(archive);
  } finally {
    await archive.close();
  }

  async function runRestore(archive) {

  let preRestorePath = null;
  if (existsSync(dbFilePath)) {
    preRestorePath = `${dbFilePath}.pre-restore-${Date.now()}`;
    try {
      const how = snapshotFile(dbFilePath, preRestorePath);
      recordOk('Safety copy', `saved current database to ${preRestorePath} (${how})`);
    } catch (err) {
      return fail('Safety copy', err.message);
    }
  } else {
    recordOk('Safety copy', 'no existing database file - fresh restore, nothing to copy');
  }

  // Stage next to the live file (same volume, so the rename is atomic).
  const stagedPath = `${dbFilePath}.restore-tmp`;
  try {
    await extractBackupDatabase(archive, stagedPath);
  } catch (err) {
    safeUnlink(stagedPath);
    return fail('Restore', `could not stage the backup: ${err.message}`);
  }

  try {
    removeSidecars(dbFilePath);
  } catch (err) {
    safeUnlink(stagedPath);
    return fail('Restore', `database appears to be in use by another process (${err.message}); nothing was changed`);
  }

  try {
    renameSync(stagedPath, dbFilePath);
    recordOk('Restore', `extracted database from ${backupFilePath} -> ${dbFilePath}`);
  } catch (err) {
    safeUnlink(stagedPath);
    return fail('Restore', err.message);
  }

  /** Puts the pre-restore copy back; returns the extra step to record. */
  const rollback = (reason) => {
    if (!preRestorePath) {
      steps.push({ name: 'Rollback', ok: false, message: `no pre-restore copy to roll back to (${reason})` });
      return;
    }
    try {
      removeSidecars(dbFilePath);
      const stagedRollback = `${dbFilePath}.rollback-tmp`;
      copyFileSync(preRestorePath, stagedRollback);
      renameSync(stagedRollback, dbFilePath);
      steps.push({ name: 'Rollback', ok: true, message: `restored the previous database from ${preRestorePath} (${reason})` });
    } catch (err) {
      steps.push({ name: 'Rollback', ok: false, message: `rollback failed: ${err.message}; previous database is still at ${preRestorePath}` });
    }
  };

  let db;
  try {
    db = createAdapterFn({ file: dbFilePath });
  } catch (err) {
    steps.push({ name: 'Reopen database', ok: false, message: err.message });
    rollback('reopen failed');
    return { ok: false, steps, preRestorePath };
  }

  // Run integrity_check directly against the connection we just opened,
  // rather than calling verifyBackupFile() again (which would open a
  // SECOND, separate connection to the same file).
  try {
    const rows = db.all('PRAGMA integrity_check');
    const ok = rows.length === 1 && Object.values(rows[0])[0] === 'ok';
    if (!ok) {
      db.close();
      steps.push({ name: 'Integrity check', ok: false, message: rows.map((r) => Object.values(r)[0]).join('; ') });
      rollback('integrity check failed');
      return { ok: false, steps, preRestorePath };
    }
    recordOk('Integrity check', 'integrity OK');
    // A backup revives what was true when it was made: sessions stolen before an incident and
    // reset links that were already cancelled would work again (audit L02). Drop them.
    const revoked = revokeRestoredCredentials(db);
    if (revoked > 0) recordOk('Revoke sessions', `${revoked} restored session/reset-token row(s) dropped; everyone signs in again`);
  } catch (err) {
    db.close();
    steps.push({ name: 'Integrity check', ok: false, message: err.message });
    rollback('integrity check failed');
    return { ok: false, steps, preRestorePath };
  }

  if (migrationsDir) {
    try {
      const status = migrationStatus(db, migrationsDir);
      const pending = status.filter((m) => !m.applied);
      recordOk(
        'Migration check',
        pending.length === 0
          ? `${status.length} applied, 0 pending`
          : `${pending.length} pending - run \`migrate\` manually (restore does not auto-apply migrations)`
      );
    } catch (err) {
      // advisory, not fatal - the restore itself already succeeded
      recordOk('Migration check', `could not check: ${err.message}`);
    }
  }

  if (auditLogFn) {
    try {
      auditLogFn(db, { actor, action: 'backup.restore', meta: { backupFilePath, preRestorePath } });
      recordOk('Audit entry', 'logged');
    } catch (err) {
      recordOk('Audit entry', `could not log: ${err.message}`);
    }
  }

  try {
    db.get('SELECT 1 AS ok');
    recordOk('Health check', 'ok');
  } catch {
    steps.push({ name: 'Health check', ok: false, message: 'not responding after restore' });
    try {
      db.close();
    } catch {
      /* already unusable */
    }
    rollback('health check failed');
    return { ok: false, steps, preRestorePath };
  }

  if (uploadsDir) {
    if (archive.manifest.uploads) {
      const staged = `${uploadsDir}.restore-tmp`;
      let movedAside = null;
      try {
        rmSync(staged, { recursive: true, force: true });
        const count = await extractBackupUploads(archive, staged);
        if (existsSync(uploadsDir)) {
          movedAside = `${uploadsDir}.pre-restore-${Date.now()}`;
          renameSync(uploadsDir, movedAside);
        }
        renameSync(staged, uploadsDir);
        recordOk('Restore uploads', `replaced ${uploadsDir} with ${count} file(s) from the archive${movedAside ? ` (previous files kept at ${movedAside})` : ''}`);
      } catch (err) {
        rmSync(staged, { recursive: true, force: true });
        if (movedAside && !existsSync(uploadsDir)) {
          try {
            renameSync(movedAside, uploadsDir);
          } catch {
            /* leave it aside; the message below names it */
          }
        }
        steps.push({ name: 'Restore uploads', ok: false, message: `${err.message}; the database WAS restored, uploads were not` });
        return { ok: false, steps, db, preRestorePath };
      }
    } else {
      recordOk('Restore uploads', 'this backup was made without an uploads directory - uploads left as they are');
    }
  }

  return { ok: true, steps, db, preRestorePath };
  }
}

/** Removes restored login sessions and still-open password-reset tokens; tables that do not exist are skipped. */
function revokeRestoredCredentials(db) {
  let n = 0;
  for (const sql of [`DELETE FROM sessions`, `DELETE FROM password_resets WHERE used_at IS NULL`]) {
    try {
      n += db.run(sql).changes ?? 0;
    } catch {
      /* table not present in this application's database */
    }
  }
  return n;
}

function safeUnlink(file) {
  try {
    unlinkSync(file);
  } catch {
    /* best effort */
  }
}

/** Removes `-wal`/`-shm` next to a database file; throws if one exists but cannot be removed. */
function removeSidecars(dbFilePath) {
  for (const suffix of ['-wal', '-shm']) {
    const f = dbFilePath + suffix;
    if (existsSync(f)) unlinkSync(f);
  }
}

/** The safety copy holds password hashes and personal data: owner-only (audit L03). */
function ownerOnly(file) {
  try {
    chmodSync(file, 0o600);
  } catch {
    /* not supported on this platform */
  }
}

/**
 * Consistent copy of a database file that may have a pending WAL: opens
 * it (which replays the WAL) and VACUUM INTOs the destination. Falls back
 * to a plain file copy only if the source cannot be opened as a database
 * (e.g. it is the corrupt file we are replacing) - the returned string
 * says which one happened.
 */
function snapshotFile(source, dest) {
  let src;
  try {
    src = new DatabaseSync(source);
    src.prepare('VACUUM INTO ?').run(String(dest));
    ownerOnly(dest);
    return 'consistent snapshot';
  } catch {
    copyFileSync(source, dest);
    ownerOnly(dest);
    return 'raw file copy - source was not readable as a database';
  } finally {
    try {
      src?.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Runs `fn(plainPath)` on a readable archive: an encrypted backup (`.zip.enc`)
 * is decrypted into a private temporary directory first (removed afterwards),
 * a plain one is passed through. Returns `{error}` instead of throwing so the
 * callers can report it in their own shape.
 */
async function withPlainArchive(filePath, encryptionKey, fn) {
  if (!existsSync(filePath) || !isEncryptedBackup(filePath)) return { value: await fn(filePath) };
  if (!encryptionKey) return { error: 'This backup is encrypted: set backup.encryptionKey (DAS_BACKUP_KEY) to read it' };
  const dir = mkdtempSync(path.join(os.tmpdir(), 'das-forge-decrypt-'));
  try {
    const plain = path.join(dir, 'backup.zip');
    try {
      await decryptBackupFile(filePath, plain, encryptionKey);
    } catch (err) {
      return { error: err.message };
    }
    return { value: await fn(plain) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Verifies a backup archive (see the checks above). Encrypted backups
 * (`.zip.enc`) need `encryptionKey`; a wrong key reads as a damaged file.
 * @param {(opts:object) => object} createAdapterFn
 * @param {string} filePath
 * @param {{encryptionKey?: string|null}} [opts]
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export async function verifyBackupFile(createAdapterFn, filePath, { encryptionKey = null } = {}) {
  const r = await withPlainArchive(filePath, encryptionKey, (plain) => verifyPlainBackupFile(createAdapterFn, plain));
  return r.error ? { ok: false, message: r.error } : r.value;
}

/**
 * Restore pipeline (see restorePlainBackup's description above). Accepts
 * encrypted backups when `encryptionKey` is given.
 */
export async function restoreBackup(options) {
  // G02: restoring swaps the database file under a running server (it keeps writing to the
  // unlinked inode and the live -wal is deleted). With serverLockFile (held by the server for its
  // whole life) the restore refuses while a server runs, and holds the lock itself so one cannot
  // start in the middle of the restore.
  let release = null;
  if (options.serverLockFile) {
    release = acquireFileLock(options.serverLockFile, { staleMs: Infinity });
    if (!release) {
      const owner = readLockOwner(options.serverLockFile);
      return {
        ok: false,
        steps: [{ name: 'Check server', ok: false, message: `the application server is running${owner ? ` (pid ${owner.pid})` : ''} - stop it first, then restore` }],
      };
    }
  }
  try {
    return await restoreInner(options);
  } finally {
    release?.();
  }
}

async function restoreInner(options) {
  const r = await withPlainArchive(options.backupFilePath, options.encryptionKey ?? null, (plain) =>
    restorePlainBackup({ ...options, backupFilePath: plain })
  );
  if (r.error) return { ok: false, steps: [{ name: 'Verify backup', ok: false, message: r.error }] };
  return r.value;
}
