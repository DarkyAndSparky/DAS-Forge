/**
 * Turns the rows of a sheet into records for an import: finds the header row, matches columns by their
 * header text, converts and checks every value, and reports each problem with its row and column so the
 * person can fix the file. Nothing is written anywhere: the caller shows a preview, then saves.
 */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const isEmpty = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.replace(/[\s\u00a0\u202f']/g, '');
  const comma = s.lastIndexOf(',');
  const dot = s.lastIndexOf('.');
  // Both marks: the last one is the decimal mark. One comma is a decimal comma (the default here); repeated ones are thousands.
  if (comma >= 0 && dot >= 0) s = comma > dot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (comma >= 0) s = s.indexOf(',') !== comma ? s.replace(/,/g, '') : s.replace(',', '.');
  else if (s.indexOf('.') !== dot) s = s.replace(/\./g, '');
  return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : null;
}

function toDate(v) {
  if (typeof v === 'number' && v >= 1 && v < 2_958_466) { // a day number from a cell that has no date format
    const d = new Date(Date.UTC(1899, 11, 30) + (v >= 1 && v < 61 ? 86_400_000 : 0) + Math.round(v * 86_400_000));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(s);
  let y; let mo; let d; let h = 0; let mi = 0;
  if (m) [, y, mo, d, h = 0, mi = 0] = m;
  else if ((m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s))) [, d, mo, y] = m;
  else return null;
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi));
  return date.getUTCFullYear() === +y && date.getUTCMonth() === +mo - 1 && date.getUTCDate() === +d ? date : null;
}

const LETTERS = /^[A-Za-z]{1,3}$/;
/** A column given as 0-based number or as letters ("C", "AB") -> 0-based number, or -1. */
function columnOf(ix) {
  if (Number.isInteger(ix) && ix >= 0 && ix < 16_384) return ix;
  if (typeof ix === 'string' && LETTERS.test(ix)) { let n = 0; for (const ch of ix.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1 < 16_384 ? n - 1 : -1; }
  return -1;
}

/** The allowed value a mistyped one is probably meant to be (a few letters off), or null. Bounded: short texts, short lists. */
function nearest(val, allowed) {
  if (typeof val !== 'string' || val.length < 4 || val.length > 64) return null;
  const a = val.toLowerCase(); const limit = Math.min(3, Math.max(1, Math.floor(a.length / 3)));
  let best = null; let bestD = limit + 1;
  for (const cand of allowed.slice(0, 200)) {
    if (typeof cand !== 'string' || cand.length > 64 || Math.abs(cand.length - a.length) > limit) continue;
    const b = cand.toLowerCase();
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    if (prev[b.length] < bestD) { bestD = prev[b.length]; best = cand; }
  }
  return best;
}

/** The longest text a `pattern` is run on when the column sets no `max`. */
export const PATTERN_DEFAULT_MAX = 1000;

/** `test` on a regular expression with the g or y flag remembers where it stopped, so the same text gives different answers row to row: use one without them. */
const patterns = new WeakMap();
function patternFor(re) {
  let p = patterns.get(re);
  if (!p) { p = /[gy]/.test(re.flags) ? new RegExp(re.source, re.flags.replace(/[gy]/g, '')) : re; patterns.set(re, p); }
  return p;
}

/**
 * @param {any[][]} rows - from `readWorkbook`
 * @param {{columns: Record<string, {header: string|string[], type?: 'string'|'number'|'integer'|'date'|'boolean', required?: boolean, max?: number, min?: number, allowed?: any[], pattern?: RegExp, default?: any, unique?: boolean, normalize?: (value: any) => any}>}} spec
 * @param {{maxErrors?: number, maxRecords?: number, headerSearchRows?: number, table?: {r1:number,c1:number,r2:number,c2:number,headerRow:boolean,totalsRow:boolean}, header?: boolean, headerRow?: number, firstRow?: number, schema?: {safeParse: Function}}} [opts]
 * Each column may also set `index` (0-based number or letters such as "C"): the column to read when the header text is
 * not found, or the only way to find it when `header: false` (a sheet without a header; data starts at `firstRow`, default 1).
 * `validate(value, data)` runs last and returns nothing/true when fine, a code (string) or false when not.
 * `schema` (a Zod schema, or anything with `safeParse`) is the second step: it runs on each row that passed the column rules,
 * sees only the mapped values, may transform them (the parsed value is what is returned), and a failure is a `SCHEMA` error
 * per issue (`column` = the key the issue points at, `hint` = its message). Use a synchronous schema.
 * `table` (from `sheet.tables`) restricts the reading to that Excel table and takes its first row as the header;
 * `headerRow` (1-based) names the header row outright.
 * @returns {{headerRow: number|null, records: Array<{row: number, data: object}>, errors: Array<{row: number, column: string|null, code: string}>, missingColumns: string[], unknownColumns: string[], duplicateColumns: string[], truncated: boolean}}
 */
export function mapRows(allRows, spec, { maxErrors = 100, maxRecords = 20_000, headerSearchRows = 10, table, header = true, headerRow: forcedHeader, firstRow = 1, schema } = {}) {
  if (schema !== undefined && typeof schema?.safeParse !== 'function') throw new TypeError('mapRows: schema needs a safeParse method (a Zod schema)');
  let rows = allRows; let offset = 0;
  if (table && Number.isInteger(table.r1) && Number.isInteger(table.r2) && table.r1 >= 1 && table.r2 >= table.r1) {
    const end = table.r2 - (table.totalsRow ? 1 : 0);
    offset = table.r1 - 1;
    rows = allRows.slice(offset, end).map((r) => (r ?? []).map((v, i) => (i < table.c1 || i > table.c2 ? null : v)));
    if (table.headerRow) forcedHeader ??= 1; // the first row of the table, in the view
    else header = header && forcedHeader !== undefined;
  }
  const keys = Object.keys(spec.columns);
  const aliases = new Map(); // normalised header -> key
  for (const k of keys) for (const h of [].concat(spec.columns[k].header ?? k)) aliases.set(norm(h), k);

  let headerRow = -1;
  let best = 0;
  if (header === false) {
    // no header: columns are found by `index`, the data starts at `firstRow`
    headerRow = Math.max(0, firstRow - 2);
    best = 1;
  } else if (Number.isInteger(forcedHeader) && forcedHeader >= 1) { headerRow = forcedHeader - 1; best = 1; }
  else {
    for (let i = 0; i < Math.min(rows.length, headerSearchRows); i++) {
      const hits = new Set((rows[i] ?? []).map((c) => aliases.get(norm(c))).filter(Boolean)).size;
      if (hits > best) { best = hits; headerRow = i; }
    }
  }
  const noHeader = header === false;
  const result = { headerRow: headerRow >= 0 && !noHeader ? headerRow + offset + 1 : null, records: [], errors: [], missingColumns: [], unknownColumns: [], duplicateColumns: [], truncated: false };
  if (headerRow < 0) { result.missingColumns = keys.filter((k) => spec.columns[k].required); result.errors.push({ row: 1, column: null, code: 'NO_HEADER' }); return result; }

  const at = new Map(); // key -> column index
  (noHeader ? [] : rows[headerRow] ?? []).forEach((c, i) => {
    const k = aliases.get(norm(c));
    if (k && !at.has(k)) at.set(k, i);
    else if (k) result.duplicateColumns.push(String(c));
    else if (!isEmpty(c)) result.unknownColumns.push(String(c));
  });
  for (const k of keys) if (!at.has(k) && spec.columns[k].index !== undefined) { const c = columnOf(spec.columns[k].index); if (c >= 0) at.set(k, c); }
  result.missingColumns = keys.filter((k) => spec.columns[k].required && !at.has(k));
  if (result.missingColumns.length) {
    for (const k of result.missingColumns) result.errors.push({ row: headerRow + offset + 1, column: k, code: 'MISSING_COLUMN' });
    return result;
  }

  const startRow = noHeader ? Math.max(0, firstRow - 1) : headerRow + 1;
  const seen = new Map(keys.filter((k) => spec.columns[k].unique).map((k) => [k, new Set()]));
  const fail = (row, column, code, hint) => { if (result.errors.length < maxErrors) result.errors.push(hint ? { row, column, code, hint } : { row, column, code }); else result.truncated = true; };
  for (let i = startRow; i < rows.length; i++) {
    const raw = rows[i] ?? [];
    if (raw.every(isEmpty)) continue;
    const rowNo = i + offset + 1;
    const data = {};
    const pending = [];
    let ok = true;
    for (const k of keys) {
      const def = spec.columns[k];
      const v = at.has(k) ? raw[at.get(k)] : null;
      if (isEmpty(v)) {
        if (def.default !== undefined) data[k] = def.default;
        else if (def.required) { fail(rowNo, k, 'REQUIRED'); ok = false; } else data[k] = null;
        continue;
      }
      let val;
      const type = def.type ?? 'string';
      if (type === 'number' || type === 'integer') {
        val = toNumber(v);
        if (val === null) { fail(rowNo, k, 'NOT_A_NUMBER'); ok = false; continue; }
        if (type === 'integer' && !Number.isInteger(val)) { fail(rowNo, k, 'NOT_AN_INTEGER'); ok = false; continue; }
        if ((def.min !== undefined && val < def.min) || (def.max !== undefined && val > def.max)) { fail(rowNo, k, 'OUT_OF_RANGE'); ok = false; continue; }
      } else if (type === 'date') {
        val = toDate(v);
        if (val === null) { fail(rowNo, k, 'NOT_A_DATE'); ok = false; continue; }
      } else if (type === 'boolean') {
        const s = norm(v);
        val = v === true || ['1', 'true', 'yes', 'да', 'истина'].includes(s) ? true : v === false || ['0', 'false', 'no', 'нет', 'ложь'].includes(s) ? false : null;
        if (val === null) { fail(rowNo, k, 'NOT_A_BOOLEAN'); ok = false; continue; }
      } else {
        val = (v instanceof Date ? v.toISOString() : String(v)).replace(CONTROL, '').trim();
        // a pattern is the application's regular expression run on text from a file: the text is cut to a known length
        // first (the column's `max`, or PATTERN_DEFAULT_MAX), so a pattern that backtracks badly cannot be fed a huge cell
        if (val.length > (def.max ?? (def.pattern ? PATTERN_DEFAULT_MAX : Infinity))) { fail(rowNo, k, 'TOO_LONG'); ok = false; continue; }
        if (def.pattern && !patternFor(def.pattern).test(val)) { fail(rowNo, k, 'BAD_FORMAT'); ok = false; continue; }
      }
      if (typeof def.normalize === 'function') val = def.normalize(val);
      if (def.allowed && !def.allowed.includes(val)) { fail(rowNo, k, 'NOT_ALLOWED', nearest(val, def.allowed)); ok = false; continue; }
      if (typeof def.validate === 'function') {
        const verdict = def.validate(val, data);
        if (verdict !== undefined && verdict !== null && verdict !== true) { fail(rowNo, k, typeof verdict === 'string' && verdict ? verdict : 'INVALID'); ok = false; continue; }
      }
      if (seen.has(k)) {
        const key = val instanceof Date ? val.getTime() : String(val).toLowerCase();
        if (seen.get(k).has(key)) { fail(rowNo, k, 'DUPLICATE'); ok = false; continue; }
        pending.push([k, key]);
      }
      data[k] = val;
    }
    // the second step: the application's Zod schema runs on the row that passed the column rules. It sees only the
    // mapped values (never the sheet), may transform them (the parsed result is what is returned), and a failure is one
    // SCHEMA error per issue, tied to the column the issue points at.
    let out = data;
    if (ok && schema) {
      let parsed = null;
      try { parsed = schema.safeParse(data); } catch { fail(rowNo, null, 'SCHEMA_ERROR'); ok = false; }
      if (ok && parsed && parsed.success) out = parsed.data;
      else if (ok) {
        ok = false;
        for (const issue of (parsed?.error?.issues ?? []).slice(0, 20)) {
          const first = issue.path?.[0];
          const hint = String(issue.message ?? '').replace(CONTROL, '').slice(0, 200);
          fail(rowNo, typeof first === 'string' && keys.includes(first) ? first : null, 'SCHEMA', hint || undefined);
        }
        if (!(parsed?.error?.issues ?? []).length) fail(rowNo, null, 'SCHEMA');
      }
    }
    if (ok) for (const [k, key] of pending) seen.get(k).add(key);
    if (ok) {
      if (result.records.length >= maxRecords) { result.truncated = true; break; }
      result.records.push({ row: rowNo, data: out });
    }
  }
  return result;
}
