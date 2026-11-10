/**
 * The gauges the core knows how to read by itself. Each source is optional; what the application does not pass is skipped.
 * @param {object} metrics - from createPrometheusMetrics
 * @param {object} o
 * @param {object} [o.db] - sessions are counted from here
 * @param {{stats: () => {pending: number, sending: number, sent: number, failed: number}}} [o.mailQueue]
 * @param {() => (Date|number|string|null)} [o.lastBackupAt] - when the newest backup was made
 * @param {{get: () => {enabled: boolean}}} [o.maintenance] - exports whether maintenance mode is on
 * @param {() => number} [o.now]
 */
export function registerCoreGauges(metrics, { db, mailQueue, lastBackupAt, maintenance, now = () => Date.now() } = {}) {
  if (db) {
    metrics.addGauge({ name: 'sessions_active', help: 'Sessions that have not expired', collect: () => db.get('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?', [new Date(now()).toISOString()]).n });
  }
  if (db) {
    // State of the security tables. A table that does not exist yet makes the source fail, and a failing source is skipped at scrape time.
    metrics.addGauge({ name: 'bans_active', help: 'Active IP/user bans', collect: () => { const t = new Date(now()).toISOString(); return db.get('SELECT COUNT(*) AS n FROM security_bans WHERE lifted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)', [t]).n; } });
    metrics.addGauge({ name: 'security_incidents_open', help: 'Security incidents not closed yet', collect: () => db.get("SELECT COUNT(*) AS n FROM security_incidents WHERE status != 'closed' AND closed_at IS NULL").n });
    metrics.addGauge({ name: 'alerts_24h', help: 'Alerts raised in the last 24 hours', collect: () => db.get('SELECT COUNT(*) AS n FROM alerts WHERE created_at > ?', [new Date(now() - 86400000).toISOString()]).n });
  }
  if (maintenance?.get) {
    metrics.addGauge({ name: 'maintenance_mode', help: '1 while maintenance mode is on', collect: () => (maintenance.get().enabled ? 1 : 0) });
  }
  if (mailQueue?.stats) {
    metrics.addGauge({ name: 'mail_queue_pending', help: 'Mails waiting to be sent', collect: () => mailQueue.stats().pending });
    metrics.addGauge({ name: 'mail_queue_failed', help: 'Mails that failed for good', collect: () => mailQueue.stats().failed });
  }
  if (lastBackupAt) {
    metrics.addGauge({
      name: 'last_backup_age_seconds', help: 'Seconds since the newest backup (absent when there is none)',
      collect: () => { const t = lastBackupAt(); const ms = t == null ? NaN : new Date(t).getTime(); return Number.isFinite(ms) ? Math.max(0, (now() - ms) / 1000) : null; },
    });
  }
}
