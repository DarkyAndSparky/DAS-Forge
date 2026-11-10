/**
 * Persistent outgoing-mail queue (survives a restart). The mail is written to
 * the `email_queue` table first and sent in the background, so a caller (a
 * password-reset request, an alert) never waits for SMTP and a temporary SMTP
 * outage or a restart loses nothing.
 *
 * - Retries with doubling pauses (`baseDelayMs`, `baseDelayMs*2`, ...) up to
 *   `maxAttempts`; a refusal that cannot succeed later (`EMAIL_REJECTED`, a
 *   permanent 5xx answer) fails at once. Login failures are retried: an operator
 *   fixing the password in the config makes them succeed.
 * - A row claimed by a process that then died (`status = 'sending'` for longer
 *   than `lockMs`) is picked up again.
 * - Sensitive content: a queued reset mail contains its link until it is sent.
 *   The body of a row is deleted as soon as the mail is sent or finally failed
 *   (the table then keeps only scenario, masked recipients, attempts and the
 *   error code); the database file is owner-only (0600) like everything else.
 */

const MAX_PENDING_DEFAULT = 10_000;

import { createHash } from 'node:crypto';
import { backoffDelay } from '../util/backoff.js';

const addressHash = (a) => createHash('sha256').update(String(a).trim().toLowerCase()).digest('hex');

export class EmailQueueError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EmailQueueError';
    this.code = code;
  }
}

function maskAddress(a) {
  const [local, domain] = String(a).split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

function isPermanent(err) {
  if (err?.code === 'EMAIL_REJECTED') return true;
  const rc = Number(err?.cause?.responseCode);
  return Number.isInteger(rc) && rc >= 500;
}

/**
 * @param {object} opts
 * @param {object} opts.db - DatabaseAdapter
 * @param {(mail: object) => Promise<any>} opts.send - sends ONE prepared mail (e.g. `service.sendRaw`); throws on failure
 * @param {{info?: Function, warn?: Function, error?: Function}} [opts.logger]
 * @param {number} [opts.maxAttempts=6]
 * @param {number} [opts.baseDelayMs=60000]
 * @param {number} [opts.lockMs=300000] - how long a claimed row is considered in progress
 * @param {number} [opts.maxPending=10000] - enqueue refuses beyond this (EMAIL_QUEUE_FULL)
 * @param {number} [opts.batchSize=20]
 * @param {number} [opts.pendingTtlMs=259200000] - a mail still unsent after this long is dropped (3 days)
 * @param {() => number} [opts.now]
 * @param {() => number} [opts.random] - [0, 1) source for the retry jitter (tests)
 */
export function createEmailQueue({ db, send, logger, maxAttempts = 6, baseDelayMs = 60_000, lockMs = 300_000, maxPending = MAX_PENDING_DEFAULT, batchSize = 20, pendingTtlMs = 72 * 3_600_000, now = Date.now, random = Math.random } = {}) {
  if (!db || typeof send !== 'function') throw new TypeError('createEmailQueue: db and send are required');
  db.exec(`CREATE TABLE IF NOT EXISTS email_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scenario TEXT NOT NULL,
    recipients TEXT NOT NULL,
    payload TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    locked_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_email_queue_due ON email_queue(status, next_attempt_at)');
  // Hashes of the recipient addresses while the mail waits: they let an erased person's pending mail be
  // cancelled by address (cancelForAddress); they are cleared as soon as the mail is finished.
  if (!db.all('PRAGMA table_info(email_queue)').some((c) => c.name === 'recipient_hashes')) {
    db.exec('ALTER TABLE email_queue ADD COLUMN recipient_hashes TEXT');
  }

  const iso = (t) => new Date(t).toISOString();
  let timer = null;
  let running = false;

  /** @returns {{id: number}} */
  function enqueue(mail, { scenario = 'mail' } = {}) {
    const pending = db.get(`SELECT COUNT(*) AS n FROM email_queue WHERE status IN ('pending','sending')`).n;
    if (pending >= maxPending) throw new EmailQueueError('EMAIL_QUEUE_FULL', `E-mail queue is full (${maxPending} waiting)`);
    const t = iso(now());
    const r = db.run(
      `INSERT INTO email_queue (scenario, recipients, recipient_hashes, payload, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [scenario, JSON.stringify((mail.to ?? []).map(maskAddress)), JSON.stringify((mail.to ?? []).map(addressHash)), JSON.stringify(mail), t, t]
    );
    return { id: Number(r.lastInsertRowid) };
  }

  async function processOne(row) {
    const attempt = row.attempts + 1;
    try {
      await send(JSON.parse(row.payload));
      db.run(`UPDATE email_queue SET status = 'sent', payload = NULL, recipient_hashes = NULL, attempts = ?, locked_at = NULL, last_error = NULL WHERE id = ?`, [attempt, row.id]);
      logger?.info?.('queued email sent', { scenario: row.scenario, attempts: attempt });
      return 'sent';
    } catch (err) {
      const code = err?.code ?? 'EMAIL_SEND_FAILED';
      if (isPermanent(err) || attempt >= maxAttempts) {
        db.run(`UPDATE email_queue SET status = 'failed', payload = NULL, recipient_hashes = NULL, attempts = ?, locked_at = NULL, last_error = ? WHERE id = ?`, [attempt, code, row.id]);
        logger?.error?.('queued email failed for good', { scenario: row.scenario, attempts: attempt, code });
        return 'failed';
      }
      const delay = backoffDelay(attempt, { baseMs: baseDelayMs, random });
      db.run(`UPDATE email_queue SET status = 'pending', attempts = ?, locked_at = NULL, last_error = ?, next_attempt_at = ? WHERE id = ?`, [attempt, code, iso(now() + delay), row.id]);
      logger?.warn?.('queued email will be retried', { scenario: row.scenario, attempts: attempt, code, retryInMs: delay });
      return 'retry';
    }
  }

  /** Sends what is due (oldest first, at most `batchSize`). Never throws. @returns {Promise<{sent:number, retried:number, failed:number}>} */
  async function processDue() {
    const out = { sent: 0, retried: 0, failed: 0 };
    if (running) return out; // one pass at a time inside a process
    running = true;
    try {
      const t = now();
      expireStale(t);
      const due = db.all(
        `SELECT * FROM email_queue
          WHERE (status = 'pending' AND next_attempt_at <= ?) OR (status = 'sending' AND locked_at <= ?)
          ORDER BY id LIMIT ?`,
        [iso(t), iso(t - lockMs), batchSize]
      );
      for (const row of due) {
        // Claim atomically: another process may be running the same queue.
        const claimed = db.run(
          `UPDATE email_queue SET status = 'sending', locked_at = ? WHERE id = ? AND status = ? AND COALESCE(locked_at, '') = COALESCE(?, '')`,
          [iso(now()), row.id, row.status, row.locked_at]
        ).changes;
        if (Number(claimed) !== 1) continue;
        const result = await processOne({ ...row, status: 'sending' });
        if (result === 'sent') out.sent++;
        else if (result === 'retry') out.retried++;
        else out.failed++;
      }
    } catch (err) {
      logger?.error?.('email queue pass failed', { message: err?.message });
    } finally {
      running = false;
    }
    return out;
  }

  /** Drops mails that waited longer than `pendingTtlMs` (body wiped). */
  function expireStale(t = now()) {
    return Number(
      db.run(
        `UPDATE email_queue SET status = 'failed', payload = NULL, recipient_hashes = NULL, locked_at = NULL, last_error = 'EXPIRED'
          WHERE status IN ('pending','sending') AND created_at <= ?`,
        [iso(t - pendingTtlMs)]
      ).changes
    );
  }

  /**
   * Cancels every waiting mail addressed to `address` (a person being erased must not get mail
   * afterwards) and wipes its body. @returns {number} mails cancelled
   */
  function cancelForAddress(address) {
    if (!address) return 0;
    const h = JSON.stringify(addressHash(address)).slice(1, -1);
    return Number(
      db.run(
        `UPDATE email_queue SET status = 'failed', payload = NULL, recipient_hashes = NULL, locked_at = NULL, last_error = 'CANCELLED'
          WHERE status IN ('pending','sending') AND recipient_hashes LIKE ?`,
        [`%"${h}"%`]
      ).changes
    );
  }

  /** Cancels one waiting letter (pending, not yet claimed): it is marked failed/CANCELLED and its content is erased. @returns {boolean} */
  function cancel(id) {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) return false;
    return Number(db.run(`UPDATE email_queue SET status = 'failed', payload = NULL, recipient_hashes = NULL, locked_at = NULL, last_error = 'CANCELLED' WHERE id = ? AND status = 'pending'`, [n]).changes) === 1;
  }

  /** Background loop; the timer is unref-ed so it never keeps the process alive. */
  function start({ intervalMs = 15_000 } = {}) {
    if (timer) return;
    timer = setInterval(() => void processDue(), intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function stats() {
    const rows = db.all(`SELECT status, COUNT(*) AS n FROM email_queue GROUP BY status`);
    const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
    return { pending: by.pending ?? 0, sending: by.sending ?? 0, sent: by.sent ?? 0, failed: by.failed ?? 0 };
  }

  /**
   * The newest queue rows for the admin panel: scenario, masked recipients, status, attempts, next attempt, the last error code.
   * Bodies and addresses are never returned (addresses are stored masked; bodies are not selected).
   */
  function list({ limit = 50, status = null, offset = 0 } = {}) {
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const off = Math.max(0, Math.trunc(Number(offset)) || 0);
    const where = status ? 'WHERE status = ?' : '';
    return db.all(
      `SELECT id, scenario, recipients, status, attempts, next_attempt_at, last_error, created_at FROM email_queue ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
      status ? [status, n, off] : [n, off]
    ).map((r) => {
      let to = [];
      try { to = JSON.parse(r.recipients); } catch { to = []; }
      return { id: Number(r.id), scenario: r.scenario, recipients: Array.isArray(to) ? to : [], status: r.status, attempts: Number(r.attempts), nextAttemptAt: r.next_attempt_at, lastError: r.last_error ?? null, createdAt: r.created_at };
    });
  }

  /** Deletes finished rows (sent/failed) older than `olderThanDays`. @returns {number} rows removed */
  function purgeFinished({ olderThanDays = 7 } = {}) {
    const cutoff = iso(now() - olderThanDays * 86_400_000);
    return Number(db.run(`DELETE FROM email_queue WHERE status IN ('sent','failed') AND created_at <= ?`, [cutoff]).changes);
  }

  return { enqueue, processDue, start, stop, stats, list, purgeFinished, cancelForAddress, cancel, expireStale };
}
