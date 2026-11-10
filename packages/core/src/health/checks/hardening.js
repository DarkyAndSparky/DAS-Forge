/**
 * Hardening category: things that are not wrong in the configuration file but weaken a running installation -
 * the process runs as root, secret files readable by other users, administrators without a second factor, a proxy
 * trusted too widely, a backup or audit-chain check that has not run for days, a heap close to its limit, a blocked
 * event loop. Every check only reads; nothing is changed.
 *
 * File modes are checked on POSIX only (Windows has no comparable mode bits, the check is skipped there).
 */
import { statSync } from 'node:fs';
import v8 from 'node:v8';

const HOUR = 3_600_000;
const posix = () => process.platform !== 'win32';

function lastRun(db, name) {
  try { return db.get('SELECT last_run_at FROM scheduler_state WHERE name = ?', [name])?.last_run_at ?? null; } catch { return null; }
}
const safe = (fn) => { try { return fn?.() ?? null; } catch { return null; } };
/** The later of two ISO times (either may be missing or unreadable). */
function latestIso(a, b) {
  const ta = Date.parse(a ?? ''); const tb = Date.parse(b ?? '');
  if (Number.isNaN(ta) && Number.isNaN(tb)) return a ?? b ?? null;
  return Number.isNaN(tb) || ta >= tb ? a : b;
}
const ageHours = (iso, now) => (Number.isNaN(Date.parse(iso)) ? null : (now - Date.parse(iso)) / HOUR);

/** One-shot measure of how late a 20 ms timer fires: a blocked event loop shows up as a large drift. */
function loopDelayMs(sampleMs = 20) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    setTimeout(() => resolve(Math.max(0, Number(process.hrtime.bigint() - t0) / 1e6 - sampleMs)), sampleMs);
  });
}

/**
 * @param {object} o
 * @param {object} [o.appConfig]
 * @param {object} [o.db]
 * @param {Record<string, string>} [o.secretFiles] - label -> path of files that must not be readable by group/others (database, certificate key)
 * @param {Record<string, string>} [o.secretDirs] - label -> path of directories that must not be accessible to others
 * @param {string} [o.adminRole='admin']
 * @param {string} [o.backupJob='backup'] - scheduler job whose last run is the "last backup"
 * @param {() => (string|null)} [o.lastBackupAt] - ISO time of the newest backup file; counts together with the job's last run, so a backup made by hand is seen too
 * @param {string} [o.auditJob='alerts-audit-chain'] - scheduler job that verifies the audit chain
 * @param {number} [o.backupMaxAgeHours=48]
 * @param {number} [o.auditMaxAgeHours=72]
 * @param {() => number} [o.now]
 */
export async function hardeningChecks({ appConfig = {}, db = null, secretFiles = {}, secretDirs = {}, adminRole = 'admin', backupJob = 'backup', auditJob = 'alerts-audit-chain', lastBackupAt = null, backupMaxAgeHours = 48, auditMaxAgeHours = 72, now = () => Date.now() } = {}) {
  const out = [];

  if (posix() && typeof process.getuid === 'function') {
    out.push(process.getuid() === 0
      ? { name: 'Process user', status: 'warn', message: 'running as root - run the service as an unprivileged user (a flaw in the application would then own the machine)' }
      : { name: 'Process user', status: 'ok', message: `uid ${process.getuid()}` });
  }

  if (posix()) {
    for (const [label, file, mask] of [...Object.entries(secretFiles).map(([l, f]) => [l, f, 0o077]), ...Object.entries(secretDirs).map(([l, f]) => [l, f, 0o007])]) {
      try {
        const mode = statSync(file).mode & 0o777;
        out.push((mode & mask) === 0
          ? { name: `Permissions: ${label}`, status: 'ok', message: `${mode.toString(8)}` }
          : { name: `Permissions: ${label}`, status: 'warn', message: `${file} has mode ${mode.toString(8)} - readable by other users; use ${mask === 0o077 ? '600' : '750'}` });
      } catch { /* a missing file is reported by the Storage category */ }
    }
  }

  if (db) {
    try {
      const row = db.get(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN totp_enabled = 1 OR EXISTS (SELECT 1 FROM authenticators a WHERE a.user_id = users.id AND a.status = 'active') THEN 1 ELSE 0 END) AS secured
           FROM users WHERE role = ? AND disabled = 0`, [adminRole]);
      const total = Number(row?.total ?? 0);
      const secured = Number(row?.secured ?? 0);
      if (total > 0) {
        out.push(secured === total
          ? { name: 'Administrators: second factor', status: 'ok', message: `${total} of ${total} have an authenticator` }
          : { name: 'Administrators: second factor', status: 'warn', message: `${total - secured} of ${total} administrators have no authenticator - enable two-factor sign-in` });
      }
    } catch { /* tables absent: nothing to say */ }

    const t = now();
    const b = latestIso(lastRun(db, backupJob), safe(lastBackupAt));
    if (!b) out.push({ name: 'Last backup', status: 'warn', message: 'no backup run is recorded yet' });
    else {
      const h = ageHours(b, t);
      out.push(h !== null && h > backupMaxAgeHours
        ? { name: 'Last backup', status: 'warn', message: `${Math.floor(h)} h ago (more than ${backupMaxAgeHours} h) - is the automatic backup on?` }
        : { name: 'Last backup', status: 'ok', message: h === null ? b : `${Math.floor(h)} h ago` });
    }
    const a = lastRun(db, auditJob);
    if (a) {
      const h = ageHours(a, t);
      out.push(h !== null && h > auditMaxAgeHours
        ? { name: 'Audit chain check', status: 'warn', message: `last verified ${Math.floor(h)} h ago (more than ${auditMaxAgeHours} h)` }
        : { name: 'Audit chain check', status: 'ok', message: h === null ? a : `${Math.floor(h)} h ago` });
    }
  }

  const server = appConfig?.server;
  if (server) {
    const trust = server.trustProxy;
    const proxied = trust === true || typeof trust === 'number' || Array.isArray(trust);
    const mode = server.https?.mode;
    const adminSeparate = Boolean(server.admin?.port);
    const loopbackOnly = ['127.0.0.1', 'localhost', '::1'].includes(String(server.host));
    out.push(adminSeparate
      ? { name: 'Administration address', status: 'ok', message: `the panel has its own listener (${server.admin.host ?? '127.0.0.1'}:${server.admin.port}) and is not served on the application's address` }
      : loopbackOnly
        ? { name: 'Administration address', status: 'ok', message: 'the application listens on the loopback address only' }
        : { name: 'Administration address', status: 'warn', message: 'the administration panel is served on the application\'s address; set server.admin.port to give it a listener of its own (default 127.0.0.1)' });
    if (trust === true) out.push({ name: 'Proxy trust', status: 'warn', message: 'trustProxy is true: any client can forge X-Forwarded-For unless the application port is reachable only from the proxy; prefer a list of proxy addresses' });
    else if (proxied && mode !== 'reverse-proxy') out.push({ name: 'Proxy trust', status: 'warn', message: `trustProxy is set but https.mode is "${mode}" - a trusted proxy normally means "reverse-proxy"` });
    else if (!proxied && mode === 'reverse-proxy') out.push({ name: 'Proxy trust', status: 'warn', message: 'https.mode is "reverse-proxy" but trustProxy is off: client addresses (rate limit, bans, audit) will all be the proxy\'s' });
    else out.push({ name: 'Proxy trust', status: 'ok', message: proxied ? 'a proxy is trusted for forwarded headers' : 'forwarded headers are not trusted' });
  }

  const heap = v8.getHeapStatistics();
  const pct = Math.round((heap.used_heap_size / heap.heap_size_limit) * 100);
  out.push(pct >= 85
    ? { name: 'Heap', status: pct >= 95 ? 'fail' : 'warn', message: `${pct}% of the heap limit is used` }
    : { name: 'Heap', status: 'ok', message: `${pct}% of the heap limit` });

  const delay = await loopDelayMs();
  out.push(delay > 200
    ? { name: 'Event loop', status: delay > 1000 ? 'fail' : 'warn', message: `timer fired ${Math.round(delay)} ms late - something blocks the loop` }
    : { name: 'Event loop', status: 'ok', message: `${Math.round(delay)} ms drift` });

  return out;
}
