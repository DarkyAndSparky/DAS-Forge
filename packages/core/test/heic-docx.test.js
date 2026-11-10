import { describe, it, expect } from 'vitest';
import { detectFileType } from '../src/files/magic-bytes.js';
import { decodeHeic } from '../src/files/image-pipeline.js';
import { buildDocx } from '../src/files/docx-report.js';
import { acceptUpload } from '../src/files/accept-upload.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function heicBytes(brand = 'heic') {
  return Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftyp'), Buffer.from(brand), Buffer.alloc(12)]);
}

function fakeHeif({ width = 2, height = 1, fail = false, empty = false } = {}) {
  return {
    HeifDecoder: class {
      decode() {
        if (empty) return [];
        return [
          {
            get_width: () => width,
            get_height: () => height,
            display: (target, cb) => {
              if (fail) return cb(null);
              target.data.fill(7);
              cb(target);
            },
          },
        ];
      }
    },
  };
}

describe('HEIC (libheif-js)', () => {
  it('is detected by its ftyp brand, and a non-HEIC ftyp (mp4) is not', () => {
    expect(detectFileType(heicBytes('heic'))).toEqual({ type: 'heic', mime: 'image/heic' });
    expect(detectFileType(heicBytes('mif1')).type).toBe('heic');
    expect(detectFileType(heicBytes('isom'))).toBeNull();
  });

  it('decodes to RGBA of the right size', async () => {
    const out = await decodeHeic(heicBytes(), { heif: fakeHeif({ width: 3, height: 2 }) });
    expect(out.width).toBe(3);
    expect(out.height).toBe(2);
    expect(out.data.length).toBe(3 * 2 * 4);
    expect(out.data[0]).toBe(7);
  });

  it('refuses a declared canvas over the pixel budget before allocating it', async () => {
    await expect(decodeHeic(heicBytes(), { heif: fakeHeif({ width: 20000, height: 20000 }), maxInputPixels: 1000 })).rejects.toThrow(/too large/);
  });

  it('reports an empty file and a failed decode as errors', async () => {
    await expect(decodeHeic(heicBytes(), { heif: fakeHeif({ empty: true }) })).rejects.toThrow(/no image/);
    await expect(decodeHeic(heicBytes(), { heif: fakeHeif({ fail: true }) })).rejects.toThrow(/decode failed/);
  });

  it('acceptUpload sends HEIC through the re-encoder and stores what came out (jpg)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heic-'));
    const seen = [];
    const r = await acceptUpload(heicBytes(), {
      allowedTypes: ['heic', 'jpg'],
      maxBytes: 1_000_000,
      storageDir: dir,
      reencode: async (buf) => {
        seen.push(buf.length);
        return { buffer: Buffer.from([0xff, 0xd8, 0xff, 0x00]), format: 'jpeg' };
      },
    });
    expect(seen.length).toBe(1);
    expect(r.type).toBe('jpg');
    expect(r.mime).toBe('image/jpeg');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('buildDocx', () => {
  // A recording stand-in for the docx module: proves what we feed it, not Word's file format.
  function recorder() {
    const log = [];
    const mk = (name) =>
      class {
        constructor(opts) {
          this.name = name;
          this.opts = opts;
          log.push(this);
        }
      };
    return {
      log,
      mod: {
        Document: mk('Document'),
        Paragraph: mk('Paragraph'),
        TextRun: class {
          constructor(o) {
            this.text = typeof o === 'string' ? o : o.text;
          }
        },
        Table: mk('Table'),
        TableRow: mk('TableRow'),
        TableCell: mk('TableCell'),
        HeadingLevel: { TITLE: 'title', HEADING_1: 'h1' },
        WidthType: { PERCENTAGE: 'pct' },
        Packer: { toBuffer: async (doc) => Buffer.from(JSON.stringify({ sections: doc.opts.sections.length, title: doc.opts.title })) },
      },
    };
  }

  it('turns data into a document and returns a Buffer', async () => {
    const { mod, log } = recorder();
    const buf = await buildDocx(
      { title: 'Report', author: 'root', sections: [{ heading: 'A', paragraphs: ['p1'], bullets: ['b1'], table: { header: ['x'], rows: [['1'], ['2']] } }] },
      { docx: mod }
    );
    expect(JSON.parse(buf.toString())).toEqual({ sections: 1, title: 'Report' });
    expect(log.filter((o) => o.name === 'TableRow').length).toBe(3);
  });

  it('strips control characters that would make Word reject the file, and refuses object cells', async () => {
    const { mod, log } = recorder();
    await buildDocx({ title: 'T\u0000', sections: [{ paragraphs: ['a\u0001b'] }] }, { docx: mod });
    const texts = log.filter((o) => o.name === 'Document')[0].opts.title;
    expect(texts).toBe('T');
    await expect(buildDocx({ title: 'T', sections: [{ table: { rows: [[{ a: 1 }]] } }] }, { docx: mod })).rejects.toThrow(/must be text/);
  });

  it('requires a title and sections', async () => {
    const { mod } = recorder();
    await expect(buildDocx({ title: ' ', sections: [] }, { docx: mod })).rejects.toThrow(/title/);
    await expect(buildDocx({ title: 'T' }, { docx: mod })).rejects.toThrow(/sections/);
  });
});
