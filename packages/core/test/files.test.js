import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { detectFileType, assertAllowedFileType } from '../src/files/magic-bytes.js';
import { listZipEntries, detectOfficeType } from '../src/files/zip-inspect.js';
import { checkZipSafety, assertSafeOfficeFile } from '../src/files/zip-guard.js';
import { generateSafeFilename, storeUpload } from '../src/files/upload-storage.js';
import { sanitizeSvg } from '../src/files/svg-sanitize.js';
import { validateUpload } from '../src/files/validate-upload.js';

// 1x1 transparent PNG (hardcoded well-known minimal fixture)
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);
const JPG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PDF_HEADER = Buffer.from('%PDF-1.4\n%fake pdf content for testing\n');
const GIF_HEADER = Buffer.from('GIF89a' + 'fake gif body');
const RANDOM_BYTES = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);

describe('detectFileType', () => {
  it('detects a real PNG by its signature', () => {
    expect(detectFileType(PNG_1X1)).toEqual({ type: 'png', mime: 'image/png' });
  });

  it('detects JPEG, PDF, GIF by signature', () => {
    expect(detectFileType(JPG_HEADER).type).toBe('jpg');
    expect(detectFileType(PDF_HEADER).type).toBe('pdf');
    expect(detectFileType(GIF_HEADER).type).toBe('gif');
  });

  it('detects SVG via text sniff', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(detectFileType(svg)).toEqual({ type: 'svg', mime: 'image/svg+xml' });
  });

  it('returns null for unrecognized content', () => {
    expect(detectFileType(RANDOM_BYTES)).toBeNull();
  });

  it('is not fooled by a .png extension on non-PNG content (magic bytes rule)', () => {
    // simulates a client lying about the file type via filename/Content-Type
    const fakeImage = Buffer.from('<html><script>alert(1)</script></html>');
    const detected = detectFileType(fakeImage);
    expect(detected?.type).not.toBe('png');
  });
});

describe('assertAllowedFileType', () => {
  it('passes for an allowed detected type', () => {
    expect(assertAllowedFileType(PNG_1X1, ['png', 'jpg']).type).toBe('png');
  });

  it('throws for a type not in the allow-list', () => {
    expect(() => assertAllowedFileType(PDF_HEADER, ['png', 'jpg'])).toThrow();
  });

  it('throws for undetectable content even if allow-list is broad', () => {
    expect(() => assertAllowedFileType(RANDOM_BYTES, ['png', 'jpg', 'pdf'])).toThrow();
  });
});

/**
 * Builds a minimal synthetic ZIP buffer: a real (empty-data) local file
 * header per entry - so magic-bytes' PK\x03\x04 signature check
 * recognizes it as a zip, matching every real-world zip file - followed
 * by a central directory + end-of-central-directory record. The
 * project's zip-reader only reads the central directory index, so the
 * local headers' data payload doesn't need to be real compressed bytes.
 * Good enough as a test fixture without needing a real zip-writing
 * dependency.
 */
function buildTestZip(entries) {
  const localHeaders = entries.map(({ name }) => {
    const nameBuf = Buffer.from(name, 'utf8');
    const header = Buffer.alloc(30 + nameBuf.length);
    header.writeUInt32LE(0x04034b50, 0); // local file header signature
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0, 6); // flags
    header.writeUInt16LE(0, 8); // compression method
    header.writeUInt16LE(0, 10); // mod time
    header.writeUInt16LE(0, 12); // mod date
    header.writeUInt32LE(0, 14); // crc32
    header.writeUInt32LE(0, 18); // compressed size (local header copy, unused by our reader)
    header.writeUInt32LE(0, 22); // uncompressed size (local header copy, unused by our reader)
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28); // extra length
    nameBuf.copy(header, 30);
    return header;
  });
  const localHeadersBlock = Buffer.concat(localHeaders);

  const centralRecords = entries.map(({ name, compressedSize, uncompressedSize }) => {
    const nameBuf = Buffer.from(name, 'utf8');
    const record = Buffer.alloc(46 + nameBuf.length);
    record.writeUInt32LE(0x02014b50, 0); // central dir signature
    record.writeUInt16LE(20, 4); // version made by
    record.writeUInt16LE(20, 6); // version needed
    record.writeUInt16LE(0, 8); // flags
    record.writeUInt16LE(0, 10); // compression method (stored)
    record.writeUInt16LE(0, 12); // mod time
    record.writeUInt16LE(0, 14); // mod date
    record.writeUInt32LE(0, 16); // crc32
    record.writeUInt32LE(compressedSize, 20);
    record.writeUInt32LE(uncompressedSize, 24);
    record.writeUInt16LE(nameBuf.length, 28);
    record.writeUInt16LE(0, 30); // extra length
    record.writeUInt16LE(0, 32); // comment length
    record.writeUInt16LE(0, 34); // disk number start
    record.writeUInt16LE(0, 36); // internal attrs
    record.writeUInt32LE(0, 38); // external attrs
    record.writeUInt32LE(0, 42); // local header offset
    nameBuf.copy(record, 46);
    return record;
  });

  const centralDir = Buffer.concat(centralRecords);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(localHeadersBlock.length, 16); // central dir starts right after local headers
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localHeadersBlock, centralDir, eocd]);
}

describe('listZipEntries / detectOfficeType', () => {
  it('parses entry names and sizes from a synthetic zip', async () => {
    const zip = buildTestZip([
      { name: '[Content_Types].xml', compressedSize: 100, uncompressedSize: 300 },
      { name: 'word/document.xml', compressedSize: 500, uncompressedSize: 2000 },
    ]);
    const entries = await listZipEntries(zip);
    expect(entries).toHaveLength(2);
    expect(entries[0].name).toBe('[Content_Types].xml');
    expect(entries[1].uncompressedSize).toBe(2000);
  });

  it('identifies docx/xlsx/pptx by their characteristic internal path', async () => {
    const docx = buildTestZip([
      { name: '[Content_Types].xml', compressedSize: 1, uncompressedSize: 1 },
      { name: 'word/document.xml', compressedSize: 1, uncompressedSize: 1 },
    ]);
    const xlsx = buildTestZip([
      { name: '[Content_Types].xml', compressedSize: 1, uncompressedSize: 1 },
      { name: 'xl/workbook.xml', compressedSize: 1, uncompressedSize: 1 },
    ]);
    const pptx = buildTestZip([
      { name: '[Content_Types].xml', compressedSize: 1, uncompressedSize: 1 },
      { name: 'ppt/presentation.xml', compressedSize: 1, uncompressedSize: 1 },
    ]);
    const plainZip = buildTestZip([{ name: 'readme.txt', compressedSize: 1, uncompressedSize: 1 }]);

    expect(detectOfficeType(await listZipEntries(docx))).toBe('docx');
    expect(detectOfficeType(await listZipEntries(xlsx))).toBe('xlsx');
    expect(detectOfficeType(await listZipEntries(pptx))).toBe('pptx');
    expect(detectOfficeType(await listZipEntries(plainZip))).toBe('zip');
  });

  it('throws on a buffer with no valid end-of-central-directory', async () => {
    await expect(listZipEntries(Buffer.from('not a zip at all'))).rejects.toThrow(/end of central directory/i);
  });
});

describe('checkZipSafety', () => {
  it('passes a normal-looking office document', async () => {
    const zip = buildTestZip([
      { name: '[Content_Types].xml', compressedSize: 200, uncompressedSize: 800 },
      { name: 'word/document.xml', compressedSize: 5000, uncompressedSize: 40000 },
    ]);
    const result = await checkZipSafety(zip);
    expect(result.ok).toBe(true);
  });

  it('rejects an entry with an absurd compression ratio (zip-bomb style)', async () => {
    const zip = buildTestZip([
      { name: '[Content_Types].xml', compressedSize: 100, uncompressedSize: 300 },
      { name: 'bomb.xml', compressedSize: 1000, uncompressedSize: 2_000_000_000 },
    ]);
    const result = await checkZipSafety(zip);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/compression ratio/);
  });

  it('rejects an archive with too many entries', async () => {
    const manyEntries = Array.from({ length: 10 }, (_, i) => ({
      name: `file${i}.txt`,
      compressedSize: 10,
      uncompressedSize: 20,
    }));
    const zip = buildTestZip(manyEntries);
    const result = await checkZipSafety(zip, { maxEntries: 5 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/too many entries/);
  });

  it('rejects when total uncompressed size exceeds the limit', async () => {
    const zip = buildTestZip([
      { name: 'a.xml', compressedSize: 1000, uncompressedSize: 50_000 },
      { name: 'b.xml', compressedSize: 1000, uncompressedSize: 60_000 },
    ]);
    const result = await checkZipSafety(zip, { maxUncompressedTotal: 100_000, maxRatio: 1000 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/total uncompressed/);
  });
});

describe('assertSafeOfficeFile', () => {
  it('passes when the archive is safe and matches the expected type', async () => {
    const docx = buildTestZip([
      { name: '[Content_Types].xml', compressedSize: 100, uncompressedSize: 300 },
      { name: 'word/document.xml', compressedSize: 500, uncompressedSize: 2000 },
    ]);
    expect((await assertSafeOfficeFile(docx, 'docx')).ok).toBe(true);
  });

  it('throws when the archive structure does not match the claimed type', async () => {
    const xlsx = buildTestZip([
      { name: '[Content_Types].xml', compressedSize: 100, uncompressedSize: 300 },
      { name: 'xl/workbook.xml', compressedSize: 500, uncompressedSize: 2000 },
    ]);
    await expect(assertSafeOfficeFile(xlsx, 'docx')).rejects.toThrow(/indicates xlsx/);
  });

  it('throws when the archive itself is unsafe', async () => {
    const bomb = buildTestZip([
      { name: '[Content_Types].xml', compressedSize: 100, uncompressedSize: 300 },
      { name: 'word/document.xml', compressedSize: 10, uncompressedSize: 50_000_000 },
    ]);
    await expect(assertSafeOfficeFile(bomb, 'docx')).rejects.toThrow(/Unsafe docx/);
  });
});

describe('upload-storage', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'uploads-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('generateSafeFilename never uses the input - returns a uuid + detected extension', () => {
    const name = generateSafeFilename('png');
    expect(name).toMatch(/^[0-9a-f-]{36}\.png$/);
  });

  it('storeUpload writes the buffer under a generated name inside storageDir', () => {
    const { filename, fullPath } = storeUpload(PNG_1X1, tmpDir, 'png');
    expect(filename).toMatch(/\.png$/);
    expect(fullPath.startsWith(path.resolve(tmpDir))).toBe(true);
    expect(existsSync(fullPath)).toBe(true);
    expect(readFileSync(fullPath).equals(PNG_1X1)).toBe(true);
  });

  it('two uploads never collide on filename', () => {
    const a = storeUpload(PNG_1X1, tmpDir, 'png');
    const b = storeUpload(PNG_1X1, tmpDir, 'png');
    expect(a.filename).not.toBe(b.filename);
  });
});

describe('sanitizeSvg', () => {
  it('strips <script> tags', () => {
    const dirty = '<svg><script>alert(1)</script><circle r="5"/></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toContain('<script');
    expect(clean).toContain('<circle');
  });

  it('strips on* event handler attributes', () => {
    const dirty = '<svg onload="alert(1)"><rect onclick=\'evil()\'/></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toMatch(/onload/i);
    expect(clean).not.toMatch(/onclick/i);
  });

  it('strips javascript: URLs in href', () => {
    const dirty = '<svg><a href="javascript:alert(1)">click</a></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toContain('javascript:');
  });

  it('strips foreignObject blocks', () => {
    const dirty = '<svg><foreignObject><body onload="x()">hi</body></foreignObject></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toContain('foreignObject');
  });

  it('preserves benign SVG content (DOMPurify re-serializes, so check semantically)', () => {
    const benign = '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="5" r="4" fill="red"/></svg>';
    const clean = sanitizeSvg(benign);
    expect(clean).toContain('<circle');
    expect(clean).toContain('cx="5"');
    expect(clean).toContain('fill="red"');
  });
});

describe('validateUpload', () => {
  it('accepts an allowed, well-formed PNG', async () => {
    const result = await validateUpload(PNG_1X1, { allowedTypes: ['png', 'jpg'] });
    expect(result.type).toBe('png');
    expect(result.buffer.equals(PNG_1X1)).toBe(true);
  });

  it('rejects a type not in the allow-list', async () => {
    await expect(validateUpload(PDF_HEADER, { allowedTypes: ['png'] })).rejects.toThrow(/not allowed/);
  });

  it('rejects content exceeding maxBytes', async () => {
    await expect(validateUpload(PNG_1X1, { allowedTypes: ['png'], maxBytes: 5 })).rejects.toThrow(/maximum allowed size/);
  });

  it('rejects undetectable content', async () => {
    await expect(validateUpload(RANDOM_BYTES, { allowedTypes: ['png', 'jpg', 'pdf'] })).rejects.toThrow(
      /Could not determine file type/
    );
  });

  it('sanitizes SVG content before accepting it', async () => {
    const dirtySvg = Buffer.from('<svg onload="alert(1)"><circle r="5"/></svg>');
    const result = await validateUpload(dirtySvg, { allowedTypes: ['svg'] });
    expect(result.type).toBe('svg');
    expect(result.buffer.toString('utf8')).not.toMatch(/onload/i);
  });

  it('routes a docx through the zip-bomb guard and resolves its real mime type', async () => {
    const docx = buildTestZip([
      { name: '[Content_Types].xml', compressedSize: 100, uncompressedSize: 300 },
      { name: 'word/document.xml', compressedSize: 500, uncompressedSize: 2000 },
    ]);
    const result = await validateUpload(docx, { allowedTypes: ['docx'] });
    expect(result.type).toBe('docx');
    expect(result.mime).toContain('wordprocessingml');
  });

  it('rejects a docx-shaped zip bomb even if "docx" is allowed', async () => {
    const bomb = buildTestZip([
      { name: '[Content_Types].xml', compressedSize: 100, uncompressedSize: 300 },
      { name: 'word/document.xml', compressedSize: 10, uncompressedSize: 50_000_000 },
    ]);
    await expect(validateUpload(bomb, { allowedTypes: ['docx'] })).rejects.toThrow(/Unsafe archive/);
  });
});
