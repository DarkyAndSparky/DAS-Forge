import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Encryption at rest for TOTP secrets (audit A10).
 * Format: `enc:v2:<iv>:<tag>:<ciphertext>` (base64url), AES-256-GCM,
 * key = HKDF-SHA256(secret, info 'das-forge/totp/v1'), and the row's id as
 * additional authenticated data (audit R-03): a secret copied to another row
 * (another user's authenticator) no longer opens. `enc:v1:` (no row binding) and
 * plaintext (legacy) values stay readable and are brought to v2 by
 * sealExistingTotpSecrets.
 */
const PREFIX = 'enc:v1:';
const PREFIX2 = 'enc:v2:';
const aadOf = (id) => Buffer.from(`das-forge/totp-row/${id}`);

/** A key argument may be one string or a list: the FIRST encrypts, every entry can decrypt (key rotation). */
export const keyList = (k) => (Array.isArray(k) ? k : k ? [k] : []).filter(Boolean);
const INFO = 'das-forge/totp/v1';

function deriveKey(secret) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new TypeError('encryptionKey must be a string of at least 16 characters');
  }
  return Buffer.from(hkdfSync('sha256', secret, 'das-forge', INFO, 32));
}

export function isSealed(value) {
  return typeof value === 'string' && (value.startsWith(PREFIX) || value.startsWith(PREFIX2));
}

/** True for a value in the current format (bound to its row). */
export const isBoundSecret = (value) => typeof value === 'string' && value.startsWith(PREFIX2);

/** @param {{id?: number|string}} [opts] - the authenticator row the value belongs to; with it the v2 format is written */
export function sealSecret(plain, encryptionKey, { id } = {}) {
  const [current] = keyList(encryptionKey);
  if (!current) return plain;
  if (isSealed(plain)) return plain;
  encryptionKey = current;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(encryptionKey), iv);
  if (id !== undefined && id !== null) cipher.setAAD(aadOf(id));
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `${id !== undefined && id !== null ? PREFIX2 : PREFIX}${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${ct.toString('base64url')}`;
}

export function openSecret(stored, encryptionKey, { id } = {}) {
  if (!isSealed(stored)) return stored;
  const keys = keyList(encryptionKey);
  if (keys.length === 0) throw new Error('TOTP secret is encrypted but no encryptionKey was provided');
  let lastError;
  for (const key of keys) {
    try {
      return openWith(stored, key, { id });
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

export function openWith(stored, encryptionKey, { id } = {}) {
  const bound = stored.startsWith(PREFIX2);
  if (bound && (id === undefined || id === null)) throw new Error('Cannot decrypt TOTP secret (the row it belongs to was not given)');
  const [iv, tag, ct] = stored.slice(PREFIX.length).split(':');
  if (!iv || !tag || !ct) throw new Error('Malformed encrypted TOTP secret');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(encryptionKey), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  if (bound) decipher.setAAD(aadOf(id));
  try {
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Cannot decrypt TOTP secret (wrong encryptionKey or corrupted data)');
  }
}

/**
 * Brings every TOTP secret to the CURRENT key: plaintext ones are encrypted, ones sealed with an
 * older key are re-encrypted (so an old key can be dropped from the config afterwards).
 * Returns how many rows changed. A row no listed key can open is left alone (with a console warning).
 */
export function sealExistingTotpSecrets(db, encryptionKey) {
  const keys = keyList(encryptionKey);
  if (keys.length === 0) return 0;
  let n = 0;
  let unreadable = 0;
  for (const row of db.all(`SELECT authenticator_id, secret FROM totp_credentials`)) {
    let plain;
    if (isSealed(row.secret)) {
      try {
        if (!isBoundSecret(row.secret)) throw new Error('v1: not bound to its row yet');
        openWith(row.secret, keys[0], { id: row.authenticator_id });
        continue; // already in the current format under the current key
      } catch {
        try {
          plain = openSecret(row.secret, keys, { id: row.authenticator_id });
        } catch {
          unreadable++;
          continue;
        }
      }
    } else {
      plain = row.secret;
    }
    db.run(`UPDATE totp_credentials SET secret = ? WHERE authenticator_id = ?`, [sealSecret(plain, keys[0], { id: row.authenticator_id }), row.authenticator_id]);
    n++;
  }
  if (unreadable > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[das-forge] ${unreadable} TOTP secret(s) cannot be decrypted with the configured keys - add the old key to auth.previousTotpEncryptionKeys`);
  }
  return n;
}
