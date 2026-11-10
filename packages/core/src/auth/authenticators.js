import { atomic } from '../database/atomic.js';
import { ensureAuthTables } from './schema.js';
import { sealSecret, openSecret } from './secret-box.js';
import { generateTotpSecret, verifyTotp, matchTotpStep, buildTotpUri } from './totp.js';

function rowToAuthenticator(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    status: row.status,
    name: row.name,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
  };
}

/**
 * Deletes PENDING authenticators past their enrollment window - an
 * abandoned QR scan leaves nothing behind.
 *
 * Compares against a JS-generated ISO timestamp, NOT SQL's own
 * `datetime('now')` - `expires_at` is stored as `new Date().toISOString()`
 * (e.g. "2026-10-07T12:34:56.789Z"), while SQLite's `datetime('now')`
 * produces a different format ("2026-10-07 12:34:56", space-separated,
 * no fractional seconds, no 'Z'). Comparing the two lexicographically
 * is unreliable - 'T' (0x54) sorts after ' ' (0x20), which can make an
 * actually-expired row silently fail to match. Always compare like
 * against like.
 */
export function purgeExpiredPendingAuthenticators(db) {
  ensureAuthTables(db);
  db.run(`DELETE FROM authenticators WHERE status = 'pending' AND expires_at < ?`, [new Date().toISOString()]);
}

/** Every authenticator for a user, newest first - never includes the secret (that's totp_credentials, never selected here). */
export function listAuthenticators(db, userId) {
  ensureAuthTables(db);
  return db.all(`SELECT * FROM authenticators WHERE user_id = ? ORDER BY id DESC`, [userId]).map(rowToAuthenticator);
}

/**
 * Starts TOTP enrollment (§5): creates a PENDING authenticator + its
 * secret, returns the otpauth:// URI for QR display. The authenticator
 * is NOT usable for login yet - only startTotpEnrollment() + a
 * successful verifyTotpEnrollment() together activate it. Per the doc's
 * "не считать TOTP зарегистрированным сразу после генерации QR".
 *
 * @param {object} opts
 * @param {string} [opts.name] - display name, e.g. "Google Authenticator"
 * @param {string} opts.accountName - for the otpauth:// label (usually the username)
 * @param {string} [opts.issuer='DAS-Forge']
 * @param {number} [opts.ttlMinutes=10] - how long the PENDING row survives unverified
 */
export function startTotpEnrollment(db, userId, { name = null, accountName, issuer = 'DAS-Forge', ttlMinutes = 10, encryptionKey = null } = {}) {
  ensureAuthTables(db);
  purgeExpiredPendingAuthenticators(db);

  const secret = generateTotpSecret();
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();

  const result = db.run(
    `INSERT INTO authenticators (user_id, type, status, name, expires_at) VALUES (?, 'totp', 'pending', ?, ?)`,
    [userId, name, expiresAt]
  );
  const authenticatorId = result.lastInsertRowid;
  db.run(`INSERT INTO totp_credentials (authenticator_id, secret) VALUES (?, ?)`, [authenticatorId, sealSecret(secret, encryptionKey)]);

  return { authenticatorId, secret, otpauthUri: buildTotpUri(secret, { accountName, issuer }), expiresAt };
}

/**
 * Completes TOTP enrollment: the user's first correct code flips the
 * PENDING authenticator to ACTIVE. Returns false (not a throw) for a
 * wrong code, an unknown id, or an expired enrollment window - all
 * three are "try again or re-enroll", not exceptional.
 */
export function verifyTotpEnrollment(db, authenticatorId, code, { userId = null, encryptionKey = null } = {}) {
  ensureAuthTables(db);

  const row = db.get(
    `SELECT a.*, t.secret, t.period FROM authenticators a
     JOIN totp_credentials t ON t.authenticator_id = a.id
     WHERE a.id = ? AND a.status = 'pending'`,
    [authenticatorId]
  );
  if (!row) return false;
  // Ownership check (audit A08): when the caller says WHOSE enrollment
  // this is, someone else's pending factor is simply "not found" - same
  // answer as a nonexistent id, so it can't be probed. Routes handling
  // an authenticated user's request must always pass `userId`.
  if (userId !== null && row.user_id !== userId) return false;
  if (row.expires_at && row.expires_at < new Date().toISOString()) return false;

  // Enrollment deliberately does NOT burn the step: the user's very next
  // action is usually a login with the same still-valid code. Replay
  // protection applies at login (verifyTotpLogin).
  if (!verifyTotp(openSecret(row.secret, encryptionKey), code, { stepSeconds: row.period })) return false;

  db.run(`UPDATE authenticators SET status = 'active', expires_at = NULL, last_used_at = datetime('now') WHERE id = ?`, [
    authenticatorId,
  ]);
  return true;
}

/**
 * Login-time TOTP check (§8's TOTP equivalent): tries every ACTIVE TOTP
 * authenticator the user has (supporting more than one, e.g. a phone
 * AND a backup device) and returns the id of whichever matched, or null.
 * Updates last_used_at on the matching authenticator only.
 */
let warnedUnreadable = false;

export function verifyTotpLogin(db, userId, code, { encryptionKey = null } = {}) {
  ensureAuthTables(db);

  const rows = db.all(
    `SELECT a.id, t.secret, t.period FROM authenticators a
     JOIN totp_credentials t ON t.authenticator_id = a.id
     WHERE a.user_id = ? AND a.type = 'totp' AND a.status = 'active'`,
    [userId]
  );

  for (const row of rows) {
    let secret;
    try {
      secret = openSecret(row.secret, encryptionKey);
    } catch (err) {
      // A key problem is an operator's to fix (wrong/rotated key), not a reason for a 500 on login:
      // this factor simply cannot be checked. Say so, once per process, on the console.
      if (!warnedUnreadable) {
        warnedUnreadable = true;
        // eslint-disable-next-line no-console
        console.warn(`[das-forge] a TOTP secret cannot be decrypted (${err.message}) - check auth.totpEncryptionKey / previousTotpEncryptionKeys`);
      }
      continue;
    }
    const step = matchTotpStep(secret, code, { stepSeconds: row.period });
    if (step === null) continue;
    // Replay protection (RFC 6238 §5.2, audit A07): a step may be used
    // once. The conditional UPDATE is the atomic check - two concurrent
    // requests with the same code cannot both change a row.
    const claimed = db.run(
      `UPDATE totp_credentials SET last_used_step = ?
       WHERE authenticator_id = ? AND (last_used_step IS NULL OR last_used_step < ?)`,
      [step, row.id, step]
    );
    if (claimed.changes !== 1) continue;
    db.run(`UPDATE authenticators SET last_used_at = datetime('now') WHERE id = ?`, [row.id]);
    return row.id;
  }
  return null;
}

/**
 * Removes an authenticator (§18: "нельзя разрешить пользователю удалить
 * последний фактор, если policy требует MFA"). `mfaRequired` is the
 * caller's own policy decision (core/auth has no concept of per-role
 * security policy - that's exactly the kind of thing the earlier
 * discussion flagged as config the APP owns, not core); this function
 * only enforces the invariant once told whether it applies.
 *
 * @returns {{ok: boolean, reason?: 'not_found'|'last_required_factor'}}
 */
export function removeAuthenticator(db, userId, authenticatorId, { mfaRequired = false } = {}) {
  ensureAuthTables(db);

  // The count and the delete are one transaction: two removals at the same moment (two processes) cannot both see
  // "two factors left" and leave the user with none (G-04).
  return atomic(db, () => {
    const target = db.get(`SELECT * FROM authenticators WHERE id = ? AND user_id = ?`, [authenticatorId, userId]);
    if (!target) return { ok: false, reason: 'not_found' };

    if (mfaRequired && target.status === 'active') {
      const { c: activeCount } = db.get(
        `SELECT COUNT(*) AS c FROM authenticators WHERE user_id = ? AND status = 'active'`,
        [userId]
      );
      if (activeCount <= 1) {
        return { ok: false, reason: 'last_required_factor' };
      }
    }

    db.run(`DELETE FROM authenticators WHERE id = ?`, [authenticatorId]);
    return { ok: true };
  });
}
