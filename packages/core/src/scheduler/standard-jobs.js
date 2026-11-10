import { purgeOlderThan, archiveAndPurge, purgePersonalData } from '../audit/retention.js';
import { purgePasswordResetTokens } from '../auth/password-reset.js';
import { createRegistrationStore } from '../accounts/registration.js';

const registered = new WeakMap(); // scheduler -> names registered by registerStandardJobs

/**
 * The housekeeping every app needs and forgets: expired sessions, old audit rows, lifted/expired bans, old metrics, spent
 * password-reset tokens and unconfirmed registrations, finished mail rows. Each job is registered only when its source is given.
 * Call it once, before `scheduler.start()`.
 * @param {object} scheduler - `createScheduler()` result
 * @param {object} o
 * @param {object} o.db
 * @param {object} [o.logger]
 * @param {{purgeExpired: () => number}} [o.sessionStore]
 * @param {{purge: () => unknown}} [o.bans]
 * @param {{purge: () => unknown}} [o.metrics] - `admin.createMetrics(db)`
 * @param {{purgeFinished: (o: {olderThanDays: number}) => number}} [o.emailQueue]
 * @param {number} [o.auditRetentionDays=0] - 0 = keep audit rows forever (no job)
 * @param {number} [o.auditPersonalDataDays=0] - erase the real logins/IPs behind audit pseudonyms unseen for this many days (rows stay, chain stays valid); 0 = off
 * @param {number} [o.auditPurgeBatchSize]
 * @param {string} [o.auditArchiveDir] - when set, rows are archived (gzip NDJSON + checksum) before audit-gc deletes them
 * @param {number} [o.mailKeepFinishedDays=30]
 * @param {boolean} [o.passwordResets=true]
 * @returns {string[]} names of the jobs registered
 */
export function registerStandardJobs(scheduler, { db, logger = null, sessionStore = null, bans = null, metrics = null, emailQueue = null, auditRetentionDays = 0, auditPersonalDataDays = 0, auditPurgeBatchSize, auditArchiveDir = '', mailKeepFinishedDays = 30, passwordResets = true } = {}) {
  if (!scheduler?.registerJob) throw new TypeError('registerStandardJobs: scheduler is required');
  if (!db) throw new TypeError('registerStandardJobs: db is required');
  const names = [];
  const add = (name, cron, fn) => { scheduler.registerJob(name, cron, fn); names.push(name); };
  const info = (msg, meta) => logger?.info?.(msg, meta);
  if (sessionStore) {
    add('sessions-gc', '15 * * * *', () => { const removed = sessionStore.purgeExpired(); if (removed > 0) info('sessions-gc removed expired sessions', { removed }); });
  }
  if (auditRetentionDays > 0) {
    add('audit-gc', '50 3 * * *', async () => {
      const cutoff = new Date(Date.now() - auditRetentionDays * 86_400_000).toISOString();
      if (auditArchiveDir) {
        const { removed, archive } = await archiveAndPurge(db, cutoff, { archiveDir: auditArchiveDir, record: true, actor: 'system', batchSize: auditPurgeBatchSize });
        if (removed > 0) info('audit-gc archived and removed old audit rows', { removed, retentionDays: auditRetentionDays, archive: archive?.file });
        return;
      }
      const removed = purgeOlderThan(db, cutoff, { record: true, actor: 'system', batchSize: auditPurgeBatchSize });
      if (removed > 0) info('audit-gc removed old audit rows', { removed, retentionDays: auditRetentionDays });
    });
  }
  if (auditPersonalDataDays > 0) {
    add('audit-personal-gc', '55 3 * * *', () => {
      const removed = purgePersonalData(db, auditPersonalDataDays, { record: true, actor: 'system' });
      if (removed > 0) info('audit-personal-gc erased personal details of audit pseudonyms', { removed, days: auditPersonalDataDays });
    });
  }
  if (bans) add('bans-gc', '15 4 * * *', () => { bans.purge(); });
  if (metrics) add('metrics-gc', '10 4 * * *', () => { metrics.purge(); });
  if (passwordResets) {
    add('password-resets-gc', '20 4 * * *', () => {
      const removed = purgePasswordResetTokens(db);
      const pending = createRegistrationStore(db).purge();
      if (removed + pending > 0) info('password-resets-gc removed expired tokens', { removed, registrations: pending });
    });
  }
  if (emailQueue) {
    add('email-queue-gc', '40 4 * * *', () => { const removed = emailQueue.purgeFinished({ olderThanDays: mailKeepFinishedDays }); if (removed > 0) info('email-queue-gc removed finished rows', { removed }); });
  }
  registered.set(scheduler, names);
  return names;
}

/** Doctor check: did the application register the standard cleanup jobs on this scheduler? */
export function standardJobsChecks(scheduler) {
  const names = scheduler ? registered.get(scheduler) : undefined;
  if (!names) return [{ name: 'Cleanup jobs', status: 'warn', message: 'standard cleanup jobs are not registered: sessions, audit, mail and tokens grow without limit (scheduler.registerStandardJobs)' }];
  return [{ name: 'Cleanup jobs', status: 'ok', message: `${names.length} registered (${names.join(', ')})` }];
}
