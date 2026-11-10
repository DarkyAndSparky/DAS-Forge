let docxPromise;
/** The `docx` package is loaded on first use only (apps that never export Word files do not pay for it). */
function loadDocx() {
  docxPromise ??= import('docx').then((m) => m.default ?? m);
  return docxPromise;
}

const MAX_ROWS = 10_000;
const MAX_BLOCKS = 5_000;

function text(value, what) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') throw new TypeError(`buildDocx: ${what} must be text, got an object`);
  // Control characters are not valid in WordprocessingML (Word refuses to open the file).
  return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/**
 * Builds a .docx report from plain data (the `docx` package; no raw XML is
 * ever assembled from user text, so values cannot break out of the markup).
 *
 * @param {object} report
 * @param {string} report.title
 * @param {string} [report.subtitle]
 * @param {string} [report.author] - document properties
 * @param {Array<{heading?: string, paragraphs?: string[], bullets?: string[], table?: {header?: string[], rows: any[][]}}>} report.sections
 * @param {object} [opts]
 * @param {object} [opts.docx] - module override (tests)
 * @returns {Promise<Buffer>}
 */
export async function buildDocx(report, { docx } = {}) {
  if (!report || typeof report !== 'object') throw new TypeError('buildDocx: report is required');
  if (!text(report.title, 'title').trim()) throw new TypeError('buildDocx: title is required');
  if (!Array.isArray(report.sections)) throw new TypeError('buildDocx: sections must be an array');
  const d = docx ?? (await loadDocx());
  const { Document, Packer, Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell, WidthType } = d;

  const children = [new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(text(report.title, 'title'))] })];
  if (report.subtitle) children.push(new Paragraph({ children: [new TextRun({ text: text(report.subtitle, 'subtitle'), italics: true })] }));

  for (const section of report.sections) {
    if (section.heading) children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(text(section.heading, 'heading'))] }));
    for (const p of section.paragraphs ?? []) children.push(new Paragraph({ children: [new TextRun(text(p, 'paragraph'))] }));
    for (const b of section.bullets ?? []) children.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun(text(b, 'bullet'))] }));
    if (section.table) {
      const rows = section.table.rows ?? [];
      if (rows.length > MAX_ROWS) throw new RangeError(`buildDocx: a table may have at most ${MAX_ROWS} rows`);
      const cell = (value, bold) =>
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: text(value, 'table cell'), bold })] })] });
      const tableRows = [];
      if (section.table.header?.length) tableRows.push(new TableRow({ tableHeader: true, children: section.table.header.map((h) => cell(h, true)) }));
      for (const row of rows) tableRows.push(new TableRow({ children: row.map((v) => cell(v, false)) }));
      if (tableRows.length) children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: tableRows }));
    }
    if (children.length > MAX_BLOCKS + MAX_ROWS) throw new RangeError('buildDocx: report is too large');
  }

  const doc = new Document({
    creator: text(report.author ?? '', 'author'),
    title: text(report.title, 'title'),
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}
