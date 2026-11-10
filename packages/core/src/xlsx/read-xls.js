import { XlsxError } from './errors.js';
import { openCfb } from './cfb.js';
import { createFormatter, errorText, showCell } from './numfmt.js';
import { refuseHiddenColumns, checkDates, DEFAULT_LIMITS, capText, tick, fillMerged, squareUp, BUILTIN_DATE_FORMATS, isElapsed, isDateCode, serialToDate } from './read.js';

const bad = (why) => new XlsxError('BAD_BINARY', `the old Excel file is damaged (${why})`);
const MAX_RECORD = 8224; // the format's own limit for one record

/** The records of a BIFF stream, a following CONTINUE joined to the record it continues (as chunks, for strings that span them). */
function* records(buf, from = 0) {
  let p = from; let cur = null;
  while (p < buf.length) {
    if (p + 4 > buf.length) throw bad('a record header is cut short');
    const id = buf.readUInt16LE(p); const len = buf.readUInt16LE(p + 2);
    if (len > MAX_RECORD) throw bad('a record is too long');
    if (p + 4 + len > buf.length) throw bad('a record runs past the end');
    const data = buf.subarray(p + 4, p + 4 + len);
    p += 4 + len;
    if (id === 0x3c && cur) { cur.chunks.push(data); continue; }
    if (cur) yield cur;
    cur = { id, chunks: [data], get data() { return this.chunks[0]; } };
  }
  if (cur) yield cur;
}

/** Reads strings that may continue into the next chunk; a continuation starts with a fresh "is it UTF-16" byte. */
class Chunks {
  constructor(chunks) { this.c = chunks; this.i = 0; this.p = 0; }
  more() { while (this.i < this.c.length && this.p >= this.c[this.i].length) { this.i += 1; this.p = 0; } return this.i < this.c.length; }
  byte() { if (!this.more()) throw bad('a string is cut short'); return this.c[this.i][this.p++]; }
  u16() { return this.byte() | (this.byte() << 8); }
  u32() { return (this.u16() | (this.u16() << 16)) >>> 0; }
  skip(n) { while (n > 0) { if (!this.more()) throw bad('a string is cut short'); const k = Math.min(n, this.c[this.i].length - this.p); this.p += k; n -= k; } }
  /** XLUnicodeString body after its length: flags, optional run/extension sizes, characters, then the extras are skipped. */
  chars(cch, flags) {
    if (cch > 32_767) throw new XlsxError('CELL_TOO_LONG', 'a cell holds more text than Excel allows');
    let wide = (flags & 1) !== 0;
    const runs = flags & 8 ? this.u16() : 0; const ext = flags & 4 ? this.u32() : 0;
    let out = '';
    let left = cch;
    while (left > 0) {
      if (this.p >= this.c[this.i].length) { if (!this.more()) throw bad('a string is cut short'); wide = (this.byte() & 1) !== 0; if (!this.more() && left > 0) throw bad('a string is cut short'); }
      const room = this.c[this.i].length - this.p;
      const n = Math.min(left, wide ? Math.floor(room / 2) : room);
      if (n === 0) { if (wide && room === 1) throw bad('a string splits a character'); continue; }
      const seg = this.c[this.i].subarray(this.p, this.p + n * (wide ? 2 : 1));
      out += wide ? seg.toString('utf16le') : seg.toString('latin1');
      this.p += seg.length; left -= n;
    }
    this.skip(runs * 4); this.skip(ext);
    return out;
  }
  /** XLUnicodeString: 16-bit length. */
  str16() { const cch = this.u16(); return this.chars(cch, this.byte()); }
  /** ShortXLUnicodeString: 8-bit length. */
  str8() { const cch = this.byte(); return this.chars(cch, this.byte()); }
}

function rk(v) {
  let x;
  if (v & 2) x = v >> 2; else { const b = Buffer.alloc(8); b.writeUInt32LE((v & 0xfffffffc) >>> 0, 4); x = b.readDoubleLE(0); }
  return v & 1 ? x / 100 : x;
}

/**
 * Reads an old Excel workbook (.xls, BIFF8) into the same shape `readWorkbook` returns, under the same rules.
 * The container (OLE2) and every record are bounds-checked; encrypted files (FILEPASS) and files with macros (a macro
 * project or a macro sheet) are refused; linked workbooks are refused unless `externalLinks: 'ignore'`; formulas are
 * not evaluated (the stored result is read and counted in `warnings`). Older BIFF versions (Excel 5 and before) are not read.
 */
export async function readXls(buffer, { limits: custom = {}, sheets: only, fillMergedCells = false, macros = 'refuse', externalLinks = 'refuse', skipHiddenRows = false, display = false, locale = 'en', dates = 'date', skipHiddenColumns = false, signal } = {}) {
  refuseHiddenColumns(skipHiddenColumns, '.xls files');
  checkDates(dates);
  const limits = { ...DEFAULT_LIMITS, ...custom };
  if (!Buffer.isBuffer(buffer)) throw new TypeError('readXls: a Buffer is required');
  if (buffer.length > limits.maxBytes) throw new XlsxError('TOO_BIG', 'the file is larger than allowed');
  const cfb = openCfb(buffer, { maxStreamBytes: limits.maxEntryBytes });
  const names = cfb.entries.map((e) => e.name);
  if (names.some((n) => /^(EncryptedPackage|EncryptionInfo|\u0006DataSpaces)$/i.test(n))) throw new XlsxError('ENCRYPTED', 'the workbook is encrypted');
  const stream = cfb.entries.find((e) => e.type === 2 && /^(Workbook|Book)$/i.test(e.name));
  if (!stream) throw new XlsxError('NOT_A_WORKBOOK', 'the file is not a workbook');
  if (macros !== 'ignore' && cfb.entries.some((e) => /^(_VBA_PROJECT_CUR|VBA|Macros|_VBA_PROJECT)$/i.test(e.name))) throw new XlsxError('MACROS', 'the workbook contains macros');
  const wb = cfb.read(stream);
  signal?.throwIfAborted();

  const shared = []; const formats = new Map(); const xfFormat = []; const list = [];
  let date1904 = false; let linked = false; let first = true; let depth = 0;
  for (const r of records(wb)) {
    const d = r.data;
    if (first) { if (r.id !== 0x809 || d.length < 4) throw new XlsxError('NOT_A_WORKBOOK', 'the file is not a workbook'); if (d.readUInt16LE(0) !== 0x600) throw new XlsxError('UNSUPPORTED_FORMAT', 'only Excel 97 and newer (BIFF8) files are read'); first = false; }
    if (r.id === 0x809) { depth += 1; if (depth > 1) break; continue; }
    if (r.id === 0x0a) break; // end of the workbook globals
    if (r.id === 0x2f) throw new XlsxError('ENCRYPTED', 'the workbook is encrypted');
    if (r.id === 0x22 && d.length >= 2) date1904 = d.readUInt16LE(0) === 1;
    else if (r.id === 0x1ae && d.length >= 4) { const k = d.readUInt16LE(2); if (k !== 0x0401 && k !== 0x3a01) linked = true; }
    else if (r.id === 0x41e && d.length >= 5) { const c = new Chunks(r.chunks); const id = c.u16(); formats.set(id, c.str16()); }
    else if (r.id === 0xe0 && d.length >= 4) {
      xfFormat.push(d.readUInt16LE(2));
    } else if (r.id === 0x85 && d.length >= 8) {
      const c = new Chunks([d.subarray(6)]);
      list.push({ pos: d.readUInt32LE(0), hidden: d[4] !== 0, kind: d[5], name: c.str8() });
    } else if (r.id === 0xfc && d.length >= 8) {
      const c = new Chunks(r.chunks); c.skip(4); const unique = c.u32();
      if (unique > limits.maxSharedStrings) throw new XlsxError('TOO_MANY_CELLS', 'too many distinct strings');
      for (let i = 0; i < unique && c.more(); i++) shared.push(c.str16());
    }
  }
  if (first) throw new XlsxError('NOT_A_WORKBOOK', 'the file is not a workbook');
  const xfDate = dates === 'serial' ? [] : xfFormat.map((id) => { const code = formats.get(id); return id === 46 || (code !== undefined && isElapsed(code)) ? false : BUILTIN_DATE_FORMATS.has(id) || (code !== undefined && isDateCode(code)); });
  const xfCode = xfFormat.map((id) => formats.get(id) ?? id);
  const fmt = display ? createFormatter({ locale, date1904 }) : null;
  if (linked && externalLinks !== 'ignore') throw new XlsxError('EXTERNAL_LINKS', 'the workbook links to other files');
  if (list.length === 0) throw new XlsxError('NOT_A_WORKBOOK', 'the workbook has no sheets');
  if (list.length > limits.maxSheets) throw new XlsxError('TOO_MANY_SHEETS', 'the workbook has too many sheets');
  if (macros !== 'ignore' && list.some((s) => s.kind === 1)) throw new XlsxError('MACROS', 'the workbook contains macros');

  const counters = { cells: 0, formulas: 0, errors: 0, skipped: 0 };
  const out = [];
  let n = 0;
  for (const sh of list) {
    if (only && !only.includes(sh.name)) continue;
    if (sh.kind !== 0) { counters.skipped += 1; continue; } // chart sheets, macro sheets, modules: no cells
    if (sh.pos + 4 > wb.length || wb.readUInt16LE(sh.pos) !== 0x809) throw bad(`the sheet "${sh.name}" starts nowhere`);
    const rows = []; const shown = fmt ? [] : null; const merges = []; const hiddenRows = new Set();
    let pending = null; let level = 0;
    const putErr = (r, c, code) => { if (shown && c < limits.maxCols && r < limits.maxRows) (shown[r] ??= [])[c] = errorText(code); };
    const put = (r, c, value, raw, ixfe) => {
      if (value === null || value === undefined) return;
      if (c >= limits.maxCols) throw new XlsxError('TOO_MANY_COLS', `the sheet has data right of column ${limits.maxCols}`);
      if (r >= limits.maxRows) throw new XlsxError('TOO_MANY_ROWS', `the sheet has data below row ${limits.maxRows}`);
      if (skipHiddenRows && hiddenRows.has(r)) return;
      counters.cells += 1;
      if (counters.cells > limits.maxCells) throw new XlsxError('TOO_MANY_CELLS', 'the sheet has too many cells');
      (rows[r] ??= [])[c] = value;
      if (shown) (shown[r] ??= [])[c] = typeof value === 'string' || typeof value === 'boolean' ? showCell(fmt, value) : showCell(fmt, raw, xfCode[ixfe]);
    };
    const num = (x, ixfe) => (Number.isFinite(x) ? (xfDate[ixfe] ? serialToDate(x, date1904) : x) : null);
    const putNum = (r, c, x, ixfe) => put(r, c, num(x, ixfe), x, ixfe);
    for (const r of records(wb, sh.pos)) {
      if ((++n & 8191) === 0) { signal?.throwIfAborted(); await tick(); }
      const d = r.data;
      if (r.id === 0x809) { level += 1; continue; }
      if (r.id === 0x0a) { level -= 1; if (level <= 0) break; continue; }
      if (level !== 1) continue; // inside an embedded chart or the like
      const need = (k) => { if (d.length < k) throw bad('a cell record is cut short'); };
      switch (r.id) {
        case 0x208: need(14); if (d.readUInt16LE(12) & 0x20) hiddenRows.add(d.readUInt16LE(0)); break;
        case 0xfd: need(10); put(d.readUInt16LE(0), d.readUInt16LE(2), shared[d.readUInt32LE(6)] ?? null); break;
        case 0x204: { need(8); const c = new Chunks(r.chunks); c.skip(6); put(d.readUInt16LE(0), d.readUInt16LE(2), capText(c.str16())); break; }
        case 0x203: need(14); putNum(d.readUInt16LE(0), d.readUInt16LE(2), d.readDoubleLE(6), d.readUInt16LE(4)); break;
        case 0x27e: need(10); putNum(d.readUInt16LE(0), d.readUInt16LE(2), rk(d.readUInt32LE(6)), d.readUInt16LE(4)); break;
        case 0xbd: {
          need(6); const row = d.readUInt16LE(0); const c0 = d.readUInt16LE(2); const cnt = Math.floor((d.length - 6) / 6);
          for (let i = 0; i < cnt; i++) putNum(row, c0 + i, rk(d.readUInt32LE(4 + i * 6 + 2)), d.readUInt16LE(4 + i * 6));
          break;
        }
        case 0x205: need(8); if (d[7] === 1) { counters.errors += 1; putErr(d.readUInt16LE(0), d.readUInt16LE(2), d[6]); } else put(d.readUInt16LE(0), d.readUInt16LE(2), d[6] === 1); break;
        case 0x06: {
          need(14); counters.formulas += 1;
          const row = d.readUInt16LE(0); const col = d.readUInt16LE(2); const ixfe = d.readUInt16LE(4);
          if (d.readUInt16LE(12) === 0xffff) { // not a number: the result is text (next record), a boolean, an error or empty
            const t = d[6];
            if (t === 0) pending = { row, col };
            else if (t === 1) put(row, col, d[8] === 1);
            else if (t === 2) { counters.errors += 1; putErr(row, col, d[8]); }
          } else putNum(row, col, d.readDoubleLE(6), ixfe);
          break;
        }
        case 0x207: if (pending) { const c = new Chunks(r.chunks); put(pending.row, pending.col, capText(c.str16())); pending = null; } break;
        case 0xe5: {
          need(2); const cnt = Math.min(d.readUInt16LE(0), Math.floor((d.length - 2) / 8));
          for (let i = 0; i < cnt && merges.length < 10_000; i++) { const o = 2 + i * 8; merges.push({ c1: d.readUInt16LE(o + 4), r1: d.readUInt16LE(o) + 1, c2: d.readUInt16LE(o + 6), r2: d.readUInt16LE(o + 2) + 1 }); }
          break;
        }
        default: break;
      }
    }
    const trimmed = squareUp(rows);
    const shownRows = shown ? squareUp(shown, trimmed.length) : null;
    if (fillMergedCells) { fillMerged(trimmed, merges, limits); if (shownRows) fillMerged(shownRows, merges, limits); }
    out.push({ name: sh.name, hidden: sh.hidden, rows: trimmed, ...(shownRows ? { shown: shownRows } : {}), merges });
  }
  const warnings = [];
  if (counters.formulas) warnings.push({ code: 'FORMULAS_NOT_EVALUATED', count: counters.formulas });
  if (counters.errors) warnings.push({ code: 'ERROR_CELLS_IGNORED', count: counters.errors });
  if (counters.skipped) warnings.push({ code: 'NON_WORKSHEET_SKIPPED', count: counters.skipped });
  if (linked) warnings.push({ code: 'EXTERNAL_LINKS_IGNORED', count: 1 });
  return { sheets: out, warnings };
}
