import { listBackups, verifyBackupFile } from './backup-ops.js';

/**
 * Scheduled test of the newest backup (A4): the newest local/mounted copy of every destination is decrypted into a
 * private temporary folder, its archive is checked and `PRAGMA integrity_check` is run on the database inside; the
 * temporary files are removed (`verifyBackupFile` does all of that). A backup nobody ever opened is a hope, not a copy.
 *
 * Like `createBackupJob`, the returned function throws when anything failed (`err.results` carries each outcome), so the
 * scheduler records the error and the alert hooks fire. Destinations without a copy count as a failure: an empty folder
 * is exactly what this job must notice.
 *
 * @param {object} o
 * @param {Array} o.destinations - from BackupConfigSchema.destinations
 * @param {(opts:object) => object} o.createAdapterFn - opens a SQLite file (as for `verifyBackupFile`)
 * @param {string|null} [o.encryptionKey]
 * @param {(entry:{ok:boolean, destinationId:string, file?:string, message:string}) => void} [o.onResult] - for the audit entry / metric
 * @param {Function} [o.verifyFn] - replaceable in tests; default `verifyBackupFile`
 * @returns {() => Promise<Array<{destinationId:string, ok:boolean, file?:string, message:string}>>}
 */
export function createBackupVerifyJob({ destinations, createAdapterFn, encryptionKey = null, onResult = () => {}, verifyFn = verifyBackupFile }) {
  return async function runBackupVerify() {
    const all = listBackups(destinations).filter((b) => b.file);
    const results = [];
    for (const d of destinations.filter((x) => x.type === 'local' || x.type === 'mount')) {
      const newest = all.find((b) => b.destinationId === d.id); // listBackups sorts newest first
      let r;
      if (!newest) r = { destinationId: d.id, ok: false, message: 'no backup found to verify' };
      else {
        const v = await verifyFn(createAdapterFn, newest.path, { encryptionKey });
        r = { destinationId: d.id, ok: v.ok, file: newest.file, message: v.message };
      }
      results.push(r);
      try { onResult(r); } catch { /* reporting must not hide the result */ }
    }
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      const err = new Error(`Backup verification failed for ${failed.length}/${results.length} destination(s): ${failed.map((f) => `${f.destinationId}: ${f.message}`).join('; ')}`);
      err.results = results;
      throw err;
    }
    return results;
  };
}
