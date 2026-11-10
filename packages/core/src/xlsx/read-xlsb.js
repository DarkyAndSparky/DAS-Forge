import { XlsxError } from './errors.js';
import { defaultZip } from './zip-backend.js';
import { assertSafeXml, tokens } from './xml.js';
import { createFormatter, errorText, showCell } from './numfmt.js';
import { refuseHiddenColumns, checkDates, DEFAULT_LIMITS, capText, tick, fillMerged, squareUp, normName, resolveTarget, BUILTIN_DATE_FORMATS, isElapsed, isDateCode, serialToDate } from './read.js';

/** Only the parts that hold cells, and never the macro project or printer data. */
const WANTED = /^(\[Content_Types\]\.xml|_rels\/\.rels|xl\/_rels\/[^/]+\.rels|xl\/(?!vbaProject|calcChain|metadata)[^/]+\.bin|xl\/(?!(?:drawings|charts|theme|diagrams|externalLinks|media|printerSettings|tables|activeX|embeddings|ctrlProps|slicers|pivotTables|pivotCache|persons|threadedComments|richData)\/)[^/]+\/(?!binaryIndex)[^/]+\.bin)$/i;

const bad = (why) => new XlsxError('BAD_BINARY', `the binary workbook is damaged (${why})`);

/**
 * The records of a .xlsb part: an id of one or two bytes, a size of one to four bytes (7 bits each), then the data.
 * A record that runs past the end of the part is a damaged file, not something to guess at.
 */
function* records(buf) {
  let p = 0;
  const n = buf.length;
  while (p < n) {
    let id = buf[p++];
    if (id & 0x80) { if (p >= n) throw bad('record id cut short'); id = (id & 0x7f) | ((buf[p++] & 0x7f) << 7); }
    let size = 0;
    for (let i = 0; i < 4; i++) {
      if (p >= n) throw bad('record size cut short');
      const b = buf[p++];
      size += (b & 0x7f) * 2 ** (7 * i);
      if (!(b & 0x80)) break;
    }
    if (p + size > n) throw bad('record runs past the end');
    yield { id, start: p, end: p + size };
    p += size;
  }
}

/** XLWideString: a 4-byte length in characters, then UTF-16LE. `nullable` accepts the 0xFFFFFFFF "no string" marker. */
function wide(buf, pos, end, nullable = false) {
  if (pos + 4 > end) throw bad('string cut short');
  const cch = buf.readUInt32LE(pos);
  if (nullable && cch === 0xffffffff) return { text: '', next: pos + 4 };
  if (cch > 32_767) throw new XlsxError('CELL_TOO_LONG', 'a cell holds more text than Excel allows');
  if (pos + 4 + cch * 2 > end) throw bad('string runs past the end of its record');
  return { text: buf.toString('utf16le', pos + 4, pos + 4 + cch * 2), next: pos + 4 + cch * 2 };
}

function rk(v) {
  const int = (v & 2) !== 0;
  let x;
  if (int) x = v >> 2; else { const b = Buffer.alloc(8); b.writeUInt32LE((v & 0xfffffffc) >>> 0, 4); x = b.readDoubleLE(0); }
  return v & 1 ? x / 100 : x;
}

function parseStyles(buf) {
  const custom = new Map();
  const xfDate = [];
  const xfCode = [];
  let inXfs = false;
  for (const r of records(buf)) {
    if (r.id === 44 && r.end - r.start >= 6) custom.set(buf.readUInt16LE(r.start), wide(buf, r.start + 2, r.end).text);
    else if (r.id === 617) inXfs = true;
    else if (r.id === 618) inXfs = false;
    else if (r.id === 47 && inXfs && r.end - r.start >= 4) {
      const id = buf.readUInt16LE(r.start + 2);
      const code = custom.get(id);
      xfCode.push(code ?? id);
      xfDate.push(id === 46 || (code !== undefined && isElapsed(code)) ? false : BUILTIN_DATE_FORMATS.has(id) || (code !== undefined && isDateCode(code)));
    }
  }
  return { xfDate, xfCode };
}

function parseSharedStrings(buf, limits) {
  const out = [];
  for (const r of records(buf)) {
    if (r.id !== 19) continue;
    if (r.end - r.start < 5) throw bad('shared string cut short');
    out.push(wide(buf, r.start + 1, r.end).text);
    if (out.length > limits.maxSharedStrings) throw new XlsxError('TOO_MANY_CELLS', 'too many distinct strings');
  }
  return out;
}

async function parseSheet(buf, ctx, counters) {
  const { shared, xfDate, xfCode, fmt, date1904, limits, signal, skipHiddenRows } = ctx;
  const rows = []; const merges = []; const shown = fmt ? [] : null;
  let row = -1; let hidden = false; let n = 0;
  for (const r of records(buf)) {
    if ((++n & 8191) === 0) { signal?.throwIfAborted(); await tick(); }
    const len = r.end - r.start;
    if (r.id === 0) { // row header
      if (len < 12) throw bad('row header cut short');
      row = buf.readUInt32LE(r.start);
      hidden = skipHiddenRows && (buf[r.start + 11] & 0x10) !== 0;
      if (row >= limits.maxRows) throw new XlsxError('TOO_MANY_ROWS', `the sheet has data below row ${limits.maxRows}`);
    } else if (r.id === 176) { // merged range
      if (len >= 16 && merges.length < 10_000) merges.push({ c1: buf.readUInt32LE(r.start + 8), r1: buf.readUInt32LE(r.start) + 1, c2: buf.readUInt32LE(r.start + 12), r2: buf.readUInt32LE(r.start + 4) + 1 });
    } else if (r.id >= 1 && r.id <= 11) {
      if (len < 8) throw bad('cell cut short');
      const col = buf.readUInt32LE(r.start);
      if (col >= limits.maxCols) throw new XlsxError('TOO_MANY_COLS', `the sheet has data right of column ${limits.maxCols}`);
      if (row < 0 || hidden || r.id === 1) continue;
      const style = buf.readUIntLE(r.start + 4, 3);
      const at = r.start + 8;
      let value = null; let raw = null;
      const need = (k) => { if (at + k > r.end) throw bad('cell value cut short'); };
      switch (r.id) {
        case 2: need(4); { const x = rk(buf.readUInt32LE(at)); raw = x; value = xfDate[style] ? serialToDate(x, date1904) : x; } break;
        case 3: case 11: counters.errors += 1; if (shown && at < r.end) (shown[row] ??= [])[col] = errorText(buf[at]); if (r.id === 11) counters.formulas += 1; break;
        case 4: case 10: need(1); value = buf[at] === 1; if (r.id === 10) counters.formulas += 1; break;
        case 5: case 9: { need(8); const x = buf.readDoubleLE(at); if (Number.isFinite(x)) raw = x; if (Number.isFinite(x)) value = xfDate[style] ? serialToDate(x, date1904) : x; if (r.id === 9) counters.formulas += 1; break; }
        case 6: case 8: value = capText(wide(buf, at, r.end).text); if (r.id === 8) counters.formulas += 1; break;
        case 7: need(4); value = shared[buf.readUInt32LE(at)] ?? null; break;
        default: break;
      }
      if (value !== null) {
        counters.cells += 1;
        if (counters.cells > limits.maxCells) throw new XlsxError('TOO_MANY_CELLS', 'the sheet has too many cells');
        (rows[row] ??= [])[col] = value;
        if (shown) (shown[row] ??= [])[col] = typeof value === 'string' || typeof value === 'boolean' ? showCell(fmt, value) : showCell(fmt, raw, xfCode[style]);
      }
    }
  }
  const out = squareUp(rows);
  return { rows: out, shown: shown ? squareUp(shown, out.length) : null, merges };
}

/**
 * Reads a binary workbook (.xlsb) into the same shape `readWorkbook` returns, under the same rules: only the cell
 * parts are unpacked; macros, linked workbooks and encrypted files are refused; every record is bounds-checked; sizes
 * and counts are limited; formulas are never evaluated (the stored result is used and counted in `warnings`).
 */
export async function readXlsb(buffer, { limits: custom = {}, sheets: only, zip = defaultZip, fillMergedCells = false, macros = 'refuse', externalLinks = 'refuse', skipHiddenRows = false, display = false, locale = 'en', dates = 'date', skipHiddenColumns = false, signal } = {}) {
  refuseHiddenColumns(skipHiddenColumns, '.xlsb files');
  checkDates(dates);
  const limits = { ...DEFAULT_LIMITS, ...custom };
  if (!Buffer.isBuffer(buffer)) throw new TypeError('readXlsb: a Buffer is required');
  if (buffer.length > limits.maxBytes) throw new XlsxError('TOO_BIG', 'the file is larger than allowed');
  if (buffer.length >= 4 && buffer.readUInt32BE(0) === 0xd0cf11e0) throw new XlsxError('LEGACY_OR_ENCRYPTED', 'an old Excel file or an encrypted one: save it as .xlsx without a password');
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) throw new XlsxError('NOT_A_WORKBOOK', 'the file is not a workbook');
  const parts = await zip.read(buffer, { wanted: (n) => WANTED.test(normName(n)), maxEntries: limits.maxEntries, maxEntryBytes: limits.maxEntryBytes, maxTotalBytes: limits.maxTotalBytes });
  const index = new Map([...parts.keys()].map((k) => [normName(k), k]));
  const names = [...parts.keys()].filter((k) => k.startsWith('#names:')).map((k) => normName(k.slice(7)));
  const get = (name) => parts.get(index.get(normName(name))) ?? null;
  const text = (name) => { const b = get(name); if (!b) return null; const t = b.toString('utf8'); assertSafeXml(t, name); return t; };
  signal?.throwIfAborted();

  let wbPath = 'xl/workbook.bin';
  const pkgRels = text('_rels/.rels');
  if (pkgRels) for (const tk of tokens(pkgRels)) if (tk.type === 'open' && tk.name === 'Relationship' && /\/officeDocument$/.test(tk.attrs.Type ?? '')) wbPath = resolveTarget(tk.attrs.Target ?? '', '');
  if (!WANTED.test(normName(wbPath)) || !/\.bin$/i.test(wbPath)) throw new XlsxError('NOT_A_WORKBOOK', 'the workbook is in an unexpected place');
  if (macros !== 'ignore' && names.some((n) => /vbaProject\.bin$/i.test(n) || /^xl\/macrosheets\//i.test(n))) throw new XlsxError('MACROS', 'the workbook contains macros');
  const linked = names.some((n) => /^xl\/externalLinks\//i.test(n));
  if (linked && externalLinks !== 'ignore') throw new XlsxError('EXTERNAL_LINKS', 'the workbook links to other files');

  const wbDir = wbPath.slice(0, wbPath.lastIndexOf('/') + 1);
  const wb = get(wbPath);
  const relXml = text(`${wbDir}_rels/${wbPath.slice(wbDir.length)}.rels`);
  if (!wb || !relXml) throw new XlsxError('NOT_A_WORKBOOK', 'the workbook has no sheet list');
  const rels = new Map();
  for (const tk of tokens(relXml)) if (tk.type === 'open' && tk.name === 'Relationship') rels.set(tk.attrs.Id, { target: tk.attrs.Target ?? '', type: tk.attrs.Type ?? '' });
  const list = []; let date1904 = false;
  for (const r of records(wb)) {
    if (r.id === 153 && r.end - r.start >= 4) date1904 = (wb.readUInt32LE(r.start) & 1) !== 0;
    else if (r.id === 156) {
      if (r.end - r.start < 8) throw bad('sheet entry cut short');
      const rid = wide(wb, r.start + 8, r.end, true);
      list.push({ hidden: wb.readUInt32LE(r.start) !== 0, rid: rid.text, name: wide(wb, rid.next, r.end).text });
    }
  }
  if (list.length === 0) throw new XlsxError('NOT_A_WORKBOOK', 'the workbook has no sheets');
  if (list.length > limits.maxSheets) throw new XlsxError('TOO_MANY_SHEETS', 'the workbook has too many sheets');

  const sstRel = [...rels.values()].find((r) => /\/sharedStrings$/.test(r.type));
  const stRel = [...rels.values()].find((r) => /\/styles$/.test(r.type));
  const sstBuf = get(sstRel ? resolveTarget(sstRel.target, wbDir) : `${wbDir}sharedStrings.bin`);
  const shared = sstBuf ? parseSharedStrings(sstBuf, limits) : [];
  const stBuf = get(stRel ? resolveTarget(stRel.target, wbDir) : `${wbDir}styles.bin`);
  const { xfDate, xfCode } = stBuf ? parseStyles(stBuf) : { xfDate: [], xfCode: [] };
  const fmt = display ? createFormatter({ locale, date1904 }) : null;

  const counters = { cells: 0, formulas: 0, errors: 0, skipped: 0 };
  const out = [];
  for (const sh of list) {
    if (only && !only.includes(sh.name)) continue;
    const rel = rels.get(sh.rid);
    if (rel && rel.type && !/\/worksheet$/.test(rel.type)) { counters.skipped += 1; continue; }
    const path = rel ? resolveTarget(rel.target, wbDir) : null;
    const buf = path && WANTED.test(normName(path)) ? get(path) : null;
    if (buf === null) throw new XlsxError('NOT_A_WORKBOOK', `the sheet "${sh.name}" has no data part`);
    const parsed = await parseSheet(buf, { shared, xfDate: dates === 'serial' ? [] : xfDate, xfCode, fmt, date1904, limits, signal, skipHiddenRows }, counters);
    if (fillMergedCells) { fillMerged(parsed.rows, parsed.merges, limits); if (parsed.shown) fillMerged(parsed.shown, parsed.merges, limits); }
    out.push({ name: sh.name, hidden: sh.hidden, rows: parsed.rows, ...(parsed.shown ? { shown: parsed.shown } : {}), merges: parsed.merges });
  }
  const warnings = [];
  if (counters.formulas) warnings.push({ code: 'FORMULAS_NOT_EVALUATED', count: counters.formulas });
  if (counters.errors) warnings.push({ code: 'ERROR_CELLS_IGNORED', count: counters.errors });
  if (counters.skipped) warnings.push({ code: 'NON_WORKSHEET_SKIPPED', count: counters.skipped });
  if (linked) warnings.push({ code: 'EXTERNAL_LINKS_IGNORED', count: 1 });
  return { sheets: out, warnings };
}
