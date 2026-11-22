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
import { hostPolicyFromConfig } from '../../http/host-guard.js';

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

/**
 * PostgreSQL carries every password hash and the audit journal: on a network the connection must be encrypted.
 * Fine without TLS: a unix socket or a loopback host. The connection string itself is never put into the report.
 */
function postgresTlsCheck(dbCfg, env) {
  const name = 'PostgreSQL TLS';
  const ref = typeof dbCfg.url === 'string' && dbCfg.url.startsWith('env:') ? dbCfg.url.slice(4) : null;
  const raw = ref ? env?.[ref] : null;
  let host = null; let sslmode = null;
  if (raw) {
    try { const u = new URL(raw); host = u.hostname.replace(/^\[|\]$/g, ''); sslmode = u.searchParams.get('sslmode'); } catch { /* unreadable: reported below */ }
  }
  if (dbCfg.ssl === true || ['require', 'verify-ca', 'verify-full'].includes(sslmode)) return { name, status: 'ok', message: 'the connection is encrypted' };
  if (host === null) return { name, status: 'warn', message: ref ? `cannot read the connection string from ${ref}; check that the variable is set` : 'cannot tell where the database is; set database.url to env:NAME and database.ssl to true' };
  if (host === '' || host.startsWith('/') || ['localhost', '127.0.0.1', '::1'].includes(host)) return { name, status: 'ok', message: 'the database is on this machine (TLS is not needed)' };
  return { name, status: 'warn', message: `the connection to ${host} is not encrypted - set database.ssl to true (or sslmode=require in the connection string)` };
}

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
 * @param {Record<string, string|undefined>} [o.env] - where `env:NAME` references are read (process.env)
 * @param {() => number} [o.now]
 */
export async function hardeningChecks({ appConfig = {}, db = null, secretFiles = {}, secretDirs = {}, adminRole = 'admin', backupJob = 'backup', auditJob = 'alerts-audit-chain', lastBackupAt = null, env = process.env, backupMaxAgeHours = 48, auditMaxAgeHours = 72, now = () => Date.now() } = {}) {
  const out = [];

  if (posix() && typeof process.getuid === 'function') {
    out.push(process.getuid() === 0
      ? { name: 'Process user', status: 'warn', message: 'running as root - run the service as an unprivileged user (a flaw in the application would then own the machine)' }
      : { name: 'Process user', status: 'ok', message: `uid ${process.getuid()}` });
  }

  if (appConfig?.auth?.totp?.enabled && !appConfig?.auth?.totpEncryptionKey) {
    // audit R-03: not only for the internet profile
    out.push({ name: 'TOTP encryption key', status: 'warn', message: 'auth.totpEncryptionKey is not set: the second-factor key is derived from the session secret, so one leaked secret opens both - create a key with "secret generate" and set auth.totpEncryptionKey (DAS_TOTP_KEY)' });
  }

  out.push(appConfig?.audit?.sealKey
    ? { name: 'Audit seal', status: 'ok', message: 'new journal rows are sealed with a key kept outside the database' }
    : { name: 'Audit seal', status: 'warn', message: 'audit.sealKey is not set: whoever can write the database can rewrite the journal and recompute its hash chain - create a key with "secret generate" and set audit.sealKey (DAS_AUDIT_SEAL_KEY)' });

  {
    // Host-name check (audit S-08): says what is checked and what to do when no site name is set
    const hp = hostPolicyFromConfig(appConfig);
    out.push(hp.mode === 'enforce' ? { name: 'Host-name check', status: 'ok', message: `unknown Host names get 421 (known: ${hp.names.join(', ') || 'localhost only'})` }
      : hp.mode === 'off' ? { name: 'Host-name check', status: 'warn', message: 'server.hostCheck is off - set allowedHosts (or email.baseUrl) and use "auto"' }
        : { name: 'Host-name check', status: 'warn', message: 'no site name is set, so any Host is let through and only logged - add the site name to server.allowedHosts (or set email.baseUrl): the check then turns on by itself' });
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

  if (server?.exposure === 'internet') {
    const mode = server.https?.mode;
    const trust = server.trustProxy;
    const proxied = trust === true || typeof trust === 'number' || Array.isArray(trust);
    out.push(mode === 'self-signed'
      ? { name: 'Internet exposure: TLS', status: 'fail', message: 'the application is open to the internet with a self-signed certificate - use standalone with a real certificate, or put a TLS reverse proxy in front (https.mode "reverse-proxy")' }
      : mode === 'reverse-proxy' && !proxied
        ? { name: 'Internet exposure: TLS', status: 'fail', message: 'behind a reverse proxy but trustProxy is off: every request looks like the proxy\'s address, so the automatic ban would ban the proxy - set server.trustProxy' }
        : { name: 'Internet exposure: TLS', status: 'ok', message: mode === 'reverse-proxy' ? 'TLS is terminated by the proxy, which is trusted for forwarded headers' : 'TLS with the application\'s own certificate' });
    const nets = server.admin?.allowedNets ?? [];
    out.push(nets.length > 0 || server.admin?.port
      ? { name: 'Internet exposure: administration', status: 'ok', message: nets.length > 0 ? 'the panel is limited to server.admin.allowedNets' : 'the panel has its own listener' }
      : { name: 'Internet exposure: administration', status: 'fail', message: 'the administration panel is reachable from the internet - set server.admin.allowedNets (or server.admin.port behind a VPN)' });
    out.push(appConfig?.auth?.hostCookiePrefix
      ? { name: 'Internet exposure: session cookie', status: 'ok', message: 'the cookie is named __Host-das_session' }
      : { name: 'Internet exposure: session cookie', status: 'fail', message: 'auth.hostCookiePrefix is off: a sibling sub-domain or plain HTTP can plant or overwrite the session cookie - leave it unset (the profile turns it on) or set it to true' });
    out.push(appConfig?.auth?.totpEncryptionKey
      ? { name: 'Internet exposure: encryption keys', status: 'ok', message: 'the TOTP key is separate from the session secret' }
      : { name: 'Internet exposure: encryption keys', status: 'fail', message: 'auth.totpEncryptionKey is not set: the TOTP key is derived from the session secret, so rotating that secret locks out every second-factor login - create a key with "secret generate"' });
    const reg = appConfig?.auth?.registration;
    if (reg?.enabled) {
      out.push(reg.requireEmailConfirmation === false
        ? { name: 'Internet exposure: registration', status: 'fail', message: 'self-registration is open without e-mail confirmation - bots will create accounts; turn requireEmailConfirmation on' }
        : { name: 'Internet exposure: registration', status: 'ok', message: 'self-registration needs a confirmed e-mail address' });
    }
  }

  const dbCfg = appConfig?.database;
  if (dbCfg?.driver === 'postgres') out.push(postgresTlsCheck(dbCfg, env));

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
