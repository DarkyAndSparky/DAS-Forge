import { XlsxError } from './errors.js';

const SIG = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const FREE = 0xffffffff; const END = 0xfffffffe; const FATSECT = 0xfffffffd; const DIFSECT = 0xfffffffc;
const bad = (why) => new XlsxError('BAD_CONTAINER', `the old Excel file is damaged (${why})`);

/**
 * A reader for the compound file container (OLE2) that .xls lives in: sectors, the allocation tables and the
 * directory of streams. Every sector number, chain and size is checked against the file itself - a chain that loops,
 * runs outside the file or claims more than the file holds is a damaged file, never an endless loop or a huge buffer.
 *
 * Returns { entries: [{name, type, start, size}], read(entry) -> Buffer }.
 */
export function openCfb(buf, { maxStreamBytes }) {
  if (buf.length < 512 || !buf.subarray(0, 8).equals(SIG)) throw new XlsxError('NOT_A_WORKBOOK', 'the file is not a workbook');
  const shift = buf.readUInt16LE(30); const miniShift = buf.readUInt16LE(32);
  if ((shift !== 9 && shift !== 12) || miniShift !== 6) throw bad('unsupported sector size');
  const ss = 1 << shift; const mss = 1 << miniShift;
  const sectors = Math.floor((buf.length - 512 + ss - 1) / ss); // sectors that start inside the file (the last may be short)
  const sectorAt = (n) => {
    if (n >= sectors) throw bad('a sector lies outside the file');
    const off = 512 + n * ss;
    return buf.subarray(off, Math.min(buf.length, off + ss));
  };
  const nFat = buf.readUInt32LE(44); const dirStart = buf.readUInt32LE(48); const cutoff = buf.readUInt32LE(56);
  const miniStart = buf.readUInt32LE(60); const nMini = buf.readUInt32LE(64); const difStart = buf.readUInt32LE(68); const nDif = buf.readUInt32LE(72);
  if (nFat > sectors || nMini > sectors || nDif > sectors) throw bad('the tables are larger than the file');

  // the list of sectors that hold the allocation table: 109 in the header, the rest in a chain of DIFAT sectors
  const fatSectors = [];
  for (let i = 0; i < 109 && fatSectors.length < nFat; i++) { const v = buf.readUInt32LE(76 + i * 4); if (v !== FREE) fatSectors.push(v); }
  let dif = difStart; let hops = 0;
  while (fatSectors.length < nFat && dif !== END && dif !== FREE) {
    if (++hops > nDif + 1) throw bad('the table of tables loops');
    const s = sectorAt(dif);
    if (s.length < ss) throw bad('a table sector is cut short');
    for (let i = 0; i < ss / 4 - 1 && fatSectors.length < nFat; i++) { const v = s.readUInt32LE(i * 4); if (v !== FREE) fatSectors.push(v); }
    dif = s.readUInt32LE(ss - 4);
  }
  if (fatSectors.length < nFat) throw bad('the allocation table is incomplete');
  const fat = new Uint32Array(fatSectors.length * (ss / 4));
  fatSectors.forEach((n, k) => { const s = sectorAt(n); if (s.length < ss) throw bad('a table sector is cut short'); for (let i = 0; i < ss / 4; i++) fat[k * (ss / 4) + i] = s.readUInt32LE(i * 4); });

  /** The sectors of a chain, in order; a loop, a free or special sector inside it, or a chain longer than the file fails. */
  const chain = (start, table, limit) => {
    const out = []; const seen = new Set();
    let n = start;
    while (n !== END) {
      if (n >= table.length || n === FREE || n === FATSECT || n === DIFSECT) throw bad('a chain leaves the table');
      if (seen.has(n)) throw bad('a chain loops');
      seen.add(n); out.push(n);
      if (out.length > limit) throw bad('a chain is longer than the file');
      n = table[n];
    }
    return out;
  };
  const readBig = (start, size) => {
    const list = chain(start, fat, sectors);
    if (size > list.length * ss) throw bad('a stream claims more than its sectors hold');
    const parts = list.map((n) => sectorAt(n));
    if (parts.some((p, i) => p.length < ss && i < parts.length - 1)) throw bad('a sector is cut short');
    return Buffer.concat(parts).subarray(0, size);
  };

  const dirBytes = readBig(dirStart, chain(dirStart, fat, sectors).length * ss);
  const entries = [];
  for (let o = 0; o + 128 <= dirBytes.length && entries.length < 100_000; o += 128) {
    const type = dirBytes[o + 66];
    if (type === 0) continue;
    const nl = dirBytes.readUInt16LE(o + 64);
    if (nl < 2 || nl > 64) continue;
    entries.push({ name: dirBytes.toString('utf16le', o, o + nl - 2), type, start: dirBytes.readUInt32LE(o + 116), size: dirBytes.readUInt32LE(o + 120) });
  }
  const root = entries.find((e) => e.type === 5);

  let mini = null; let miniFat = null;
  const loadMini = () => {
    if (mini) return;
    if (!root) throw bad('no root entry');
    mini = readBig(root.start, root.size);
    const list = nMini ? chain(miniStart, fat, sectors) : [];
    const raw = Buffer.concat(list.map((n) => sectorAt(n)));
    miniFat = new Uint32Array(Math.floor(raw.length / 4));
    for (let i = 0; i < miniFat.length; i++) miniFat[i] = raw.readUInt32LE(i * 4);
  };
  return {
    entries,
    read(entry) {
      if (entry.size > maxStreamBytes) throw new XlsxError('TOO_BIG_UNPACKED', `"${entry.name}" is larger than allowed`);
      if (entry.size < cutoff) {
        loadMini();
        const list = chain(entry.start, miniFat, Math.ceil(mini.length / mss));
        if (entry.size > list.length * mss) throw bad('a small stream claims more than its sectors hold');
        return Buffer.concat(list.map((n) => { if ((n + 1) * mss > mini.length) throw bad('a small sector lies outside'); return mini.subarray(n * mss, (n + 1) * mss); })).subarray(0, entry.size);
      }
      return readBig(entry.start, entry.size);
    },
  };
}
