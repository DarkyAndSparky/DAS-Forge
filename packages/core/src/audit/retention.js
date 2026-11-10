import { ensureAuditTable } from './schema.js';
import { log } from './log.js';
import { purgeStaleSubjects } from './subjects.js';
import { archiveBefore, verifyArchive } from './archive.js';

/**
 * Deletes audit_log rows strictly older than `beforeIso`. Returns the
 * number of rows removed.
 *
 * This is a plain function, not a cron job itself - core/audit doesn't
 * know about core/scheduler (no reverse dependency between modules).
 * Wiring `purgeOlderThan(db, cutoff)` into a scheduled job is left to
 * the app/examples/workshop, same pattern as createBackupJob() in
 * core/scheduler being handed a db rather than importing one.
 */
export function purgeOlderThan(db, beforeIso, { record = false, actor = null, batchSize = 5000 } = {}) {
  return purgeSync(db, beforeIso, { record, actor, batchSize });
}

/**
 * The same cleanup, but first writes the rows to an archive in `archiveDir` and deletes only after the archive has been
 * written and checked; if anything fails, nothing is deleted and the error is thrown.
 * @returns {Promise<{removed: number, archive: object|null}>}
 */
export async function archiveAndPurge(db, beforeIso, { archiveDir, record = true, actor = null, batchSize = 5000 } = {}) {
  if (!archiveDir) throw new TypeError('archiveAndPurge() requires archiveDir');
  const archive = await archiveBefore(db, beforeIso, { dir: archiveDir });
  if (archive) {
    const v = verifyArchive(archive.file);
    if (!v.ok || v.rows !== archive.rows) throw new Error(`audit archive check failed (${v.reason ?? 'row count'}); nothing was deleted`);
  }
  const removed = purgeSync(db, beforeIso, { record: false, actor, batchSize });
  if (record) log(db, { actor, action: 'audit.purge', meta: { before: beforeIso, removed, archive: archive ? { file: archive.file.split(/[\\/]/).pop(), rows: archive.rows, sha256: archive.sha256, lastId: archive.lastId, lastHash: archive.lastHash } : null } });
  return { removed, archive };
}

/**
 * Erases the personal details behind audit pseudonyms (real logins and IP addresses) that have not been seen for `days` days.
 * The rows stay and the hash chain stays valid (the hash covers the pseudonym); the fields read "[erased]" afterwards.
 * A person or address that is still active keeps its mapping: it is erased `days` days after the LAST time it was seen.
 * Rows written before pseudonyms existed hold plain values and age out through the ordinary row retention.
 * @returns {number} mappings removed
 */
export function purgePersonalData(db, days, { record = true, actor = null, now = Date.now() } = {}) {
  const d = Math.trunc(Number(days));
  if (!Number.isFinite(d) || d < 1) throw new RangeError('purgePersonalData(): days must be an integer >= 1');
  ensureAuditTable(db);
  const cutoff = new Date(now - d * 86_400_000).toISOString();
  const removed = purgeStaleSubjects(db, cutoff);
  if (record && removed > 0) log(db, { actor, action: 'audit.personal_data.purge', meta: { days: d, removed } });
  return removed;
}

function purgeSync(db, beforeIso, { record, actor, batchSize }) {
  if (!beforeIso) {
    throw new TypeError('purgeOlderThan() requires a cutoff ISO datetime string');
  }
  ensureAuditTable(db);

  // Batches (audit I06): one huge DELETE after months of growth would hold the write lock
  // and make every other writer fail with SQLITE_BUSY.
  const size = Math.max(1, Math.trunc(Number(batchSize)) || 5000);
  let removed = 0;
  for (;;) {
    const n = Number(
      db.run(`DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE created_at < ? ORDER BY id LIMIT ?)`, [beforeIso, size]).changes
    );
    removed += n;
    if (n < size) break;
  }
  purgeStaleSubjects(db, beforeIso);
  // Opt-in so existing callers/tests keep their exact row counts; a real
  // app should pass { record: true } so a retention run is itself audited.
  if (record) log(db, { actor, action: 'audit.purge', meta: { before: beforeIso, removed } });
  return removed;
}
