import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import yazl from 'yazl';

import { acceptUpload, checkZipSafety, verifyZipData } from '../src/files/index.js';

/** Audit B12: the archive guard must hold against headers that lie, not only against headers that are honest about a bomb. */

/** A real zip (deflate) built by yazl. */
function realZip(files) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const [name, content] of Object.entries(files)) zip.addBuffer(Buffer.from(content), name);
    zip.end();
    const chunks = [];
    zip.outputStream.on('data', (c) => chunks.push(c));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
}

/** A STORED zip written by hand, so a test can make the headers lie. */
function craftStored(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, crc, declaredSize } of entries) {
    const nameBuf = Buffer.from(name);
    const body = Buffer.from(data);
    const c = crc ?? crc32(body) >>> 0;
    const size = declaredSize ?? body.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(c, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(c, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** Offsets of every central-directory record in a zip buffer. */
function centralOffsets(buf) {
  const out = [];
  for (let i = 0; i + 4 <= buf.length; i++) if (buf.readUInt32LE(i) === 0x02014b50) out.push(i);
  return out;
}

describe('verifyZipData / checkZipSafety (B12)', () => {
  it('accepts an honest archive', async () => {
    const zip = await realZip({ '[Content_Types].xml': '<a/>', 'word/document.xml': '<w>hello</w>'.repeat(20) });
    expect((await checkZipSafety(zip)).ok).toBe(true);
    const r = await verifyZipData(zip);
    expect(r.ok).toBe(true);
    expect(r.files).toBe(2);
  });

  it('enforces the REAL uncompressed size, not the one the headers claim', async () => {
    const zip = await realZip({ 'big.xml': 'a'.repeat(3 * 1024 * 1024) });
    const lying = Buffer.from(zip);
    for (const off of centralOffsets(lying)) lying.writeUInt32LE(3000, off + 24); // claim 3 KB
    // the header-only guard is fooled...
    expect((await checkZipSafety(lying, { maxRatio: 1000 })).ok).toBe(true);
    // ...the data check is not
    const r = await verifyZipData(lying);
    expect(r.ok).toBe(false);
    // and an honest-but-too-big archive is stopped by the budget while inflating
    const budget = await verifyZipData(zip, { maxUncompressedTotal: 1024 * 1024 });
    expect(budget.ok).toBe(false);
    expect(budget.reason).toMatch(/exceeds/);
  });

  it('rejects a CRC mismatch', async () => {
    const r = await verifyZipData(craftStored([{ name: 'a.txt', data: 'hello', crc: 0x12345678 }]));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/CRC/);
  });

  it('rejects zip-slip names in both guards', async () => {
    const zip = craftStored([{ name: '../evil.txt', data: 'x' }]);
    const guard = await checkZipSafety(zip);
    expect(guard.ok).toBe(false);
    expect(guard.reason).toMatch(/unsafe entry name|invalid relative path/);
    expect((await verifyZipData(zip)).ok).toBe(false);
    for (const name of ['/abs.txt', 'a/../../b.txt', 'C:/x.txt']) {
      expect((await checkZipSafety(craftStored([{ name, data: 'x' }]))).ok).toBe(false);
    }
  });

  it('rejects a truncated central directory (hidden entries)', async () => {
    const zip = craftStored([{ name: 'a.txt', data: '1' }]);
    const lying = Buffer.from(zip);
    const eocd = lying.length - 22;
    lying.writeUInt16LE(3, eocd + 8);
    lying.writeUInt16LE(3, eocd + 10); // claims 3 entries, only 1 record exists
    const guard = await checkZipSafety(lying);
    expect(guard.ok).toBe(false);
    expect(guard.reason).toMatch(/cannot be read|truncated|inconsistent/);
    expect((await verifyZipData(lying)).ok).toBe(false);
  });

  it('rejects encrypted entries', async () => {
    const zip = craftStored([{ name: 'a.txt', data: '1' }]);
    const flagged = Buffer.from(zip);
    for (const off of centralOffsets(flagged)) flagged.writeUInt16LE(1, off + 8);
    expect((await checkZipSafety(flagged)).reason).toMatch(/encrypted/);
    // yauzl may refuse the entry before our own check does (a flagged stored entry looks 12 bytes short)
    const verified = await verifyZipData(flagged);
    expect(verified.ok).toBe(false);
    expect(verified.reason).toMatch(/encrypted|size mismatch/);
  });

  it('rejects too many entries and non-zip input', async () => {
    const many = craftStored(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, data: 'x' })));
    const r = await verifyZipData(many, { maxEntries: 2 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/too many entries/);
    expect((await verifyZipData(Buffer.from('definitely not a zip'))).ok).toBe(false);
  });
});

describe('acceptUpload runs the data check on archives (B12)', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'das-zip-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const opts = () => ({ allowedTypes: ['docx', 'zip'], maxBytes: 20 * 1024 * 1024, storageDir: dir });

  it('stores an honest docx and refuses one whose headers lie, leaving nothing on disk', async () => {
    const docx = await realZip({ '[Content_Types].xml': '<a/>', 'word/document.xml': '<w>text</w>' });
    const ok = await acceptUpload(docx, opts());
    expect(ok.type).toBe('docx');
    expect(readdirSync(dir)).toHaveLength(1);

    const lying = Buffer.from(await realZip({ '[Content_Types].xml': '<a/>', 'word/document.xml': 'a'.repeat(2 * 1024 * 1024) }));
    for (const off of centralOffsets(lying)) lying.writeUInt32LE(100, off + 24);
    await expect(acceptUpload(lying, { ...opts(), zipGuardOptions: { maxRatio: 100000 } })).rejects.toThrow(/Unsafe archive/);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('verifyArchiveData:false skips the data check (trusted sources only)', async () => {
    const bad = craftStored([{ name: '[Content_Types].xml', data: 'x', crc: 1 }, { name: 'word/document.xml', data: 'y', crc: 1 }]);
    await expect(acceptUpload(bad, opts())).rejects.toThrow(/Unsafe archive/);
    const r = await acceptUpload(bad, { ...opts(), verifyArchiveData: false });
    expect(r.type).toBe('docx');
  });
});
