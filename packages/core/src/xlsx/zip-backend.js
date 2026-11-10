/**
 * The ZIP side of a workbook, behind a small interface so the spreadsheet code can be tested
 * without the archive libraries: `read(buffer, limits) -> Map<name, Buffer>` and
 * `write(entries: Array<[name, Buffer]>) -> Buffer`, plus the two that stream: `stream(buffer, match, limits) -> Readable`
 * (one part, unpacked as it is read) and `writeStream(entries) -> Readable` (parts may be streams too). The default uses yauzl (reading, with the
 * same strict options as `files.verifyZipData`) and yazl (writing); both load on first use.
 */
import { Readable } from 'node:stream';
import { XlsxError } from './errors.js';

async function drain(stream, budget, name) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > budget) {
      stream.destroy();
      throw new XlsxError('TOO_BIG_UNPACKED', `"${name}" unpacks to more than the allowed size`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Checks the archive's own list of parts before anything is unpacked: no part twice (two parts with one name are how a
 * checker and a reader come to see different files), and no part that claims a ratio deflate cannot reach (1032 to 1 is its ceiling, so such a header lies).
 * Kept apart from the library so it can be tested without it.
 * @param {Array<{fileName: string, compressedSize: number, uncompressedSize: number}>} list
 */
export function checkArchive(list, { maxEntryBytes, maxTotalBytes, maxRatio = 1032 }) {
  const seen = new Set();
  let total = 0;
  for (const e of list) {
    if (e.fileName.endsWith('/')) continue;
    const key = e.fileName.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
    if (seen.has(key)) throw new XlsxError('DUPLICATE_ENTRY', 'the archive has two parts with the same name');
    seen.add(key);
    if (e.uncompressedSize > maxEntryBytes) throw new XlsxError('TOO_BIG_UNPACKED', `"${e.fileName}" claims to unpack to more than the allowed size`);
    if (e.uncompressedSize > 1024 * 1024 && e.uncompressedSize > Math.max(1, e.compressedSize) * maxRatio) throw new XlsxError('ZIP_BOMB', `"${e.fileName}" is compressed suspiciously well`);
    total += e.uncompressedSize;
    if (total > maxTotalBytes) throw new XlsxError('TOO_BIG_UNPACKED', 'the archive claims to unpack to more than the allowed size');
  }
}

async function openArchive(buffer) {
  const { default: yauzl } = await import('yauzl');
  try {
    return await yauzl.fromBufferPromise(buffer, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true });
  } catch (err) {
    throw new XlsxError('NOT_A_WORKBOOK', `the file is not a readable archive (${err.message})`);
  }
}

async function listEntries(zipfile, limits) {
  if (zipfile.entryCount > limits.maxEntries) throw new XlsxError('TOO_MANY_ENTRIES', 'the archive has too many entries');
  const entries = await new Promise((resolve, reject) => {
    const list = [];
    zipfile.on('entry', (e) => { list.push(e); zipfile.readEntry(); });
    zipfile.on('end', () => resolve(list));
    zipfile.on('error', reject);
    zipfile.readEntry();
  });
  checkArchive(entries, limits);
  return entries;
}

/**
 * @param {{wanted: (name: string) => boolean, maxEntries: number, maxEntryBytes: number, maxTotalBytes: number, maxPartBytes?: number}} limits
 * `maxEntryBytes` is what the archive may claim for any part; `maxPartBytes` (default: the same) is what a part that is read may unpack to.
 */
async function read(buffer, limits) {
  const zipfile = await openArchive(buffer);
  try {
    const out = new Map();
    let total = 0;
    const entries = await listEntries(zipfile, limits);
    for (const entry of entries) {
      const name = entry.fileName;
      if (name.endsWith('/')) continue;
      if (entry.isEncrypted()) throw new XlsxError('ENCRYPTED', 'the workbook is encrypted');
      out.set(`#names:${name}`, Buffer.alloc(0)); // every name is reported, whether it is read or not
      if (!limits.wanted(name)) continue;
      if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) throw new XlsxError('NOT_A_WORKBOOK', `"${name}" uses an unsupported compression`);
      const room = Math.min(limits.maxPartBytes ?? limits.maxEntryBytes, limits.maxTotalBytes - total);
      const data = await drain(await zipfile.openReadStreamPromise(entry), room, name);
      total += data.length;
      out.set(name, data);
    }
    return out;
  } finally {
    try { zipfile.close(); } catch { /* already closed */ }
  }
}

async function write(entries) {
  const { default: yazl } = await import('yazl');
  const zip = new yazl.ZipFile();
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    zip.outputStream.on('data', (c) => chunks.push(c));
    zip.outputStream.on('end', resolve);
    zip.outputStream.on('error', reject);
  });
  const mtime = new Date(Date.UTC(2020, 0, 1)); // a fixed time: the same data gives the same bytes
  for (const [name, data] of entries) zip.addBuffer(data, name, { mtime, compress: true });
  zip.end();
  await done;
  return Buffer.concat(chunks);
}

/**
 * One part of the archive as a stream of its unpacked bytes (null when there is no such part). The archive's own list is
 * checked first, as for `read`; the unpacked size is counted while it flows and the stream fails past `limits.maxBytes`.
 * @param {(name: string) => boolean} match
 * @param {{maxEntries: number, maxEntryBytes: number, maxTotalBytes: number, maxBytes: number}} limits
 */
async function stream(buffer, match, limits) {
  const zipfile = await openArchive(buffer);
  let handedOver = false;
  try {
    const entries = await listEntries(zipfile, limits);
    const entry = entries.find((e) => !e.fileName.endsWith('/') && match(e.fileName));
    if (!entry) return null;
    if (entry.isEncrypted()) throw new XlsxError('ENCRYPTED', 'the workbook is encrypted');
    if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) throw new XlsxError('NOT_A_WORKBOOK', `"${entry.fileName}" uses an unsupported compression`);
    const source = await zipfile.openReadStreamPromise(entry);
    handedOver = true;
    return Readable.from((async function* flow() {
      let size = 0;
      try {
        for await (const chunk of source) {
          size += chunk.length;
          if (size > limits.maxBytes) { source.destroy(); throw new XlsxError('TOO_BIG_UNPACKED', `"${entry.fileName}" unpacks to more than the allowed size`); }
          yield chunk;
        }
      } finally {
        source.destroy();
        try { zipfile.close(); } catch { /* already closed */ }
      }
    })());
  } finally {
    if (!handedOver) { try { zipfile.close(); } catch { /* already closed */ } }
  }
}

async function* bytesOf(source) {
  for await (const chunk of source) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

/**
 * Writes an archive as a stream. Each entry is `[name, Buffer | Readable | AsyncIterable]`; they are written in the order
 * given, one at a time, so an entry may be produced lazily (and may depend on entries before it). An error in any entry
 * destroys the output with that error.
 * @param {Array<[string, Buffer | AsyncIterable<Buffer|string>]>} entries
 * @returns {Promise<import('node:stream').Readable>}
 */
async function writeStream(entries) {
  const { default: yazl } = await import('yazl');
  const zip = new yazl.ZipFile();
  const mtime = new Date(Date.UTC(2020, 0, 1));
  for (const [name, data] of entries) {
    if (Buffer.isBuffer(data)) { zip.addBuffer(data, name, { mtime, compress: true }); continue; }
    // yazl counts the size and the checksum of what flows through: it must be bytes, never strings (a Cyrillic letter is two bytes)
    const readable = Readable.from(bytesOf(data), { objectMode: false });
    readable.on('error', (err) => zip.outputStream.destroy(err));
    zip.addReadStream(readable, name, { mtime, compress: true });
  }
  zip.end();
  return zip.outputStream;
}

export const defaultZip = { read, write, stream, writeStream };
