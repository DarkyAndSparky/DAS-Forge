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
// audit S-06: also after leading blanks or invisible characters, and in the full-width forms
const TRIGGER = /^[\s\u200b-\u200f\u2028\u2029\ufeff]*[=+\-@\uff1d\uff0b\uff0d\uff20|]|^[\t\r\n]/;
const DANGEROUS = /^[\s\u200b-\u200f\ufeff'"]*[=+\-@\uff1d\uff0b\uff0d\uff20]\s*(?:cmd|HYPERLINK|IMPORT\w+|IMAGE|WEBSERVICE|DDE)\b/i;

/** @param {string} s */
export function isFormulaText(s) { return typeof s === 'string' && (TRIGGER.test(s) || DANGEROUS.test(s)); }
// a text that already begins with apostrophes before a formula ("'=1") also gets one more, or reading would take it for an escaped "=1"
const needsApostrophe = (s) => isFormulaText(s) || (s[0] === "'" && isFormulaText(s.replace(/^'+/, '')));
/** Prefix a text that would run as a formula with an apostrophe. @param {string} s */
export function escapeFormula(s) { return typeof s === 'string' && needsApostrophe(s) ? `'${s}` : s; }
/** Undo {@link escapeFormula}, only where it would have added the apostrophe. @param {string} s */
export function unescapeFormula(s) { return typeof s === 'string' && s.length > 1 && s[0] === "'" && needsApostrophe(s.slice(1)) ? s.slice(1) : s; }

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

const LEGACY_ENCODINGS = ['windows-1251', 'ibm866', 'koi8-r'];
const lowerCyr = /[\u0430-\u044f\u0451]/g;
const upperCyr = /[\u0410-\u042f\u0401]/g;
const oddMarks = /[\u2500-\u257f\u0080-\u009f\u00c0-\u00ff\u0402-\u040f\u0452-\u045f\u0490-\u04ff]/g;

/** Which old Russian code page the bytes are: the one whose reading looks most like Russian text (small letters dominate, no box-drawing signs). */
function guessLegacy(body) {
  const sample = body.subarray(0, 64 * 1024);
  let best = null;
  for (const l of LEGACY_ENCODINGS) {
    let text;
    try { text = new TextDecoder(l).decode(sample); } catch { continue; }
    const score = (text.match(lowerCyr)?.length ?? 0) - (text.match(upperCyr)?.length ?? 0) * 0.7 - (text.match(oddMarks)?.length ?? 0) * 1.5;
    if (!best || score > best.score) best = { label: l, score };
  }
  return best && best.score > 0 ? best.label : null;
}

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
  // not UTF-8: with a fallback named by the caller use that; otherwise look at which old Russian code page it is
  if (fallbackEncoding) return { ...tryLabel(fallbackEncoding, false), guessed: false };
  const guess = guessLegacy(body);
  return { ...tryLabel(guess ?? 'windows-1251', false), guessed: guess !== null };
}

const DELIMITERS = [',', ';', '\t', '|'];

/**
 * Looks at the first lines (up to 30, quotes respected), not only the first: a delimiter is the character that stands the
 * same number of times in the most lines. `confident` is false when there is no such character or the lines disagree
 * (one column, or a text with commas inside), so the caller can say it was a guess.
 */
function detectDelimiter(text) {
  const lines = [];
  let counts = { ',': 0, ';': 0, '\t': 0, '|': 0 };
  let q = false; let any = false;
  for (let i = 0; i < text.length && i < 128 * 1024 && lines.length < 30; i++) {
    const c = text[i];
    if (c === '"') { q = !q; any = true; } else if (!q && (c === '\n' || c === '\r')) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (any) lines.push(counts);
      counts = { ',': 0, ';': 0, '\t': 0, '|': 0 }; any = false;
    } else if (!q && c in counts) { counts[c] += 1; any = true; } else if (!q || c !== '\n') any = true;
  }
  if (any) lines.push(counts);
  let best = null;
  for (const d of DELIMITERS) {
    const first = lines[0]?.[d] ?? 0;
    if (first === 0) continue;
    const same = lines.filter((l) => l[d] === first).length / lines.length;
    const score = same * 100 + first; // consistency first, then how many columns it makes
    if (!best || score > best.score) best = { d, score, same };
  }
  return best ? { delimiter: best.d, confident: best.same >= 0.8 || lines.length === 1 } : { delimiter: ',', confident: false };
}

/**
 * @param {string | Buffer | Uint8Array} input
 * @param {{encoding?: string, fallbackEncoding?: string, delimiter?: ',' | ';' | '\t' | '|' | 'auto', unescapeFormulae?: boolean, limits?: Partial<typeof DEFAULT_CSV_LIMITS>}} [opts]
 * @returns {{rows: string[][], delimiter: string, encoding: string, warnings: Array<{code: string}>}}
 * `warnings`: ENCODING_GUESSED (not UTF-8: which old Russian code page was chosen, `encoding`), DELIMITER_GUESSED (the lines do not agree on one; `delimiter`),
 * SEP_HINT_USED (the first line was Excel's `sep=;` and was taken as the delimiter), RAGGED_ROWS (rows of different width, `count`).
 * Delimiters: comma, semicolon, tab, pipe; leave `delimiter: 'auto'` for 1C and Excel exports in any of them. Without `fallbackEncoding` an
 * old file is read as whichever of windows-1251, cp866 and koi8-r looks like Russian text.
 * Every cell is a string (the caller converts: see `xlsx.mapRows`, which understands numbers and dates in text).
 */
export function parseCsv(input, { encoding, fallbackEncoding, delimiter = 'auto', unescapeFormulae = false, limits: custom = {} } = {}) {
  const limits = { ...DEFAULT_CSV_LIMITS, ...custom };
  let text; let used = 'utf-8'; let guessedEnc = false;
  const warnings = [];
  if (typeof input === 'string') { if (input.length > limits.maxBytes) throw new CsvError('TOO_BIG', 'the file is larger than allowed'); text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input; }
  else if (input instanceof Uint8Array) { if (input.length > limits.maxBytes) throw new CsvError('TOO_BIG', 'the file is larger than allowed'); ({ text, encoding: used, guessed: guessedEnc } = decode(input, encoding, fallbackEncoding)); }
  else throw new TypeError('parseCsv: a string or bytes are required');
  if (guessedEnc) warnings.push({ code: 'ENCODING_GUESSED', encoding: used });
  let d = delimiter;
  if (delimiter === 'auto') {
    const hint = /^sep=(.)[ \t]*(?:\r\n|\n|\r)/i.exec(text);
    if (hint && DELIMITERS.includes(hint[1])) { d = hint[1]; text = text.slice(hint[0].length); warnings.push({ code: 'SEP_HINT_USED', delimiter: d }); } else {
      const found = detectDelimiter(text);
      d = found.delimiter;
      if (!found.confident) warnings.push({ code: 'DELIMITER_GUESSED', delimiter: d });
    }
  }
  if (!DELIMITERS.includes(d)) throw new RangeError('parseCsv: the delimiter is , ; a tab or |');

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
  const width = rows.length ? rows[0].length : 0;
  const ragged = rows.filter((r) => r.length !== width).length;
  if (ragged) warnings.push({ code: 'RAGGED_ROWS', count: ragged });
  return { rows, delimiter: d, encoding: used, warnings };
}
