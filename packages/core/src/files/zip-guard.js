import { inspectZip, detectOfficeType } from './zip-inspect.js';

/** Zip-slip names: absolute paths, drive letters, backslashes, NUL, or a `..` segment. */
function isSafeArchiveName(name) {
  if (name.length === 0 || name.includes('\0') || name.includes('\\')) return false;
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
  return !name.split('/').includes('..');
}

/**
 * §4.5h item 4a: office formats (docx/xlsx/pptx) are zip containers, so
 * an uploaded "document" can be a zip bomb - a tiny compressed file
 * that expands to gigabytes. Since the zip central directory already
 * states each entry's compressed/uncompressed size, this check doesn't
 * need to decompress anything to catch a bomb: it just refuses to
 * trust an archive whose claimed expansion ratio or entry count is
 * absurd, same principle as magic-bytes - verify before you trust.
 *
 * Defaults are generous for genuine office documents (which rarely
 * exceed a few hundred parts or a ~20x expansion ratio for mostly-XML
 * content) while still catching the classic "42.zip"-style bomb
 * (thousands of entries or ratios in the thousands/millions).
 *
 * Async since 0.1.74 (the directory is read by yauzl). This reads CLAIMED sizes only; zip-verify.js's verifyZipData() is the
 * counterpart that inflates the data and enforces the real ones.
 */
export async function checkZipSafety(
  buffer,
  { maxEntries = 2000, maxUncompressedTotal = 500 * 1024 * 1024, maxRatio = 100 } = {}
) {
  let inspected;
  try {
    // A directory cut short or inconsistent is how a hostile archive hides entries
    // from this check; yauzl refuses such an archive, which lands here.
    inspected = await inspectZip(buffer, { limit: maxEntries });
  } catch (err) {
    return { ok: false, reason: `archive cannot be read (${err.message})`, entries: [] };
  }
  const { entries, declaredCount, tooMany } = inspected;
  if (tooMany) {
    return { ok: false, reason: `too many entries (${declaredCount} > ${maxEntries})`, entries };
  }

  for (const entry of entries) {
    if (!isSafeArchiveName(entry.name)) {
      return { ok: false, reason: `unsafe entry name ${JSON.stringify(entry.name)}`, entries };
    }
    if (entry.encrypted) {
      return { ok: false, reason: `entry "${entry.name}" is encrypted`, entries };
    }
  }

  if (entries.length > maxEntries) {
    return { ok: false, reason: `too many entries (${entries.length} > ${maxEntries})`, entries };
  }

  let totalCompressed = 0;
  let totalUncompressed = 0;
  for (const entry of entries) {
    totalCompressed += entry.compressedSize;
    totalUncompressed += entry.uncompressedSize;

    // Per-entry ratio catches a bomb hidden among otherwise-normal
    // entries, not just an extreme archive-wide average.
    if (entry.compressedSize > 0) {
      const entryRatio = entry.uncompressedSize / entry.compressedSize;
      if (entryRatio > maxRatio) {
        return {
          ok: false,
          reason: `entry "${entry.name}" has an excessive compression ratio (${entryRatio.toFixed(1)}x > ${maxRatio}x)`,
          entries,
        };
      }
    }
  }

  if (totalUncompressed > maxUncompressedTotal) {
    return {
      ok: false,
      reason: `total uncompressed size too large (${totalUncompressed} > ${maxUncompressedTotal} bytes)`,
      entries,
    };
  }

  return { ok: true, entries, totalCompressed, totalUncompressed };
}

/**
 * Convenience: checks zip safety AND confirms the archive has the
 * expected internal structure for an office format - a file that's
 * zip-safe but has none of the expected office parts is suspicious
 * (either corrupted or not actually what its extension claims).
 *
 * @param {Buffer} buffer
 * @param {'docx'|'xlsx'|'pptx'} expectedType
 */
export async function assertSafeOfficeFile(buffer, expectedType, guardOptions) {
  const result = await checkZipSafety(buffer, guardOptions);
  if (!result.ok) {
    throw new Error(`Unsafe ${expectedType} file: ${result.reason}`);
  }
  const actualType = detectOfficeType(result.entries);
  if (actualType !== expectedType) {
    throw new Error(`Expected ${expectedType} but archive structure indicates ${actualType}`);
  }
  return result;
}
