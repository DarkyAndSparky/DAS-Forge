/**
 * Alerts: one place that turns "something is wrong" into a record, a log line and (when mail is configured)
 * an e-mail to the incident contacts, without flooding anyone.
 *
 *   const alerts = createAlerts({ db, email: emailService, contacts: config.security.incidentContacts, logger });
 *   alerts.raise({ key: 'backup', severity: 'critical', title: 'Backup failed', message: err.message });
 *
 * - Every alert is stored in the `alerts` table (the admin section "Alerts" lists it) and written to the log.
 * - The same `key` inside `cooldownMs` only increments a counter on the stored row; it is not mailed again.
 * - Mail goes to `contacts` through the e-mail service (queue, retries). A mail failure never throws and never
 *   hides the alert: the row stays and records `notify_error`.
 * - Acknowledge (`ack`), mute a key for a while (`mute`), and "quiet during maintenance" (`maintenance` option): a muted
 *   alert is still recorded and counted, but nobody is mailed (audit R-11).
 * - More channels than mail (`channels`, e.g. `webhookChannel`), escalation of critical alerts nobody acknowledged
 *   (`escalate`), and a heartbeat ping to an external monitor (`heartbeat`): if this application dies, the monitor
 *   notices the silence (audit R-12).
 * - The cooldown is kept in memory: after a restart the first repeat is announced once more, which is the
 *   safer direction for an alert.
 *
 * Sources that raise alerts for you: `onJobError` (scheduler), `lockoutWatcher` (login failure trackers),
 * `checkAuditChain`, `checkDoctor`, and `watch` which registers the periodic checks on a scheduler.
 */
import { assertOutboundUrl } from '../http/outbound.js';
import { verifyChain } from '../audit/chain.js';
import { log as auditLog } from '../audit/log.js';

export const SEVERITIES = ['info', 'warning', 'critical'];

const clip = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').slice(0, n);

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_at TEXT NOT NULL,
    repeats INTEGER NOT NULL DEFAULT 0,
    notified INTEGER NOT NULL DEFAULT 0,
    notify_error TEXT
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at)');
  const have = new Set(db.all('PRAGMA table_info(alerts)').map((c) => c.name));
  if (!have.has('acked_at')) db.exec('ALTER TABLE alerts ADD COLUMN acked_at TEXT');
  if (!have.has('acked_by')) db.exec('ALTER TABLE alerts ADD COLUMN acked_by TEXT');
  if (!have.has('muted')) db.exec('ALTER TABLE alerts ADD COLUMN muted INTEGER NOT NULL DEFAULT 0');
  if (!have.has('escalated_at')) db.exec('ALTER TABLE alerts ADD COLUMN escalated_at TEXT');
  db.exec('CREATE TABLE IF NOT EXISTS alert_mutes (key TEXT PRIMARY KEY, until TEXT NOT NULL, by TEXT)');
}

/**
 * A channel that POSTs the alert as JSON to an https URL (a chat bot gateway, an on-call service, ...).
 * The URL is checked once here; redirects are not followed; the request gives up after `timeoutMs`.
 * @returns {{name: string, send: (alert: object) => Promise<void>}}
 */
export function webhookChannel({ url, name = 'webhook', timeoutMs = 5000, headers = {}, fetchImpl = globalThis.fetch } = {}) {
  const u = assertOutboundUrl(url, { label: 'webhookChannel', protocols: ['https:'] });
  return {
    name,
    async send(alert) {
      const res = await fetchImpl(u, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(alert) });
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { code: `HTTP_${res.status}` });
    },
  };
}

const iso = (ms) => new Date(ms).toISOString();

/**
 * @param {object} opts
 * @param {object} opts.db - DatabaseAdapter
 * @param {{enabled?: boolean, sendAlert: Function}} [opts.email]
 * @param {string[]} [opts.contacts] - recipients (`security.incidentContacts`)
 * @param {{info?: Function, warn?: Function, error?: Function}} [opts.logger]
 * @param {number} [opts.cooldownMs=3600000] - the same key is announced at most once per this time
 * @param {(alert: {id: number, key: string, severity: string, title: string, message: string}) => void} [opts.onRaised] - called for every NEW alert (not a repeat inside the cooldown), e.g. to write a notification; an error in it is ignored
 * @param {number} [opts.keepDays=90] - `purge()` deletes older rows
 * @param {Array<{name: string, send: (alert: object) => Promise<void>}>} [opts.channels] - extra channels next to e-mail (see `webhookChannel`); one working channel is enough for `notified`
 * @param {{get: Function}} [opts.maintenance] - `createMaintenance()`: while it is on, alerts are recorded but not announced
 * @param {'ru'|'en'} [opts.locale]
 * @param {() => number} [opts.now]
 */
export function createAlerts({ db, email = null, contacts = [], logger = null, cooldownMs = 3_600_000, keepDays = 90, locale, now = Date.now, onRaised = null, channels = [], maintenance = null } = {}) {
  if (!db) throw new TypeError('createAlerts: db is required');
  ensureTable(db);
  const last = new Map(); // key -> { at, id }

  /** Why nothing should be announced right now, or null. */
  function silencedBy(key, t) {
    try { if (maintenance?.get?.().enabled) return 'maintenance'; } catch { /* unknown state: do not silence */ }
    const m = db.get('SELECT until FROM alert_mutes WHERE key = ?', [key]);
    if (m && Date.parse(m.until) > t) return 'mute';
    return null;
  }

  async function send(id, alert) {
    const errors = [];
    let ok = false;
    if (email?.enabled && contacts.length) {
      try { await email.sendAlert({ to: contacts, title: alert.title, message: alert.message, severity: alert.severity, locale }); ok = true; } catch (err) {
        errors.push(`${channels.length ? "mail:" : ""}${clip(err?.code ?? err?.message ?? err, 80)}`);
        logger?.warn?.('alert e-mail failed', { code: err?.code });
      }
    }
    for (const ch of channels) {
      try { await ch.send({ id, ...alert }); ok = true; } catch (err) {
        errors.push(`${clip(ch.name, 30)}:${clip(err?.code ?? err?.message ?? err, 80)}`);
        logger?.warn?.('alert channel failed', { channel: ch.name, code: err?.code });
      }
    }
    return { ok, errors };
  }

  async function notify(id, alert) {
    const r = await send(id, alert);
    if (r.ok) db.run('UPDATE alerts SET notified = 1 WHERE id = ?', [id]);
    if (r.errors.length) db.run('UPDATE alerts SET notify_error = ? WHERE id = ?', [clip(r.errors.join('; '), 200), id]);
  }

  const api = {
    /**
     * Records and announces an alert. Never throws.
     * @returns {Promise<{raised: boolean, id?: number}>} `raised: false` = repeat inside the cooldown
     */
    async raise({ key, severity = 'warning', title, message = '' }) {
      try {
        const sev = SEVERITIES.includes(severity) ? severity : 'warning';
        const k = clip(key, 120) || 'alert';
        const t = now();
        const prev = last.get(k);
        if (prev && t - prev.at < cooldownMs) {
          db.run('UPDATE alerts SET repeats = repeats + 1, last_at = ? WHERE id = ?', [iso(t), prev.id]);
          return { raised: false, id: prev.id };
        }
        const a = { severity: sev, title: clip(title, 200) || k, message: clip(message, 2000) };
        const quiet = silencedBy(k, t);
        const id = Number(db.run(
          'INSERT INTO alerts (key, severity, title, message, created_at, last_at, muted) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [k, a.severity, a.title, a.message, iso(t), iso(t), quiet ? 1 : 0],
        ).lastInsertRowid);
        last.set(k, { at: t, id });
        if (last.size > 1000) last.delete(last.keys().next().value);
        const line = { key: k, severity: a.severity, title: a.title };
        if (sev === 'critical') logger?.error?.('ALERT', line);
        else logger?.warn?.('ALERT', line);
        try { auditLog(db, { action: 'alert.raised', entity: 'alert', entityId: id, meta: { key: k, severity: a.severity } }); } catch { /* the alert itself matters more */ }
        if (quiet) return { raised: true, id, muted: true };
        try { onRaised?.({ id, key: k, ...a }); } catch { /* a listener must not break alerting */ }
        await notify(id, a);
        return { raised: true, id };
      } catch (err) {
        logger?.error?.('could not record an alert', { err: err?.message });
        return { raised: false };
      }
    },

    /** Newest first. */
    list({ limit = 100, offset = 0 } = {}) {
      const n = Math.min(500, Math.max(1, Number(limit) || 100));
      const off = Math.max(0, Math.trunc(Number(offset)) || 0);
      return db.all('SELECT id, key, severity, title, message, created_at AS createdAt, last_at AS lastAt, repeats, notified, notify_error AS notifyError, acked_at AS ackedAt, acked_by AS ackedBy, muted, escalated_at AS escalatedAt FROM alerts ORDER BY id DESC LIMIT ? OFFSET ?', [n, off]);
    },

    count() {
      return db.get('SELECT COUNT(*) AS n FROM alerts').n;
    },

    /** Marks an alert as seen by a person. @returns {boolean} false if there is no such alert or it was acknowledged already */
    ack(id, by = null) {
      const r = db.run('UPDATE alerts SET acked_at = ?, acked_by = ? WHERE id = ? AND acked_at IS NULL', [iso(now()), by ? clip(by, 80) : null, Number(id)]);
      if ((r.changes ?? 0) > 0) { try { auditLog(db, { action: 'alert.acked', entity: 'alert', entityId: Number(id), meta: { by: by ?? null } }); } catch { /* ignore */ } }
      return (r.changes ?? 0) > 0;
    },

    /** Silences announcements for one key for `ms` (1 min .. 30 days); the alerts are still recorded. */
    mute(key, ms, by = null) {
      const dur = Math.min(30 * 86_400_000, Math.max(60_000, Math.trunc(Number(ms)) || 0));
      const until = iso(now() + dur);
      db.run('INSERT INTO alert_mutes (key, until, by) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET until = excluded.until, by = excluded.by', [clip(key, 120), until, by ? clip(by, 80) : null]);
      try { auditLog(db, { action: 'alert.muted', entity: 'alert', meta: { key: clip(key, 120), until, by: by ?? null } }); } catch { /* ignore */ }
      return until;
    },

    unmute(key) {
      return (db.run('DELETE FROM alert_mutes WHERE key = ?', [clip(key, 120)]).changes ?? 0) > 0;
    },

    /** Active mutes: `[{key, until, by}]`. */
    mutes() {
      return db.all('SELECT key, until, by FROM alert_mutes WHERE until > ? ORDER BY until', [iso(now())]);
    },

    /**
     * Critical alerts nobody acknowledged within `afterMs` are announced once more on every channel, marked as an
     * escalation. Muted ones are skipped. @returns {Promise<number>} how many were escalated
     */
    async escalate({ afterMs = 30 * 60_000 } = {}) {
      const rows = db.all("SELECT id, key, severity, title, message FROM alerts WHERE severity = 'critical' AND acked_at IS NULL AND escalated_at IS NULL AND muted = 0 AND created_at < ?", [iso(now() - afterMs)]);
      let n = 0;
      for (const r of rows) {
        if (silencedBy(r.key, now())) continue;
        db.run('UPDATE alerts SET escalated_at = ? WHERE id = ?', [iso(now()), r.id]);
        await send(r.id, { severity: r.severity, title: `ESCALATION: ${r.title}`, message: `Not acknowledged for ${Math.round(afterMs / 60_000)} min. ${r.message}` });
        n += 1;
      }
      return n;
    },

    /** Pings an external monitor (https GET); when pings stop, the monitor reports that this application is down. */
    async heartbeat(url, { timeoutMs = 5000, fetchImpl = globalThis.fetch } = {}) {
      const u = new URL(url);
      if (u.protocol !== 'https:') throw new TypeError('heartbeat: only https URLs are allowed');
      const res = await fetchImpl(u, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      return res.ok;
    },

    /** Deletes alerts older than `keepDays`; returns how many. */
    purge() {
      db.run('DELETE FROM alert_mutes WHERE until < ?', [iso(now())]);
      return db.run('DELETE FROM alerts WHERE created_at < ?', [iso(now() - keepDays * 86_400_000)]).changes ?? 0;
    },

    /** For `createScheduler({ onError })`: a failed job is an alert (a failed backup is critical). */
    onJobError(name, err) {
      return api.raise({
        key: `job:${name}`,
        severity: /backup/i.test(name) ? 'critical' : 'warning',
        title: `Scheduled job "${name}" failed`,
        message: err?.message ?? String(err),
      });
    },

    /**
     * For `createFailureTracker({ onLock })`: many lock-outs in a short time look like password guessing.
     * Returns the callback. After an alert the counter starts over.
     */
    lockoutWatcher({ threshold = 10, windowMs = 600_000 } = {}) {
      let hits = [];
      return () => {
        const t = now();
        hits = hits.filter((x) => t - x < windowMs);
        hits.push(t);
        if (hits.length >= threshold) {
          const n = hits.length;
          hits = [];
          void api.raise({
            key: 'lockouts',
            severity: 'critical',
            title: 'Many sign-in lock-outs',
            message: `${n} accounts or addresses were locked after failed sign-ins within ${Math.round(windowMs / 60_000)} min. This looks like password guessing; see Audit and Security.`,
          });
        }
      };
    },

    /** Verifies the audit hash chain; a broken chain is critical. */
    async checkAuditChain({ anchor } = {}) {
      let r;
      try { r = verifyChain(db, { anchor }); } catch (err) { r = { ok: false, reason: `verification failed: ${err?.message}`, brokenAtId: null }; }
      if (!r.ok) {
        await api.raise({ key: 'audit-chain', severity: 'critical', title: 'Audit log integrity check failed', message: `Broken at entry ${r.brokenAtId ?? '?'}: ${r.reason}` });
      }
      return r;
    },

    /**
     * Runs the diagnostics and raises one alert per failed check. `skip` lists check names to ignore
     * (for example "Port availability", which always reports the port taken by this very process).
     */
    async checkDoctor(runDoctor, { skip = ['Port availability'] } = {}) {
      let report;
      try { report = await runDoctor(); } catch (err) {
        await api.raise({ key: 'doctor:run', severity: 'warning', title: 'Diagnostics could not run', message: err?.message ?? String(err) });
        return null;
      }
      for (const c of report?.categories ?? []) {
        for (const k of c.checks ?? []) {
          if (k.status === 'fail' && !skip.includes(k.name)) {
            await api.raise({ key: `doctor:${c.name}:${k.name}`, severity: 'critical', title: `${c.name}: ${k.name}`, message: k.message });
          }
        }
      }
      return report;
    },

    /**
     * Registers the periodic checks on a scheduler: diagnostics, audit chain and the alert purge.
     * A schedule set to a falsy value is skipped.
     */
    watch(scheduler, { doctor, doctorSchedule, auditSchedule, purgeSchedule = '40 3 * * *', escalateAfterMs = 0, escalateSchedule = '*/5 * * * *', heartbeatUrl = '', heartbeatSchedule = '* * * * *' } = {}) {
      if (doctor && doctorSchedule) scheduler.registerJob('alerts-doctor', doctorSchedule, () => api.checkDoctor(doctor));
      if (auditSchedule) scheduler.registerJob('alerts-audit-chain', auditSchedule, () => api.checkAuditChain());
      if (purgeSchedule) scheduler.registerJob('alerts-purge', purgeSchedule, () => { api.purge(); });
      if (escalateAfterMs > 0) scheduler.registerJob('alerts-escalate', escalateSchedule, () => api.escalate({ afterMs: escalateAfterMs }));
      if (heartbeatUrl) scheduler.registerJob('alerts-heartbeat', heartbeatSchedule, async () => { try { await api.heartbeat(heartbeatUrl); } catch { /* the monitor notices the silence */ } });
    },
  };
  return api;
}
