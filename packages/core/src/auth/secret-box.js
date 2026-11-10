import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Encryption at rest for TOTP secrets (audit A10).
 * Format: `enc:v1:<iv b64url>:<tag b64url>:<ciphertext b64url>`, AES-256-GCM,
 * key = HKDF-SHA256(secret, info 'das-forge/totp/v1'). Plaintext (legacy)
 * values stay readable and are encrypted lazily / by sealExistingTotpSecrets.
 */
const PREFIX = 'enc:v1:';

/** A key argument may be one string or a list: the FIRST encrypts, every entry can decrypt (key rotation). */
const keyList = (k) => (Array.isArray(k) ? k : k ? [k] : []).filter(Boolean);
const INFO = 'das-forge/totp/v1';

function deriveKey(secret) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new TypeError('encryptionKey must be a string of at least 16 characters');
  }
  return Buffer.from(hkdfSync('sha256', secret, 'das-forge', INFO, 32));
}

export function isSealed(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function sealSecret(plain, encryptionKey) {
  const [current] = keyList(encryptionKey);
  if (!current) return plain;
  if (isSealed(plain)) return plain;
  encryptionKey = current;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(encryptionKey), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `${PREFIX}${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${ct.toString('base64url')}`;
}

export function openSecret(stored, encryptionKey) {
  if (!isSealed(stored)) return stored;
  const keys = keyList(encryptionKey);
  if (keys.length === 0) throw new Error('TOTP secret is encrypted but no encryptionKey was provided');
  let lastError;
  for (const key of keys) {
    try {
      return openWith(stored, key);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

function openWith(stored, encryptionKey) {
  const [iv, tag, ct] = stored.slice(PREFIX.length).split(':');
  if (!iv || !tag || !ct) throw new Error('Malformed encrypted TOTP secret');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(encryptionKey), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
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
        openWith(row.secret, keys[0]);
        continue; // already under the current key
      } catch {
        try {
          plain = openSecret(row.secret, keys);
        } catch {
          unreadable++;
          continue;
        }
      }
    } else {
      plain = row.secret;
    }
    db.run(`UPDATE totp_credentials SET secret = ? WHERE authenticator_id = ?`, [sealSecret(plain, keys[0]), row.authenticator_id]);
    n++;
  }
  if (unreadable > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[das-forge] ${unreadable} TOTP secret(s) cannot be decrypted with the configured keys - add the old key to auth.previousTotpEncryptionKeys`);
  }
  return n;
}
