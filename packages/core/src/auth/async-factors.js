import { asyncDb } from '../database/async.js';
import { ensureAuthTablesAsync } from './async.js';
import { rowToAuthenticator } from './authenticators.js';
import { randomCode } from './recovery-codes.js';
import { hashResetToken } from './password-reset.js';
import { hashDevice, newDeviceId } from './devices.js';
import { sealSecret, openSecret } from './secret-box.js';
import { generateTotpSecret, verifyTotp, matchTotpStep, buildTotpUri } from './totp.js';
import { hashPassword, verifyPassword } from './password.js';
import { randomBytes } from 'node:crypto';

/**
 * Second factors, recovery codes, password-reset tokens and known devices over `asyncDb` (ADR-0010, step 5). Same tables and
 * rules as authenticators.js, recovery-codes.js, password-reset.js and devices.js. One difference: where the old code let SQLite
 * stamp `datetime('now')`, these write an ISO timestamp from JavaScript (the same on every database).
 */
const nowIso = () => new Date().toISOString();
let warnedUnreadable = false;

// ---- authenticators (TOTP) ---------------------------------------------------------------------------------------------------

export async function purgeExpiredPendingAuthenticatorsAsync(db) {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  await a.run(`DELETE FROM authenticators WHERE status = 'pending' AND expires_at < ?`, [nowIso()]);
}

export async function listAuthenticatorsAsync(db, userId) {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  return (await a.all('SELECT * FROM authenticators WHERE user_id = ? ORDER BY id DESC', [userId])).map(rowToAuthenticator);
}

export async function startTotpEnrollmentAsync(db, userId, { name = null, accountName, issuer = 'DAS-Forge', ttlMinutes = 10, encryptionKey = null } = {}) {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  await purgeExpiredPendingAuthenticatorsAsync(a);
  const secret = generateTotpSecret();
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
  const authenticatorId = await a.transaction(async (tx) => {
    const r = await tx.run(`INSERT INTO authenticators (user_id, type, status, name, expires_at) VALUES (?, 'totp', 'pending', ?, ?)`, [userId, name, expiresAt]);
    await tx.run('INSERT INTO totp_credentials (authenticator_id, secret) VALUES (?, ?)', [r.lastInsertRowid, sealSecret(secret, encryptionKey)]);
    return r.lastInsertRowid;
  });
  return { authenticatorId, secret, otpauthUri: buildTotpUri(secret, { accountName, issuer }), expiresAt };
}

export async function verifyTotpEnrollmentAsync(db, authenticatorId, code, { userId = null, encryptionKey = null } = {}) {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  const row = await a.get(
    `SELECT a.*, t.secret, t.period FROM authenticators a JOIN totp_credentials t ON t.authenticator_id = a.id WHERE a.id = ? AND a.status = 'pending'`,
    [authenticatorId]
  );
  if (!row) return false;
  if (userId !== null && row.user_id !== userId) return false; // someone else's pending factor is "not found" (audit A08)
  if (row.expires_at && row.expires_at < nowIso()) return false;
  if (!verifyTotp(openSecret(row.secret, encryptionKey), code, { stepSeconds: row.period })) return false;
  await a.run(`UPDATE authenticators SET status = 'active', expires_at = NULL, last_used_at = ? WHERE id = ?`, [nowIso(), authenticatorId]);
  return true;
}

export async function verifyTotpLoginAsync(db, userId, code, { encryptionKey = null } = {}) {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  const rows = await a.all(
    `SELECT a.id, t.secret, t.period FROM authenticators a JOIN totp_credentials t ON t.authenticator_id = a.id
     WHERE a.user_id = ? AND a.type = 'totp' AND a.status = 'active'`,
    [userId]
  );
  for (const row of rows) {
    let secret;
    try {
      secret = openSecret(row.secret, encryptionKey);
    } catch (err) {
      if (!warnedUnreadable) {
        warnedUnreadable = true;
        // eslint-disable-next-line no-console
        console.warn(`[das-forge] a TOTP secret cannot be decrypted (${err.message}) - check auth.totpEncryptionKey / previousTotpEncryptionKeys`);
      }
      continue;
    }
    const step = matchTotpStep(secret, code, { stepSeconds: row.period });
    if (step === null) continue;
    // the conditional UPDATE is the atomic replay check (RFC 6238 §5.2, audit A07)
    const claimed = await a.run('UPDATE totp_credentials SET last_used_step = ? WHERE authenticator_id = ? AND (last_used_step IS NULL OR last_used_step < ?)', [step, row.id, step]);
    if (Number(claimed.changes) !== 1) continue;
    await a.run('UPDATE authenticators SET last_used_at = ? WHERE id = ?', [nowIso(), row.id]);
    return row.id;
  }
  return null;
}

/** @returns {Promise<{ok:boolean, reason?:'not_found'|'last_required_factor'}>} */
export async function removeAuthenticatorAsync(db, userId, authenticatorId, { mfaRequired = false } = {}) {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  return a.transaction(async (tx) => {
    const target = await tx.get('SELECT * FROM authenticators WHERE id = ? AND user_id = ?', [authenticatorId, userId]);
    if (!target) return { ok: false, reason: 'not_found' };
    if (mfaRequired && target.status === 'active') {
      const { c } = await tx.get(`SELECT COUNT(*) AS c FROM authenticators WHERE user_id = ? AND status = 'active'`, [userId]);
      if (c <= 1) return { ok: false, reason: 'last_required_factor' };
    }
    await tx.run('DELETE FROM authenticators WHERE id = ?', [authenticatorId]);
    return { ok: true };
  }, { mode: 'immediate' });
}

// ---- recovery codes ----------------------------------------------------------------------------------------------------------

/** A fresh set replaces the old one in one transaction; the plain codes are returned once. */
export async function generateRecoveryCodesAsync(db, userId, { count = 8 } = {}) {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  const codes = Array.from({ length: count }, randomCode);
  const hashes = [];
  for (const code of codes) hashes.push(await hashPassword(code)); // slow work stays outside the transaction
  await a.transaction(async (tx) => {
    await tx.run('DELETE FROM recovery_codes WHERE user_id = ?', [userId]);
    for (const h of hashes) await tx.run('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)', [userId, h]);
  });
  return codes;
}

export async function verifyAndConsumeRecoveryCodeAsync(db, userId, code) {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  for (const row of await a.all('SELECT id, code_hash FROM recovery_codes WHERE user_id = ? AND used_at IS NULL', [userId])) {
    const result = await verifyPassword(row.code_hash, code);
    if (result.valid) {
      const claimed = await a.run('UPDATE recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL', [nowIso(), row.id]); // the UPDATE is the check (audit K01)
      if (Number(claimed.changes) === 1) return true;
    }
  }
  return false;
}

export async function countRemainingRecoveryCodesAsync(db, userId) {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  return (await a.get('SELECT COUNT(*) AS c FROM recovery_codes WHERE user_id = ? AND used_at IS NULL', [userId])).c;
}

// ---- password reset tokens ---------------------------------------------------------------------------------------------------

export async function createPasswordResetTokenAsync(db, userId, { ttlMinutes = 30, now = Date.now() } = {}) {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  const token = randomBytes(32).toString('base64url');
  const at = new Date(now).toISOString();
  const expiresAt = new Date(now + ttlMinutes * 60_000).toISOString();
  await a.transaction(async (tx) => {
    await tx.run('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL', [at, userId]);
    await tx.run('INSERT INTO password_resets (user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)', [userId, hashResetToken(token), at, expiresAt]);
  });
  return { token, expiresAt };
}

const tokenOk = (t) => typeof t === 'string' && t.length >= 20 && t.length <= 200;

export async function peekPasswordResetTokenAsync(db, token, { now = Date.now() } = {}) {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  if (!tokenOk(token)) return null;
  const row = await a.get('SELECT user_id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?', [hashResetToken(token), new Date(now).toISOString()]);
  return row ? { userId: row.user_id } : null;
}

export async function consumePasswordResetTokenAsync(db, token, { now = Date.now() } = {}) {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  if (!tokenOk(token)) return null;
  const at = new Date(now).toISOString();
  const row = await a.get('SELECT id, user_id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?', [hashResetToken(token), at]);
  if (!row) return null;
  const r = await a.run('UPDATE password_resets SET used_at = ? WHERE id = ? AND used_at IS NULL', [at, row.id]);
  return Number(r.changes) === 1 ? { userId: row.user_id } : null;
}

export async function purgePasswordResetTokensAsync(db, { olderThanMs = 24 * 3_600_000, now = Date.now() } = {}) {
  const a = asyncDb(db);
  await ensureAuthTablesAsync(a);
  return Number((await a.run('DELETE FROM password_resets WHERE expires_at < ?', [new Date(now - olderThanMs).toISOString()])).changes);
}

// ---- known devices -----------------------------------------------------------------------------------------------------------

export async function ensureDeviceTableAsync(db) {
  await asyncDb(db).exec(`CREATE TABLE IF NOT EXISTS login_devices (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, device_hash TEXT NOT NULL, first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL, first_ip TEXT, user_agent TEXT, PRIMARY KEY (user_id, device_hash));`);
}

export async function recognizeDeviceAsync(db, { userId, deviceId = null, ip = null, userAgent = null, now = Date.now } = {}) {
  const a = asyncDb(db);
  await ensureDeviceTableAsync(a);
  const t = new Date(now()).toISOString();
  const valid = typeof deviceId === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(deviceId);
  if (valid) {
    const known = await a.run('UPDATE login_devices SET last_seen_at = ? WHERE user_id = ? AND device_hash = ?', [t, userId, hashDevice(deviceId)]);
    if (Number(known.changes) > 0) return { deviceId, isNew: false, firstEver: false };
  }
  const id = valid ? deviceId : newDeviceId();
  const existing = Number((await a.get('SELECT COUNT(*) AS n FROM login_devices WHERE user_id = ?', [userId])).n);
  await a.run(
    'INSERT INTO login_devices (user_id, device_hash, first_seen_at, last_seen_at, first_ip, user_agent) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, device_hash) DO NOTHING',
    [userId, hashDevice(id), t, t, ip ? String(ip).slice(0, 64) : null, userAgent ? String(userAgent).slice(0, 300) : null]
  );
  return { deviceId: id, isNew: true, firstEver: existing === 0 };
}
