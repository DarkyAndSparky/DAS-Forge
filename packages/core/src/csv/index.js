/**
 * CSV for the platform: one writer and one reader, safe by default. Replaces the hand-written CSV code that
 * used to live in the audit export, the processing register and the CLI, each with its own idea of quoting and
 * of what counts as a formula.
 *
 * Writing: a text that a spreadsheet would run as a formula gets a leading apostrophe (on by default), fields
 * are quoted when they need it, numbers are never altered. Reading: bytes or text, a byte-order mark is honoured,
 * UTF-8 is tried strictly and falls back to windows-1251 (what Excel in Russian writes), the delimiter is found by
 * looking at the first line, and the size is limited.
 */

export class CsvError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.name = 'CsvError'; this.code = code; }
}

/** Leading characters that make a spreadsheet read a text as a formula (or as a DDE command). */
const TRIGGER = /^[=+\-@\t\r\n|]/;
const DANGEROUS = /^[\s'"]*[=+\-@]\s*(?:cmd|HYPERLINK|IMPORT\w+|IMAGE|WEBSERVICE|DDE)\b/i;

/** @param {string} s */
export function isFormulaText(s) { return typeof s === 'string' && (TRIGGER.test(s) || DANGEROUS.test(s)); }
/** Prefix a text that would run as a formula with an apostrophe. @param {string} s */
export function escapeFormula(s) { return isFormulaText(s) ? `'${s}` : s; }
/** Undo {@link escapeFormula}, only where it would have added the apostrophe. @param {string} s */
export function unescapeFormula(s) { return typeof s === 'string' && s.length > 1 && s[0] === "'" && TRIGGER.test(s[1]) ? s.slice(1) : s; }

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

function field(value, { delimiter, quoteAll, escapeFormulae }) {
  if (value === null || value === undefined) return quoteAll ? '""' : '';
  if (typeof value === 'number' || typeof value === 'bigint') return quoteAll ? `"${value}"` : String(value);
  let s = value instanceof Date ? (Number.isNaN(value.getTime()) ? '' : value.toISOString()) : typeof value === 'boolean' ? String(value) : String(value);
  s = s.replace(CONTROL, '');
  if (escapeFormulae) s = escapeFormula(s);
  return quoteAll || s.includes(delimiter) || /["\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * @param {Array<Array<any>>} rows
 * @param {{excel?: string, delimiter?: ',' | ';' | '\t', eol?: string, bom?: boolean, quoteAll?: boolean, escapeFormulae?: boolean}} [opts]
 * `excel: 'ru'` makes a file for a person who will double-click it in Excel: a UTF-8 mark first (without it Excel reads
 * Cyrillic as garbage) and ";" between fields, because that is the list separator of Excel in Russian and most European
 * settings (a comma-separated file lands in one column there); `excel: 'en'` keeps the comma. `delimiter` and `bom` still win if given.
 * `bom: true` puts a UTF-8 mark first, which is what makes Excel open a UTF-8 file as UTF-8. `escapeFormulae` is
 * on unless you turn it off, and only text is touched: a number such as -5 stays a number.
 */
export function writeCsv(rows, { excel, delimiter: d, eol = '\r\n', bom: b, quoteAll = false, escapeFormulae = true } = {}) {
  const delimiter = d ?? (excel ? (excel === 'en' ? ',' : ';') : ',');
  const bom = b ?? Boolean(excel);
  if (!Array.isArray(rows)) throw new TypeError('writeCsv: rows must be an array');
  if (![',', ';', '\t'].includes(delimiter)) throw new RangeError('writeCsv: the delimiter is , ; or a tab');
  const o = { delimiter, quoteAll, escapeFormulae };
  return (bom ? '﻿' : '') + rows.map((r) => r.map((v) => field(v, o)).join(delimiter)).join(eol);
}

export const DEFAULT_CSV_LIMITS = { maxBytes: 10 * 1024 * 1024, maxRows: 20_000, maxCols: 200, maxCells: 500_000 };

function decode(bytes, encoding, fallbackEncoding) {
  let start = 0;
  let label = encoding;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) { start = 3; label ??= 'utf-8'; }
  else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) { start = 2; label ??= 'utf-16le'; }
  else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) { start = 2; label ??= 'utf-16be'; }
  const body = bytes.subarray(start);
  const tryLabel = (l, fatal) => { try { return { text: new TextDecoder(l, { fatal }).decode(body), encoding: l }; } catch (e) { if (e instanceof RangeError) throw new CsvError('BAD_ENCODING', `unknown encoding "${l}"`); throw e; } };
  if (label) return tryLabel(label, false);
  try { return tryLabel('utf-8', true); } catch (e) { if (e.code === 'BAD_ENCODING') throw e; }
  return tryLabel(fallbackEncoding, false);
}

function detectDelimiter(text) {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let q = false;
  for (let i = 0; i < text.length && i < 64 * 1024; i++) {
    const c = text[i];
    if (c === '"') q = !q;
    else if (!q && (c === '\n' || c === '\r')) break;
    else if (!q && c in counts) counts[c] += 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0 ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ',';
}

/**
 * @param {string | Buffer | Uint8Array} input
 * @param {{encoding?: string, fallbackEncoding?: string, delimiter?: ',' | ';' | '\t' | 'auto', unescapeFormulae?: boolean, limits?: Partial<typeof DEFAULT_CSV_LIMITS>}} [opts]
 * @returns {{rows: string[][], delimiter: string, encoding: string}}
 * Every cell is a string (the caller converts: see `xlsx.mapRows`, which understands numbers and dates in text).
 */
export function parseCsv(input, { encoding, fallbackEncoding = 'windows-1251', delimiter = 'auto', unescapeFormulae = false, limits: custom = {} } = {}) {
  const limits = { ...DEFAULT_CSV_LIMITS, ...custom };
  let text; let used = 'utf-8';
  if (typeof input === 'string') { if (input.length > limits.maxBytes) throw new CsvError('TOO_BIG', 'the file is larger than allowed'); text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input; }
  else if (input instanceof Uint8Array) { if (input.length > limits.maxBytes) throw new CsvError('TOO_BIG', 'the file is larger than allowed'); ({ text, encoding: used } = decode(input, encoding, fallbackEncoding)); }
  else throw new TypeError('parseCsv: a string or bytes are required');
  const d = delimiter === 'auto' ? detectDelimiter(text) : delimiter;
  if (![',', ';', '\t'].includes(d)) throw new RangeError('parseCsv: the delimiter is , ; or a tab');

  const rows = [];
  let row = [];
  let cur = '';
  let inQ = false; let cells = 0;
  const endField = () => {
    row.push(unescapeFormulae ? unescapeFormula(cur) : cur);
    cur = '';
    if (row.length > limits.maxCols) throw new CsvError('TOO_MANY_COLS', `a row has more than ${limits.maxCols} columns`);
    if (++cells > limits.maxCells) throw new CsvError('TOO_MANY_CELLS', 'the file has too many cells');
  };
  const endRow = () => {
    endField();
    if (!(row.length === 1 && row[0] === '')) { // a blank line is not a record
      if (rows.length >= limits.maxRows) throw new CsvError('TOO_MANY_ROWS', `the file has more than ${limits.maxRows} rows`);
      rows.push(row);
    }
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += c;
    } else if (c === '"' && cur === '') inQ = true;
    else if (c === d) endField();
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; endRow(); }
    else cur += c;
  }
  if (inQ) throw new CsvError('UNTERMINATED_QUOTE', 'a quoted field is not closed');
  if (cur !== '' || row.length) endRow();
  return { rows, delimiter: d, encoding: used };
}
