import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';
import yauzl from 'yauzl';
import yazl from 'yazl';

/**
 * The ONE place that knows what a backup file looks like (and the only
 * file in core that imports `yazl` / `yauzl`).
 *
 * A backup is a single `backup-<timestamp>.zip`:
 *
 *   database.db       consistent SQLite snapshot (VACUUM INTO)
 *   uploads/...       the uploaded files, same relative layout (optional)
 *   manifest.json     { format, createdAt, uploads }  - `uploads` is true
 *                     when the uploads directory existed at backup time
 *                     (even if it was empty), so a restore knows whether
 *                     "no uploads/ entries" means "empty" or "not backed up"
 *
 * There is deliberately no other (older) layout to read: the format was
 * introduced before any production deployment.
 *
 * Everything is streamed: yazl pipes files from disk through deflate into
 * the output file, yauzl reads one entry at a time, so memory use does not
 * grow with the size of the database or the uploads. Entries are never
 * extracted with a library helper: an archive is data, a name like
 * `../../x` must not leave the target directory (zip-slip), so every name
 * is validated here and every file is written by this module. yauzl does
 * not verify CRC-32 itself, so it is checked here while streaming.
 *
 * Symbolic links inside the uploads directory are skipped (never followed
 * out of it).
 */

export const BACKUP_FORMAT = 1;
export const BACKUP_DB_ENTRY = 'database.db';
export const BACKUP_UPLOADS_PREFIX = 'uploads/';
export const BACKUP_MANIFEST_ENTRY = 'manifest.json';

const KNOWN_TOP_LEVEL = new Set([BACKUP_DB_ENTRY, BACKUP_MANIFEST_ENTRY]);
const MAX_MANIFEST_BYTES = 64 * 1024;

/** True for a name that is safe to join under a target directory. */
export function isSafeEntryName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.includes('\0') || name.includes('\\')) return false;
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
  return !name.split('/').some((part) => part === '..');
}

/** Every regular file and empty directory under `root`, as posix paths relative to it. */
function walkUploads(root) {
  const files = [];
  const emptyDirs = [];
  const visit = (dir, relDir) => {
    const children = readdirSync(dir, { withFileTypes: true });
    let kept = 0;
    for (const child of children) {
      const rel = relDir ? `${relDir}/${child.name}` : child.name;
      if (child.isSymbolicLink()) continue;
      if (child.isDirectory()) {
        kept++;
        visit(path.join(dir, child.name), rel);
      } else if (child.isFile()) {
        kept++;
        files.push(rel);
      }
    }
    if (kept === 0 && relDir) emptyDirs.push(relDir);
  };
  visit(root, '');
  return { files, emptyDirs };
}

/**
 * Streams the archive to `zipPath` (the caller renames it into place).
 *
 * @param {object} opts
 * @param {string} opts.dbFile - the verified database snapshot to include
 * @param {string|null} [opts.uploadsDir] - uploads directory to include (skipped when missing)
 * @param {string} opts.zipPath - where to write
 * @param {number} [opts.mode=0o600]
 * @param {Date} [opts.createdAt]
 * @returns {Promise<{uploadsIncluded: boolean, bytes: number}>}
 */
export async function writeBackupArchive({ dbFile, uploadsDir = null, zipPath, mode = 0o600, createdAt = new Date() }) {
  const zip = new yazl.ZipFile();
  zip.addFile(dbFile, BACKUP_DB_ENTRY);

  const uploadsIncluded = Boolean(uploadsDir) && existsSync(uploadsDir);
  if (uploadsIncluded) {
    const { files, emptyDirs } = walkUploads(uploadsDir);
    for (const rel of files) zip.addFile(path.join(uploadsDir, ...rel.split('/')), BACKUP_UPLOADS_PREFIX + rel);
    for (const rel of emptyDirs) zip.addEmptyDirectory(BACKUP_UPLOADS_PREFIX + rel);
  }

  zip.addBuffer(
    Buffer.from(JSON.stringify({ format: BACKUP_FORMAT, createdAt: createdAt.toISOString(), uploads: uploadsIncluded })),
    BACKUP_MANIFEST_ENTRY
  );
  zip.end();

  mkdirSync(path.dirname(zipPath), { recursive: true });
  await pipeline(zip.outputStream, createWriteStream(zipPath, { mode }));
  if (process.platform !== 'win32') chmodSync(zipPath, mode);
  return { uploadsIncluded, bytes: statSync(zipPath).size };
}

/** A pass-through that fails the stream when the data does not match the entry's declared CRC-32. */
function crcChecker(entry) {
  let running = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      running = crc32(chunk, running);
      cb(null, chunk);
    },
    flush(cb) {
      cb((running >>> 0) === (entry.crc32 >>> 0) ? null : new Error(`entry "${entry.fileName}" is corrupt (CRC mismatch)`));
    },
  });
}

/** Streams one entry (CRC-checked) into `destination`. */
async function pipeEntry(opened, entry, destination) {
  const source = await opened.zipfile.openReadStreamPromise(entry);
  await pipeline(source, crcChecker(entry), destination);
}

function discard() {
  return new Writable({ write: (_c, _e, cb) => cb() });
}

async function readEntryToBuffer(opened, entry, limit) {
  const chunks = [];
  let size = 0;
  await pipeEntry(
    opened,
    entry,
    new Writable({
      write(chunk, _enc, cb) {
        size += chunk.length;
        if (size > limit) return cb(new Error(`entry "${entry.fileName}" is larger than ${limit} bytes`));
        chunks.push(chunk);
        cb();
      },
    })
  );
  return Buffer.concat(chunks);
}

/** Reads the central directory, one entry at a time. */
function listEntries(zipfile) {
  return new Promise((resolve, reject) => {
    const entries = [];
    zipfile.on('entry', (entry) => {
      entries.push(entry);
      zipfile.readEntry();
    });
    zipfile.once('end', () => resolve(entries));
    zipfile.once('error', reject);
    zipfile.readEntry();
  });
}

/**
 * Opens and structurally validates a backup archive. Rejects with a
 * readable Error for anything that is not a well-formed backup. The
 * caller MUST `await opened.close()` when done.
 *
 * @returns {Promise<{ zipfile: object, entries: object[], manifest: {format:number, createdAt:string, uploads:boolean}, close: () => Promise<void> }>}
 */
export async function openBackupArchive(zipPath) {
  if (!existsSync(zipPath)) throw new Error(`${zipPath} does not exist`);

  let zipfile;
  try {
    zipfile = await yauzl.openPromise(zipPath, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true });
  } catch (err) {
    throw new Error(`not a valid backup archive: ${err.message}`);
  }

  const opened = {
    zipfile,
    entries: [],
    manifest: null,
    close: async () => {
      try {
        zipfile.close();
      } catch {
        /* already closed */
      }
    },
  };

  try {
    opened.entries = await listEntries(zipfile);
    for (const e of opened.entries) {
      if (!isSafeEntryName(e.fileName)) throw new Error(`unsafe entry name in archive: ${JSON.stringify(e.fileName)}`);
      if (!KNOWN_TOP_LEVEL.has(e.fileName) && !e.fileName.startsWith(BACKUP_UPLOADS_PREFIX)) {
        throw new Error(`unexpected entry in backup archive: ${e.fileName}`);
      }
      if (e.isEncrypted()) throw new Error(`encrypted entry in backup archive: ${e.fileName}`);
    }

    const manifestEntry = opened.entries.find((e) => e.fileName === BACKUP_MANIFEST_ENTRY);
    if (!manifestEntry) throw new Error(`not a backup archive: ${BACKUP_MANIFEST_ENTRY} is missing`);
    let manifest;
    try {
      manifest = JSON.parse((await readEntryToBuffer(opened, manifestEntry, MAX_MANIFEST_BYTES)).toString('utf8'));
    } catch (err) {
      throw new Error(`${BACKUP_MANIFEST_ENTRY} is unreadable: ${err.message}`);
    }
    if (manifest?.format !== BACKUP_FORMAT) {
      throw new Error(`unsupported backup format ${JSON.stringify(manifest?.format)} (this build reads format ${BACKUP_FORMAT})`);
    }
    if (!opened.entries.some((e) => e.fileName === BACKUP_DB_ENTRY)) {
      throw new Error(`not a backup archive: ${BACKUP_DB_ENTRY} is missing`);
    }
    opened.manifest = { format: manifest.format, createdAt: manifest.createdAt, uploads: manifest.uploads === true };
    return opened;
  } catch (err) {
    await opened.close();
    throw err;
  }
}

/** CRC-checks every entry by streaming it; returns the file count. Rejects on the first corrupt entry. */
export async function checkArchiveData(opened) {
  let files = 0;
  for (const e of opened.entries) {
    if (e.fileName.endsWith('/')) continue;
    await pipeEntry(opened, e, discard());
    files++;
  }
  return { files };
}

/** Streams `database.db` from the archive into `destFile` (owner-only on POSIX). */
export async function extractBackupDatabase(opened, destFile, mode = 0o600) {
  const entry = opened.entries.find((e) => e.fileName === BACKUP_DB_ENTRY);
  await pipeEntry(opened, entry, createWriteStream(destFile, { mode }));
  if (process.platform !== 'win32') chmodSync(destFile, mode);
}

/**
 * Streams the `uploads/` entries under `targetDir` (created if needed).
 * Every path is re-checked to stay inside `targetDir`.
 * @returns {Promise<number>} number of files written
 */
export async function extractBackupUploads(opened, targetDir) {
  const root = path.resolve(targetDir);
  mkdirSync(root, { recursive: true });
  let written = 0;
  for (const e of opened.entries) {
    if (!e.fileName.startsWith(BACKUP_UPLOADS_PREFIX)) continue;
    const relative = e.fileName.slice(BACKUP_UPLOADS_PREFIX.length);
    if (relative === '') continue;
    const target = path.resolve(root, ...relative.split('/'));
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`unsafe entry name in archive: ${JSON.stringify(e.fileName)}`);
    }
    if (e.fileName.endsWith('/')) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    await pipeEntry(opened, e, createWriteStream(target));
    written++;
  }
  return written;
}
