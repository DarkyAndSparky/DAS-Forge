import yauzl from 'yauzl';

/**
 * Reads an archive's central directory with yauzl (lazy: one entry at a time,
 * nothing is inflated) and returns what the archive CLAIMS about itself.
 * This replaced the project's own directory parser in 0.1.74: yauzl already
 * handles ZIP64, comments, truncated directories and malformed headers, and is
 * the same reader verifyZipData() uses for the real unpacking.
 *
 * @param {Buffer} buffer
 * @param {object} [opts]
 * @param {number} [opts.limit=Infinity] - stop (and report `tooMany`) once the declared entry count is above this
 * @returns {Promise<{entries: Array<{name: string, compressedSize: number, uncompressedSize: number, flags: number, encrypted: boolean}>, declaredCount: number, tooMany: boolean}>}
 * @throws {Error} when the buffer is not a readable zip (message from yauzl)
 */
export async function inspectZip(buffer, { limit = Infinity } = {}) {
  const zipfile = await yauzl.fromBufferPromise(buffer, {
    lazyEntries: true,
    decodeStrings: true,
    validateEntrySizes: false, // claimed sizes are exactly what is wanted here
    strictFileNames: false, // names are judged by zip-guard (zip-slip), not rejected by the reader
  });
  const declaredCount = zipfile.entryCount;
  if (declaredCount > limit) {
    zipfile.close();
    return { entries: [], declaredCount, tooMany: true };
  }
  try {
    const entries = await new Promise((resolve, reject) => {
      const list = [];
      zipfile.on('entry', (e) => {
        list.push({
          name: e.fileName,
          compressedSize: e.compressedSize,
          uncompressedSize: e.uncompressedSize,
          flags: e.generalPurposeBitFlag,
          encrypted: e.isEncrypted(),
        });
        zipfile.readEntry();
      });
      zipfile.once('end', () => resolve(list));
      zipfile.once('error', reject);
      zipfile.readEntry();
    });
    return { entries, declaredCount, tooMany: false };
  } finally {
    zipfile.close();
  }
}

/**
 * @param {Buffer} buffer
 * @returns {Promise<Array<{name: string, compressedSize: number, uncompressedSize: number}>>}
 */
export async function listZipEntries(buffer) {
  const { entries } = await inspectZip(buffer);
  return entries.map(({ name, compressedSize, uncompressedSize }) => ({ name, compressedSize, uncompressedSize }));
}

/**
 * Tells OOXML office formats (all zip containers) from a plain .zip purely by
 * which internal paths exist - no decompression needed.
 *
 * @param {Array<{name: string}>} entries
 * @returns {'docx'|'xlsx'|'pptx'|'odt'|'zip'}
 */
export function detectOfficeType(entries) {
  const names = new Set(entries.map((e) => e.name));
  const has = (n) => names.has(n);
  if (!has('[Content_Types].xml')) {
    // No OOXML marker - a plain zip, or ODF (first stored entry is 'mimetype').
    return has('mimetype') ? 'odt' : 'zip';
  }
  if (has('word/document.xml')) return 'docx';
  if (has('xl/workbook.xml')) return 'xlsx';
  if (has('ppt/presentation.xml')) return 'pptx';
  return 'zip'; // has [Content_Types].xml but none of the known part names
}
