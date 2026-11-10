import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';
import yauzl from 'yauzl';

/** Reads the central directory one entry at a time; null when it holds more than `limit` entries. */
function listEntries(zipfile, limit) {
  return new Promise((resolve, reject) => {
    const entries = [];
    zipfile.on('entry', (entry) => {
      if (entries.length >= limit) return resolve(null);
      entries.push(entry);
      zipfile.readEntry();
    });
    zipfile.once('end', () => resolve(entries));
    zipfile.once('error', reject);
    zipfile.readEntry();
  });
}

/**
 * Second half of the zip-bomb defence (audit B12). zip-guard.js's
 * checkZipSafety() only reads the sizes an archive CLAIMS in its central
 * directory - a hostile archive can claim small sizes and still inflate
 * to gigabytes. This function actually inflates every entry (streamed,
 * nothing is kept) and enforces what really comes out:
 *
 *   - the real uncompressed bytes, per entry and in total, are counted and
 *     the entry is aborted the moment the budget is exceeded, whatever the
 *     headers say;
 *   - yauzl rejects entries whose real size differs from the declared one
 *     (`validateEntrySizes`), unsafe names (`..`, absolute paths,
 *     backslashes - zip-slip), and a directory that does not parse;
 *   - the CRC-32 of every entry is verified (yauzl does not do that);
 *   - encrypted entries and methods other than stored/deflate are refused.
 *
 * Nothing is written to disk; memory use is one stream chunk.
 *
 * @param {Buffer} buffer
 * @param {object} [opts]
 * @param {number} [opts.maxEntries=2000]
 * @param {number} [opts.maxUncompressedTotal=500 MiB] - real bytes, all entries together
 * @returns {Promise<{ok: true, files: number, totalUncompressed: number} | {ok: false, reason: string}>}
 */
export async function verifyZipData(buffer, { maxEntries = 2000, maxUncompressedTotal = 500 * 1024 * 1024 } = {}) {
  let zipfile;
  try {
    zipfile = await yauzl.fromBufferPromise(buffer, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true });
  } catch (err) {
    return { ok: false, reason: `archive cannot be read (${err.message})` };
  }

  let files = 0;
  let total = 0;
  try {
    const entries = await listEntries(zipfile, maxEntries);
    if (entries === null) return { ok: false, reason: `too many entries (more than ${maxEntries})` };
    for (const entry of entries) {
      if (entry.isEncrypted()) return { ok: false, reason: `entry "${entry.fileName}" is encrypted` };
      if (entry.fileName.endsWith('/')) continue;
      if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
        return { ok: false, reason: `entry "${entry.fileName}" uses unsupported compression method ${entry.compressionMethod}` };
      }

      let crc = 0;
      let size = 0;
      const source = await zipfile.openReadStreamPromise(entry);
      await pipeline(
        source,
        new Writable({
          write(chunk, _enc, cb) {
            crc = crc32(chunk, crc);
            size += chunk.length;
            if (total + size > maxUncompressedTotal) {
              return cb(new Error(`real uncompressed size exceeds ${maxUncompressedTotal} bytes (entry "${entry.fileName}")`));
            }
            cb();
          },
        })
      );
      if ((crc >>> 0) !== (entry.crc32 >>> 0)) {
        return { ok: false, reason: `entry "${entry.fileName}" is corrupt (CRC mismatch)` };
      }
      total += size;
      files++;
    }
  } catch (err) {
    return { ok: false, reason: err.message };
  } finally {
    try {
      zipfile.close();
    } catch {
      /* already closed */
    }
  }
  return { ok: true, files, totalUncompressed: total };
}
