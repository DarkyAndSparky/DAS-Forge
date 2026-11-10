import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { XlsxError } from '../../src/xlsx/errors.js';

// A stand-in for the archive libraries (the real ones are used in the last block): a minimal ZIP on node:zlib.
// Also the `zip` export, so a worker thread can load it by file name.
function crc32(buf) { return zlib.crc32(buf) >>> 0; }
export const fakeZip = {
  async write(entries) {
    const files = []; const central = []; let offset = 0;
    for (const [name, data] of entries) {
      const n = Buffer.from(name); const comp = zlib.deflateRawSync(data); const crc = crc32(data);
      const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
      files.push(local, n, comp);
      const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
      central.push(c, n); offset += local.length + n.length + comp.length;
    }
    const cd = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...files, cd, end]);
  },
  async read(buffer, limits) {
    const out = new Map(); let total = 0;
    const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const count = buffer.readUInt16LE(eocd + 10); let p = buffer.readUInt32LE(eocd + 16);
    if (count > limits.maxEntries) throw new XlsxError('TOO_MANY_ENTRIES', 'too many');
    for (let i = 0; i < count; i++) {
      const nl = buffer.readUInt16LE(p + 28); const lo = buffer.readUInt32LE(p + 42); const name = buffer.toString('utf8', p + 46, p + 46 + nl); p += 46 + nl;
      out.set(`#names:${name}`, Buffer.alloc(0));
      if (!limits.wanted(name)) continue;
      const cl = buffer.readUInt32LE(lo + 18); const start = lo + 30 + buffer.readUInt16LE(lo + 26) + buffer.readUInt16LE(lo + 28);
      let data;
      try { data = zlib.inflateRawSync(buffer.subarray(start, start + cl), { maxOutputLength: Math.min(limits.maxPartBytes ?? limits.maxEntryBytes, limits.maxTotalBytes - total) }); } catch { throw new XlsxError('TOO_BIG_UNPACKED', 'too big'); }
      total += data.length; out.set(name, data);
    }
    return out;
  },
};

// The streaming half: one part inflated as a stream; and an archive written from entries that may be streams.
fakeZip.stream = async function stream(buffer, match, limits) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(eocd + 10); let p = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const nl = buffer.readUInt16LE(p + 28); const lo = buffer.readUInt32LE(p + 42); const name = buffer.toString('utf8', p + 46, p + 46 + nl); p += 46 + nl;
    if (!match(name)) continue;
    const cl = buffer.readUInt32LE(lo + 18); const start = lo + 30 + buffer.readUInt16LE(lo + 26) + buffer.readUInt16LE(lo + 28);
    const inflate = zlib.createInflateRaw();
    const source = Readable.from([buffer.subarray(start, start + cl)]).pipe(inflate);
    return Readable.from((async function* flow() {
      let size = 0;
      for await (const chunk of source) {
        // small pieces, so that the cutting in the reader is really exercised
        for (let o = 0; o < chunk.length; o += 4096) {
          const piece = chunk.subarray(o, o + 4096);
          size += piece.length;
          if (size > limits.maxBytes) throw new XlsxError('TOO_BIG_UNPACKED', 'too big');
          yield piece;
        }
      }
    })());
  }
  return null;
};
fakeZip.writeStream = async function writeStream(entries) {
  const done = [];
  for (const [name, data] of entries) {
    if (Buffer.isBuffer(data)) { done.push([name, data]); continue; }
    const chunks = [];
    for await (const c of data) chunks.push(Buffer.from(c));
    done.push([name, Buffer.concat(chunks)]);
  }
  return Readable.from([await fakeZip.write(done)]);
};
export const zip = fakeZip;
