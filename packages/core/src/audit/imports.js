import { createHash } from 'node:crypto';
import { log } from './log.js';

/**
 * Writes one audit entry for a spreadsheet import: who loaded which file (by SHA-256, not by content), how many rows
 * were read, accepted and rejected, and which error codes were seen. It goes through `log()`, so it has the same chain,
 * pseudonyms and retention as every other entry; nothing here stores a cell value, a header, a hint or an error text.
 *
 * Pass what the import already has: the file `buffer`, the `read` result of `readSpreadsheet`/`readWorkbook`, the
 * `mapped` result of `mapRows`, or an `error` (anything thrown, its `code` is kept) when the file was refused before
 * mapping. `fileName` is stored only if given (a name can hold a person's name; leave it out when it may).
 *
 * @param db - a DatabaseAdapter
 * @param {object} ctx - `{actor, requestId, ip}`, e.g. `contextFromRequest(req)`
 * @param {{buffer?: Buffer, fileName?: string, read?: object, mapped?: object, error?: any, action?: string, entity?: string, entityId?: string|number}} what
 */
export function logSpreadsheetImport(db, ctx, { buffer, fileName, read, mapped, error, action = 'import.spreadsheet', entity = 'import', entityId } = {}) {
  const meta = {};
  if (buffer) { meta.bytes = buffer.length; meta.sha256 = createHash('sha256').update(buffer).digest('hex'); }
  if (typeof fileName === 'string' && fileName) meta.fileName = fileName.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200);
  if (read) {
    if (read.format) meta.format = read.format;
    meta.sheets = Array.isArray(read.sheets) ? read.sheets.length : 0;
    meta.rowsRead = (read.sheets ?? []).reduce((n, s) => n + (s.rows?.length ?? 0), 0);
    if (read.warnings?.length) meta.warnings = Object.fromEntries(read.warnings.map((w) => [String(w.code), Number(w.count) || 0]));
  }
  let failed = false;
  if (mapped) {
    const errors = mapped.errors ?? [];
    meta.accepted = mapped.records?.length ?? 0;
    meta.rejectedRows = new Set(errors.filter((e) => Number.isInteger(e.row)).map((e) => e.row)).size;
    const codes = {};
    for (const e of errors) codes[String(e.code)] = (codes[String(e.code)] ?? 0) + 1;
    if (errors.length) meta.errorCodes = codes;
    if (mapped.truncated) meta.truncated = true;
    if (mapped.missingColumns?.length) meta.missingColumns = mapped.missingColumns.length;
    failed = meta.accepted === 0 && errors.length > 0;
  }
  if (error) { failed = true; meta.errorCode = String(error?.code ?? error?.name ?? 'ERROR').slice(0, 60); }
  return log(db, { ...ctx, action, entity, entityId: entityId ?? null, result: failed ? 'failure' : 'success', meta });
}
