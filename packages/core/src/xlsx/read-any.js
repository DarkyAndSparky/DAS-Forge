import { XlsxError } from './errors.js';
import { defaultZip } from './zip-backend.js';
import { DEFAULT_LIMITS, readWorkbook, normName } from './read.js';
import { readOds } from './read-ods.js';
import { readXlsb } from './read-xlsb.js';
import { readXls } from './read-xls.js';

/**
 * Reads a spreadsheet of any supported kind - .xlsx/.xlsm, .xlsb, .ods - by what the file is, not by its name (names
 * are chosen by whoever uploads). Takes the same options as `readWorkbook` and returns the same shape, so everything
 * downstream (`mapRows`, previews, imports) is the same for every format.
 *
 * `format` in the result says which reader ran: 'xlsx' | 'xlsb' | 'ods' | 'xls'.
 *
 * Two more options on top of the readers' own:
 * - `hiddenSheets`: 'include' (default) keeps hidden sheets, with `hidden: true`, and says so in `warnings`
 *   (`HIDDEN_SHEETS_READ`); 'skip' drops them (`HIDDEN_SHEETS_SKIPPED`). Hidden sheets hold data the person who made the
 *   file did not show, so an import should either show them in its preview or leave them out.
 * - `timeoutMs`: gives up with `TIMEOUT` after that long (the readers hand control back often enough to notice).
 *   For files from strangers use `readSpreadsheetIsolated`, which also bounds memory and cannot be stuck by the file.
 */
export async function readSpreadsheet(buffer, { hiddenSheets = 'include', timeoutMs, ...opts } = {}) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('readSpreadsheet: a Buffer is required');
  if (hiddenSheets !== 'include' && hiddenSheets !== 'skip') throw new RangeError("readSpreadsheet: hiddenSheets is 'include' or 'skip'");
  if (timeoutMs !== undefined) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new RangeError('readSpreadsheet: timeoutMs must be a positive number');
    const limit = AbortSignal.timeout(timeoutMs);
    opts.signal = opts.signal ? AbortSignal.any([opts.signal, limit]) : limit;
  }
  const limits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) };
  if (buffer.length > limits.maxBytes) throw new XlsxError('TOO_BIG', 'the file is larger than allowed');
  let format = 'xlsx';
  if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0xd0cf11e0) format = 'xls'; // the old container; an encrypted .xlsx is the same container and is refused inside
  else if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50) {
    // a first look at the archive's list of parts only (nothing is unpacked): the parts say what the file is
    const zip = opts.zip ?? defaultZip;
    const probe = await zip.read(buffer, { wanted: () => false, maxEntries: limits.maxEntries, maxEntryBytes: limits.maxEntryBytes, maxTotalBytes: limits.maxTotalBytes });
    const names = new Set([...probe.keys()].filter((k) => k.startsWith('#names:')).map((k) => normName(k.slice(7)).toLowerCase()));
    if (names.has('mimetype') && names.has('content.xml')) format = 'ods';
    else if ([...names].some((n) => /^xl\/workbook\.bin$/.test(n))) format = 'xlsb';
  }
  let result;
  try {
    result = await runReader(format, buffer, opts);
  } catch (e) {
    if (e?.name === 'TimeoutError') throw new XlsxError('TIMEOUT', 'reading the file took too long');
    throw e;
  }
  const hidden = result.sheets.filter((x) => x.hidden).length;
  const warnings = [...result.warnings];
  let sheets = result.sheets;
  if (hidden && hiddenSheets === 'skip') { sheets = sheets.filter((x) => !x.hidden); warnings.push({ code: 'HIDDEN_SHEETS_SKIPPED', count: hidden }); } else if (hidden) warnings.push({ code: 'HIDDEN_SHEETS_READ', count: hidden });
  return { sheets, warnings, format };
}

function runReader(format, buffer, opts) {
  const run = format === 'ods' ? readOds : format === 'xlsb' ? readXlsb : format === 'xls' ? readXls : readWorkbook;
  return run(buffer, opts);
}
