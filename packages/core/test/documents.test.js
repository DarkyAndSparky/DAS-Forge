import { describe, it, expect } from 'vitest';
import { defaultZip } from '../src/xlsx/zip-backend.js';
import { readDocument, inspectDocument, readDocumentIsolated, DocumentError, isPdf } from '../src/documents/index.js';

const zipOf = (files) => defaultZip.write(Object.entries(files).map(([n, c]) => [n, Buffer.from(c)]));
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const docx = (body, extra = {}) => zipOf({
  '[Content_Types].xml': '<Types/>',
  'word/document.xml': `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`,
  'docProps/core.xml': '<cp:coreProperties xmlns:cp="c" xmlns:dc="d" xmlns:dcterms="t"><dc:title>Отчёт</dc:title><dc:creator>Анна</dc:creator></cp:coreProperties>',
  ...extra,
});
const p = (t, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t>${t}</w:t></w:r></w:p>`;

describe('readDocument: docx', () => {
  it('reads headings, paragraphs, tables and properties', async () => {
    const buf = await docx(p('Итоги', 'Heading1') + p('Первая &amp; вторая') + '<w:tbl><w:tr><w:tc>' + p('A') + '</w:tc><w:tc>' + p('B') + '</w:tc></w:tr></w:tbl>');
    const r = await readDocument(buf);
    expect(r.format).toBe('docx');
    expect(r.blocks).toEqual([{ type: 'heading', level: 1, text: 'Итоги' }, { type: 'paragraph', text: 'Первая & вторая' }, { type: 'table', rows: [['A', 'B']] }]);
    expect(r.text).toContain('A\tB');
    expect(r.metadata).toEqual({ title: 'Отчёт', author: 'Анна' });
  });
  it('leaves hidden text out and says so', async () => {
    const buf = await docx(`<w:p><w:r><w:t>видно</w:t></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:t>скрыто</w:t></w:r></w:p>`);
    const r = await readDocument(buf);
    expect(r.text).toBe('видно');
    expect(r.warnings).toContainEqual({ code: 'HIDDEN_TEXT' });
  });
  it('refuses macros unless told to ignore them, and reports links and embedded parts', async () => {
    const m = await docx(p('x'), { 'word/vbaProject.bin': 'x' });
    await expect(readDocument(m)).rejects.toMatchObject({ code: 'MACROS' });
    expect((await readDocument(m, { macros: 'ignore' })).safety.macros).toBe(true);
    const l = await docx(p('x'), { 'word/_rels/document.xml.rels': '<Relationships><Relationship Id="1" Type="http://x/attachedTemplate" Target="http://evil/t.dotm" TargetMode="External"/></Relationships>', 'word/embeddings/o.bin': 'x' });
    const r = await readDocument(l);
    expect(r.safety.externalLinks).toEqual([{ kind: 'attachedTemplate', target: 'http://evil/t.dotm' }]);
    expect(r.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['EXTERNAL_LINKS', 'EMBEDDED_OBJECTS']));
    await expect(readDocument(l, { externalLinks: 'refuse' })).rejects.toMatchObject({ code: 'EXTERNAL_LINKS' });
    await expect(readDocument(l, { embedded: 'refuse' })).rejects.toMatchObject({ code: 'EMBEDDED_OBJECTS' });
  });
  it('refuses a document type declaration and files that are not documents', async () => {
    const bomb = await docx('<!DOCTYPE x [<!ENTITY a "b">]>' + p('x'));
    await expect(readDocument(bomb)).rejects.toMatchObject({ code: 'UNSAFE_XML' });
    await expect(readDocument(Buffer.from('hello world'))).rejects.toMatchObject({ code: 'NOT_A_DOCUMENT' });
    await expect(readDocument(await zipOf({ 'a.txt': 'x' }))).rejects.toMatchObject({ code: 'NOT_A_DOCUMENT' });
    await expect(readDocument(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.alloc(16)]))).rejects.toBeInstanceOf(DocumentError);
  });
  it('stops at the size limits', async () => {
    const buf = await docx(p('x'.repeat(500)));
    const r = await readDocument(buf, { limits: { maxChars: 100 } });
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBe(100);
    await expect(readDocument(buf, { limits: { maxBytes: 10 } })).rejects.toMatchObject({ code: 'TOO_BIG' });
  });
  it('inspectOnly gives safety and properties without text', async () => {
    const r = await inspectDocument(await docx(p('секрет'), { 'word/vbaProject.bin': 'x' }));
    expect(r.text).toBe('');
    expect(r.safety.macros).toBe(true);
    expect(r.metadata.title).toBe('Отчёт');
  });
  it('works in an isolated thread', async () => {
    const r = await readDocumentIsolated(await docx(p('привет')), { timeoutMs: 10_000 });
    expect(r.text).toBe('привет');
    await expect(readDocumentIsolated(await docx(p('x'), { 'word/vbaProject.bin': 'x' }))).rejects.toMatchObject({ code: 'MACROS' });
  });
});

describe('readDocument: pptx', () => {
  const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="p"';
  const slide = (t) => `<p:sld ${A}><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  it('reads slides in numeric order with notes', async () => {
    const buf = await zipOf({
      'ppt/slides/slide10.xml': slide('десять'), 'ppt/slides/slide2.xml': slide('два'), 'ppt/slides/slide1.xml': slide('один'),
      'ppt/notesSlides/notesSlide2.xml': slide('заметка'),
    });
    const r = await readDocument(buf);
    expect(r.format).toBe('pptx');
    expect(r.blocks.map((b) => [b.slide, b.type, b.text])).toEqual([[1, 'paragraph', 'один'], [2, 'paragraph', 'два'], [2, 'note', 'заметка'], [10, 'paragraph', 'десять']]);
  });
});

describe('readDocument: OpenDocument', () => {
  const T = 'xmlns:office="o" xmlns:text="t" xmlns:table="tb"';
  const odf = (mime, body, extra = {}) => zipOf({
    mimetype: mime,
    'content.xml': `<office:document-content ${T}><office:body>${body}</office:body></office:document-content>`,
    'meta.xml': '<office:document-meta xmlns:office="o" xmlns:dc="d" xmlns:meta="m"><office:meta><dc:title>Док</dc:title><meta:initial-creator>Борис</meta:initial-creator></office:meta></office:document-meta>',
    ...extra,
  });
  it('reads an .odt with headings, spaces, tables and skips comments', async () => {
    const buf = await odf('application/vnd.oasis.opendocument.text',
      '<office:text><text:h text:outline-level="2">Глава</text:h><text:p>а<text:s text:c="2"/>б<text:tab/>в<office:annotation><text:p>ЗАМЕТКА</text:p></office:annotation></text:p>'
      + '<table:table><table:table-row><table:table-cell><text:p>1</text:p></table:table-cell><table:table-cell><text:p>2</text:p></table:table-cell></table:table-row></table:table></office:text>');
    const r = await readDocument(buf);
    expect(r.format).toBe('odt');
    expect(r.blocks).toEqual([{ type: 'heading', level: 2, text: 'Глава' }, { type: 'paragraph', text: 'а  б\tв' }, { type: 'table', rows: [['1', '2']] }]);
    expect(r.metadata).toMatchObject({ title: 'Док', author: 'Борис' });
  });
  it('numbers the pages of an .odp, refuses macros and encryption', async () => {
    const buf = await odf('application/vnd.oasis.opendocument.presentation', '<office:presentation><draw:page xmlns:draw="d"><text:p>один</text:p></draw:page><draw:page xmlns:draw="d"><text:p>два</text:p></draw:page></office:presentation>');
    const r = await readDocument(buf);
    expect(r.blocks.map((b) => [b.slide, b.text])).toEqual([[1, 'один'], [2, 'два']]);
    const m = await odf('application/vnd.oasis.opendocument.text', '<office:text><text:p>x</text:p></office:text>', { 'Basic/Standard/Module1.xml': 'x' });
    await expect(readDocument(m)).rejects.toMatchObject({ code: 'MACROS' });
    const e = await odf('application/vnd.oasis.opendocument.text', '<office:text><text:p>x</text:p></office:text>', { 'META-INF/manifest.xml': '<manifest><encryption-data/></manifest>' });
    await expect(readDocument(e)).rejects.toMatchObject({ code: 'ENCRYPTED' });
    await expect(readDocument(await odf('application/vnd.oasis.opendocument.spreadsheet', ''))).rejects.toMatchObject({ code: 'NOT_A_DOCUMENT' });
  });
});

describe('readDocument: PDF', () => {
  const pdf = Buffer.from('%PDF-1.7\n%%EOF');
  it('is refused with a clear code when no PDF reader is plugged in', async () => {
    await expect(readDocument(pdf)).rejects.toMatchObject({ code: 'PDF_READER_MISSING' });
  });
  it('is handed to readers.pdf with the options of the call', async () => {
    let seen;
    const r = await readDocument(pdf, { macros: 'ignore', readers: { pdf: async (b, o) => { seen = o; return { format: 'pdf', text: 'ok' }; } } });
    expect(r.format).toBe('pdf');
    expect(seen).toMatchObject({ macros: 'ignore', externalLinks: 'allow' });
  });
  it('is recognised by its start, not by what follows', () => {
    expect(isPdf(Buffer.from('junk%PDF-1.4'))).toBe(true);
    expect(isPdf(Buffer.from('PK\u0003\u0004'))).toBe(false);
  });
});
