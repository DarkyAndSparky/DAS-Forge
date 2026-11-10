import { v4 as uuidv4 } from 'uuid';
import path from 'node:path';
import { mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';

/**
 * §4.5h item 4: path-traversal-safe storage names. The client-supplied
 * original filename is NEVER used to build a filesystem path - not
 * sanitized, not used at all - because sanitizing a hostile filename
 * ("../../etc/passwd", null bytes, Windows-reserved names) is a game
 * of whack-a-mole with no clean end state. Instead the server always
 * generates its own random name; the original filename (if wanted for
 * display, e.g. a download's suggested name) is stored as plain DB
 * metadata, never interpreted as a path.
 *
 * The extension used on disk comes from the magic-bytes-detected type
 * (see magic-bytes.js), not from the client's filename either - so a
 * file renamed to pretend to be something else still gets stored under
 * its real detected extension.
 */
export function generateSafeFilename(detectedType) {
  return `${uuidv4()}.${detectedType}`;
}

/**
 * Writes a validated buffer to disk under a safe, server-generated name.
 * Callers should run magic-bytes/zip-guard/image-pipeline checks BEFORE
 * calling this - this function trusts its input is already validated
 * and just handles the storage-safety part.
 *
 * @param {Buffer} buffer
 * @param {string} storageDir - directory uploads live in
 * @param {string} detectedType - from detectFileType()/detectOfficeType()
 * @returns {{filename: string, fullPath: string}}
 */
export function storeUpload(buffer, storageDir, detectedType) {
  mkdirSync(storageDir, { recursive: true });
  const filename = generateSafeFilename(detectedType);
  const fullPath = path.join(storageDir, filename);

  // Defense in depth: even though filename is server-generated and
  // can't contain a separator, confirm the resolved path still lands
  // inside storageDir before writing - cheap insurance against a
  // future refactor accidentally reintroducing client input here.
  const resolvedDir = path.resolve(storageDir);
  const resolvedPath = path.resolve(fullPath);
  if (!resolvedPath.startsWith(resolvedDir + path.sep)) {
    throw new Error('Refusing to write outside the configured storage directory');
  }

  // Atomic: a crash or a full disk mid-write must not leave a truncated
  // file under the final name (audit B13). Owner-only mode: uploads are
  // served by the app, never directly by the OS user's other processes.
  const tmpPath = `${resolvedPath}.tmp`;
  try {
    writeFileSync(tmpPath, buffer, { mode: 0o600 });
    renameSync(tmpPath, resolvedPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* nothing to clean */
    }
    throw err;
  }
  return { filename, fullPath: resolvedPath };
}

export const SAFE_STORED_NAME = /^[0-9a-f-]{36}\.[a-z0-9]{2,5}$/;

/**
 * Deletes a file previously created by storeUpload(). Only names of the
 * exact shape storeUpload() generates are accepted, so a filename coming
 * out of a database row can never be steered outside storageDir.
 * @returns {boolean} true if a file was removed
 */
export function removeUpload(storageDir, filename) {
  if (typeof filename !== 'string' || !SAFE_STORED_NAME.test(filename)) return false;
  try {
    unlinkSync(path.join(path.resolve(storageDir), filename));
    return true;
  } catch {
    return false;
  }
}
