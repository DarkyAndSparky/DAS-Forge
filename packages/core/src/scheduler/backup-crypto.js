import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { createReadStream, createWriteStream, openSync, readSync, closeSync, fstatSync, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

/**
 * Backup encryption (audit B17). Backups hold password hashes and personal
 * data, so a copy that leaves the server (cloud drive, USB stick) can be
 * sealed with a passphrase.
 *
 * File layout of `backup-<ts>.zip.enc`:
 *   "DASBAK1\0" (8) | scrypt salt (16) | AES-GCM iv (12) | ciphertext | auth tag (16)
 * AES-256-GCM, key = scrypt(passphrase, salt). The header is bound to the tag
 * as additional authenticated data, so a changed header is detected too.
 * Streaming: the archive is never held in memory.
 *
 * Uses node:crypto only - no new dependency; this is not a place for hand-rolled
 * primitives, only for a file container around the standard ones.
 */

const MAGIC = Buffer.from('DASBAK1\0', 'latin1');
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + SALT_LEN + IV_LEN;
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

function deriveKey(passphrase, salt) {
  return scryptAsync(passphrase, salt, 32);
}

/** True when the file starts with the encrypted-backup signature. */
export function isEncryptedBackup(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const head = Buffer.alloc(MAGIC.length);
    return readSync(fd, head, 0, MAGIC.length, 0) === MAGIC.length && head.equals(MAGIC);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Encrypts `src` into `dst` (mode 0600). Removes a partial `dst` on failure. */
export async function encryptBackupFile(src, dst, passphrase) {
  assertKey(passphrase);
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const header = Buffer.concat([MAGIC, salt, iv]);
  const cipher = createCipheriv('aes-256-gcm', await deriveKey(passphrase, salt), iv);
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
  try {
    size = fstatSync(fd).size;
    if (size < HEADER_LEN + TAG_LEN) throw new BackupCryptoError('NOT_ENCRYPTED', 'File is too short to be an encrypted backup');
    header = Buffer.alloc(HEADER_LEN);
    readSync(fd, header, 0, HEADER_LEN, 0);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new BackupCryptoError('NOT_ENCRYPTED', 'File is not an encrypted backup');
    tag = Buffer.alloc(TAG_LEN);
    readSync(fd, tag, 0, TAG_LEN, size - TAG_LEN);
  } finally {
    closeSync(fd);
  }
  const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
  const iv = header.subarray(MAGIC.length + SALT_LEN);
  const decipher = createDecipheriv('aes-256-gcm', await deriveKey(passphrase, salt), iv);
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
