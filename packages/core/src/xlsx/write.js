import { WRITE_LIMITS } from './limits.js';
import { XlsxError } from './errors.js';
import { defaultZip } from './zip-backend.js';

const MAX_ROWS = WRITE_LIMITS.maxRows; // plus the header: 1,048,576 rows in a sheet
const MAX_COLS = WRITE_LIMITS.maxCols;
const MAX_CELL = WRITE_LIMITS.maxCellChars;

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Column number (0-based) to letters: 0 -> A, 26 -> AA. */
export function columnName(i) {
  let n = i + 1;
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** Excel reads "_x0041_" in a text as the letter A; to keep such a text as typed, the underscore that starts it is itself escaped (_x005F_). */
const literal = (s) => s.replace(/_(?=x[0-9A-Fa-f]{4}_)/g, '_x005F_');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const stripControl = (s) => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');

/** Text a spreadsheet program could take for a formula (or a command) when it is opened. */
export function isFormulaLike(s) {
  return typeof s === 'string' && /^[=+\-@\t\r\n|]/.test(s);
}

// cellXfs order in styles.xml below
const S = { default: 0, header: 1, money: 2, integer: 3, percent: 4, date: 5, datetime: 6, quoted: 7, number: 8 };
const FORMAT_STYLE = { text: S.default, general: S.default, money: S.money, integer: S.integer, percent: S.percent, date: S.date, datetime: S.datetime, number: S.number };

const NUMFMT_ID = { text: 0, general: 0, money: 4, integer: 3, percent: 10, date: 164, datetime: 165, number: 2 };
const BASE = { fonts: 2, fills: 3, borders: 2, xfs: 9 };

// The colours a person may name; anything else must be a strict #RRGGBB.
const PALETTE = { white: 'FFFFFF', black: '000000', grey: 'EDEDED', darkgrey: '595959', green: 'C6EFCE', darkgreen: '006100', red: 'FFC7CE', darkred: '9C0006', yellow: 'FFEB9C', darkyellow: '9C5700', blue: 'DDEBF7', darkblue: '1F4E78', orange: 'FCE4D6', darkorange: 'C55A11' };
function colour(c, what) {
  if (typeof c === 'string') {
    if (Object.hasOwn(PALETTE, c)) return `FF${PALETTE[c]}`;
    if (/^#[0-9A-Fa-f]{6}$/.test(c)) return `FF${c.slice(1).toUpperCase()}`;
  }
  throw new XlsxError('BAD_STYLE', `${what} must be a colour name (${Object.keys(PALETTE).join(', ')}) or #RRGGBB`);
}

const STYLE_KEYS = new Set(['bold', 'italic', 'color', 'fill', 'border', 'align', 'valign', 'wrap']);
/** Checks a style object and returns it in a fixed shape (so equal styles share one cell format). */
function normStyle(st) {
  if (st === undefined || st === null) return null;
  if (typeof st !== 'object' || Array.isArray(st)) throw new XlsxError('BAD_STYLE', 'a style is an object');
  for (const k of Object.keys(st)) if (!STYLE_KEYS.has(k)) throw new XlsxError('BAD_STYLE', `unknown style setting "${k}"`);
  const out = {};
  if (st.bold !== undefined) { if (typeof st.bold !== 'boolean') throw new XlsxError('BAD_STYLE', 'bold is true or false'); if (st.bold) out.bold = true; }
  if (st.italic !== undefined) { if (typeof st.italic !== 'boolean') throw new XlsxError('BAD_STYLE', 'italic is true or false'); if (st.italic) out.italic = true; }
  if (st.wrap !== undefined) { if (typeof st.wrap !== 'boolean') throw new XlsxError('BAD_STYLE', 'wrap is true or false'); if (st.wrap) out.wrap = true; }
  if (st.color !== undefined) out.color = colour(st.color, 'color');
  if (st.fill !== undefined) out.fill = colour(st.fill, 'fill');
  if (st.border !== undefined && st.border !== false) { if (!['thin', 'bottom'].includes(st.border)) throw new XlsxError('BAD_STYLE', 'border is "thin" or "bottom"'); out.border = st.border; }
  if (st.align !== undefined) { if (!['left', 'center', 'right'].includes(st.align)) throw new XlsxError('BAD_STYLE', 'align is left, center or right'); out.align = st.align; }
  if (st.valign !== undefined) { if (!['top', 'center', 'bottom'].includes(st.valign)) throw new XlsxError('BAD_STYLE', 'valign is top, center or bottom'); out.valign = st.valign; }
  return Object.keys(out).length ? out : null;
}
const mergeStyle = (a, b) => (a && b ? { ...a, ...b } : a ?? b);

const LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
const MAX_LINKS = WRITE_LIMITS.maxLinks;
const LINK_STYLE = normStyle({ color: '#0563C1' });

/** A link target as it will be written, or BAD_LINK. Only http, https and mailto, no credentials, no controls or spaces. */
function checkLink(url) {
  if (typeof url !== 'string' || url.length === 0 || url.length > 2000 || /[\u0000-\u0020\u007f-\u009f]/.test(url)) throw new XlsxError('BAD_LINK', 'a link is a text of up to 2000 characters without spaces or control characters');
  let u;
  try { u = new URL(url); } catch { throw new XlsxError('BAD_LINK', 'a link must be an absolute address (https://..., http://... or mailto:...)'); }
  if (!LINK_SCHEMES.has(u.protocol)) throw new XlsxError('BAD_LINK', 'a link may start only with https://, http:// or mailto:');
  if (u.username || u.password) throw new XlsxError('BAD_LINK', 'a link with a login or password in it is refused');
  return u.href;
}

/** The cell formats of one workbook: the nine fixed ones, then one per distinct style that the sheets use. */
function createStyles() {
  const fonts = []; const fills = []; const borders = []; const xfs = []; const index = new Map(); const dxfs = [];
  const slot = (list, base, xml) => { let i = list.indexOf(xml); if (i < 0) { i = list.push(xml) - 1; } return base + i; };
  /** Cell format number for a style (already normalised), a number format and the quote-prefix flag. */
  function xf(style, numFmtId, quote = false) {
    const key = `${numFmtId}|${quote ? 1 : 0}|${JSON.stringify(style)}`;
    const known = index.get(key);
    if (known !== undefined) return known;
    if (xfs.length >= WRITE_LIMITS.maxStyles) throw new XlsxError('BAD_STYLE', 'a workbook uses too many different styles');
    const f = style && (style.bold || style.italic || style.color) ? slot(fonts, BASE.fonts, `<font>${style.bold ? '<b/>' : ''}${style.italic ? '<i/>' : ''}<sz val="11"/>${style.color ? `<color rgb="${style.color}"/>` : ''}<name val="Calibri"/></font>`) : 0;
    const fl = style?.fill ? slot(fills, BASE.fills, `<fill><patternFill patternType="solid"><fgColor rgb="${style.fill}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    const side = (on, n) => (on ? `<${n} style="thin"><color auto="1"/></${n}>` : `<${n}/>`);
    const bd = style?.border ? slot(borders, BASE.borders, `<border>${side(style.border === 'thin', 'left')}${side(style.border === 'thin', 'right')}${side(style.border === 'thin', 'top')}${side(true, 'bottom')}<diagonal/></border>`) : 0;
    const align = style && (style.align || style.valign || style.wrap) ? `<alignment${style.align ? ` horizontal="${style.align}"` : ''}${style.valign ? ` vertical="${style.valign}"` : ''}${style.wrap ? ' wrapText="1"' : ''}/>` : '';
    const attrs = `numFmtId="${numFmtId}" fontId="${f}" fillId="${fl}" borderId="${bd}" xfId="0"${numFmtId ? ' applyNumberFormat="1"' : ''}${f ? ' applyFont="1"' : ''}${fl ? ' applyFill="1"' : ''}${bd ? ' applyBorder="1"' : ''}${align ? ' applyAlignment="1"' : ''}${quote ? ' quotePrefix="1"' : ''}`;
    const id = BASE.xfs + xfs.push(align ? `<xf ${attrs}>${align}</xf>` : `<xf ${attrs}/>`) - 1;
    index.set(key, id);
    return id;
  }
  /** A differential format (what a conditional-formatting rule applies): font, fill and border only. Returns its number. */
  function dxf(style) {
    for (const k of ['align', 'valign', 'wrap']) if (style?.[k] !== undefined) throw new XlsxError('BAD_STYLE', `${k} cannot be set by a rule`);
    const font = style.bold || style.italic || style.color ? `<font>${style.bold ? '<b/>' : ''}${style.italic ? '<i/>' : ''}${style.color ? `<color rgb="${style.color}"/>` : ''}</font>` : '';
    const fill = style.fill ? `<fill><patternFill patternType="solid"><fgColor rgb="${style.fill}"/><bgColor rgb="${style.fill}"/></patternFill></fill>` : '';
    const side = (on, n) => (on ? `<${n} style="thin"><color auto="1"/></${n}>` : '');
    const border = style.border ? `<border>${side(style.border === 'thin', 'left')}${side(style.border === 'thin', 'right')}${side(style.border === 'thin', 'top')}${side(true, 'bottom')}</border>` : '';
    const xmlText = `<dxf>${font}${fill}${border}</dxf>`;
    let i = dxfs.indexOf(xmlText);
    if (i < 0) { if (dxfs.length >= WRITE_LIMITS.maxRuleStyles) throw new XlsxError('BAD_STYLE', 'a workbook uses too many different rule styles'); i = dxfs.push(xmlText) - 1; }
    return i;
  }
  function xml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/><numFmt numFmtId="165" formatCode="yyyy\\-mm\\-dd\\ hh:mm"/></numFmts><fonts count="${BASE.fonts + fonts.length}"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font>${fonts.join('')}</fonts><fills count="${BASE.fills + fills.length}"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE7ECF3"/><bgColor indexed="64"/></patternFill></fill>${fills.join('')}</fills><borders count="${BASE.borders + borders.length}"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color auto="1"/></bottom><diagonal/></border>${borders.join('')}</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${BASE.xfs + xfs.length}"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" quotePrefix="1"/><xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>${xfs.join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>${dxfs.length ? `<dxfs count="${dxfs.length}">${dxfs.join('')}</dxfs>` : ''}</styleSheet>`;
  }
  return { xf, dxf, xml };
}

const BAD_FORMULA = /[[|]|\b(?:HYPERLINK|WEBSERVICE|FILTERXML|RTD|CALL|REGISTER|EXEC|DDE|IMPORTXML|IMPORTDATA|IMPORTHTML|IMPORTRANGE|INDIRECT)\s*\(/i;

// Functions newer than Excel 2007 are stored with a prefix; without it Excel shows #NAME? until the cell is edited.
const NEW_FUNCTIONS = ['XLOOKUP', 'XMATCH', 'IFS', 'SWITCH', 'TEXTJOIN', 'CONCAT', 'MAXIFS', 'MINIFS', 'IFNA', 'XOR', 'DAYS', 'ISOWEEKNUM', 'NUMBERVALUE', 'TEXTBEFORE', 'TEXTAFTER', 'FORMULATEXT', 'ISFORMULA', 'SHEET', 'SHEETS', 'ARABIC', 'BASE', 'DECIMAL', 'PDURATION', 'RRI', 'CEILING.MATH', 'FLOOR.MATH', 'STDEV.S', 'STDEV.P', 'VAR.S', 'VAR.P', 'PERCENTILE.INC', 'PERCENTILE.EXC', 'QUARTILE.INC', 'QUARTILE.EXC', 'RANK.EQ', 'RANK.AVG', 'MODE.SNGL', 'NORM.DIST', 'NORM.INV', 'T.TEST', 'CONFIDENCE.NORM'];
// Functions that return several values at once need array metadata in the file that this writer does not produce.
const ARRAY_FUNCTIONS = ['FILTER', 'SORT', 'SORTBY', 'UNIQUE', 'SEQUENCE', 'RANDARRAY', 'LET', 'LAMBDA', 'VSTACK', 'HSTACK', 'TAKE', 'DROP', 'CHOOSECOLS', 'CHOOSEROWS', 'TOCOL', 'TOROW', 'WRAPCOLS', 'WRAPROWS', 'EXPAND', 'TEXTSPLIT'];
const NEW_RE = new RegExp(`(?<![\\w.])(${NEW_FUNCTIONS.map((n) => n.replace('.', '\\.')).join('|')})\\(`, 'gi');
const ARRAY_RE = new RegExp(`(?<![\\w.])(${ARRAY_FUNCTIONS.join('|')})\\(`, 'i');
/** Adds the `_xlfn.` prefix to newer functions outside quoted text. */
export function prefixNewFunctions(formula) {
  return formula.split(/("(?:[^"]|"")*")/).map((part, i) => (i % 2 ? part : part.replace(NEW_RE, (_, n) => `_xlfn.${n.toUpperCase()}(`))).join('');
}

function formulaText(f) {
  const s = String(f).replace(/^=/, '');
  if (!s || s.length > 8192 || BAD_FORMULA.test(s) || /[\u0000-\u001F]/.test(s)) throw new XlsxError('BAD_FORMULA', 'the formula is empty, too long or not allowed');
  if (s.split(/("(?:[^"]|"")*")/).some((part, i) => i % 2 === 0 && ARRAY_RE.test(part))) throw new XlsxError('BAD_FORMULA', 'functions that return several values (FILTER, SORT, UNIQUE, LET ...) are not supported: write the result as values');
  return esc(prefixNewFunctions(s));
}

const serial = (d) => (d.getTime() - Date.UTC(1899, 11, 30)) / 86_400_000;

function toDate(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) { const d = new Date(v.length === 10 ? `${v}T00:00:00Z` : v); return Number.isNaN(d.getTime()) ? null : d; }
  return null;
}

const NUM_OF = [0, 0, 4, 3, 10, 164, 165, 49, 2]; // number format of each fixed cell format, by position in `S`
const HEADER_BASE = { bold: true, fill: 'FFE7ECF3', border: 'bottom' };

/**
 * One cell. `value` may be a plain value, `{ formula, value }`, or either of those with a `style` next to it:
 * `{ value, style }` / `{ formula, value, style }`. `colStyle` is the (normalised) style of the column.
 */
function cellXml(ref, value, format, styles, colStyle, links) {
  let cellStyle = null; let linked = false;
  if (value && typeof value === 'object' && !(value instanceof Date) && ('style' in value || 'link' in value) && !Array.isArray(value)) {
    cellStyle = normStyle(value.style);
    if (value.link !== undefined && value.link !== null) {
      const href = checkLink(value.link);
      if (links.length >= MAX_LINKS) throw new XlsxError('BAD_LINK', `a sheet holds at most ${MAX_LINKS} links`);
      links.push({ ref, href }); linked = true;
      if (value.value === undefined || value.value === null || value.value === '') value = { ...value, value: href };
    }
    value = 'formula' in value ? { formula: value.formula, value: value.value } : value.value;
  }
  const eff = linked ? mergeStyle(mergeStyle(colStyle, LINK_STYLE), cellStyle) : mergeStyle(colStyle, cellStyle);
  const pick = (base) => (eff ? styles.xf(eff, NUM_OF[base], base === S.quoted) : base);
  let style = FORMAT_STYLE[format] ?? S.default;
  if (value && typeof value === 'object' && !(value instanceof Date) && 'formula' in value) {
    const cached = value.value;
    const f = `<f>${formulaText(value.formula)}</f>`;
    const sx = pick(style);
    if (typeof cached === 'number' && Number.isFinite(cached)) return `<c r="${ref}" s="${sx}">${f}<v>${cached}</v></c>`;
    if (typeof cached === 'boolean') return `<c r="${ref}" s="${sx}" t="b">${f}<v>${cached ? 1 : 0}</v></c>`;
    if (typeof cached === 'string') return `<c r="${ref}" s="${sx}" t="str">${f}<v>${esc(literal(stripControl(cached).slice(0, MAX_CELL)))}</v></c>`;
    return `<c r="${ref}" s="${sx}">${f}</c>`;
  }
  if (value === null || value === undefined || value === '') { const sx = pick(style); return sx === S.default ? '' : `<c r="${ref}" s="${sx}"/>`; }
  if (typeof value === 'boolean') return `<c r="${ref}" s="${pick(S.default)}" t="b"><v>${value ? 1 : 0}</v></c>`;
  const date = toDate(value);
  if (date && (format === 'date' || format === 'datetime' || value instanceof Date)) {
    if (style !== S.date && style !== S.datetime) style = date.getUTCHours() + date.getUTCMinutes() + date.getUTCSeconds() === 0 ? S.date : S.datetime;
    return `<c r="${ref}" s="${pick(style)}"><v>${serial(date)}</v></c>`;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    const n = Number(value);
    return Number.isFinite(n) ? `<c r="${ref}" s="${pick(style)}"><v>${n}</v></c>` : '';
  }
  const text = stripControl(value);
  if (text.length > MAX_CELL) throw new XlsxError('CELL_TOO_LONG', `a cell holds more than ${MAX_CELL} characters`);
  // Text is always written as an explicit string, never as a formula; text that starts like one also gets the
  // "quote prefix" style, so it stays text even after being edited in Excel.
  const s = isFormulaLike(text) ? pick(S.quoted) : pick(style);
  return `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${esc(literal(text))}</t></is></c>`;
}

/** "A1:C3" -> { c1, r1, c2, r2 } (columns from 0, rows from 1), or a clear error. */
function rangeOf(text, maxRow) {
  const m = /^([A-Z]{1,3})([1-9]\d{0,6}):([A-Z]{1,3})([1-9]\d{0,6})$/.exec(typeof text === 'string' ? text : '');
  if (!m) throw new XlsxError('BAD_SHEET', `a merged range looks like "A1:C2", not ${JSON.stringify(text)}`);
  const col = (l) => [...l].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const r = { c1: col(m[1]), r1: Number(m[2]), c2: col(m[3]), r2: Number(m[4]) };
  if (r.c2 < r.c1 || r.r2 < r.r1 || (r.c1 === r.c2 && r.r1 === r.r2) || r.c2 >= MAX_COLS || r.r2 > maxRow) throw new XlsxError('BAD_SHEET', `the merged range ${text} is empty, reversed or outside the sheet`);
  return r;
}

const OPERATORS = { equals: 'equal', notEquals: 'notEqual', greaterThan: 'greaterThan', greaterOrEqual: 'greaterThanOrEqual', lessThan: 'lessThan', lessOrEqual: 'lessThanOrEqual' };
/** A value inside a rule formula: a number as it is, a text in quotes (a quote inside is doubled). */
function ruleValue(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string' && v.length <= 255 && !/[\u0000-\u001F]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  throw new XlsxError('BAD_SHEET', 'a rule compares with a number or a text of at most 255 characters');
}

/**
 * Rules that colour cells by their value, so a status keeps its colour when the person edits the cell.
 * `conditional: [{ column: 'status', rules: [{ equals: 'Готово', style: { fill: 'green' } }, { between: [1, 5], style }, { contains: 'проср', style }] }]`
 */
function conditionalXml(sheet, cols, first, styles) {
  const list = sheet.conditional;
  if (list === undefined) return '';
  if (!Array.isArray(list) || list.length > 50) throw new XlsxError('BAD_SHEET', 'conditional is a list of at most 50 column rules');
  let priority = 0; let xml = '';
  for (const entry of list) {
    const at = typeof entry?.column === 'number' ? entry.column : cols.findIndex((c) => (c.key ?? c.header) === entry?.column);
    if (!Number.isInteger(at) || at < 0 || at >= cols.length) throw new XlsxError('BAD_SHEET', 'a conditional rule names a column that is not in the sheet');
    if (!Array.isArray(entry.rules) || entry.rules.length === 0 || entry.rules.length > 20) throw new XlsxError('BAD_SHEET', 'a column has 1 to 20 rules');
    const col = columnName(at);
    const rules = entry.rules.map((rule) => {
      const style = normStyle(rule?.style);
      if (!style) throw new XlsxError('BAD_STYLE', 'a rule needs a style');
      const kinds = Object.keys(rule).filter((k) => k !== 'style');
      if (kinds.length !== 1) throw new XlsxError('BAD_SHEET', 'a rule has exactly one condition besides its style');
      const [kind] = kinds; const dxfId = styles.dxf(style); priority += 1;
      if (Object.hasOwn(OPERATORS, kind)) return `<cfRule type="cellIs" dxfId="${dxfId}" priority="${priority}" operator="${OPERATORS[kind]}"><formula>${esc(ruleValue(rule[kind]))}</formula></cfRule>`;
      if (kind === 'between') {
        if (!Array.isArray(rule.between) || rule.between.length !== 2) throw new XlsxError('BAD_SHEET', 'between is a pair of values');
        return `<cfRule type="cellIs" dxfId="${dxfId}" priority="${priority}" operator="between"><formula>${esc(ruleValue(rule.between[0]))}</formula><formula>${esc(ruleValue(rule.between[1]))}</formula></cfRule>`;
      }
      if (kind === 'contains') {
        if (typeof rule.contains !== 'string' || !rule.contains || rule.contains.length > 255 || /[\u0000-\u001F]/.test(rule.contains)) throw new XlsxError('BAD_SHEET', 'contains is a text of 1 to 255 characters');
        return `<cfRule type="containsText" dxfId="${dxfId}" priority="${priority}" operator="containsText" text="${esc(rule.contains)}"><formula>${esc(`NOT(ISERROR(SEARCH(${ruleValue(rule.contains)},${col}${first})))`)}</formula></cfRule>`;
      }
      throw new XlsxError('BAD_SHEET', `unknown rule "${kind}"`);
    });
    xml += `<conditionalFormatting sqref="${col}${first}:${col}${MAX_ROWS + 1}">${rules.join('')}</conditionalFormatting>`;
  }
  return xml;
}

const PAPER = { A4: 9, A3: 8, Letter: 1 };

/** Everything about a sheet that does not depend on how many rows it has: its start, a function for each row, and its end. */
function prepareSheet(sheet, styles) {
  const cols = sheet.columns ?? [];
  if (cols.length === 0 || cols.length > MAX_COLS) throw new XlsxError('BAD_SHEET', 'a sheet needs 1 to 16384 columns');
  const header = sheet.header !== false;
  const colStyles = cols.map((c) => normStyle(c.style));
  const headStyles = cols.map((c) => { const h = normStyle(c.headerStyle); return h ? styles.xf(mergeStyle(HEADER_BASE, h), 0) : S.header; });
  const links = [];
  const headerRow = header ? `<row r="1">${cols.map((c, i) => `<c r="${columnName(i)}1" s="${headStyles[i]}" t="inlineStr"><is><t xml:space="preserve">${esc(literal(stripControl(c.header ?? c.key ?? '')))}</t></is></c>`).join('')}</row>` : '';
  const rowXml = (row, r) => `<row r="${r}">${cols.map((c, i) => cellXml(`${columnName(i)}${r}`, Array.isArray(row) ? row[i] : row?.[c.key], c.format, styles, colStyles[i], links)).join('')}</row>`;
  const widths = cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.min(Math.max(Number(c.width) || Math.min(Math.max(String(c.header ?? c.key ?? '').length + 4, 10), 40), 4), 100)}" customWidth="1"/>`).join('');
  const fc = sheet.freezeColumns ?? 0;
  if (!Number.isInteger(fc) || fc < 0 || fc >= cols.length) throw new XlsxError('BAD_SHEET', 'freezeColumns is a number of columns from 0 up to the last but one');
  const frozenRow = header && sheet.freezeHeader !== false;
  const pane = frozenRow || fc ? `<pane${fc ? ` xSplit="${fc}"` : ''}${frozenRow ? ' ySplit="1"' : ''} topLeftCell="${columnName(fc)}${frozenRow ? 2 : 1}" activePane="${fc && frozenRow ? 'bottomRight' : fc ? 'topRight' : 'bottomLeft'}" state="frozen"/>` : '';
  const first = header ? 2 : 1;
  const lists = cols.map((c, i) => [c, i]).filter(([c]) => c.list !== undefined).map(([c, i]) => {
    const items = c.list;
    if (!Array.isArray(items) || items.length === 0 || items.some((x) => typeof x !== 'string' || /[,"<>&\u0000-\u001f]/.test(x))) throw new XlsxError('BAD_SHEET', 'a drop-down list needs plain texts without commas and quotes');
    const joined = items.join(',');
    if (joined.length > 255) throw new XlsxError('BAD_SHEET', 'a drop-down list is at most 255 characters in all');
    const col = columnName(i);
    return `<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="${col}${first}:${col}${MAX_ROWS + 1}"><formula1>"${joined}"</formula1></dataValidation>`;
  });
  const mergeList = sheet.merges ?? [];
  if (!Array.isArray(mergeList) || mergeList.length > WRITE_LIMITS.maxMerges) throw new XlsxError('BAD_SHEET', 'merges is a list of at most 1000 ranges');
  const ranges = mergeList.map((m) => rangeOf(m, MAX_ROWS + 1));
  for (let i = 0; i < ranges.length; i++) for (let j = 0; j < i; j++) {
    const a = ranges[i]; const b = ranges[j];
    if (a.c1 <= b.c2 && b.c1 <= a.c2 && a.r1 <= b.r2 && b.r1 <= a.r2) throw new XlsxError('BAD_SHEET', `the merged ranges ${mergeList[j]} and ${mergeList[i]} overlap`);
  }
  if (header && sheet.autoFilter !== false && ranges.some((r) => r.r1 <= 1 && r.r2 >= 1)) throw new XlsxError('BAD_SHEET', 'a merged range over the header row breaks its filter (Excel shows the headers blank): set autoFilter: false or merge below the header');
  const merged = ranges.length ? `<mergeCells count="${ranges.length}">${mergeList.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
  const pr = sheet.print;
  if (pr !== undefined && (pr === null || typeof pr !== 'object')) throw new XlsxError('BAD_SHEET', 'print is an object');
  if (pr?.orientation !== undefined && !['portrait', 'landscape'].includes(pr.orientation)) throw new XlsxError('BAD_SHEET', 'print.orientation is portrait or landscape');
  if (pr?.paper !== undefined && !Object.hasOwn(PAPER, pr.paper)) throw new XlsxError('BAD_SHEET', 'print.paper is A4, A3 or Letter');
  const tab = sheet.tabColor !== undefined ? `<tabColor rgb="${colour(sheet.tabColor, 'tabColor')}"/>` : '';
  const fit = pr?.fitToWidth ? '<pageSetUpPr fitToPage="1"/>' : '';
  const sheetPr = tab || fit ? `<sheetPr>${tab}${fit}</sheetPr>` : '';
  const pageSetup = pr ? `<pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/><pageSetup${pr.paper ? ` paperSize="${PAPER[pr.paper]}"` : ''} orientation="${pr.orientation ?? 'portrait'}"${pr.fitToWidth ? ' fitToWidth="1" fitToHeight="0"' : ''}/>` : '';
  const validation = lists.length ? `<dataValidations count="${lists.length}">${lists.join('')}</dataValidations>` : '';
  const open = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${sheetPr}<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${widths}</cols><sheetData>${headerRow}`;
  /** The end of the sheet; `last` is the number of the last row, `dataRows` how many rows of data there were. */
  const close = (last, dataRows) => {
    const filter = header && sheet.autoFilter !== false && dataRows > 0 ? `<autoFilter ref="A1:${columnName(cols.length - 1)}${Math.max(last, 1)}"/>` : '';
    return `</sheetData>${filter}${merged}${conditionalXml(sheet, cols, first, styles)}${validation}${hyperlinksXml(links)}${pageSetup}</worksheet>`;
  };
  return { header, open, rowXml, close, links };
}

const hyperlinksXml = (links) => (links.length ? `<hyperlinks>${links.map((l, i) => `<hyperlink ref="${l.ref}" r:id="rId${i + 1}"/>`).join('')}</hyperlinks>` : '');
const sheetRels = (links) => `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${links.map((l, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${esc(l.href)}" TargetMode="External"/>`).join('')}</Relationships>`;

function sheetXml(sheet, styles, out) {
  const rows = sheet.rows ?? [];
  if (rows.length > MAX_ROWS) throw new XlsxError('TOO_MANY_ROWS', 'a sheet holds at most 1,048,575 data rows');
  const p = prepareSheet(sheet, styles);
  let xml = p.open;
  let r = p.header ? 1 : 0;
  for (const row of rows) { r += 1; xml += p.rowXml(row, r); }
  if (out) out.links = p.links;
  return xml + p.close(r, rows.length);
}

function sheetName(name, used) {
  const n = stripControl(name ?? '').replace(/[[\]:*?/\\]/g, ' ').trim().replace(/^'+|'+$/g, '').slice(0, 31);
  if (!n) throw new XlsxError('BAD_SHEET', 'a sheet needs a name');
  if (n.toLowerCase() === 'history') throw new XlsxError('BAD_SHEET', 'the sheet name "History" is reserved by Excel');
  if (used.has(n.toLowerCase())) throw new XlsxError('BAD_SHEET', `two sheets are named "${n}"`);
  used.add(n.toLowerCase());
  return n;
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

function packageParts(book, sheets, names, titles) {
  const created = new Date(book.created instanceof Date && !Number.isNaN(book.created.getTime()) ? book.created : Date.UTC(2020, 0, 1)).toISOString().replace(/\.\d+Z$/, 'Z');
  const props = `${XML_DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(stripControl(book.title ?? '').slice(0, 255))}</dc:title><dc:creator>${esc(stripControl(book.creator ?? 'DAS-Forge').slice(0, 255))}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created></cp:coreProperties>`;
  return {
    types: `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
    rels: `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    props,
    workbook: (hasFormulas) => `${XML_DECL}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>${titles ? `<definedNames>${titles}</definedNames>` : ''}${hasFormulas ? '<calcPr calcId="191029" fullCalcOnLoad="1"/>' : ''}</workbook>`,
    workbookRels: `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  };
}

function checkBook(book) {
  const sheets = book?.sheets;
  if (!Array.isArray(sheets) || sheets.length === 0 || sheets.length > 50) throw new XlsxError('BAD_SHEET', 'a workbook needs 1 to 50 sheets');
  const used = new Set();
  const names = sheets.map((s) => sheetName(s.name, used));
  const titles = sheets.map((sh, i) => (sh.print?.repeatHeader && sh.header !== false ? `<definedName name="_xlnm.Print_Titles" localSheetId="${i}">'${names[i].replace(/'/g, "''")}'!$1:$1</definedName>` : '')).join('');
  return { sheets, names, titles };
}

/**
 * Builds a workbook (.xlsx) from plain data. Text is always written as text (never as a formula), control
 * characters are removed, formulas are accepted only as `{ formula, value }` objects and are checked.
 *
 * @param {{title?: string, creator?: string, created?: Date, sheets: Array<{name: string, columns: Array<{header?: string, key?: string, width?: number, format?: 'text'|'number'|'integer'|'money'|'percent'|'date'|'datetime', list?: string[], style?: object, headerStyle?: object}>, rows: Array<object|any[]>, header?: boolean, freezeHeader?: boolean, freezeColumns?: number, autoFilter?: boolean, conditional?: Array<{column: string|number, rules: Array<object>}>, merges?: string[], tabColor?: string, print?: {orientation?: 'portrait'|'landscape', paper?: 'A4'|'A3'|'Letter', fitToWidth?: boolean, repeatHeader?: boolean}}>}} book
 * @param {{zip?: {write: Function}}} [opts]
 * @returns {Promise<Buffer>}
 */
export async function buildWorkbook(book, { zip = defaultZip } = {}) {
  const { sheets, names, titles } = checkBook(book);
  const styles = createStyles();
  const linkLists = [];
  const sheetParts = sheets.map((sh, i) => { const out = {}; const x = sheetXml(sh, styles, out); linkLists[i] = out.links; return x; });
  const hasFormulas = sheetParts.some((x) => x.includes('<f>'));
  const parts = packageParts(book, sheets, names, titles);
  const entries = [
    ['[Content_Types].xml', parts.types],
    ['_rels/.rels', parts.rels],
    ['docProps/core.xml', parts.props],
    ['xl/workbook.xml', parts.workbook(hasFormulas)],
    ['xl/_rels/workbook.xml.rels', parts.workbookRels],
    ['xl/styles.xml', styles.xml()],
    ...sheetParts.map((x, i) => [`xl/worksheets/sheet${i + 1}.xml`, x]),
    ...linkLists.flatMap((l, i) => (l.length ? [[`xl/worksheets/_rels/sheet${i + 1}.xml.rels`, sheetRels(l)]] : [])),
  ].map(([name, text]) => [name, Buffer.from(text, 'utf8')]);
  return zip.write(entries);
}

/**
 * Builds the same workbook as a stream, for exports too big to hold: a sheet's `rows` may be any iterable or async
 * iterable (a database cursor, a generator), each row is turned into XML and handed on, and the archive is written as it
 * goes, so memory holds one run of rows and not the sheet. Every check of `buildWorkbook` applies (styles, formulas, names,
 * limits); a problem found midway (a bad cell, a row past the limit) ends the stream with that error, so the receiver must
 * treat a failed stream as a failed file. Returns a Readable to pipe to a response or a file.
 *
 * @param {Parameters<typeof buildWorkbook>[0]} book - as for `buildWorkbook`, but `rows` may also be an (async) iterable
 * @param {{zip?: {writeStream: Function}}} [opts]
 * @returns {Promise<import('node:stream').Readable>}
 */
export async function buildWorkbookStream(book, { zip = defaultZip } = {}) {
  const { sheets, names, titles } = checkBook(book);
  const styles = createStyles();
  let hasFormulas = false;
  const parts = packageParts(book, sheets, names, titles);
  const linkLists = [];
  async function* sheetChunks(sheet, i) {
    const p = prepareSheet(sheet, styles);
    linkLists[i] = p.links;
    yield p.open;
    let r = p.header ? 1 : 0; let count = 0; let buffer = '';
    for await (const row of sheet.rows ?? []) {
      count += 1;
      if (count > MAX_ROWS) throw new XlsxError('TOO_MANY_ROWS', 'a sheet holds at most 1,048,575 data rows');
      r += 1;
      const x = p.rowXml(row, r);
      if (!hasFormulas && x.includes('<f>')) hasFormulas = true;
      buffer += x;
      if (buffer.length >= 65_536) { yield buffer; buffer = ''; }
    }
    yield buffer + p.close(r, count);
  }
  // the parts that depend on all the sheets (which styles were used, whether a formula turned up) are produced last
  const lazy = async function* lazy(make) { yield make(); };
  const entries = [
    ['[Content_Types].xml', Buffer.from(parts.types)],
    ['_rels/.rels', Buffer.from(parts.rels)],
    ['docProps/core.xml', Buffer.from(parts.props)],
    ['xl/_rels/workbook.xml.rels', Buffer.from(parts.workbookRels)],
    ...sheets.map((sh, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetChunks(sh, i)]),
    ...sheets.map((_, i) => [`xl/worksheets/_rels/sheet${i + 1}.xml.rels`, lazy(() => sheetRels(linkLists[i] ?? []))]),
    ['xl/workbook.xml', lazy(() => parts.workbook(hasFormulas))],
    ['xl/styles.xml', lazy(() => styles.xml())],
  ];
  return zip.writeStream(entries);
}
