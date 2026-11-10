import { DEFAULT_LIMITS } from './limits.js';
import { XlsxError } from './errors.js';
import { defaultZip } from './zip-backend.js';
import { assertSafeXml, tokens, attr, decodeExcelEscapes } from './xml.js';
import { createFormatter } from './numfmt.js';

export { DEFAULT_LIMITS };

/** Excel's own limit for the text of one cell. */
const MAX_CELL_CHARS = 32_767;
/** `dates`: 'date' (default) gives JavaScript dates for date-formatted cells, 'serial' keeps the spreadsheet's own day number. */
/** Hidden columns are skipped only where the reader can see them (.xlsx); elsewhere the option is refused, not ignored. */
export function refuseHiddenColumns(skip, what) {
  if (skip) throw new XlsxError('BAD_OPTION', `skipHiddenColumns is available for .xlsx files only, not for ${what}`);
}

export function checkDates(dates) {
  if (dates !== 'date' && dates !== 'serial') throw new RangeError("dates is 'date' or 'serial'");
}

export const capText = (t) => { if (t.length > MAX_CELL_CHARS) throw new XlsxError('CELL_TOO_LONG', 'a cell holds more text than Excel allows'); return t; };

const WANTED = /^(\[Content_Types\]\.xml|_rels\/\.rels|xl\/(?!calcChain)[^/]+\.xml|xl\/_rels\/[^/]+\.rels|xl\/worksheets\/_rels\/[^/]+\.rels|xl\/tables\/[^/]+\.xml|xl\/(?!(?:drawings|charts|theme|diagrams|externalLinks|media|printerSettings|activeX|embeddings|ctrlProps|slicers|pivotTables|pivotCache|persons|threadedComments|richData)\/)[^/]+\/[^/]+\.xml)$/i;

/** Part names as producers write them vary: "Xl\\Workbook.xml", "/xl/workbook.xml"; compare them normalised. */
export const normName = (n) => n.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();

/** A relationship target (relative to the folder of the part that owns it, or absolute) to a package path. */
export function resolveTarget(target, dir) {
  const parts = (target.startsWith('/') ? target.slice(1) : `${dir}${target}`).split('/');
  const out = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); }
  return out.join('/');
}

export const tick = () => new Promise((resolve) => setImmediate(resolve));
export const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

export const isElapsed = (code) => /\[(h+|m+|s+)\]/i.test(code);
export const isDateCode = (code) => {
  if (code.length > 255) return false; // bound what the scan below looks at
  const bare = code.replace(/"[^"]*"|\\.|\[[^\]]*\]|_.|\*./g, '');
  return /[ymdhs]/i.test(bare) && !/^general$/i.test(code);
};

/** Column letters to a 0-based number: A -> 0, AA -> 26. */
function colIndex(ref) {
  const m = /^([A-Z]{1,3})/.exec(ref ?? '');
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** A day number to a Date (UTC). A time alone (0 <= n < 1) gives 1899-12-30 plus the time; Excel's fake 29 Feb 1900 is skipped. */
export function serialToDate(n, date1904) {
  if (!Number.isFinite(n) || n < 0) return null;
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const shift = !date1904 && n >= 1 && n < 61 ? 86_400_000 : 0;
  const d = new Date(base + shift + Math.round(n * 86_400_000));
  return Number.isNaN(d.getTime()) || d.getUTCFullYear() > 9999 ? null : d;
}

/** "A2:B3" to {c1, r1, c2, r2} (0-based columns, 1-based rows) or null. */
function parseRange(ref) {
  const m = /^([A-Z]{1,3})(\d+):([A-Z]{1,3})(\d+)$/.exec(ref ?? '');
  return m ? { c1: colIndex(m[1]), r1: Number(m[2]), c2: colIndex(m[3]), r2: Number(m[4]) } : null;
}

function parseSharedStrings(xml, limits) {
  const out = [];
  let inSi = false; let inT = false; let inPh = false; let cur = '';
  for (const tk of tokens(xml)) {
    if (tk.type === 'open') {
      if (tk.name === 'si') { inSi = true; cur = ''; } else if (tk.name === 'rPh') inPh = true; else if (tk.name === 't' && inSi && !inPh) inT = true;
    } else if (tk.type === 'close') {
      if (tk.name === 'si') { out.push(capText(decodeExcelEscapes(cur))); inSi = false; if (out.length > limits.maxSharedStrings) throw new XlsxError('TOO_MANY_CELLS', 'too many distinct strings'); } else if (tk.name === 'rPh') inPh = false; else if (tk.name === 't') inT = false;
    } else if (tk.type === 'text' && inT) cur += tk.text;
  }
  return out;
}

function parseStyles(xml) {
  const custom = new Map();
  const xfDate = [];
  const xfCode = [];
  let inXfs = false;
  for (const tk of tokens(xml)) {
    if (tk.type === 'open') {
      if (tk.name === 'numFmt') custom.set(Number(tk.attrs.numFmtId), tk.attrs.formatCode ?? '');
      else if (tk.name === 'cellXfs') inXfs = true;
      else if (tk.name === 'xf' && inXfs) {
        const id = Number(tk.attrs.numFmtId ?? 0);
        const code = custom.get(id);
        xfCode.push(code ?? id);
        xfDate.push(id === 46 || (code !== undefined && isElapsed(code)) ? false : BUILTIN_DATE_FORMATS.has(id) || (code !== undefined && isDateCode(code)));
      }
    } else if (tk.type === 'close' && tk.name === 'cellXfs') inXfs = false;
  }
  return { xfDate, xfCode };
}

/** The Excel table in a part: its name, its range (same shape as `merges`), whether it has a header row and a totals row, and its column names. */
function parseTable(xml) {
  let t = null; const columns = [];
  for (const tk of tokens(xml)) {
    if (tk.type !== 'open') continue;
    if (tk.name === 'table' && !t) {
      const r = parseRange(tk.attrs.ref);
      if (!r) return null;
      t = { name: capText(tk.attrs.displayName ?? tk.attrs.name ?? ''), ...r, headerRow: (tk.attrs.headerRowCount ?? '1') !== '0', totalsRow: Number(tk.attrs.totalsRowCount ?? 0) > 0 };
    } else if (tk.name === 'tableColumn' && t && columns.length < 500) columns.push(capText(decodeExcelEscapes(tk.attrs.name ?? '')));
  }
  if (t) t.columns = columns;
  return t;
}

/**
 * Turns the tokens of one sheet into rows, one row at a time: `feed(token)` returns `{ rowNo, values, shown }` when a row
 * ends (only rows that hold something) and null otherwise. `values` is sparse; `merges` fills up as the tokens come.
 * The same machine serves reading a whole sheet and streaming it.
 */
export class RowParser {
  constructor(ctx, counters) {
    this.ctx = ctx; this.counters = counters;
    this.merges = []; this.hiddenCols = [];
    this.rowNo = 0; this.nextCol = 0; this.hiddenRow = false; this.inRow = false;
    this.cell = null; this.text = ''; this.collecting = null;
    this.cur = []; this.curShown = ctx.fmt ? [] : null;
  }

  feed(tk) {
    const { shared, xfDate, xfCode, fmt, date1904, limits, skipHiddenRows } = this.ctx;
    const { counters } = this;
    if (tk.type === 'open') {
      if (tk.name === 'row') {
        this.nextCol = 0;
        this.hiddenRow = skipHiddenRows && (tk.attrs.hidden === '1' || tk.attrs.hidden === 'true');
        this.rowNo = tk.attrs.r ? Number(tk.attrs.r) : this.rowNo + 1;
        if (!Number.isInteger(this.rowNo) || this.rowNo < 1) throw new XlsxError('NOT_A_WORKBOOK', 'a row has no valid number');
        if (this.rowNo > limits.maxRows) throw new XlsxError('TOO_MANY_ROWS', `the sheet has data below row ${limits.maxRows}`);
        this.inRow = true; this.cur = []; this.curShown = fmt ? [] : null;
      } else if (tk.name === 'col') {
        // hidden columns: their cells are left out (the columns keep their places, so letters and merges stay true)
        if (this.ctx.skipHiddenColumns && (tk.attrs.hidden === '1' || tk.attrs.hidden === 'true') && this.hiddenCols.length < 1000) {
          const a = Number(tk.attrs.min); const b = Number(tk.attrs.max);
          if (Number.isInteger(a) && Number.isInteger(b) && a >= 1 && b >= a) this.hiddenCols.push([a - 1, Math.min(b, 16_384) - 1]);
        }
      } else if (tk.name === 'mergeCell') {
        const r = parseRange(tk.attrs.ref);
        if (r && this.merges.length < 10_000) this.merges.push(r);
      } else if (tk.name === 'c') {
        this.cell = { ref: tk.attrs.r ?? null, col: tk.attrs.r ? colIndex(tk.attrs.r) : this.nextCol, t: tk.attrs.t ?? 'n', s: Number(tk.attrs.s ?? 0), v: null, is: '', f: false };
      } else if (this.cell && (tk.name === 'v' || tk.name === 'f')) { this.collecting = tk.name; this.text = ''; if (tk.name === 'f') this.cell.f = true; }
      else if (this.cell && tk.name === 't') { this.collecting = 'is'; this.text = ''; }
      return null;
    }
    if (tk.type === 'text') { if (this.collecting) this.text += tk.text; return null; }
    // close
    const { cell } = this;
    if (tk.name === 'v' && this.collecting === 'v') { cell.v = this.text; this.collecting = null; }
    else if (tk.name === 'f') this.collecting = null;
    else if (tk.name === 't' && this.collecting === 'is') { cell.is += this.text; this.collecting = null; }
    else if (tk.name === 'row') {
      this.inRow = false;
      const filled = this.cur.length > 0 || (this.curShown && this.curShown.length > 0);
      if (!filled) return null;
      const out = { rowNo: this.rowNo, values: this.cur, shown: this.curShown };
      this.cur = []; this.curShown = fmt ? [] : null;
      return out;
    } else if (tk.name === 'c' && cell) {
      const col = cell.col;
      this.nextCol = col + 1;
      if (col >= limits.maxCols) throw new XlsxError('TOO_MANY_COLS', `the sheet has data right of column ${limits.maxCols}`);
      if (col >= 0 && this.inRow && this.rowNo > 0 && !this.hiddenRow && !(this.hiddenCols.length && this.hiddenCols.some(([a, b]) => col >= a && col <= b))) {
        counters.cells += 1;
        if (counters.cells > limits.maxCells) throw new XlsxError('TOO_MANY_CELLS', 'the sheet has too many cells');
        if (cell.f) counters.formulas += 1;
        let value = null; let text = null;
        if (cell.t === 's') value = shared[Number(cell.v)] ?? null;
        else if (cell.t === 'str') value = capText(decodeExcelEscapes(cell.v ?? ''));
        else if (cell.t === 'inlineStr') value = capText(decodeExcelEscapes(cell.is));
        else if (cell.t === 'b') value = cell.v === '1';
        else if (cell.t === 'e') { counters.errors += 1; value = null; }
        else if (cell.t === 'd') { const d = new Date(cell.v); value = Number.isNaN(d.getTime()) ? null : d; }
        else if (cell.v !== null && cell.v !== '') {
          const n = Number(cell.v);
          value = !Number.isFinite(n) ? null : xfDate[cell.s] ? serialToDate(n, date1904) : n;
        }
        if (value === null && cell.t === 'e' && this.curShown) this.curShown[col] = cell.v;
        if (value !== null) {
          this.cur[col] = value;
          if (this.curShown) {
            if (typeof value === 'string') text = value;
            else if (typeof value === 'boolean') text = fmt.bool(value);
            else if (value instanceof Date || typeof value === 'number') {
              const c = xfCode[cell.s];
              text = cell.t === 'd' ? cell.v : fmt.show(Number(cell.v), typeof c === 'string' ? c : fmt.builtin(c ?? 0));
            }
            this.curShown[col] = text;
          }
        }
      }
      this.cell = null;
    }
    return null;
  }
}

async function parseSheet(xml, ctx, counters) {
  const { fmt, signal } = ctx;
  const parser = new RowParser(ctx, counters);
  const rows = [];
  const shown = fmt ? [] : null;
  let n = 0;
  for (const tk of tokens(xml)) {
    if ((++n & 8191) === 0) { signal?.throwIfAborted(); await tick(); }
    const row = parser.feed(tk);
    if (row) {
      const at = row.rowNo - 1;
      if (rows[at]) Object.assign(rows[at], row.values); else rows[at] = row.values; // a row number that comes twice adds to the first
      if (shown) { if (shown[at]) Object.assign(shown[at], row.shown); else shown[at] = row.shown; }
    }
  }
  const out = squareUp(rows);
  return { rows: out, shown: shown ? squareUp(shown, out.length) : null, merges: parser.merges };
}

/** Sparse rows -> dense rows with trailing empties trimmed (rows, when given, is the length to match). */
export function squareUp(rows, len) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] ? Array.from(rows[i], (v) => v ?? null) : [];
    while (r.length && r[r.length - 1] === null) r.pop();
    out.push(r);
  }
  if (len === undefined) while (out.length && out[out.length - 1].length === 0) out.pop();
  else out.length = Math.min(out.length, len);
  while (len !== undefined && out.length < len) out.push([]);
  return out;
}

/** Copies the top-left value of every merged range into the covered cells (bounded by the cell limit). */
export function fillMerged(rows, merges, limits) {
  let budget = limits.maxCells;
  for (const m of merges) {
    if (m.c1 < 0 || m.c2 >= limits.maxCols || m.r2 > limits.maxRows || m.r2 < m.r1 || m.c2 < m.c1) continue;
    const v = rows[m.r1 - 1]?.[m.c1];
    if (v === undefined || v === null) continue;
    for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) {
      if (r === m.r1 && c === m.c1) continue;
      if (--budget < 0) return;
      const row = (rows[r - 1] ??= []);
      while (row.length <= c) row.push(null);
      if (row[c] === null) row[c] = v;
    }
  }
}

function partText(parts, name) {
  const buf = parts.get(parts.index.get(normName(name)));
  if (!buf) return null;
  let text;
  try { text = buf.toString('utf8'); } catch { throw new XlsxError('TOO_BIG_UNPACKED', `"${name}" is too large to read into memory`); }
  assertSafeXml(text, name);
  return text;
}

const SHEET_PART = /^xl\/worksheets\/[^/]+\.xml$/i;

/**
 * Opens the package of a workbook: checks what must be refused (not a workbook, macros, linked workbooks) and reads the
 * parts every sheet needs (sheet list, shared strings, styles). With `streamSheets` the sheet parts under `xl/worksheets/`
 * are left in the archive, for a reader that takes them as a stream.
 */
export async function openPackage(buffer, { limits, zip, macros, externalLinks, display, locale, signal, streamSheets = false }) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('readWorkbook: a Buffer is required');
  if (buffer.length > limits.maxBytes) throw new XlsxError('TOO_BIG', 'the file is larger than allowed');
  if (buffer.length >= 4 && buffer.readUInt32BE(0) === 0xd0cf11e0) throw new XlsxError('LEGACY_OR_ENCRYPTED', 'an old Excel file (.xls) or an encrypted one: save it as .xlsx without a password');
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) throw new XlsxError('NOT_A_WORKBOOK', 'the file is not a workbook');

  const parts = await zip.read(buffer, { wanted: (n) => WANTED.test(normName(n)) && !(streamSheets && SHEET_PART.test(normName(n))), maxEntries: limits.maxEntries, maxEntryBytes: limits.maxEntryBytes, maxPartBytes: limits.maxPartBytes, maxTotalBytes: limits.maxTotalBytes });
  parts.index = new Map([...parts.keys()].map((k) => [normName(k), k]));
  const names = [...parts.keys()].filter((k) => k.startsWith('#names:')).map((k) => normName(k.slice(7)));
  signal?.throwIfAborted();
  let wbPath = 'xl/workbook.xml';
  const pkgRels = partText(parts, '_rels/.rels');
  if (pkgRels) for (const tk of tokens(pkgRels)) if (tk.type === 'open' && tk.name === 'Relationship' && /\/officeDocument$/.test(tk.attrs.Type ?? '')) wbPath = resolveTarget(tk.attrs.Target ?? '', '');
  if (!WANTED.test(normName(wbPath))) throw new XlsxError('NOT_A_WORKBOOK', 'the workbook is in an unexpected place');
  const types = partText(parts, '[Content_Types].xml');
  let mainType = '';
  if (types !== null) for (const tk of tokens(types)) if (tk.type === 'open' && tk.name === 'Override' && tk.attrs.PartName?.toLowerCase() === `/${wbPath.toLowerCase()}`) mainType = tk.attrs.ContentType ?? '';
  if (!/sheet(\.macroEnabled)?\.main\+xml$/i.test(mainType)) throw new XlsxError('NOT_A_WORKBOOK', 'the file is not a workbook');
  // Macros are judged by what the file really holds (the macro project, macro sheets, a macro-enabled main part), not by
  // default content types that templates carry along. With macros: 'ignore' the cells of an .xlsm are read and the
  // macro project is never opened or run.
  if (macros !== 'ignore' && (/macroEnabled/i.test(mainType) || names.some((n) => /vbaProject\.bin$/i.test(n) || /^xl\/macrosheets\//i.test(n)))) throw new XlsxError('MACROS', 'the workbook contains macros');
  const linked = names.some((n) => /^xl\/externalLinks\//i.test(n));
  if (linked && externalLinks !== 'ignore') throw new XlsxError('EXTERNAL_LINKS', 'the workbook links to other files');

  const wbDir = wbPath.slice(0, wbPath.lastIndexOf('/') + 1);
  const wbXml = partText(parts, wbPath);
  const relXml = partText(parts, `${wbDir}_rels/${wbPath.slice(wbDir.length)}.rels`);
  if (!wbXml || !relXml) throw new XlsxError('NOT_A_WORKBOOK', 'the workbook has no sheet list');
  const rels = new Map();
  for (const tk of tokens(relXml)) if (tk.type === 'open' && tk.name === 'Relationship') rels.set(tk.attrs.Id, { target: tk.attrs.Target ?? '', type: tk.attrs.Type ?? '' });
  const list = [];
  let date1904 = false;
  for (const tk of tokens(wbXml)) {
    if (tk.type !== 'open') continue;
    if (tk.name === 'workbookPr') date1904 = tk.attrs.date1904 === '1' || tk.attrs.date1904 === 'true';
    if (tk.name === 'sheet') list.push({ name: tk.attrs.name ?? '', hidden: (tk.attrs.state ?? 'visible') !== 'visible', rid: attr(tk.attrs, 'id') });
  }
  if (list.length === 0) throw new XlsxError('NOT_A_WORKBOOK', 'the workbook has no sheets');
  if (list.length > limits.maxSheets) throw new XlsxError('TOO_MANY_SHEETS', 'the workbook has too many sheets');

  const sstRel = [...rels.values()].find((r) => /\/sharedStrings$/.test(r.type));
  const stRel = [...rels.values()].find((r) => /\/styles$/.test(r.type));
  const sstXml = partText(parts, sstRel ? resolveTarget(sstRel.target, wbDir) : `${wbDir}sharedStrings.xml`);
  const shared = sstXml ? parseSharedStrings(sstXml, limits) : [];
  const stylesXml = partText(parts, stRel ? resolveTarget(stRel.target, wbDir) : `${wbDir}styles.xml`);
  const { xfDate, xfCode } = stylesXml ? parseStyles(stylesXml) : { xfDate: [], xfCode: [] };
  const fmt = display ? createFormatter({ locale, date1904 }) : null;


  /** The Excel tables of the sheet whose part is at `path`. */
  const tablesOf = (path) => {
    const tables = [];
    const relsPath = path.replace(/([^/]+)$/, '_rels/$1.rels');
    const sheetRels = WANTED.test(normName(relsPath)) ? partText(parts, relsPath) : null;
    if (sheetRels) {
      const dir = path.slice(0, path.lastIndexOf('/') + 1);
      for (const tk of tokens(sheetRels)) {
        if (tk.type !== 'open' || tk.name !== 'Relationship' || !/\/table$/.test(tk.attrs.Type ?? '') || tables.length >= 100) continue;
        const tp = resolveTarget(tk.attrs.Target ?? '', dir);
        const txml = WANTED.test(normName(tp)) ? partText(parts, tp) : null;
        const t = txml ? parseTable(txml) : null;
        if (t && t.r2 <= limits.maxRows && t.c2 < limits.maxCols) tables.push(t);
      }
    }
    return tables;
  };
  return { limits, parts, list, rels, wbDir, shared, xfDate, xfCode, fmt, date1904, linked, tablesOf };
}

/**
 * Reads a workbook (.xlsx) into plain values. Strict on purpose: only the cell parts are read; macros, external
 * links, encrypted or old binary (.xls) files are refused; the file, every part and the number of rows, columns and
 * cells are limited; XML with a document type or entities is refused; formulas are never evaluated (the value the
 * file stores is used, and the number of formula cells is reported in `warnings`).
 *
 * @param {Buffer} buffer
 * @param {{limits?: Partial<typeof DEFAULT_LIMITS>, sheets?: string[], zip?: {read: Function}, fillMergedCells?: boolean, macros?: 'refuse'|'ignore', externalLinks?: 'refuse'|'ignore', skipHiddenRows?: boolean, signal?: AbortSignal}} [opts]
 * @returns {Promise<{sheets: Array<{name: string, hidden: boolean, rows: any[][], merges: Array<{c1:number,r1:number,c2:number,r2:number}>, tables: Array<{name:string,c1:number,r1:number,c2:number,r2:number,headerRow:boolean,totalsRow:boolean,columns:string[]}>}>, warnings: Array<{code: string, count: number}>}>}
 */
export async function readWorkbook(buffer, { limits: custom = {}, sheets: only, zip = defaultZip, fillMergedCells = false, macros = 'refuse', externalLinks = 'refuse', skipHiddenRows = false, display = false, locale = 'en', dates = 'date', skipHiddenColumns = false, signal } = {}) {
  checkDates(dates);
  const limits = { ...DEFAULT_LIMITS, ...custom };
  const { parts, list, rels, wbDir, shared, xfDate, xfCode, fmt, date1904, linked, tablesOf } = await openPackage(buffer, { limits, zip, macros, externalLinks, display, locale, signal });

  const counters = { cells: 0, formulas: 0, errors: 0, skipped: 0 };
  const out = [];
  for (const sh of list) {
    if (only && !only.includes(sh.name)) continue;
    const rel = rels.get(sh.rid);
    if (rel && rel.type && !/\/worksheet$/.test(rel.type)) { counters.skipped += 1; continue; } // chart sheets, dialog sheets: no cells
    const path = rel ? resolveTarget(rel.target, wbDir) : null;
    const xml = path && WANTED.test(normName(path)) ? partText(parts, path) : null;
    if (xml === null) throw new XlsxError('NOT_A_WORKBOOK', `the sheet "${sh.name}" has no data part`);
    const tables = tablesOf(path);
    const parsed = await parseSheet(xml, { shared, xfDate: dates === 'serial' ? [] : xfDate, xfCode, fmt, date1904, limits, signal, skipHiddenRows, skipHiddenColumns }, counters);
    if (fillMergedCells) { fillMerged(parsed.rows, parsed.merges, limits); if (parsed.shown) fillMerged(parsed.shown, parsed.merges, limits); }
    out.push({ name: sh.name, hidden: sh.hidden, rows: parsed.rows, ...(parsed.shown ? { shown: parsed.shown } : {}), merges: parsed.merges, tables });
  }
  const warnings = [];
  if (counters.formulas) warnings.push({ code: 'FORMULAS_NOT_EVALUATED', count: counters.formulas });
  if (counters.errors) warnings.push({ code: 'ERROR_CELLS_IGNORED', count: counters.errors });
  if (counters.skipped) warnings.push({ code: 'NON_WORKSHEET_SKIPPED', count: counters.skipped });
  if (linked) warnings.push({ code: 'EXTERNAL_LINKS_IGNORED', count: 1 });
  return { sheets: out, warnings };
}
