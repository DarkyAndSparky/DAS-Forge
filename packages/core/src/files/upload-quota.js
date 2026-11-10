import path from 'node:path';
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';

/**
 * Quotas and garbage collection for the uploads directory (audit B13).
 *
 * Only files of the exact shape `storeUpload()` generates count and are
 * ever touched (`<uuid>.<ext>`, plus its `.tmp` leftovers) - anything else
 * an operator put in the directory is none of core's business.
 */
const STORED = /^[0-9a-f-]{36}\.[a-z0-9]{2,5}$/;
const STORED_TMP = /^[0-9a-f-]{36}\.[a-z0-9]{2,5}\.tmp$/;

function* storedFiles(dir, pattern) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !pattern.test(entry.name)) continue;
    try {
      const st = statSync(path.join(dir, entry.name));
      yield { name: entry.name, size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      /* removed meanwhile */
    }
  }
}

/**
 * Directory usage is cached per directory for `cacheMs` (default 2 s) so a burst of uploads does not list the
 * directory every time (audit I09); `noteUploadStored()` adds a stored file to the cached figure.
 * Another process writing meanwhile is seen after the TTL. `cacheMs: 0` = always rescan (old behaviour).
 */
const usageCache = new Map();
export function invalidateUploadUsage(storageDir) {
  if (storageDir === undefined) usageCache.clear();
  else usageCache.delete(path.resolve(storageDir));
}

/** @returns {{files: number, bytes: number}} what the directory currently holds */
export function getUploadUsage(storageDir) {
  let files = 0;
  let bytes = 0;
  for (const f of storedFiles(storageDir, STORED)) {
    files++;
    bytes += f.size;
  }
  return { files, bytes };
}

/**
 * Throws an Error with `code: 'QUOTA_EXCEEDED'` when storing `incomingBytes`
 * more would break a limit. A limit of 0/undefined means "no limit".
 * Call it right before the (synchronous) write so check and write cannot
 * interleave with another upload in the same process.
 *
 * @param {string} storageDir
 * @param {{maxTotalBytes?: number, maxFiles?: number, cacheMs?: number}|undefined} quota
 * @param {number} incomingBytes
 */
export function assertUploadQuota(storageDir, quota, incomingBytes) {
  if (!quota) return;
  const { maxTotalBytes = 0, maxFiles = 0, cacheMs = 2000 } = quota;
  if (!maxTotalBytes && !maxFiles) return;
  const key = path.resolve(storageDir);
  const cached = usageCache.get(key);
  const fresh = cacheMs > 0 && cached && Date.now() - cached.at < cacheMs;
  const usage = fresh ? cached : { ...getUploadUsage(storageDir), at: Date.now() };
  const fail = (message) => Object.assign(new Error(message), { code: 'QUOTA_EXCEEDED' });
  if (maxFiles && usage.files + 1 > maxFiles) throw fail(`Upload storage is full (limit ${maxFiles} files)`);
  if (maxTotalBytes && usage.bytes + incomingBytes > maxTotalBytes) {
    throw fail(`Upload storage is full (limit ${maxTotalBytes} bytes)`);
  }
  if (cacheMs > 0 && !fresh) usageCache.set(key, usage);
  else if (cacheMs <= 0) usageCache.delete(key);
}

/** Call after a file was really stored: keeps the cached usage honest between rescans (audit I09). */
export function noteUploadStored(storageDir, bytes) {
  const c = usageCache.get(path.resolve(storageDir));
  if (c) { c.files += 1; c.bytes += bytes; }
}

/**
 * Files in `storageDir` that no database row refers to. `referenced` is
 * every stored filename still in use (a Set or any iterable). Files
 * younger than `minAgeMs` are never reported: an upload is written BEFORE
 * its row, so a brand-new file may simply not be referenced yet.
 * Stale `.tmp` files from a crashed write are reported too.
 *
 * @returns {Array<{name: string, size: number}>}
 */
export function findOrphanUploads(storageDir, referenced, { minAgeMs = 60 * 60 * 1000, now = Date.now() } = {}) {
  const used = referenced instanceof Set ? referenced : new Set(referenced);
  const orphans = [];
  for (const f of storedFiles(storageDir, STORED)) {
    if (!used.has(f.name) && now - f.mtimeMs >= minAgeMs) orphans.push({ name: f.name, size: f.size });
  }
  for (const f of storedFiles(storageDir, STORED_TMP)) {
    if (now - f.mtimeMs >= minAgeMs) orphans.push({ name: f.name, size: f.size });
  }
  return orphans;
}

/**
 * Deletes what findOrphanUploads() finds (or only reports it with
 * `dryRun: true`). Pass an EMPTY referenced set only on purpose: it makes
 * every old file an orphan.
 *
 * @returns {{removed: number, bytes: number, names: string[]}}
 */
export function removeOrphanUploads(storageDir, referenced, { minAgeMs, now, dryRun = false } = {}) {
  invalidateUploadUsage(storageDir);
  const orphans = findOrphanUploads(storageDir, referenced, { minAgeMs, now });
  const names = [];
  let bytes = 0;
  for (const o of orphans) {
    if (!dryRun) {
      try {
        unlinkSync(path.join(path.resolve(storageDir), o.name));
      } catch {
        continue;
      }
    }
    names.push(o.name);
    bytes += o.size;
  }
  return { removed: names.length, bytes, names };
}
