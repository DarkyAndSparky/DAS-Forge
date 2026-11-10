import { XlsxError } from './errors.js';
import { defaultZip } from './zip-backend.js';
import { assertSafeXml, tokens, attr } from './xml.js';
import { refuseHiddenColumns, checkDates, DEFAULT_LIMITS, capText, tick, fillMerged, squareUp } from './read.js';

const ODS_MIME = /^application\/vnd\.oasis\.opendocument\.spreadsheet(-template)?$/;
const WANTED = /^(mimetype|content\.xml|META-INF\/manifest\.xml)$/;
const MAX_CELL_CHARS = 32_767;

/** Names (lowercased, forward slashes) the ODS reader looks at; everything else in the archive is never unpacked. */
const normName = (n) => n.replace(/\\/g, '/').replace(/^\/+/, '');

/** Elements whose text is not cell text: notes, drawings, nested tables. Skipped as a whole. */
const SKIP = new Set(['annotation', 'frame', 'shapes', 'forms', 'custom-shape', 'rect', 'ellipse', 'line', 'polygon', 'polyline', 'path', 'control', 'g']);

/** A repeat count: a positive whole number, or the file is not what it claims to be. */
function repeat(v) {
  if (v === undefined) return 1;
  if (!/^\d{1,10}$/.test(v) || Number(v) < 1 || Number(v) > 2_147_483_647) throw new XlsxError('NOT_A_WORKBOOK', 'a repeat count is not a valid number');
  return Number(v);
}

function parseDate(v) {
  const m = /^(\d{4,6})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?)?(?:Z|[+-]\d{2}:\d{2})?$/.exec(v ?? '');
  if (!m) return null;
  const [y, mo, d, h = 0, mi = 0, se = 0] = [m[1], m[2], m[3], m[4], m[5], m[6]].map((x) => (x === undefined ? 0 : Number(x)));
  if (y < 1 || y > 9999 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 24 || mi > 59 || se > 60) return null;
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  date.setUTCHours(h, mi, se, m[7] ? Math.round(Number(`0.${m[7]}`) * 1000) : 0);
  if (Number.isNaN(date.getTime()) || date.getUTCMonth() !== mo - 1 && h < 24) return null; // "31 February"
  return date;
}

/** A duration (PT1H30M) is a time of day below 24 hours (1899-12-30 plus the time, as in .xlsx), else a number of days. */
function parseTime(v) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(v ?? '');
  if (!m || v === 'P' || v.endsWith('T')) return null;
  const ms = (Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0)) * 1000;
  if (!Number.isFinite(ms)) return null;
  return ms < 86_400_000 ? new Date(Date.UTC(1899, 11, 30) + Math.round(ms)) : ms / 86_400_000;
}

/**
 * Reads the cells of an OpenDocument spreadsheet (.ods) into the same shape `readWorkbook` returns. Held to the same
 * rules: only content.xml (and the manifest, to see encryption) is unpacked; encrypted files, macros (Basic and
 * Scripts), linked tables, document types and entities are refused; formulas are never evaluated (the stored value is
 * read and counted in `warnings`); every size and count is limited. Repeats ("1,048,576 empty rows" is how every .ods
 * ends) are never expanded unless the rows hold data, and then only inside the limits.
 *
 * The `office:` / `table:` / `calcext:` prefixes are taken as written (every producer uses them).
 */
export async function readOds(buffer, { limits: custom = {}, sheets: only, zip = defaultZip, fillMergedCells = false, macros = 'refuse', externalLinks = 'refuse', skipHiddenRows = false, display = false, dates = 'date', skipHiddenColumns = false, signal } = {}) {
  refuseHiddenColumns(skipHiddenColumns, '.ods files');
  checkDates(dates);
  if (dates === 'serial') throw new XlsxError('BAD_OPTION', "dates: 'serial' is not available for .ods files (they store dates as text)");
  const limits = { ...DEFAULT_LIMITS, ...custom };
  if (!Buffer.isBuffer(buffer)) throw new TypeError('readOds: a Buffer is required');
  if (buffer.length > limits.maxBytes) throw new XlsxError('TOO_BIG', 'the file is larger than allowed');
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) throw new XlsxError('NOT_A_WORKBOOK', 'the file is not a workbook');
  const parts = await zip.read(buffer, { wanted: (n) => WANTED.test(normName(n)), maxEntries: limits.maxEntries, maxEntryBytes: limits.maxEntryBytes, maxTotalBytes: limits.maxTotalBytes });
  const get = (name) => { const b = parts.get(name) ?? [...parts].find(([k]) => !k.startsWith('#') && normName(k) === name)?.[1]; return b ?? null; };
  const names = [...parts.keys()].filter((k) => k.startsWith('#names:')).map((k) => normName(k.slice(7)));
  const mime = get('mimetype');
  if (!mime || !ODS_MIME.test(mime.toString('latin1').trim())) throw new XlsxError('NOT_A_WORKBOOK', 'the file is not an OpenDocument spreadsheet');
  const manifest = get('META-INF/manifest.xml');
  if (manifest) {
    const mt = manifest.toString('utf8');
    assertSafeXml(mt, 'manifest.xml');
    if (/encryption-data/.test(mt)) throw new XlsxError('ENCRYPTED', 'the workbook is encrypted');
  }
  if (macros !== 'ignore' && names.some((n) => /^(basic|scripts)\//i.test(n))) throw new XlsxError('MACROS', 'the workbook contains macros');
  const raw = get('content.xml');
  if (!raw) throw new XlsxError('NOT_A_WORKBOOK', 'the workbook has no content');
  const xml = raw.toString('utf8');
  assertSafeXml(xml, 'content.xml');
  signal?.throwIfAborted();

  const counters = { cells: 0, formulas: 0, errors: 0, skipped: 0 };
  const hiddenStyles = new Set();
  const out = [];
  let curStyle = null; let tableStyles = false;
  let skip = 0;
  let linked = false;
  let sheet = null; // { name, hidden, rows, merges, rowNo, wanted }
  let row = null; // { cells: [], rep, hidden, col }
  let cell = null;
  let n = 0;
  const finishRow = () => {
    const { cells, rep, hidden, shown } = row;
    row = null;
    const filled = cells.some((v) => v !== undefined && v !== null) || (display && shown.length > 0);
    if (!filled || hidden || !sheet.wanted) { sheet.rowNo += rep; return; }
    if (sheet.rowNo + rep > limits.maxRows) throw new XlsxError('TOO_MANY_ROWS', `the sheet has data below row ${limits.maxRows}`);
    counters.cells += cells.filter((v) => v !== undefined && v !== null).length * rep;
    if (counters.cells > limits.maxCells) throw new XlsxError('TOO_MANY_CELLS', 'the sheet has too many cells');
    for (let i = 0; i < rep; i++) { sheet.rows[sheet.rowNo + i] = i === 0 ? cells : cells.slice(); if (display) sheet.shown[sheet.rowNo + i] = i === 0 ? shown : shown.slice(); }
    sheet.rowNo += rep;
  };
  const cellValue = (cell) => {
    const a = cell.attrs;
    const type = a['office:value-type'] ?? attr(a, 'value-type');
    if (type === 'error' || a['calcext:value-type'] === 'error') { counters.errors += 1; return null; }
    const text = cell.text;
    switch (type) {
      case 'float': case 'percentage': case 'currency': { const v = a['office:value']; if (v === undefined || v === '') return null; const x = Number(v); return Number.isFinite(x) ? x : null; }
      case 'date': return parseDate(a['office:date-value']);
      case 'time': return parseTime(a['office:time-value']);
      case 'boolean': return a['office:boolean-value'] === 'true' ? true : a['office:boolean-value'] === 'false' ? false : null;
      case 'string': { const s = a['office:string-value'] ?? text; return s === '' ? null : capText(s); }
      default: return text === '' ? null : capText(text);
    }
  };
  for (const tk of tokens(xml)) {
    if ((++n & 8191) === 0) { signal?.throwIfAborted(); await tick(); }
    if (tk.type === 'open') {
      const nm = tk.name;
      if (skip > 0) { if (SKIP.has(nm) || nm === 'table') skip += 1; continue; }
      if (nm === 'style' && !sheet) { curStyle = tk.attrs['style:family'] === 'table' ? tk.attrs['style:name'] : null; continue; }
      if (nm === 'table-properties' && curStyle && tk.attrs['table:display'] === 'false') { hiddenStyles.add(curStyle); continue; }
      if (nm === 'table-source' && sheet) { if (externalLinks !== 'ignore') throw new XlsxError('EXTERNAL_LINKS', 'the workbook links to other files'); linked = true; continue; }
      if (nm === 'table') {
        if (cell || row) { skip += 1; continue; } // a table inside a cell
        if (out.length + 1 > limits.maxSheets && !only) throw new XlsxError('TOO_MANY_SHEETS', 'the workbook has too many sheets');
        const name = tk.attrs['table:name'] ?? '';
        sheet = { name, hidden: hiddenStyles.has(tk.attrs['table:style-name']), rows: [], shown: [], merges: [], rowNo: 0, wanted: !only || only.includes(name) };
        if (out.length + 1 > limits.maxSheets) throw new XlsxError('TOO_MANY_SHEETS', 'the workbook has too many sheets');
      } else if (!sheet) continue;
      else if (SKIP.has(nm)) skip += 1;
      else if (nm === 'table-row') {
        const vis = tk.attrs['table:visibility'];
        row = { cells: [], rep: repeat(tk.attrs['table:number-rows-repeated']), hidden: skipHiddenRows && (vis === 'collapse' || vis === 'filter'), col: 0, shown: [] };
      } else if (row && (nm === 'table-cell' || nm === 'covered-table-cell')) {
        cell = { covered: nm === 'covered-table-cell', attrs: tk.attrs, rep: repeat(tk.attrs['table:number-columns-repeated']), text: '', para: 0, inP: false };
        if (!cell.covered && tk.attrs['table:formula'] !== undefined) counters.formulas += 1;
      } else if (cell && (nm === 'p' || nm === 'h')) { if (cell.para > 0) cell.text += '\n'; cell.para += 1; cell.inP = true; }
      else if (cell && cell.inP) {
        if (nm === 's') cell.text += ' '.repeat(Math.min(Number(tk.attrs['text:c'] ?? 1) || 1, MAX_CELL_CHARS));
        else if (nm === 'tab') cell.text += '\t';
        else if (nm === 'line-break') cell.text += '\n';
        if (cell.text.length > MAX_CELL_CHARS) throw new XlsxError('CELL_TOO_LONG', 'a cell holds more text than Excel allows');
      }
    } else if (tk.type === 'text') {
      if (skip === 0 && cell && cell.inP) { cell.text += tk.text; if (cell.text.length > MAX_CELL_CHARS) throw new XlsxError('CELL_TOO_LONG', 'a cell holds more text than Excel allows'); }
    } else if (tk.type === 'close') {
      const nm = tk.name;
      if (skip > 0) { if (SKIP.has(nm) || nm === 'table') skip -= 1; continue; }
      if (nm === 'style') curStyle = null;
      else if (nm === 'p' || nm === 'h') { if (cell) cell.inP = false; }
      else if ((nm === 'table-cell' || nm === 'covered-table-cell') && cell && row) {
        const c = cell; cell = null;
        const value = c.covered ? null : cellValue(c);
        const col = row.col;
        if (value !== null) {
          if (col + c.rep > limits.maxCols) throw new XlsxError('TOO_MANY_COLS', `the sheet has data right of column ${limits.maxCols}`);
          for (let i = 0; i < c.rep; i++) row.cells[col + i] = value;
        }
        if (display && !c.covered && c.text !== '' && (value !== null || c.attrs['office:value-type'] === 'error' || c.attrs['calcext:value-type'] === 'error')) {
          if (col + c.rep > limits.maxCols) throw new XlsxError('TOO_MANY_COLS', `the sheet has data right of column ${limits.maxCols}`);
          for (let i = 0; i < c.rep; i++) row.shown[col + i] = c.text;
        }
        const cs = Number(c.attrs['table:number-columns-spanned'] ?? 1); const rs = Number(c.attrs['table:number-rows-spanned'] ?? 1);
        if (!c.covered && (cs > 1 || rs > 1) && Number.isInteger(cs) && Number.isInteger(rs) && sheet.merges.length < 10_000 && col < limits.maxCols) sheet.merges.push({ c1: col, r1: sheet.rowNo + 1, c2: col + cs - 1, r2: sheet.rowNo + rs });
        row.col = col + c.rep;
      } else if (nm === 'table-row' && row) finishRow();
      else if (nm === 'table' && sheet) {
        if (sheet.wanted) {
          const rows = squareUp(sheet.rows);
          const shown = display ? squareUp(sheet.shown, rows.length) : null;
          if (fillMergedCells) { fillMerged(rows, sheet.merges, limits); if (shown) fillMerged(shown, sheet.merges, limits); }
          out.push({ name: sheet.name, hidden: sheet.hidden, rows, ...(shown ? { shown } : {}), merges: sheet.merges });
        }
        sheet = null;
      }
    }
  }
  if (out.length === 0 && !only) throw new XlsxError('NOT_A_WORKBOOK', 'the workbook has no sheets');
  const warnings = [];
  if (counters.formulas) warnings.push({ code: 'FORMULAS_NOT_EVALUATED', count: counters.formulas });
  if (counters.errors) warnings.push({ code: 'ERROR_CELLS_IGNORED', count: counters.errors });
  if (linked) warnings.push({ code: 'EXTERNAL_LINKS_IGNORED', count: 1 });
  return { sheets: out, warnings };
}
