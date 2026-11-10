import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { writeBackupArchive } from './backup-archive.js';
import { encryptBackupFile } from './backup-crypto.js';
import { createRemoteTarget, pruneTarget } from './backup-remote.js';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';

/**
 * Backs up the sqlite database per BackupConfigSchema (core/config:
 * schedule, destinations, retentionDays).
 *
 * A backup is ONE file, `backup-<timestamp>.zip`, holding the database
 * snapshot, the uploads directory and a manifest (layout: backup-archive.js).
 *
 * How a copy is made (audit B01): `VACUUM INTO` a temporary file next to
 * the final name, `PRAGMA integrity_check` on that temporary file, the
 * snapshot (plus uploads) is streamed into `<name>.zip.tmp`, and only then
 * an atomic `rename` to `backup-<timestamp>.zip`. A half-written or
 * corrupt copy therefore never appears under a `backup-*.zip` name.
 *
 * Destination types: 'local' (a directory), 'mount' (a mounted network share) and 'sftp'
 * (scheduler/backup-remote.js; one archive is built once in a private staging directory and sent to
 * every remote target, encrypted unless the destination says otherwise). 's3'/'webdav'
 * are validated by the config schema but their upload isn't built: such a
 * destination FAILS (it is not silently skipped), but since B02 it no
 * longer prevents the other destinations from being written.
 */

export const DEFAULT_MIN_KEEP = 3;

const BACKUP_NAME = /^backup-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.zip(?:\.enc)?$/;

/** Timestamp encoded in a backup file name, or null for a foreign name. */
export function parseBackupTimestamp(fileName) {
  const m = BACKUP_NAME.exec(fileName);
  if (!m) return null;
  const iso = m[1].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z');
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

function integrityOk(file) {
  const check = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = check.prepare('PRAGMA integrity_check').all();
    return rows.length === 1 && Object.values(rows[0])[0] === 'ok';
  } finally {
    check.close();
  }
}

async function backupToLocal(db, destination, timestamp, uploadsDir, encryptionKey) {
  if (typeof db.snapshotTo !== 'function') {
    throw new Error('backup requires a DatabaseAdapter with snapshotTo() (core createSqliteAdapter provides it)');
  }
  mkdirSync(destination.path, { recursive: true });
  const finalPath = path.join(destination.path, `backup-${timestamp}.zip`);
  const tmpZip = `${finalPath}.tmp`;
  const tmpDb = `${finalPath}.db.tmp`;
  for (const stale of [tmpZip, tmpDb]) if (existsSync(stale)) unlinkSync(stale); // leftovers from a crashed run
  try {
    // A file database is copied and checked in a worker thread, so the event loop keeps serving requests (audit I03).
    let checked = null;
    if (typeof db.snapshotToAsync === 'function') ({ integrityOk: checked } = await db.snapshotToAsync(tmpDb));
    else db.snapshotTo(tmpDb);
    if (!(checked ?? integrityOk(tmpDb))) throw new Error('integrity_check failed on the new backup copy');
    // backups hold hashes and PII: owner-only (writeBackupArchive applies the mode)
    const { uploadsIncluded } = await writeBackupArchive({ dbFile: tmpDb, uploadsDir, zipPath: tmpZip });
    if (encryptionKey) {
      const encPath = `${finalPath}.enc`;
      const tmpEnc = `${encPath}.tmp`;
      try {
        await encryptBackupFile(tmpZip, tmpEnc, encryptionKey);
        renameSync(tmpEnc, encPath);
      } finally {
        safeRemove(tmpEnc);
        safeRemove(tmpZip); // the plain archive never stays next to the sealed one
      }
      return { backupPath: encPath, uploadsIncluded, encrypted: true };
    }
    renameSync(tmpZip, finalPath);
    return { backupPath: finalPath, uploadsIncluded, encrypted: false };
  } catch (err) {
    safeRemove(tmpZip);
    throw err;
  } finally {
    safeRemove(tmpDb);
  }
}

function safeRemove(file) {
  try {
    rmSync(file, { force: true, recursive: true });
  } catch {
    /* nothing to clean */
  }
}

/**
 * Prunes old backups (audit B03). Age comes from the timestamp in the
 * file NAME (mtime only for foreign names - copying a file resets mtime),
 * the newest `minKeep` are ALWAYS kept regardless of age (a job that did
 * not run for a month must not delete every older copy), and a file that
 * cannot be removed is skipped instead of aborting the rest.
 */
function applyLocalRetention(destination, retentionDays, minKeep) {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let entries;
  try {
    entries = readdirSync(destination.path);
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    if (!entry.startsWith('backup-') || !(entry.endsWith('.zip') || entry.endsWith('.zip.enc'))) continue;
    const fullPath = path.join(destination.path, entry);
    let time = parseBackupTimestamp(entry);
    if (time === null) {
      try {
        time = statSync(fullPath).mtimeMs;
      } catch {
        continue;
      }
    }
    files.push({ entry, fullPath, time });
  }
  files.sort((a, b) => b.time - a.time);

  const removed = [];
  for (const f of files.slice(minKeep)) {
    if (f.time >= cutoff) continue;
    try {
      unlinkSync(f.fullPath);
      removed.push(f.entry);
    } catch {
      /* keep going; the next run retries */
    }
  }
  return removed;
}

/**
 * Builds the handler function to pass to scheduler.registerJob().
 *
 * Each destination is independent (audit B02): one failing destination
 * is recorded and the rest still run; if ANY failed, the job throws at
 * the end with `err.results` carrying the per-destination outcome (so
 * the scheduler still records lastError). Retention for a destination
 * runs only after its new copy was written AND verified.
 *
 * @param {object} opts
 * @param {object} opts.db - DatabaseAdapter with snapshotTo()
 * @param {string} [opts.dbFilePath] - unused since B01 (snapshots go through the connection); accepted for compatibility
 * @param {Array} opts.destinations - from BackupConfigSchema.destinations
 * @param {number} opts.retentionDays - integer >= 1
 * @param {number} [opts.minKeep=3] - newest copies never pruned, per destination
 * @param {string|null} [opts.encryptionKey] - passphrase (>= 16 chars): every backup is written as `backup-<ts>.zip.enc` (AES-256-GCM, see backup-crypto.js); the plain zip is removed
 * @param {string|null} [opts.uploadsDir] - when set (and the directory exists), its files are packed into every backup under `uploads/`
 */
export function createBackupJob({
  db,
  destinations,
  retentionDays,
  minKeep = DEFAULT_MIN_KEEP,
  uploadsDir = null,
  encryptionKey = null,
  dbFilePath = null,
  env = process.env,
  ssh2 = null,
  targetFactory = createRemoteTarget,
}) {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new RangeError(`createBackupJob: retentionDays must be an integer >= 1, got ${retentionDays}`);
  }
  if (encryptionKey !== null && (typeof encryptionKey !== 'string' || encryptionKey.length < 16)) {
    throw new RangeError('createBackupJob: encryptionKey must be a string of at least 16 characters');
  }
  if (!Number.isInteger(minKeep) || minKeep < 1) {
    throw new RangeError(`createBackupJob: minKeep must be an integer >= 1, got ${minKeep}`);
  }

  return async function runBackup() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const results = [];
    let staged = null; // { dir, file, name } - built once for all remote targets

    const stage = async () => {
      if (staged) return staged;
      const dir = mkdtempSync(path.join(os.tmpdir(), 'das-backup-'));
      try {
        const made = await backupToLocal(db, { path: dir }, timestamp, uploadsDir, encryptionKey);
        staged = { dir, file: made.backupPath, name: path.basename(made.backupPath), uploadsIncluded: made.uploadsIncluded, encrypted: made.encrypted };
      } catch (err) {
        safeRemove(dir);
        throw err;
      }
      return staged;
    };

    for (const destination of destinations) {
      if (destination.type === 'mount' || destination.type === 'sftp') {
        let target;
        try {
          target = targetFactory(destination, {
            ssh2,
            env,
            localCheckPath: dbFilePath ? path.dirname(dbFilePath) : null,
          });
          if (!encryptionKey && !target.options?.allowUnencrypted) {
            throw new Error('refusing to send an unencrypted backup off the machine: set backup.encryptionKey (or allowUnencrypted in the destination config)');
          }
          await target.preflight();
          const s = await stage();
          const put = await target.put(s.file, s.name);
          const removed = await pruneTarget(target, { retentionDays, minKeep });
          results.push({ destinationId: destination.id, ok: true, backupPath: put.location, bytes: put.bytes, sha256: put.sha256, verified: put.verified, uploadsIncluded: s.uploadsIncluded, encrypted: s.encrypted, prunedCount: removed.length });
        } catch (err) {
          results.push({ destinationId: destination.id, ok: false, error: err.message });
        } finally {
          try {
            await target?.close();
          } catch {
            /* closing must not hide the result */
          }
        }
        continue;
      }
      try {
        if (destination.type !== 'local') {
          throw new Error(
            `Backup destination type "${destination.type}" is not implemented yet (by design - ` +
              `extension point, see backup-job.js). Only "local" is implemented.`
          );
        }
        const { backupPath, uploadsIncluded, encrypted } = await backupToLocal(db, destination, timestamp, uploadsDir, encryptionKey);
        const removed = applyLocalRetention(destination, retentionDays, minKeep);
        results.push({ destinationId: destination.id, ok: true, backupPath, uploadsIncluded, encrypted, prunedCount: removed.length });
      } catch (err) {
        results.push({ destinationId: destination.id, ok: false, error: err.message });
      }
    }

    if (staged) safeRemove(staged.dir);

    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      const err = new Error(
        `Backup failed for ${failed.length}/${results.length} destination(s): ` +
          failed.map((f) => `${f.destinationId}: ${f.error}`).join('; ')
      );
      err.results = results;
      throw err;
    }
    return results;
  };
}
