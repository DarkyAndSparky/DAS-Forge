/**
 * Every size limit of the spreadsheet module in one place, with what each one protects against.
 * Reading: `DEFAULT_LIMITS` (whole workbook in memory) and `STREAM_LIMITS` (one sheet read row by row). Any of them can
 * be raised per call with `limits: { ... }`. Writing: `WRITE_LIMITS`, which follow Excel's own ceilings and are fixed.
 */

export const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 10 * 1024 * 1024,
  maxEntries: 200,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
  maxSheets: 50,
  maxRows: 20_000,
  maxCols: 200,
  maxCells: 500_000,
  maxSharedStrings: 500_000,
});

export const STREAM_LIMITS = Object.freeze({ ...DEFAULT_LIMITS, maxRows: 1_048_576, maxCells: 20_000_000, maxSheetBytes: 1024 * 1024 * 1024 });

export const WRITE_LIMITS = Object.freeze({
  maxRows: 1_048_575, // Excel's 1,048,576 rows, minus the header
  maxCols: 16_384,
  maxCellChars: 32_767,
  maxLinks: 65_530,
  maxMerges: 1000,
  maxStyles: 1000,
  maxRuleStyles: 500,
  maxRuleText: 255,
  maxListChars: 255,
  maxSheets: 50,
});

/** What each limit is for, in plain words (for documentation and error help). */
export const LIMIT_NOTES = Object.freeze({
  maxBytes: 'size of the uploaded file; the first and cheapest check. Raise it for big exports.',
  maxEntries: 'number of parts in the archive; stops archives made of millions of tiny parts.',
  maxEntryBytes: 'one part unpacked; stops a small file that unpacks into gigabytes (a "zip bomb").',
  maxTotalBytes: 'all parts unpacked together; the same protection for many parts.',
  maxSheets: 'sheets read; each one is parsed, so each one costs time.',
  maxRows: 'rows per sheet kept in memory.',
  maxCols: 'columns per sheet; a single cell at column XFD would otherwise make every row 16,384 wide.',
  maxCells: 'non-empty cells in the whole workbook.',
  maxSharedStrings: 'entries of the shared string table.',
  maxSheetBytes: 'one sheet unpacked, in streaming reads (the sheet is counted as it is unpacked, never held whole).',
  maxPartBytes: 'a part read into memory in a streaming read (styles, strings); sheets are not counted here.',
});
