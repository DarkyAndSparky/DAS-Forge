import { Readable } from 'node:stream';
import { XlsxError } from './errors.js';
import { defaultZip } from './zip-backend.js';
import { streamTokens } from './xml.js';
import { STREAM_LIMITS } from './limits.js';
import { checkDates, openPackage, RowParser, DEFAULT_LIMITS, normName, resolveTarget, tick } from './read.js';

/** What streaming changes in the limits: rows and cells may be many (they are not kept), a sheet part may unpack to much more. */
export { STREAM_LIMITS };

/**
 * Opens one sheet of an .xlsx for reading row by row. Each row is handed over and forgotten, so the memory in use is the
 * file itself, the shared strings, and the rows of a short run of the sheet: not every row of the sheet at once. The sheet
 * part is unpacked while it is read and the unpacked size is counted (`limits.maxSheetBytes`, 1 GiB by default); the
 * archive's list is checked as for `readWorkbook`; the same refusals apply (macros, linked workbooks, encryption, a
 * document type in the XML). The file itself is still given as a Buffer, so `limits.maxBytes` (10 MiB by default) is
 * what to raise for a big export.
 *
 * @param {Buffer} buffer
 * @param {{sheet?: string|number, limits?: object, zip?: object, macros?: 'refuse'|'ignore', externalLinks?: 'refuse'|'ignore', skipHiddenRows?: boolean, display?: boolean, locale?: 'en'|'ru', signal?: AbortSignal}} [opts]
 *   `sheet`: the sheet's name, or its number from 0 (the first worksheet when left out).
 * @returns {Promise<{name: string, hidden: boolean, tables: object[], rows: AsyncGenerator<{row: number, values: any[], shown?: (string|null)[]}>, merges: object[], warnings: Array<{code: string, count: number}>}>}
 *   `rows` can be read once; `row` is the sheet's own row number (from 1), rows with nothing in them are left out; `merges` and
 *   `warnings` are complete once the rows have all been read.
 */
export async function streamSheet(buffer, { sheet, limits: custom = {}, zip = defaultZip, macros = 'refuse', externalLinks = 'refuse', skipHiddenRows = false, display = false, locale = 'en', dates = 'date', skipHiddenColumns = false, signal } = {}) {
  checkDates(dates);
  const limits = { ...STREAM_LIMITS, ...custom };
  if (!Buffer.isBuffer(buffer)) throw new TypeError('streamSheet: a Buffer is required');
  if (buffer.length > limits.maxBytes) throw new XlsxError('TOO_BIG', 'the file is larger than allowed');
  if (buffer.length >= 4 && buffer.readUInt32BE(0) === 0xd0cf11e0) throw new XlsxError('LEGACY_OR_ENCRYPTED', 'an old Excel file (.xls) or an encrypted one: save it as .xlsx without a password');
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) throw new XlsxError('NOT_A_WORKBOOK', 'the file is not a workbook');
  if (!zip.stream) throw new TypeError('streamSheet: the archive backend cannot stream');
  // the archive may claim a big sheet part (that is what `maxSheetBytes` allows) while every other part stays small
  const pkgLimits = { ...limits, maxPartBytes: custom.maxEntryBytes ?? DEFAULT_LIMITS.maxEntryBytes, maxEntryBytes: limits.maxSheetBytes, maxTotalBytes: limits.maxSheetBytes + limits.maxTotalBytes };
  const pkg = await openPackage(buffer, { limits: pkgLimits, zip, macros, externalLinks, display, locale, signal, streamSheets: true });
  const { list, rels, wbDir, shared, xfDate, xfCode, fmt, date1904, linked, parts, tablesOf } = pkg;

  const worksheets = list.map((sh) => ({ sh, rel: rels.get(sh.rid) })).filter(({ rel }) => !(rel && rel.type && !/\/worksheet$/.test(rel.type)));
  const chosen = sheet === undefined ? worksheets[0] : typeof sheet === 'number' ? worksheets[sheet] : worksheets.find(({ sh }) => sh.name === sheet);
  if (!chosen) throw new XlsxError('NO_SUCH_SHEET', 'the workbook has no such sheet');
  const path = chosen.rel ? resolveTarget(chosen.rel.target, wbDir) : null;
  if (!path) throw new XlsxError('NOT_A_WORKBOOK', `the sheet "${chosen.sh.name}" has no data part`);

  const counters = { cells: 0, formulas: 0, errors: 0, skipped: 0 };
  const parser = new RowParser({ shared, xfDate: dates === 'serial' ? [] : xfDate, xfCode, fmt, date1904, limits, skipHiddenRows, skipHiddenColumns }, counters);
  const out = { name: chosen.sh.name, hidden: chosen.sh.hidden, tables: tablesOf(path), merges: [], warnings: [], rows: null };
  const want = normName(path);

  async function* rows() {
    let source = null;
    try {
      // a sheet kept in the archive is streamed; one the package reader already had in memory (an unusual place) is fed from there
      const known = [...parts.keys()].find((k) => !k.startsWith('#names:') && normName(k) === want);
      source = known !== undefined ? Readable.from([parts.get(known)]) : await zip.stream(buffer, (n) => normName(n) === want, { maxEntries: limits.maxEntries, maxEntryBytes: limits.maxSheetBytes, maxTotalBytes: limits.maxSheetBytes + limits.maxTotalBytes, maxBytes: limits.maxSheetBytes });
      if (!source) throw new XlsxError('NOT_A_WORKBOOK', `the sheet "${chosen.sh.name}" has no data part`);
      let n = 0;
      for await (const tk of streamTokens(source, chosen.sh.name)) {
        if ((++n & 8191) === 0) { signal?.throwIfAborted(); await tick(); }
        const r = parser.feed(tk);
        if (!r) continue;
        const values = Array.from(r.values, (v) => v ?? null);
        while (values.length && values[values.length - 1] === null) values.pop();
        if (r.shown) {
          const shown = Array.from(r.shown, (v) => v ?? null);
          while (shown.length && shown[shown.length - 1] === null) shown.pop();
          yield { row: r.rowNo, values, shown };
        } else yield { row: r.rowNo, values };
      }
      out.merges = parser.merges;
      if (counters.formulas) out.warnings.push({ code: 'FORMULAS_NOT_EVALUATED', count: counters.formulas });
      if (counters.errors) out.warnings.push({ code: 'ERROR_CELLS_IGNORED', count: counters.errors });
      if (linked) out.warnings.push({ code: 'EXTERNAL_LINKS_IGNORED', count: 1 });
    } finally {
      source?.destroy?.();
    }
  }
  out.rows = rows();
  return out;
}
