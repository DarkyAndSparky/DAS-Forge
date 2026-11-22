import { describe, it, expect, afterAll } from 'vitest';
import sharp from 'sharp';
import yazl from 'yazl';
import { reencodeImageIsolated, checkZipSafetyIsolated, verifyZipDataIsolated, parseCsvIsolated, closeWorkers } from '../src/files/isolated.js';
import { reencodeImage } from '../src/files/image-pipeline.js';
import { checkZipSafety } from '../src/files/zip-guard.js';
import { verifyZipData } from '../src/files/zip-verify.js';
import { parseCsv, CsvError } from '../src/csv/index.js';

afterAll(() => closeWorkers());

/** A real zip (deflate) built by yazl. */
function realZip(files) {
  return new Promise((resolve, reject) => {
    const z = new yazl.ZipFile(); const chunks = [];
    for (const [name, data] of Object.entries(files)) z.addBuffer(Buffer.from(data), name);
    z.outputStream.on('data', (c) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks))).on('error', reject);
    z.end();
  });
}

const png = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 10, b: 10 } } }).png().toBuffer();

describe('readers of untrusted files in worker threads (same answers as the plain functions)', () => {
  it('an image is re-encoded in the worker, with the same result and metadata stripped', async () => {
    const src = await png(40, 30);
    const a = await reencodeImageIsolated(src, { maxWidth: 20 });
    const b = await reencodeImage(src, { maxWidth: 20 });
    expect(Buffer.isBuffer(a.buffer)).toBe(true);
    expect({ f: a.format, w: a.width, h: a.height }).toEqual({ f: b.format, w: b.width, h: b.height });
    expect(a.width).toBe(20);
  });
  it('a pixel bomb and a broken image are refused by the worker, the server goes on', async () => {
    await expect(reencodeImageIsolated(await png(200, 200), { maxInputPixels: 1000 })).rejects.toBeTruthy();
    await expect(reencodeImageIsolated(Buffer.from('not an image at all'))).rejects.toBeTruthy();
    expect((await reencodeImageIsolated(await png(8, 8))).width).toBe(8);
  });
  it('the heif option (a module) cannot cross to the worker', async () => {
    await expect(reencodeImageIsolated(await png(4, 4), { heif: {} })).rejects.toThrow(TypeError);
  });
  it('archive checks give the same answers', async () => {
    const good = await realZip({ 'a.txt': 'hello', 'b/c.txt': 'x'.repeat(1000) });
    expect(await checkZipSafetyIsolated(good)).toEqual(await checkZipSafety(good));
    expect(await verifyZipDataIsolated(good)).toEqual(await verifyZipData(good));
    const bomb = await realZip({ 'z.bin': Buffer.alloc(5_000_000) });
    const g = await checkZipSafetyIsolated(bomb);
    expect(g.ok).toBe(false);
    expect((await verifyZipDataIsolated(bomb, { maxUncompressedTotal: 1000 })).ok).toBe(false);
    expect((await checkZipSafetyIsolated(Buffer.from('PK nonsense'))).ok).toBe(false);
  });
  it('CSV parses in the worker; limits become CsvError with the same code', async () => {
    const text = 'a;b\r\n1;2\r\n';
    expect(await parseCsvIsolated(text)).toEqual(parseCsv(text));
    expect(await parseCsvIsolated(Buffer.from('x,y\n1,2\n'))).toEqual(parseCsv(Buffer.from('x,y\n1,2\n')));
    const e = await parseCsvIsolated('a\n'.repeat(50), { limits: { maxRows: 5 } }).catch((x) => x);
    expect(e).toBeInstanceOf(CsvError);
    expect(e.code).toBe('TOO_MANY_ROWS');
  });
});
