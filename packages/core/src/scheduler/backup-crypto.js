import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { createReadStream, createWriteStream, openSync, readSync, closeSync, fstatSync, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

/**
 * Backup encryption (audit B17). Backups hold password hashes and personal
 * data, so a copy that leaves the server (cloud drive, USB stick) can be
 * sealed with a passphrase.
 *
 * File layout of `backup-<ts>.zip.enc` (written: DASBAK2; DASBAK1 is still read, for good):
 *   DASBAK1: "DASBAK1\0" (8) | scrypt salt (16) | AES-GCM iv (12) | ciphertext | auth tag (16)
 *            key = scrypt(passphrase, salt) with Node's default cost (N=16384, r=8, p=1).
 *   DASBAK2: "DASBAK2\0" (8) | kdf_id (1, 1 = scrypt) | logN (1) | r (1) | p (1) | salt (16) | iv (12) | ciphertext | tag (16)
 *            the cost sits in the header, so it can grow later; default logN=17 (N=131072), r=8, p=1.
 * AES-256-GCM. The whole header is bound to the tag as additional authenticated data, so a changed header is detected too.
 * The cost read from a file is bounded (logN 14..20, memory N*r up to 2^21 blocks) so a forged header cannot exhaust memory.
 * Streaming: the archive is never held in memory.
 *
 * Uses node:crypto only - no new dependency; this is not a place for hand-rolled
 * primitives, only for a file container around the standard ones.
 */

const MAGIC1 = Buffer.from('DASBAK1\0', 'latin1');
const MAGIC2 = Buffer.from('DASBAK2\0', 'latin1');
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER1_LEN = MAGIC1.length + SALT_LEN + IV_LEN;
const HEADER2_LEN = MAGIC2.length + 1 + 3 + SALT_LEN + IV_LEN;
const KDF_SCRYPT = 1;
/** Default scrypt cost of new files. */
export const DEFAULT_SCRYPT = Object.freeze({ logN: 17, r: 8, p: 1 });
export const MIN_BACKUP_KEY_LENGTH = 16;
const scryptAsync = promisify(scrypt);

export class BackupCryptoError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BackupCryptoError';
    this.code = code;
  }
}

function assertKey(key) {
  if (typeof key !== 'string' || key.length < MIN_BACKUP_KEY_LENGTH) {
    throw new BackupCryptoError('KEY_TOO_SHORT', `Backup encryption key must be at least ${MIN_BACKUP_KEY_LENGTH} characters`);
  }
}

function deriveKey(passphrase, salt, cost = null) {
  if (!cost) return scryptAsync(passphrase, salt, 32); // DASBAK1: Node's defaults
  const N = 2 ** cost.logN;
  return scryptAsync(passphrase, salt, 32, { N, r: cost.r, p: cost.p, maxmem: 128 * N * cost.r + 128 * cost.r * cost.p + 1024 * 1024 });
}

function assertCost({ logN, r, p }) {
  if (!(logN >= 14 && logN <= 20) || !(r >= 1 && r <= 32) || !(p >= 1 && p <= 8) || 2 ** logN * r > 2 ** 21) {
    throw new BackupCryptoError('BAD_HEADER', 'The key-derivation cost in the backup header is outside the accepted range');
  }
}

/** True when the file starts with the encrypted-backup signature. */
export function isEncryptedBackup(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const head = Buffer.alloc(8);
    return readSync(fd, head, 0, 8, 0) === 8 && (head.equals(MAGIC1) || head.equals(MAGIC2));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Encrypts `src` into `dst` (mode 0600). Removes a partial `dst` on failure.
 * @param {{format?: 1|2, cost?: {logN:number, r:number, p:number}}} [o] - `format` 1 only for compatibility tests; `cost` for tests
 */
export async function encryptBackupFile(src, dst, passphrase, { format = 2, cost = DEFAULT_SCRYPT } = {}) {
  assertKey(passphrase);
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  let header;
  let key;
  if (format === 1) {
    header = Buffer.concat([MAGIC1, salt, iv]);
    key = await deriveKey(passphrase, salt);
  } else {
    assertCost(cost);
    header = Buffer.concat([MAGIC2, Buffer.from([KDF_SCRYPT, cost.logN, cost.r, cost.p]), salt, iv]);
    key = await deriveKey(passphrase, salt, cost);
  }
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);
  const out = createWriteStream(dst, { mode: 0o600 });
  try {
    out.write(header);
    await pipeline(createReadStream(src), cipher, out, { end: false });
    out.write(cipher.getAuthTag());
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    rmSync(dst, { force: true });
    throw err;
  }
}

/**
 * Decrypts `src` into `dst`. A wrong passphrase and a damaged file are
 * indistinguishable by design (GCM): both throw BAD_KEY_OR_CORRUPT and `dst`
 * is removed, so unauthenticated plaintext never stays on disk.
 */
export async function decryptBackupFile(src, dst, passphrase) {
  assertKey(passphrase);
  const fd = openSync(src, 'r');
  let header;
  let tag;
  let size;
  let v2;
  try {
    size = fstatSync(fd).size;
    if (size < HEADER1_LEN + TAG_LEN) throw new BackupCryptoError('NOT_ENCRYPTED', 'File is too short to be an encrypted backup');
    const magic = Buffer.alloc(8);
    readSync(fd, magic, 0, 8, 0);
    v2 = magic.equals(MAGIC2);
    if (!v2 && !magic.equals(MAGIC1)) throw new BackupCryptoError('NOT_ENCRYPTED', 'File is not an encrypted backup');
    const len = v2 ? HEADER2_LEN : HEADER1_LEN;
    if (size < len + TAG_LEN) throw new BackupCryptoError('NOT_ENCRYPTED', 'File is too short to be an encrypted backup');
    header = Buffer.alloc(len);
    readSync(fd, header, 0, len, 0);
    tag = Buffer.alloc(TAG_LEN);
    readSync(fd, tag, 0, TAG_LEN, size - TAG_LEN);
  } finally {
    closeSync(fd);
  }
  const HEADER_LEN = header.length;
  let key;
  if (v2) {
    if (header[8] !== KDF_SCRYPT) throw new BackupCryptoError('BAD_HEADER', 'Unknown key-derivation method in the backup header');
    const cost = { logN: header[9], r: header[10], p: header[11] };
    assertCost(cost);
    key = await deriveKey(passphrase, header.subarray(12, 12 + SALT_LEN), cost);
  } else {
    key = await deriveKey(passphrase, header.subarray(MAGIC1.length, MAGIC1.length + SALT_LEN));
  }
  const iv = header.subarray(HEADER_LEN - IV_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  try {
    await pipeline(
      createReadStream(src, { start: HEADER_LEN, end: size - TAG_LEN - 1 }),
      decipher,
      createWriteStream(dst, { mode: 0o600 })
    );
  } catch (err) {
    rmSync(dst, { force: true });
    if (/authenticate|unsupported state/i.test(err.message)) {
      throw new BackupCryptoError('BAD_KEY_OR_CORRUPT', 'Wrong encryption key or the backup file is damaged');
    }
    throw err;
  }
}
