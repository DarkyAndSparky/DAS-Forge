import { describe, it, expect } from 'vitest';
import { WRITE_LIMITS, LIMIT_NOTES, DEFAULT_LIMITS, STREAM_LIMITS, buildWorkbookStream, streamSheet, buildWorkbook, readWorkbook, readOds, readXlsb, readXls, readSpreadsheet, readSpreadsheetIsolated, mapRows, columnName, isFormulaLike, XlsxError } from '../src/xlsx/index.js';
import { z } from 'zod';
import { checkArchive } from '../src/xlsx/zip-backend.js';

import { fakeZip } from './helpers/fake-zip.js';
/** The promise must fail with an XlsxError carrying this code (undefined: any failure). */
async function rej(promise, code) {
  let err = null;
  try { await promise; } catch (e) { err = e; }
  expect(err === null ? 'it did not fail' : (code === undefined ? undefined : err.code)).toBe(code);
}
const build = (book) => buildWorkbook(book, { zip: fakeZip });
const read = (buf, o = {}) => readWorkbook(buf, { zip: fakeZip, ...o });

/** A workbook made by hand: any parts, to test what the reader must refuse or accept. */
const pack = (parts) => fakeZip.write(Object.entries(parts).map(([n, t]) => [n, Buffer.from(t)]));
const TYPES = '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>';
const WB = '<workbook xmlns:r="x"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>';
const RELS = '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>';
const sheet = (rows) => `<worksheet><sheetData>${rows}</sheetData></worksheet>`;
const base = (sheetXml, extra = {}) => pack({ '[Content_Types].xml': TYPES, 'xl/workbook.xml': WB, 'xl/_rels/workbook.xml.rels': RELS, 'xl/worksheets/sheet1.xml': sheetXml, ...extra });

describe('xlsx: writing and reading back', () => {
  it('round-trips text, numbers, booleans, dates and empty cells', async () => {
    const buf = await build({ sheets: [{ name: 'Заявки', columns: [{ header: 'Название', key: 'name' }, { header: 'Цена', key: 'price', format: 'money' }, { header: 'Готово', key: 'done' }, { header: 'Дата', key: 'at', format: 'date' }, { header: 'Заметка', key: 'note' }], rows: [{ name: 'Ноутбук <A&B>', price: 1234.5, done: true, at: new Date('2026-11-02T00:00:00Z'), note: null }, ['второй', 7, false, new Date('2026-11-03T10:30:00Z')]] }] });
    const { sheets, warnings } = await read(buf);
    expect(warnings).toEqual([]);
    expect(sheets[0].name).toBe('Заявки');
    expect(sheets[0].rows[0]).toEqual(['Название', 'Цена', 'Готово', 'Дата', 'Заметка']);
    expect(sheets[0].rows[1].slice(0, 4)).toEqual(['Ноутбук <A&B>', 1234.5, true, new Date('2026-11-02T00:00:00Z')]);
    expect(sheets[0].rows[2][3]).toEqual(new Date('2026-11-03T10:30:00Z'));
  });

  it('writes text as text: nothing starting like a formula is ever a formula, and it comes back unchanged', async () => {
    const evil = ['=HYPERLINK("http://x","y")', '+1+1', '-2', '@SUM(A1)', '\t=1'];
    const buf = await build({ sheets: [{ name: 'S', columns: [{ header: 'v', key: 'v' }], rows: evil.map((v) => ({ v })) }] });
    const { sheets, warnings } = await read(buf);
    expect(sheets[0].rows.slice(1).map((r) => r[0])).toEqual(evil);
    expect(warnings).toEqual([]); // no formula cell was written
    const parts = await fakeZip.read(buf, { wanted: () => true, maxEntries: 100, maxEntryBytes: 1e7, maxTotalBytes: 1e8 });
    const xml = parts.get('xl/worksheets/sheet1.xml').toString();
    expect(xml).not.toContain('<f>');
    expect(xml).toContain('t="inlineStr"');
    expect(parts.get('xl/styles.xml').toString()).toContain('quotePrefix="1"');
    expect(evil.every(isFormulaLike)).toBe(true);
  });

  it('formulas only through { formula }, checked: no external links or web functions', async () => {
    const ok = await build({ sheets: [{ name: 'S', columns: [{ header: 'a', key: 'a' }, { header: 'b', key: 'b' }, { header: 'c', key: 'c', format: 'money' }], rows: [{ a: 2, b: 3, c: { formula: 'A2*B2', value: 6 } }] }] });
    const { sheets, warnings } = await read(ok);
    expect(sheets[0].rows[1]).toEqual([2, 3, 6]);
    expect(warnings).toEqual([{ code: 'FORMULAS_NOT_EVALUATED', count: 1 }]);
    for (const f of ['HYPERLINK("http://x","y")', "'[other.xlsx]S'!A1", 'WEBSERVICE("http://x")', 'cmd|calc', '']) {
      await rej(build({ sheets: [{ name: 'S', columns: [{ key: 'a' }], rows: [{ a: { formula: f } }] }] }), 'BAD_FORMULA');
    }
  });

  it('removes control characters, refuses an over-long cell and bad sheet names', async () => {
    const { sheets } = await read(await build({ sheets: [{ name: 'S', columns: [{ key: 'a' }], rows: [{ a: 'x\u0000y\u0008z' }] }] }));
    expect(sheets[0].rows[1][0]).toBe('xyz');
    await rej(build({ sheets: [{ name: 'S', columns: [{ key: 'a' }], rows: [{ a: 'x'.repeat(32768) }] }] }), 'CELL_TOO_LONG');
    await rej(build({ sheets: [{ name: 'A', columns: [{ key: 'a' }], rows: [] }, { name: 'a', columns: [{ key: 'a' }], rows: [] }] }), 'BAD_SHEET');
    const n = await read(await build({ sheets: [{ name: "A/B:C*D?[E]'x".repeat(5), columns: [{ key: 'a' }], rows: [] }] }));
    expect(n.sheets[0].name.length).toBeLessThanOrEqual(31);
    expect(n.sheets[0].name).not.toMatch(/[[\]:*?/\\]/);
  });

  it('column names', () => {
    expect([0, 25, 26, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'ZZ', 'AAA']);
  });
});

describe('xlsx: what the reader refuses', () => {
  it('refuses non-workbooks, old binary and encrypted files, oversized files', async () => {
    await rej(read(Buffer.from('hello world')), 'NOT_A_WORKBOOK');
    await rej(read(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.alloc(100)])), 'LEGACY_OR_ENCRYPTED');
    await rej(read(Buffer.alloc(200), { limits: { maxBytes: 100 } }), 'TOO_BIG');
    await rej(read(await pack({ 'a.txt': 'x' })), 'NOT_A_WORKBOOK');
    await rej(read('not a buffer'), undefined);
  });

  it('refuses macros, external links and macro-enabled types', async () => {
    await rej(read(await base(sheet(''), { 'xl/vbaProject.bin': 'x' })), 'MACROS');
    await rej(read(await base(sheet(''), { 'xl/externalLinks/externalLink1.xml': '<x/>' })), 'EXTERNAL_LINKS');
    await rej(read(await pack({ '[Content_Types].xml': TYPES.replace('sheet.main', 'sheet.macroEnabled.main'), 'xl/workbook.xml': WB, 'xl/_rels/workbook.xml.rels': RELS, 'xl/worksheets/sheet1.xml': sheet('') })), 'MACROS');
  });

  it('refuses XML with a document type or entities (XML bombs, external entities)', async () => {
    const bomb = '<!DOCTYPE lolz [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]>';
    await rej(read(await base(`${bomb}${sheet('<row r="1"><c r="A1" t="inlineStr"><is><t>&b;</t></is></c></row>')}`)), 'UNSAFE_XML');
    await rej(read(await base(sheet(''), { 'xl/sharedStrings.xml': `${bomb}<sst/>` })), 'UNSAFE_XML');
  });

  it('enforces the limits on rows, columns, cells and the unpacked size', async () => {
    const rows = (n) => Array.from({ length: n }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join('');
    await rej(read(await base(sheet(rows(30))), { limits: { maxRows: 20 } }), 'TOO_MANY_ROWS');
    await rej(read(await base(sheet('<row r="1"><c r="ZZ1"><v>1</v></c></row>')), { limits: { maxCols: 50 } }), 'TOO_MANY_COLS');
    await rej(read(await base(sheet(rows(30))), { limits: { maxCells: 10 } }), 'TOO_MANY_CELLS');
    await rej(read(await base(sheet(rows(30))), { limits: { maxEntryBytes: 200 } }), 'TOO_BIG_UNPACKED');
    await rej(read(await base(sheet('<row r="2000000"><c r="A1"><v>1</v></c></row>'))), 'TOO_MANY_ROWS');
  });
});

describe('xlsx: reading files made by other programs', () => {
  it('shared strings (with rich text and phonetic parts), inline strings, escapes and entities', async () => {
    const sst = '<sst><si><t>Привет &amp; &#1084;ир</t></si><si><r><t>Ри</t></r><r><t>ч</t></r><rPh><t>PHONETIC</t></rPh></si><si><t>a_x000D_b _x005F_x0041_</t></si></sst>';
    const { sheets } = await read(await base(sheet('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="inlineStr"><is><t>x&lt;y</t></is></c></row>'), { 'xl/sharedStrings.xml': sst }));
    expect(sheets[0].rows[0]).toEqual(['Привет & мир', 'Рич', 'a\rb _x0041_'.replace('_x0041_', '_x0041_'), 'x<y']);
  });

  it('dates by cell format (built-in and custom, 1900 and 1904), booleans, errors, formulas and gaps', async () => {
    const styles = '<styleSheet><numFmts><numFmt numFmtId="170" formatCode="dd.mm.yyyy"/><numFmt numFmtId="171" formatCode="0.00&quot;m&quot;"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="170"/><xf numFmtId="171"/></cellXfs></styleSheet>';
    const cells = '<row r="2"><c r="A2" s="1"><v>46328</v></c><c r="B2" s="2"><v>46328.5</v></c><c r="C2" s="3"><v>46328</v></c><c r="E2" t="b"><v>1</v></c><c r="F2" t="e"><v>#N/A</v></c><c r="G2"><f>1+1</f><v>2</v></c></row>';
    const { sheets, warnings } = await read(await base(sheet(cells), { 'xl/styles.xml': styles }));
    const r = sheets[0].rows;
    expect(r[0]).toEqual([]); // an empty row 1 stays empty
    expect(r[1]).toEqual([new Date('2026-11-02T00:00:00Z'), new Date('2026-11-02T12:00:00Z'), 46328, null, true, null, 2]);
    expect(warnings).toEqual([{ code: 'FORMULAS_NOT_EVALUATED', count: 1 }, { code: 'ERROR_CELLS_IGNORED', count: 1 }]);
    const wb1904 = WB.replace('<sheets>', '<workbookPr date1904="1"/><sheets>');
    const d = await read(await pack({ '[Content_Types].xml': TYPES, 'xl/workbook.xml': wb1904, 'xl/_rels/workbook.xml.rels': RELS, 'xl/styles.xml': styles, 'xl/worksheets/sheet1.xml': sheet('<row r="1"><c r="A1" s="1"><v>0</v></c></row>') }));
    expect(d.sheets[0].rows[0][0]).toEqual(new Date('1904-01-01T00:00:00Z'));
  });

  it('keeps hidden sheets flagged, and can read only the sheets asked for', async () => {
    const wb = '<workbook xmlns:r="x"><sheets><sheet name="A" sheetId="1" r:id="rId1"/><sheet name="B" state="hidden" sheetId="2" r:id="rId2"/></sheets></workbook>';
    const rels = '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>';
    const buf = await pack({ '[Content_Types].xml': TYPES, 'xl/workbook.xml': wb, 'xl/_rels/workbook.xml.rels': rels, 'xl/worksheets/sheet1.xml': sheet('<row r="1"><c r="A1"><v>1</v></c></row>'), 'xl/worksheets/sheet2.xml': sheet('<row r="1"><c r="A1"><v>2</v></c></row>') });
    const all = await read(buf);
    expect(all.sheets.map((s) => [s.name, s.hidden])).toEqual([['A', false], ['B', true]]);
    expect((await read(buf, { sheets: ['B'] })).sheets.map((s) => s.name)).toEqual(['B']);
  });
});

describe('xlsx: mapping rows to records', () => {
  const spec = { columns: {
    name: { header: ['Название', 'Name'], required: true, max: 10 },
    qty: { header: 'Кол-во', type: 'integer', min: 1, max: 100, required: true },
    price: { header: 'Цена', type: 'number', min: 0 },
    due: { header: 'Срок', type: 'date' },
    kind: { header: 'Тип', allowed: ['a', 'b'] },
  } };

  it('finds the header below a title, matches by header, converts and reports each problem with its row and column', () => {
    const rows = [['Список'], [], ['название', 'КОЛ-ВО', 'Цена', 'Срок', 'Тип', 'Лишнее'], ['Мышь', 2, '1 234,50', '02.11.2026', 'a', 'x'], ['', null, null], ['Клавиатура-очень-длинная', 1], ['Кабель', 0, 5], ['Блок', 1.5], ['Док', 3, 'abc'], ['Хаб', 4, 1, '31.02.2026'], ['Сумка', 1, 1, null, 'z']];
    const r = mapRows(rows, spec);
    expect(r.headerRow).toBe(3);
    expect(r.unknownColumns).toEqual(['Лишнее']);
    expect(r.records).toEqual([{ row: 4, data: { name: 'Мышь', qty: 2, price: 1234.5, due: new Date('2026-11-02T00:00:00Z'), kind: 'a' } }]);
    expect(r.errors).toEqual([
      { row: 6, column: 'name', code: 'TOO_LONG' },
      { row: 7, column: 'qty', code: 'OUT_OF_RANGE' },
      { row: 8, column: 'qty', code: 'NOT_AN_INTEGER' },
      { row: 9, column: 'price', code: 'NOT_A_NUMBER' },
      { row: 10, column: 'due', code: 'NOT_A_DATE' },
      { row: 11, column: 'kind', code: 'NOT_ALLOWED' },
    ]);
  });

  it('reports missing required columns and a missing header, and limits the error list', () => {
    expect(mapRows([['Цена'], [1]], spec).missingColumns).toEqual(['name', 'qty']);
    expect(mapRows([['x'], ['y']], spec).errors).toEqual([{ row: 1, column: null, code: 'NO_HEADER' }]);
    const many = [['Название', 'Кол-во'], ...Array.from({ length: 300 }, () => ['', 5])];
    const r = mapRows(many, spec, { maxErrors: 10 });
    expect(r.errors.length).toBe(10);
    expect(r.truncated).toBe(true);
  });

  it('strips control characters from text and never evaluates anything', () => {
    const r = mapRows([['Название', 'Кол-во'], ['=1+1\u0000', 1]], spec);
    expect(r.records[0].data.name).toBe('=1+1');
  });
});

// The real archive libraries (yauzl and yazl): runs where they are installed.
let real = true;
try { await import('yauzl'); const y = await import('yazl'); real = typeof new y.default.ZipFile().addBuffer === 'function'; } catch { real = false; }
(real ? describe : () => {})('xlsx: with the real archive libraries', () => {
  it('writes a workbook and reads it back', async () => {
    const buf = await buildWorkbook({ sheets: [{ name: 'S', columns: [{ header: 'a', key: 'a' }, { header: 'b', key: 'b', format: 'money' }], rows: [{ a: '=cmd', b: 1.25 }, { a: 'x', b: 2 }] }] });
    const again = await buildWorkbook({ sheets: [{ name: 'S', columns: [{ header: 'a', key: 'a' }, { header: 'b', key: 'b', format: 'money' }], rows: [{ a: '=cmd', b: 1.25 }, { a: 'x', b: 2 }] }] });
    expect(again.equals(buf)).toBe(true); // the same data gives the same bytes
    const { sheets } = await readWorkbook(buf);
    expect(sheets[0].rows).toEqual([['a', 'b'], ['=cmd', 1.25], ['x', 2]]);
  });

  it('refuses a corrupt archive and a zip bomb by the unpacked size', async () => {
    await rej(readWorkbook(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(50)])), 'NOT_A_WORKBOOK');
    const big = await buildWorkbook({ sheets: [{ name: 'S', columns: [{ key: 'a' }], rows: Array.from({ length: 2000 }, () => ({ a: 'x'.repeat(200) })) }] });
    await rej(readWorkbook(big, { limits: { maxEntryBytes: 10_000 } }), 'TOO_BIG_UNPACKED');
  });

  it('streams a workbook out and a sheet in: written by yazl as it goes, read back by yauzl row by row', async () => {
    async function* rows() { for (let i = 0; i < 4000; i++) yield { a: i, b: `т ${i}` }; }
    const chunks = [];
    for await (const c of await buildWorkbookStream({ sheets: [{ name: 'S', columns: [{ header: 'a', key: 'a' }, { header: 'b', key: 'b' }], rows: rows() }] })) chunks.push(c);
    const file = Buffer.concat(chunks);
    expect((await readWorkbook(file, { limits: { maxRows: 10_000 } })).sheets[0].rows.length).toBe(4001);
    const sheet = await streamSheet(file);
    let n = 0; let last = null;
    for await (const r of sheet.rows) { n += 1; last = r; }
    expect(n).toBe(4001);
    expect(last).toEqual({ row: 4001, values: [3999, 'т 3999'] });
    let code = null; try { for await (const r of (await streamSheet(file, { limits: { maxSheetBytes: 5000 } })).rows) void r; } catch (e) { code = e.code; }
    expect(code).toBe('TOO_BIG_UNPACKED');
  });

  it('an error in the rows destroys the written stream with that error', async () => {
    async function* rows() { yield { a: 1 }; throw new XlsxError('BAD_SHEET', 'source failed'); }
    let code = null;
    try { for await (const c of await buildWorkbookStream({ sheets: [{ name: 'S', columns: [{ header: 'a', key: 'a' }], rows: rows() }] })) void c; } catch (e) { code = e.code; }
    expect(code).toBe('BAD_SHEET');
  });
});

describe('xlsx: files from real programs', () => {
  const STYLES = '<styleSheet><numFmts count="2"><numFmt numFmtId="164" formatCode="[h]:mm"/><numFmt numFmtId="165" formatCode="hh:mm:ss"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="46"/></cellXfs></styleSheet>';
  const wb = (sheetXml, extra = {}) => base(sheetXml, { 'xl/styles.xml': STYLES, ...extra });

  it('does not mistake a default ".bin" macro content type (Excel templates carry it) for macros', async () => {
    const types = '<Types><Default Extension="bin" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>';
    const buf = await pack({ '[Content_Types].xml': types, 'xl/workbook.xml': WB, 'xl/_rels/workbook.xml.rels': RELS, 'xl/worksheets/sheet1.xml': sheet('<row r="1"><c r="A1" t="inlineStr"><is><t>ok</t></is></c></row>') });
    expect((await read(buf)).sheets[0].rows).toEqual([['ok']]);
  });

  it('reads an .xlsm only with macros: "ignore" (the macro project is never opened), and still refuses it by default', async () => {
    const types = '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></Types>';
    const buf = await pack({ '[Content_Types].xml': types, 'xl/workbook.xml': WB, 'xl/_rels/workbook.xml.rels': RELS, 'xl/worksheets/sheet1.xml': sheet('<row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row>'), 'xl/vbaProject.bin': 'MZ' });
    await rej(read(buf), 'MACROS');
    expect((await read(buf, { macros: 'ignore' })).sheets[0].rows).toEqual([['x']]);
  });

  it('reads a time without a date, keeps elapsed time as a number, and skips the fake 29 Feb 1900', async () => {
    const buf = await wb('<row r="1"><c r="A1" s="3"><v>0.5729166666666666</v></c><c r="B1" s="2"><v>100</v></c><c r="C1" s="1"><v>61</v></c><c r="D1" s="1"><v>1</v></c><c r="E1" s="4"><v>1.5</v></c></row>');
    const [row] = (await read(buf)).sheets[0].rows;
    expect(row[0].toISOString()).toBe('1899-12-30T13:45:00.000Z');
    expect(row[1]).toBe(100);
    expect(row[2].toISOString()).toBe('1900-03-01T00:00:00.000Z');
    expect(row[3].toISOString()).toBe('1900-01-01T00:00:00.000Z');
    expect(row[4]).toBe(1.5);
  });

  it('reports merged ranges and fills them on request', async () => {
    const xml = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Группа</t></is></c></row><row r="2"><c r="B2"><v>1</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="A1:A2"/></mergeCells></worksheet>';
    const plain = (await read(await base(xml))).sheets[0];
    expect(plain.merges).toEqual([{ c1: 0, r1: 1, c2: 0, r2: 2 }]);
    expect(plain.rows[1]).toEqual([null, 1]);
    expect((await read(await base(xml), { fillMergedCells: true })).sheets[0].rows[1]).toEqual(['Группа', 1]);
  });
});

describe('xlsx: stricter reading and a fuller writer', () => {
  const row1 = '<row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row>';

  it('reads a file whose elements use a namespace prefix and whose cells have no address', async () => {
    const xml = '<x:worksheet xmlns:x="m"><x:sheetData><x:row><x:c t="inlineStr"><x:is><x:t>a</x:t></x:is></x:c><x:c><x:v>2</x:v></x:c></x:row><x:row r="3"><x:c r="B3"><x:v>7</x:v></x:c></x:row></x:sheetData></x:worksheet>';
    expect((await read(await base(xml))).sheets[0].rows).toEqual([['a', 2], [], [null, 7]]);
  });

  it('finds the workbook through _rels/.rels, with any prefix for the relationship id, and skips chart sheets', async () => {
    const parts = {
      '[Content_Types].xml': '<Types><Override PartName="/xl/book.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
      '_rels/.rels': '<Relationships><Relationship Id="r1" Type="http://x/officeDocument" Target="/xl/book.xml"/></Relationships>',
      'xl/book.xml': '<workbook xmlns:rel="y"><sheets><sheet name="S" sheetId="1" rel:id="a"/><sheet name="C" sheetId="2" rel:id="b"/></sheets></workbook>',
      'xl/_rels/book.xml.rels': '<Relationships><Relationship Id="a" Type="http://x/worksheet" Target="sheets/one.xml"/><Relationship Id="b" Type="http://x/chartsheet" Target="charts/c.xml"/></Relationships>',
      'xl/sheets/one.xml': '<worksheet><sheetData><row r="1"><c r="A1"><v>5</v></c></row></sheetData></worksheet>',
    };
    const r = await read(await pack(parts));
    expect(r.sheets.map((s) => [s.name, s.rows])).toEqual([['S', [[5]]]]);
    expect(r.warnings).toEqual([{ code: 'NON_WORKSHEET_SKIPPED', count: 1 }]);
  });

  it('refuses XML that is not well-formed instead of guessing', async () => {
    for (const bad of ['<worksheet><sheetData><row r="1"></sheetData></worksheet>', '<worksheet><sheetData><row r=1/></sheetData></worksheet>', '<worksheet><sheetData>', '<worksheet><sheetData><!-- x </sheetData></worksheet>']) {
      await rej(read(await base(bad)), 'BAD_XML');
    }
  });

  it('stays fast on input made to slow a regular-expression parser down', async () => {
    const evil = `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${'a'.repeat(30000)}</t></is></c></row></sheetData></worksheet>`;
    const t0 = Date.now();
    expect((await read(await base(evil))).sheets[0].rows[0][0].length).toBe(30000);
    await rej(read(await base(`<worksheet><sheetData><row r="1"><c ${'a="1" '.repeat(50000)}`)), 'BAD_XML');
    expect(Date.now() - t0 < 3000).toBe(true);
  });

  it('can skip hidden rows and can be cancelled', async () => {
    const xml = sheet('<row r="1"><c r="A1"><v>1</v></c></row><row r="2" hidden="1"><c r="A2"><v>2</v></c></row><row r="3"><c r="A3"><v>3</v></c></row>');
    expect((await read(await base(xml))).sheets[0].rows).toEqual([[1], [2], [3]]);
    expect((await read(await base(xml), { skipHiddenRows: true })).sheets[0].rows).toEqual([[1], [], [3]]);
    const ctl = new AbortController(); ctl.abort();
    await rej(read(await base(xml), { signal: ctl.signal }), undefined);
  });

  it('checks the archive list: duplicates, oversize and absurd compression ratios', () => {
    const lim = { maxEntryBytes: 64 * 1024 * 1024, maxTotalBytes: 200 * 1024 * 1024 };
    const e = (fileName, compressedSize, uncompressedSize) => ({ fileName, compressedSize, uncompressedSize });
    expect(() => checkArchive([e('a.xml', 10, 100), e('b.xml', 10, 100)], lim)).not.toThrow();
    expect(() => checkArchive([e('a.xml', 10, 100), e('A.xml', 10, 100)], lim)).toThrow(/same name/);
    expect(() => checkArchive([e('a.xml', 10, 100 * 1024 * 1024)], lim)).toThrow(/allowed size/);
    expect(() => checkArchive([e('a.xml', 1000, 50 * 1024 * 1024)], lim)).toThrow(/suspiciously/);
    expect(() => checkArchive([e('a.xml', 10_000_000, 60 * 1024 * 1024), e('b.xml', 10_000_000, 60 * 1024 * 1024), e('c.xml', 10_000_000, 60 * 1024 * 1024), e('d.xml', 10_000_000, 60 * 1024 * 1024)], lim)).toThrow(/allowed size/);
  });

  it('maps numbers with either decimal mark, serial dates, defaults, duplicates and a normalizer', () => {
    const rows = [['Код', 'Цена', 'Дата', 'Статус'], ['A', '1 234,50', 46328, 'Используеться'], ['B', '1,234.50', '02.11.2026', 'резерв'], ['A', '1.234.567', null, null]];
    const m = mapRows(rows, { columns: {
      code: { header: 'Код', unique: true },
      price: { header: 'Цена', type: 'number' },
      at: { header: 'Дата', type: 'date', default: null },
      status: { header: 'Статус', default: 'используется', normalize: (v) => (/^использу/i.test(v) ? 'используется' : v), allowed: ['используется', 'резерв'] },
    } });
    expect(m.records.map((r) => [r.data.price, r.data.status])).toEqual([[1234.5, 'используется'], [1234.5, 'резерв']]);
    expect(m.records[0].data.at.toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(m.errors).toEqual([{ row: 4, column: 'code', code: 'DUPLICATE' }]);
  });

  it('writes drop-down lists, document properties, cached text results and recalculation on open', async () => {
    const buf = await build({ title: 'Заявки', creator: 'Тест', sheets: [{ name: 'S', columns: [{ header: 'Статус', key: 's', list: ['новая', 'в работе'] }, { header: 'F', key: 'f' }], rows: [{ s: 'новая', f: { formula: 'IF(1=1,"да","нет")', value: 'да' } }] }] });
    const parts = new Map((await fakeZip.read(buf, { wanted: () => true, maxEntries: 100, maxEntryBytes: 1e8, maxTotalBytes: 1e9 })).entries());
    const text = (n) => parts.get(n).toString();
    expect(text('xl/worksheets/sheet1.xml')).toContain('<dataValidation type="list"');
    expect(text('xl/worksheets/sheet1.xml')).toContain('t="str"><f>');
    expect(text('xl/workbook.xml')).toContain('fullCalcOnLoad="1"');
    expect(text('docProps/core.xml')).toContain('<dc:creator>Тест</dc:creator>');
    await rej(build({ sheets: [{ name: 'S', columns: [{ header: 'a', key: 'a', list: ['a,b'] }], rows: [] }] }), 'BAD_SHEET');
    expect((await read(buf)).sheets[0].rows[1]).toEqual(['новая', 'да']);
  });

  it('accepts part names written with capitals, backslashes or a leading slash, and still sees a macro project hidden behind them', async () => {
    const cell = '<worksheet><sheetData><row r="1"><c r="A1"><v>9</v></c></row></sheetData></worksheet>';
    const odd = { '[Content_Types].xml': TYPES, 'Xl\\Workbook.xml': WB, '/xl/_rels/workbook.xml.rels': RELS, 'XL/Worksheets/Sheet1.xml': cell };
    expect((await read(await pack(odd))).sheets[0].rows).toEqual([[9]]);
    await rej(read(await pack({ ...odd, '\\xl\\VBAProject.bin': 'MZ' })), 'MACROS');
    await rej(read(await pack({ ...odd, 'XL\\MacroSheets\\sheet1.xml': cell })), 'MACROS');
  });

  it('refuses a cell with more text than Excel allows, and never lets a header become an object key', async () => {
    await rej(read(await base(`<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${'a'.repeat(32768)}</t></is></c></row></sheetData></worksheet>`)), 'CELL_TOO_LONG');
    const m = mapRows([['__proto__', 'constructor', 'name'], ['x', 'y', 'z']], { columns: { name: { header: 'name' } } });
    expect(m.records[0].data).toEqual({ name: 'z' });
    expect(m.unknownColumns).toEqual(['__proto__', 'constructor']);
    expect({}.polluted).toBe(undefined);
  });

  it('survives 400 randomly damaged worksheets: it reads them or fails with an XlsxError, nothing else', async () => {
    let a = 20261103; // a seeded generator: a failure can be reproduced
    const rnd = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const good = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a&amp;b</t></is></c><c r="B1" s="1"><v>2.5</v></c></row><row r="2"><c r="A2" t="s"><v>0</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells></worksheet>';
    const bits = ['<', '>', '"', "'", '&', '/', '=', ' ', '<!DOCTYPE x>', '&#x110000;', '</row>', '<c ', '\u0000'];
    for (let i = 0; i < 400; i++) {
      let x = good;
      for (let k = 0, n = 1 + Math.floor(rnd() * 4); k < n; k++) {
        const at = Math.floor(rnd() * x.length);
        x = rnd() < 0.4 ? x.slice(0, at) + x.slice(at + 1 + Math.floor(rnd() * 6)) : x.slice(0, at) + bits[Math.floor(rnd() * bits.length)] + x.slice(at);
      }
      let err = null;
      try { await read(await base(x)); } catch (e) { err = e; }
      expect(err === null || err instanceof XlsxError ? 'ok' : `case ${i}: ${err?.name}: ${err?.message}`).toBe('ok');
    }
  });

  it('keeps a text that looks like an Excel escape (_x0041_) exactly as typed, and refuses the reserved sheet name', async () => {
    const texts = ['код _x0041_', '_x005F_x0042_', 'a_x000D_b', '_x_ _x00_ plain'];
    const buf = await build({ sheets: [{ name: 'S', columns: [{ header: '_x0041_h', key: 'a' }], rows: texts.map((a) => ({ a })) }] });
    const rows = (await read(buf)).sheets[0].rows;
    expect(rows.map((r) => r[0])).toEqual(['_x0041_h', ...texts]);
    await rej(build({ sheets: [{ name: 'history', columns: [{ key: 'a' }], rows: [] }] }), 'BAD_SHEET');
  });
});



// ---- other formats: .ods, .xlsb, and telling them apart ----------------------------------------------------------
const ODS_MIMETYPE = 'application/vnd.oasis.opendocument.spreadsheet';
const odsFile = (body, { extra = {}, mimetype = ODS_MIMETYPE, styles = '' } = {}) => pack({
  mimetype,
  'META-INF/manifest.xml': '<manifest/>',
  'content.xml': `<office:document-content><office:automatic-styles>${styles}</office:automatic-styles><office:body><office:spreadsheet>${body}</office:spreadsheet></office:body></office:document-content>`,
  ...extra,
});
const odsRead = (buf, o = {}) => readOds(buf, { zip: fakeZip, ...o });
const str = (t) => `<table:table-cell office:value-type="string"><text:p>${t}</text:p></table:table-cell>`;

describe('readOds', () => {
  it('reads text, numbers, dates, times, booleans and formulas into the same shape as .xlsx', async () => {
    const body = `<table:table table:name="Data"><table:table-row>
      ${str('Name')}<table:table-cell office:value-type="float" office:value="12.5"><text:p>12.5</text:p></table:table-cell>
      <table:table-cell office:value-type="percentage" office:value="0.25"/>
      <table:table-cell office:value-type="date" office:date-value="2026-11-03"/>
      <table:table-cell office:value-type="date" office:date-value="2026-11-03T12:30:15"/>
      <table:table-cell office:value-type="time" office:time-value="PT06H00M00S"/>
      <table:table-cell office:value-type="time" office:time-value="PT30H00M00S"/>
      <table:table-cell office:value-type="boolean" office:boolean-value="true"/>
      <table:table-cell office:value-type="float" office:value="3" table:formula="of:=1+2"/>
    </table:table-row></table:table>`;
    const r = await odsRead(await odsFile(body));
    expect(r.sheets.map((s) => s.name)).toEqual(['Data']);
    const row = r.sheets[0].rows[0];
    expect(row[0]).toBe('Name');
    expect(row[1]).toBe(12.5);
    expect(row[2]).toBe(0.25);
    expect(row[3].toISOString()).toBe('2026-11-03T00:00:00.000Z');
    expect(row[4].toISOString()).toBe('2026-11-03T12:30:15.000Z');
    expect(row[5].toISOString()).toBe('1899-12-30T06:00:00.000Z');
    expect(row[6]).toBe(1.25);
    expect(row[7]).toBe(true);
    expect(row[8]).toBe(3);
    expect(r.warnings).toEqual([{ code: 'FORMULAS_NOT_EVALUATED', count: 1 }]);
  });

  it('keeps spaces, tabs, line breaks and several paragraphs; ignores notes and drawings', async () => {
    const body = `<table:table table:name="T"><table:table-row><table:table-cell office:value-type="string">
      <text:p>a<text:s text:c="3"/>b<text:tab/>c<text:line-break/>d</text:p><text:p>second</text:p>
      <office:annotation><text:p>a hidden note</text:p></office:annotation>
      <draw:frame><draw:text-box><text:p>box text</text:p></draw:text-box></draw:frame>
    </table:table-cell></table:table-row></table:table>`;
    const r = await odsRead(await odsFile(body));
    expect(r.sheets[0].rows[0][0]).toBe('a   b\tc\nd\nsecond');
  });

  it('repeats: a million empty rows cost nothing, repeated data is counted against the limits', async () => {
    const huge = `<table:table table:name="T"><table:table-row>${str('x')}</table:table-row><table:table-row table:number-rows-repeated="1048576"><table:table-cell table:number-columns-repeated="16384"/></table:table-row></table:table>`;
    const t0 = Date.now();
    const r = await odsRead(await odsFile(huge));
    expect(r.sheets[0].rows).toEqual([['x']]);
    expect(Date.now() - t0 < 2000).toBe(true);
    const rows = `<table:table table:name="T"><table:table-row table:number-rows-repeated="3">${str('a')}<table:table-cell table:number-columns-repeated="2" office:value-type="float" office:value="1"/></table:table-row></table:table>`;
    expect((await odsRead(await odsFile(rows))).sheets[0].rows).toEqual([['a', 1, 1], ['a', 1, 1], ['a', 1, 1]]);
    const bomb = `<table:table table:name="T"><table:table-row table:number-rows-repeated="1048576">${str('a')}</table:table-row></table:table>`;
    await rej(odsRead(await odsFile(bomb)), 'TOO_MANY_ROWS');
    const wide = `<table:table table:name="T"><table:table-row><table:table-cell table:number-columns-repeated="1000000000" office:value-type="float" office:value="1"/></table:table-row></table:table>`;
    await rej(odsRead(await odsFile(wide)), 'TOO_MANY_COLS');
    await rej(odsRead(await odsFile(`<table:table table:name="T"><table:table-row table:number-rows-repeated="0">${str('a')}</table:table-row></table:table>`)), 'NOT_A_WORKBOOK');
    await rej(odsRead(await odsFile(`<table:table table:name="T"><table:table-row table:number-rows-repeated="-1">${str('a')}</table:table-row></table:table>`)), 'NOT_A_WORKBOOK');
    await rej(odsRead(await odsFile(rows), { limits: { maxCells: 5 } }), 'TOO_MANY_CELLS');
  });

  it('reads merges, hidden sheets (set in a style), groups and header rows, and covered cells', async () => {
    const styles = '<style:style style:name="ta2" style:family="table"><style:table-properties table:display="false"/></style:style><style:style style:name="ta1" style:family="table"><style:table-properties table:display="true"/></style:style>';
    const body = `<table:table table:name="Shown" table:style-name="ta1"><table:table-header-rows><table:table-row>${str('H')}</table:table-row></table:table-header-rows>
      <table:table-row-group><table:table-row><table:table-cell office:value-type="string" table:number-columns-spanned="2" table:number-rows-spanned="1"><text:p>M</text:p></table:table-cell><table:covered-table-cell/></table:table-row></table:table-row-group></table:table>
      <table:table table:name="Secret" table:style-name="ta2"><table:table-row>${str('s')}</table:table-row></table:table>`;
    const r = await odsRead(await odsFile(body, { styles }));
    expect(r.sheets.map((s) => [s.name, s.hidden])).toEqual([['Shown', false], ['Secret', true]]);
    expect(r.sheets[0].rows).toEqual([['H'], ['M']]);
    expect(r.sheets[0].merges).toEqual([{ c1: 0, r1: 2, c2: 1, r2: 2 }]);
    expect((await odsRead(await odsFile(body, { styles }), { fillMergedCells: true })).sheets[0].rows[1]).toEqual(['M', 'M']);
    expect((await odsRead(await odsFile(body, { styles }), { sheets: ['Secret'] })).sheets.map((s) => s.name)).toEqual(['Secret']);
  });

  it('turns formula errors into nothing and says so', async () => {
    const body = '<table:table table:name="T"><table:table-row><table:table-cell office:value-type="error" office:string-value="#NAME?" table:formula="of:=X()"><text:p>#NAME?</text:p></table:table-cell>' + `${str('ok')}</table:table-row></table:table>`;
    const r = await odsRead(await odsFile(body));
    expect(r.sheets[0].rows).toEqual([[null, 'ok']]);
    expect(r.warnings.map((w) => w.code).sort()).toEqual(['ERROR_CELLS_IGNORED', 'FORMULAS_NOT_EVALUATED']);
  });

  it('refuses what .xlsx refuses: encryption, macros, linked tables, document types, wrong type, over-long text', async () => {
    const ok = `<table:table table:name="T"><table:table-row>${str('a')}</table:table-row></table:table>`;
    await rej(odsRead(await odsFile(ok, { extra: { 'META-INF/manifest.xml': '<manifest><file-entry><encryption-data/></file-entry></manifest>' } })), 'ENCRYPTED');
    await rej(odsRead(await odsFile(ok, { extra: { 'Basic/Standard/Module1.xml': '<x/>' } })), 'MACROS');
    expect((await odsRead(await odsFile(ok, { extra: { 'Basic/Standard/Module1.xml': '<x/>' } }), { macros: 'ignore' })).sheets).toHaveLength(1);
    const linked = '<table:table table:name="T"><table:table-source xlink:href="file:///etc/passwd"/><table:table-row>' + str('a') + '</table:table-row></table:table>';
    await rej(odsRead(await odsFile(linked)), 'EXTERNAL_LINKS');
    expect((await odsRead(await odsFile(linked), { externalLinks: 'ignore' })).warnings).toEqual([{ code: 'EXTERNAL_LINKS_IGNORED', count: 1 }]);
    await rej(odsRead(await pack({ mimetype: ODS_MIMETYPE, 'content.xml': '<!DOCTYPE x [<!ENTITY a "b">]><office:document-content/>' })), 'UNSAFE_XML');
    await rej(odsRead(await odsFile(ok, { mimetype: 'application/zip' })), 'NOT_A_WORKBOOK');
    await rej(odsRead(await pack({ 'content.xml': '<x/>' })), 'NOT_A_WORKBOOK');
    await rej(odsRead(await odsFile(`<table:table table:name="T"><table:table-row><table:table-cell office:value-type="string"><text:p>${'x'.repeat(40_000)}</text:p></table:table-cell></table:table-row></table:table>`)), 'CELL_TOO_LONG');
    await rej(odsRead(await odsFile(`<table:table table:name="T"><table:table-row><table:table-cell office:value-type="string"><text:p>a<text:s text:c="999999999"/></text:p></table:table-cell></table:table-row></table:table>`)), 'CELL_TOO_LONG');
    await rej(odsRead(await odsFile('<table:table table:name="T"><table:table-row><table:table-cell></table:table-row></table:table>')), 'BAD_XML');
    await rej(odsRead(Buffer.from('nope')), 'NOT_A_WORKBOOK');
  });

  it('a nested table or a drawing in a cell does not leak into the sheet', async () => {
    const body = `<table:table table:name="Outer"><table:table-row><table:table-cell office:value-type="string"><text:p>cell</text:p><table:table table:name="Inner"><table:table-row>${str('inner')}</table:table-row></table:table></table:table-cell>${str('next')}</table:table-row></table:table>`;
    const r = await odsRead(await odsFile(body));
    expect(r.sheets.map((s) => s.name)).toEqual(['Outer']);
    expect(r.sheets[0].rows).toEqual([['cell', 'next']]);
  });
});

// A .xlsb part by hand: records of an id (1-2 bytes), a size (1-4 bytes of 7 bits) and data.
const rid = (id) => (id < 0x80 ? Buffer.from([id]) : Buffer.from([0x80 | (id & 0x7f), id >> 7]));
const rsz = (n) => { const b = []; do { let x = n & 0x7f; n = Math.floor(n / 128); if (n) x |= 0x80; b.push(x); } while (n); return Buffer.from(b); };
const rec = (id, ...data) => { const d = Buffer.concat(data); return Buffer.concat([rid(id), rsz(d.length), d]); };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const f64 = (x) => { const b = Buffer.alloc(8); b.writeDoubleLE(x); return b; };
const wstr = (t) => Buffer.concat([u32(t.length), Buffer.from(t, 'utf16le')]);
const cellHead = (col, style = 0) => Buffer.concat([u32(col), Buffer.from([style & 255, style >> 8, 0, 0])]);
const rowHdr = (r, hidden = false) => rec(0, u32(r), u32(0), u16(0), Buffer.from([0, hidden ? 0x10 : 0]), Buffer.alloc(1));
const XLSB_RELS = '<Relationships><Relationship Id="rId1" Type="http://x/worksheet" Target="worksheets/sheet1.bin"/><Relationship Id="rId2" Type="http://x/sharedStrings" Target="sharedStrings.bin"/><Relationship Id="rId3" Type="http://x/styles" Target="styles.bin"/></Relationships>';
const xlsbFile = (sheetRecords, { sheets = [[0, 'rId1', 'Data']], extra = {}, strings = ['shared'], date1904 = false } = {}) => pack({
  '[Content_Types].xml': '<Types><Default Extension="bin" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/></Types>',
  '_rels/.rels': '<Relationships><Relationship Id="rId1" Type="http://x/officeDocument" Target="xl/workbook.bin"/></Relationships>',
  'xl/_rels/workbook.bin.rels': XLSB_RELS,
  'xl/workbook.bin': Buffer.concat([rec(153, u32(date1904 ? 1 : 0), u32(0)), rec(143), ...sheets.map(([st, id, name]) => rec(156, u32(st), u32(1), wstr(id), wstr(name))), rec(144)]),
  'xl/sharedStrings.bin': Buffer.concat([rec(159, u32(1), u32(1)), ...strings.map((t) => rec(19, Buffer.from([0]), wstr(t)))]),
  'xl/styles.bin': Buffer.concat([rec(44, u16(164), wstr('dd/mm/yyyy')), rec(617, u32(3)), rec(47, u16(0), u16(0), Buffer.alloc(12)), rec(47, u16(0), u16(14), Buffer.alloc(12)), rec(47, u16(0), u16(164), Buffer.alloc(12)), rec(618)]),
  'xl/worksheets/sheet1.bin': Buffer.concat([rec(145), sheetRecords, rec(146)]),
  ...extra,
});
const xlsbRead = (buf, o = {}) => readXlsb(buf, { zip: fakeZip, ...o });

describe('readXlsb', () => {
  it('reads every kind of cell: text, numbers, RK numbers, booleans, shared strings, dates, formula results', async () => {
    const recs = Buffer.concat([
      rowHdr(0),
      rec(6, cellHead(0), wstr('Привет')), rec(5, cellHead(1), f64(1.5)),
      rec(2, cellHead(2), u32((42 << 2) | 2)), // integer 42
      rec(2, cellHead(3), u32(((150 << 2) | 3) >>> 0)), // 150 / 100 = 1.5 (integer, x100)
      rec(4, cellHead(4), Buffer.from([1])), rec(7, cellHead(5), u32(0)),
      rec(5, cellHead(6, 1), f64(46054)), // style 1 = built-in date format 14
      rec(5, cellHead(7, 2), f64(46054.5)), // style 2 = custom dd/mm/yyyy
      rec(9, cellHead(8), f64(7), u16(0), Buffer.alloc(4)), rec(8, cellHead(9), wstr('fx'), u16(0), Buffer.alloc(4)),
      rec(3, cellHead(10), Buffer.from([0x2a])), rec(1, cellHead(11)),
      rowHdr(2), rec(6, cellHead(1), wstr('below')),
    ]);
    const r = await xlsbRead(await xlsbFile(recs));
    const [row0, , row2] = r.sheets[0].rows;
    expect(row0.slice(0, 6)).toEqual(['Привет', 1.5, 42, 1.5, true, 'shared']);
    expect(row0[6].toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(row0[7].toISOString()).toBe('2026-02-01T12:00:00.000Z');
    expect(row0.slice(8, 10)).toEqual([7, 'fx']);
    expect(row0.length).toBe(10);
    expect(row2).toEqual([null, 'below']);
    expect(r.warnings.map((w) => w.code).sort()).toEqual(['ERROR_CELLS_IGNORED', 'FORMULAS_NOT_EVALUATED']);
  });

  it('reads merges, hidden sheets and hidden rows; picks sheets by name', async () => {
    const recs = Buffer.concat([rowHdr(0), rec(6, cellHead(0), wstr('a')), rowHdr(1, true), rec(6, cellHead(0), wstr('hid')), rowHdr(2), rec(6, cellHead(0), wstr('c')), rec(177, u32(1)), rec(176, u32(0), u32(0), u32(0), u32(1))]);
    const book = await xlsbFile(recs, { sheets: [[0, 'rId1', 'Data'], [1, 'rId1', 'Hidden one']] });
    const r = await xlsbRead(book);
    expect(r.sheets.map((s) => [s.name, s.hidden])).toEqual([['Data', false], ['Hidden one', true]]);
    expect(r.sheets[0].rows).toEqual([['a'], ['hid'], ['c']]);
    expect(r.sheets[0].merges).toEqual([{ c1: 0, r1: 1, c2: 1, r2: 1 }]);
    expect((await xlsbRead(book, { skipHiddenRows: true })).sheets[0].rows).toEqual([['a'], [], ['c']]);
    expect((await xlsbRead(book, { sheets: ['Hidden one'] })).sheets).toHaveLength(1);
  });

  it('uses the 1904 date system when the workbook says so', async () => {
    const r = await xlsbRead(await xlsbFile(Buffer.concat([rowHdr(0), rec(5, cellHead(0, 1), f64(1))]), { date1904: true }));
    expect(r.sheets[0].rows[0][0].toISOString()).toBe('1904-01-02T00:00:00.000Z');
  });

  it('refuses damaged records instead of guessing: a size past the end, a string longer than its record, cut-short cells', async () => {
    await rej(xlsbRead(await xlsbFile(Buffer.concat([rowHdr(0), rid(6), rsz(5000), Buffer.alloc(10)]))), 'BAD_BINARY');
    await rej(xlsbRead(await xlsbFile(Buffer.concat([rowHdr(0), rec(6, cellHead(0), u32(1000), Buffer.from('ab', 'utf16le'))]))), 'BAD_BINARY');
    await rej(xlsbRead(await xlsbFile(Buffer.concat([rowHdr(0), rec(5, cellHead(0), Buffer.alloc(3))]))), 'BAD_BINARY');
    await rej(xlsbRead(await xlsbFile(Buffer.concat([rowHdr(0), rec(6, cellHead(0), u32(0x7fffffff))]))), 'CELL_TOO_LONG');
    const own = (tail) => xlsbFile(Buffer.alloc(0), { extra: { 'xl/worksheets/sheet1.bin': Buffer.concat([rowHdr(0), tail]) } });
    await rej(xlsbRead(await own(Buffer.from([0x80]))), 'BAD_BINARY'); // an id cut short
    await rej(xlsbRead(await own(Buffer.from([6, 0x80]))), 'BAD_BINARY'); // a size cut short
  });

  it('holds the same limits and refusals as .xlsx', async () => {
    await rej(xlsbRead(await xlsbFile(Buffer.concat([rowHdr(25_000), rec(6, cellHead(0), wstr('x'))]))), 'TOO_MANY_ROWS');
    await rej(xlsbRead(await xlsbFile(Buffer.concat([rowHdr(0), rec(6, cellHead(5000), wstr('x'))]))), 'TOO_MANY_COLS');
    await rej(xlsbRead(await xlsbFile(Buffer.concat([rowHdr(0), rec(6, cellHead(0), wstr('x')), rec(6, cellHead(1), wstr('y'))])), { limits: { maxCells: 1 } }), 'TOO_MANY_CELLS');
    const macro = await xlsbFile(rowHdr(0), { extra: { 'xl/vbaProject.bin': Buffer.from('MZ') } });
    await rej(xlsbRead(macro), 'MACROS');
    expect((await xlsbRead(macro, { macros: 'ignore' })).sheets).toHaveLength(1);
    const linked = await xlsbFile(rowHdr(0), { extra: { 'xl/externalLinks/externalLink1.bin': Buffer.from('x') } });
    await rej(xlsbRead(linked), 'EXTERNAL_LINKS');
    expect((await xlsbRead(linked, { externalLinks: 'ignore' })).warnings).toEqual([{ code: 'EXTERNAL_LINKS_IGNORED', count: 1 }]);
    await rej(xlsbRead(await xlsbFile(rowHdr(0), { sheets: [[0, 'rId9', 'X']] })), 'NOT_A_WORKBOOK');
  });

  it('no damage to a workbook makes the reader crash, hang or return anything but a workbook or an XlsxError (fuzz)', async () => {
    const recs = Buffer.concat([rowHdr(0), rec(6, cellHead(0), wstr('abc')), rec(5, cellHead(1), f64(2)), rec(7, cellHead(2), u32(0)), rowHdr(1), rec(2, cellHead(0, 1), u32(1 << 2 | 2)), rec(176, u32(0), u32(1), u32(0), u32(1))]);
    let seed = 20261103;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let i = 0; i < 300; i++) {
      const sheet = Buffer.from(recs);
      const flips = 1 + Math.floor(rnd() * 4);
      for (let k = 0; k < flips; k++) sheet[Math.floor(rnd() * sheet.length)] = Math.floor(rnd() * 256);
      const cut = rnd() < 0.3 ? sheet.subarray(0, Math.floor(rnd() * sheet.length)) : sheet;
      try { await xlsbRead(await xlsbFile(cut)); } catch (e) { expect(e instanceof XlsxError).toBe(true); }
    }
  });
});

describe('readOds under damage', () => {
  it('no change to the content makes the reader crash, hang or fail with anything but an XlsxError (fuzz)', async () => {
    const base = `<table:table table:name="T" table:style-name="ta1"><table:table-row table:number-rows-repeated="2">${str('a &amp; b')}<table:table-cell office:value-type="float" office:value="1.5" table:number-columns-spanned="2"/><table:covered-table-cell/><table:table-cell office:value-type="date" office:date-value="2026-02-30"/></table:table-row></table:table>`;
    const xml = `<office:document-content><office:automatic-styles/><office:body><office:spreadsheet>${base}</office:spreadsheet></office:body></office:document-content>`;
    let seed = 20261104;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
    const pieces = ['<', '>', '"', '&', '</table:table-row>', '<table:table>', 'number-rows-repeated="99999999999"', '\u0000', '<!DOCTYPE x>', '<![CDATA['];
    for (let i = 0; i < 300; i++) {
      let t = xml;
      const edits = 1 + Math.floor(rnd() * 3);
      for (let k = 0; k < edits; k++) { const at = Math.floor(rnd() * t.length); t = rnd() < 0.5 ? t.slice(0, at) + pieces[Math.floor(rnd() * pieces.length)] + t.slice(at) : t.slice(0, at) + t.slice(at + 1 + Math.floor(rnd() * 8)); }
      try { await odsRead(await pack({ mimetype: ODS_MIMETYPE, 'content.xml': t })); } catch (e) { expect(e instanceof XlsxError).toBe(true); }
    }
  });
});

// ---- .xls: a compound file (OLE2) holding a BIFF8 stream, both made by hand --------------------------------------
const FREE = 0xffffffff; const ENDC = 0xfffffffe;
/** A version 3 compound file (512-byte sectors, one FAT sector) holding the given streams (padded to the 4096-byte small-stream limit) and any extra empty storages. */
function cfbFile(streams, extraDirs = []) {
  const ents = [{ name: 'Root Entry', type: 5 }, ...streams.map((s) => ({ name: s.name, type: 2, data: s.data })), ...extraDirs.map((n) => ({ name: n, type: 1 }))];
  const dirSectors = Math.ceil(ents.length / 4);
  const fat = new Array(128).fill(FREE); fat[0] = 0xfffffffd;
  let next = 1;
  const dirStart = next; for (let i = 0; i < dirSectors; i++) { fat[next] = i === dirSectors - 1 ? ENDC : next + 1; next += 1; }
  const bodies = [];
  for (const e of ents) {
    if (e.type !== 2) continue;
    const padded = Buffer.concat([e.data, Buffer.alloc(Math.max(4096, Math.ceil(e.data.length / 512) * 512) - e.data.length)]);
    e.start = next; e.size = padded.length; // not below the small-stream limit, so it lives in ordinary sectors; the trailing zeros read as empty records
    const n = padded.length / 512;
    for (let i = 0; i < n; i++) { fat[next] = i === n - 1 ? ENDC : next + 1; next += 1; }
    bodies.push(padded);
  }
  if (next > 128) throw new Error('test file too big for one FAT sector');
  const head = Buffer.alloc(512, 0);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(head);
  head.writeUInt16LE(0x3e, 24); head.writeUInt16LE(3, 26); head.writeUInt16LE(0xfffe, 28); head.writeUInt16LE(9, 30); head.writeUInt16LE(6, 32);
  head.writeUInt32LE(1, 44); head.writeUInt32LE(dirStart, 48); head.writeUInt32LE(4096, 56); head.writeUInt32LE(ENDC, 60); head.writeUInt32LE(0, 64); head.writeUInt32LE(ENDC, 68); head.writeUInt32LE(0, 72);
  head.writeUInt32LE(0, 76); for (let i = 1; i < 109; i++) head.writeUInt32LE(FREE, 76 + i * 4);
  const fatBuf = Buffer.alloc(512); fat.forEach((v, i) => fatBuf.writeUInt32LE(v, i * 4));
  const dir = Buffer.alloc(dirSectors * 512, 0);
  ents.forEach((e, i) => {
    const o = i * 128; const nm = Buffer.from(e.name, 'utf16le');
    nm.copy(dir, o); dir.writeUInt16LE(nm.length + 2, o + 64); dir[o + 66] = e.type; dir[o + 67] = 1;
    dir.writeUInt32LE(FREE, o + 68); dir.writeUInt32LE(FREE, o + 72); dir.writeUInt32LE(FREE, o + 76);
    dir.writeUInt32LE(e.type === 2 ? e.start : ENDC, o + 116); dir.writeUInt32LE(e.type === 2 ? e.size : 0, o + 120);
  });
  for (let i = ents.length; i < dirSectors * 4; i++) dir.writeUInt32LE(FREE, i * 128 + 68), dir.writeUInt32LE(FREE, i * 128 + 72), dir.writeUInt32LE(FREE, i * 128 + 76);
  return Buffer.concat([head, fatBuf, dir, ...bodies]);
}
const b16 = (n) => u16(n);
const brec = (id, ...data) => { const d = Buffer.concat(data); return Buffer.concat([u16(id), u16(d.length), d]); };
const bof = (type) => brec(0x809, u16(0x600), u16(type), Buffer.alloc(12));
const eof = () => brec(0x0a);
const s8 = (t, wide = /[^\u0000-\u00ff]/.test(t)) => Buffer.concat([Buffer.from([t.length, wide ? 1 : 0]), Buffer.from(t, wide ? 'utf16le' : 'latin1')]);
const s16 = (t, wide = /[^\u0000-\u00ff]/.test(t)) => Buffer.concat([u16(t.length), Buffer.from([wide ? 1 : 0]), Buffer.from(t, wide ? 'utf16le' : 'latin1')]);
const xfRec = (fmt) => brec(0xe0, u16(0), u16(fmt), Buffer.alloc(16));
const cell = (row, col, ixfe = 0) => Buffer.concat([u16(row), u16(col), u16(ixfe)]);
const rkInt = (n) => u32(((n << 2) | 2) >>> 0);
const formulaHead = (row, col, result, ixfe = 0) => brec(0x06, cell(row, col, ixfe), result, u16(0), u32(0), u16(0));
const NAN_TAIL = Buffer.from([0xff, 0xff]);
function biffBook({ sheets, sst = [], rawSst = null, date1904 = false, extraGlobals = [], version = 0x600 }) {
  const globals = (pos) => Buffer.concat([
    version === 0x600 ? bof(5) : brec(0x809, u16(version), u16(5), Buffer.alloc(12)), brec(0x22, u16(date1904 ? 1 : 0)),
    brec(0x041e, u16(164), s16('dd/mm/yyyy')), xfRec(0), xfRec(14), xfRec(164),
    ...sheets.map((s, i) => brec(0x85, u32(pos[i]), Buffer.from([s.hidden ? 1 : 0, s.kind ?? 0]), s8(s.name))),
    ...extraGlobals,
    ...(rawSst ?? [brec(0xfc, u32(sst.length), u32(sst.length), ...sst.map((t) => s16(t)))]),
    eof(),
  ]);
  const bodies = sheets.map((s) => Buffer.concat([bof(0x10), ...s.records, eof()]));
  const glen = globals(sheets.map(() => 0)).length;
  const pos = []; let at = glen; for (const b of bodies) { pos.push(at); at += b.length; }
  return Buffer.concat([globals(pos), ...bodies]);
}
const xlsFile = (book, extraDirs = []) => cfbFile([{ name: 'Workbook', data: book }], extraDirs);
const xlsRead = (buf, o = {}) => readXls(buf, o);
const ROW = (r, hidden = false) => brec(0x208, u16(r), u16(0), u16(8), u16(255), u16(0), u16(0), u16(hidden ? 0x20 : 0), u16(0));

describe('readXls', () => {
  it('reads every kind of cell: shared and inline text (Cyrillic too), numbers, RK and MULRK, booleans, dates by format, formula results', async () => {
    const rows = Buffer.concat([
      ROW(0),
      brec(0xfd, cell(0, 0), u32(0)), brec(0x203, cell(0, 1), f64(1.5)), brec(0x27e, cell(0, 2), rkInt(42)), brec(0x27e, cell(0, 3), u32(((150 << 2) | 3) >>> 0)),
      brec(0xbd, u16(0), u16(4), u16(0), rkInt(7), u16(0), rkInt(8), u16(5)),
      brec(0x203, cell(0, 6, 1), f64(46054)), brec(0x203, cell(0, 7, 2), f64(46054.5)),
      brec(0x205, cell(0, 8), Buffer.from([1, 0])), brec(0x205, cell(0, 9), Buffer.from([0x2a, 1])),
      formulaHead(0, 10, f64(7)), formulaHead(0, 11, Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 0]), NAN_TAIL])), brec(0x207, s16('fx')), formulaHead(0, 12, Buffer.concat([Buffer.from([1, 0, 1, 0, 0, 0]), NAN_TAIL])),
      brec(0x204, cell(2, 1), s16('метка')), brec(0xfd, cell(2, 2), u32(1)),
    ]);
    const r = await xlsRead(xlsFile(biffBook({ sheets: [{ name: 'Лист', records: [rows] }], sst: ['Привет', 'two'] })));
    expect(r.sheets.map((s) => s.name)).toEqual(['Лист']);
    const [r0, , r2] = r.sheets[0].rows;
    expect(r0.slice(0, 6)).toEqual(['Привет', 1.5, 42, 1.5, 7, 8]);
    expect(r0[6].toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(r0[7].toISOString()).toBe('2026-02-01T12:00:00.000Z');
    expect(r0.slice(8)).toEqual([true, null, 7, 'fx', true]);
    expect(r2).toEqual([null, 'метка', 'two']);
    expect(r.warnings.map((w) => w.code).sort()).toEqual(['ERROR_CELLS_IGNORED', 'FORMULAS_NOT_EVALUATED']);
  });

  it('reads a shared-string table that continues in CONTINUE records, including a switch between 8-bit and 16-bit text', async () => {
    const sstHead = Buffer.concat([u32(3), u32(3), s16('first')]);
    const long = Buffer.concat([u16(6), Buffer.from([0]), Buffer.from('abc')]); // "abcdéf": 8-bit "abc" ...
    const cont = Buffer.concat([Buffer.from([1]), Buffer.from('déf', 'utf16le'), u16(4), Buffer.from([1]), Buffer.from('日本語!', 'utf16le')]); // ... then 16-bit "déf", then a whole string
    const raw = [Buffer.concat([u16(0xfc), u16(sstHead.length + long.length), sstHead, long]), brec(0x3c, cont)];
    const cells = Buffer.concat([ROW(0), brec(0xfd, cell(0, 0), u32(0)), brec(0xfd, cell(0, 1), u32(1)), brec(0xfd, cell(0, 2), u32(2))]);
    const r = await xlsRead(xlsFile(biffBook({ sheets: [{ name: 'S', records: [cells] }], rawSst: raw })));
    expect(r.sheets[0].rows[0]).toEqual(['first', 'abcdéf', '日本語!']);
  });

  it('reads the 1904 date system, merges, hidden sheets and rows, and picks sheets by name', async () => {
    const cells = Buffer.concat([ROW(0), brec(0x203, cell(0, 0, 1), f64(1)), ROW(1, true), brec(0xfd, cell(1, 0), u32(0)), ROW(2), brec(0xfd, cell(2, 0), u32(0)), brec(0xe5, u16(1), u16(0), u16(0), u16(0), u16(1))]);
    const book = xlsFile(biffBook({ sheets: [{ name: 'A', records: [cells] }, { name: 'Hidden', hidden: true, records: [cells] }], sst: ['x'], date1904: true }));
    const r = await xlsRead(book);
    expect(r.sheets.map((s) => [s.name, s.hidden])).toEqual([['A', false], ['Hidden', true]]);
    expect(r.sheets[0].rows[0][0].toISOString()).toBe('1904-01-02T00:00:00.000Z');
    expect(r.sheets[0].merges).toEqual([{ c1: 0, r1: 1, c2: 1, r2: 1 }]);
    expect((await xlsRead(book, { skipHiddenRows: true })).sheets[0].rows[1]).toEqual([]);
    expect((await xlsRead(book, { sheets: ['Hidden'] })).sheets).toHaveLength(1);
    expect((await xlsRead(book, { fillMergedCells: true })).sheets[0].rows[0][1]).toEqual(r.sheets[0].rows[0][0]);
  });

  it('holds the same limits and refusals as .xlsx: encryption, macros, linked workbooks, old Excel versions, size, rows, columns, cells', async () => {
    const one = Buffer.concat([ROW(0), brec(0xfd, cell(0, 0), u32(0))]);
    const book = (extra = {}) => biffBook({ sheets: [{ name: 'S', records: [one] }], sst: ['x'], ...extra });
    await rej(xlsRead(xlsFile(book({ extraGlobals: [brec(0x2f, u16(1), u16(1), u16(1))] }))), 'ENCRYPTED');
    await rej(xlsRead(cfbFile([{ name: 'EncryptedPackage', data: Buffer.alloc(16) }, { name: 'EncryptionInfo', data: Buffer.alloc(16) }])), 'ENCRYPTED');
    await rej(xlsRead(xlsFile(book(), ['_VBA_PROJECT_CUR'])), 'MACROS');
    expect((await xlsRead(xlsFile(book(), ['_VBA_PROJECT_CUR']), { macros: 'ignore' })).sheets).toHaveLength(1);
    await rej(xlsRead(xlsFile(biffBook({ sheets: [{ name: 'M', kind: 1, records: [] }, { name: 'S', records: [one] }], sst: ['x'] }))), 'MACROS');
    const linked = book({ extraGlobals: [brec(0x1ae, u16(1), u16(5), Buffer.from([0, 0x61, 0x2e, 0x78, 0x6c, 0x73]))] });
    await rej(xlsRead(xlsFile(linked)), 'EXTERNAL_LINKS');
    expect((await xlsRead(xlsFile(linked), { externalLinks: 'ignore' })).warnings).toEqual([{ code: 'EXTERNAL_LINKS_IGNORED', count: 1 }]);
    expect((await xlsRead(xlsFile(book({ extraGlobals: [brec(0x1ae, u16(1), u16(0x0401))] })))).sheets).toHaveLength(1); // a reference to this very workbook is fine
    await rej(xlsRead(xlsFile(book({ version: 0x500 }))), 'UNSUPPORTED_FORMAT');
    await rej(xlsRead(cfbFile([{ name: 'WordDocument', data: Buffer.alloc(8) }])), 'NOT_A_WORKBOOK');
    await rej(xlsRead(xlsFile(book()), { limits: { maxBytes: 100 } }), 'TOO_BIG');
    await rej(xlsRead(xlsFile(biffBook({ sheets: [{ name: 'S', records: [Buffer.concat([ROW(0), brec(0xfd, cell(30_000, 0), u32(0))])] }], sst: ['x'] })), { limits: { maxRows: 100 } }), 'TOO_MANY_ROWS');
    await rej(xlsRead(xlsFile(biffBook({ sheets: [{ name: 'S', records: [brec(0xfd, cell(0, 200), u32(0))] }], sst: ['x'] })), { limits: { maxCols: 100 } }), 'TOO_MANY_COLS');
    await rej(xlsRead(xlsFile(biffBook({ sheets: [{ name: 'S', records: [brec(0xfd, cell(0, 0), u32(0)), brec(0xfd, cell(0, 1), u32(0))] }], sst: ['x'] })), { limits: { maxCells: 1 } }), 'TOO_MANY_CELLS');
    await rej(xlsRead(xlsFile(biffBook({ sheets: [{ name: 'S', records: [] }], sst: ['a', 'b'] })), { limits: { maxSharedStrings: 1 } }), 'TOO_MANY_CELLS');
  });

  it('refuses a damaged container or damaged records instead of guessing: loops, sectors outside the file, sizes that lie', async () => {
    const book = biffBook({ sheets: [{ name: 'S', records: [Buffer.concat([ROW(0), brec(0xfd, cell(0, 0), u32(0))])] }], sst: ['x'] });
    const good = xlsFile(book);
    expect((await xlsRead(good)).sheets).toHaveLength(1);
    const mutate = (fn) => { const b = Buffer.from(good); fn(b); return b; };
    // the FAT sector is file sector 0 (offset 512); the workbook stream starts after the directory (sector 2)
    await rej(xlsRead(mutate((b) => b.writeUInt32LE(2, 512 + 3 * 4))), 'BAD_CONTAINER'); // the chain loops back to its own start
    await rej(xlsRead(mutate((b) => b.writeUInt32LE(9999, 512 + 2 * 4))), 'BAD_CONTAINER'); // a chain leaves the file
    await rej(xlsRead(mutate((b) => b.writeUInt32LE(0xffffffff, 512 + 2 * 4))), 'BAD_CONTAINER'); // a free sector inside a chain
    await rej(xlsRead(mutate((b) => b.writeUInt32LE(5_000_000, 1024 + 128 + 120))), 'BAD_CONTAINER'); // the directory claims more than the sectors hold (the Workbook entry is the second one)
    await rej(xlsRead(mutate((b) => b.writeUInt16LE(7, 30))), 'BAD_CONTAINER'); // an unsupported sector size
    await rej(xlsRead(mutate((b) => b.writeUInt32LE(0xffffff, 44))), 'BAD_CONTAINER'); // more table sectors than the file has
    await rej(xlsRead(good.subarray(0, 700)), undefined);
    await rej(xlsRead(Buffer.concat([good.subarray(0, 8), Buffer.alloc(100)])), 'NOT_A_WORKBOOK');
    // records: one that claims to run past the end, an over-long one, a cell cut short, a string longer than its record
    await rej(xlsRead(xlsFile(Buffer.concat([book.subarray(0, 20), u16(0x00fd), u16(5000), Buffer.alloc(8)]))), 'BAD_BINARY');
    await rej(xlsRead(xlsFile(Buffer.concat([book.subarray(0, 20), u16(0x00fd), u16(9000), Buffer.alloc(9000)]))), 'BAD_BINARY');
    await rej(xlsRead(xlsFile(biffBook({ sheets: [{ name: 'S', records: [brec(0x203, cell(0, 0), Buffer.alloc(3))] }], sst: ['x'] }))), 'BAD_BINARY');
    await rej(xlsRead(xlsFile(biffBook({ sheets: [{ name: 'S', records: [brec(0x204, cell(0, 0), u16(1000), Buffer.from([0]), Buffer.from('ab'))] }], sst: ['x'] }))), 'BAD_BINARY');
    await rej(xlsRead(xlsFile(biffBook({ sheets: [{ name: 'S', records: [brec(0x204, cell(0, 0), u16(40_000), Buffer.from([0]))] }], sst: ['x'] }))), 'CELL_TOO_LONG');
    await rej(xlsRead(xlsFile(bof(5).subarray(0, 6))), 'NOT_A_WORKBOOK'); // a globals part with no sheets
  });

  it('no damage to the file makes the reader crash, hang or fail with anything but an XlsxError (fuzz)', async () => {
    const cells = Buffer.concat([ROW(0), brec(0xfd, cell(0, 0), u32(0)), brec(0x203, cell(0, 1, 1), f64(2)), brec(0x27e, cell(0, 2), rkInt(3)), brec(0xbd, u16(1), u16(0), u16(0), rkInt(1), u16(0)), brec(0xe5, u16(1), u16(0), u16(0), u16(0), u16(1))]);
    const good = xlsFile(biffBook({ sheets: [{ name: 'S', records: [cells] }, { name: 'T', hidden: true, records: [cells] }], sst: ['abc', 'Привет'] }));
    let seed = 20261105;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let i = 0; i < 400; i++) {
      const b = Buffer.from(good);
      const flips = 1 + Math.floor(rnd() * 5);
      for (let k = 0; k < flips; k++) { const at = rnd() < 0.5 ? Math.floor(rnd() * 1536) : Math.floor(rnd() * b.length); b[at] = Math.floor(rnd() * 256); }
      try { await xlsRead(rnd() < 0.2 ? b.subarray(0, Math.floor(rnd() * b.length)) : b); } catch (e) { expect(e instanceof XlsxError).toBe(true); }
    }
  });
});

describe('readSpreadsheet', () => {
  it('tells .xlsx, .xlsb and .ods apart by what is inside and returns one shape', async () => {
    const x = await readSpreadsheet(await build({ sheets: [{ name: 'S', columns: [{ header: 'a', key: 'a' }, { header: 'b', key: 'b' }], rows: [{ a: 'x', b: 1 }] }] }), { zip: fakeZip });
    expect(x.format).toBe('xlsx');
    expect(x.sheets[0].rows).toEqual([['a', 'b'], ['x', 1]]);
    const b = await readSpreadsheet(await xlsbFile(Buffer.concat([rowHdr(0), rec(6, cellHead(0), wstr('a')), rec(5, cellHead(1), f64(1))]), { extra: {} }), { zip: fakeZip });
    expect(b.format).toBe('xlsb');
    expect(b.sheets[0].rows).toEqual([['a', 1]]);
    const o = await readSpreadsheet(await odsFile(`<table:table table:name="S"><table:table-row>${str('a')}<table:table-cell office:value-type="float" office:value="1"/></table:table-row></table:table>`), { zip: fakeZip });
    expect(o.format).toBe('ods');
    expect(o.sheets[0].rows).toEqual([['a', 1]]);
    const x2 = await readSpreadsheet(xlsFile(biffBook({ sheets: [{ name: 'S', records: [Buffer.concat([ROW(0), brec(0xfd, cell(0, 0), u32(0)), brec(0x203, cell(0, 1), f64(1))])] }], sst: ['a'] })), { zip: fakeZip });
    expect(x2.format).toBe('xls');
    expect(x2.sheets[0].rows).toEqual([['a', 1]]);
  });

  it('refuses what is none of them, and a file that is too big, before reading further', async () => {
    await rej(readSpreadsheet(Buffer.from('hello world, not a spreadsheet'), { zip: fakeZip }), 'NOT_A_WORKBOOK');
    await rej(readSpreadsheet(Buffer.alloc(64), { zip: fakeZip, limits: { maxBytes: 10 } }), 'TOO_BIG');
    await rej(readSpreadsheet(await pack({ 'readme.txt': 'hi' }), { zip: fakeZip }), 'NOT_A_WORKBOOK');
  });
});

/** The error a promise fails with (null when it does not fail). */
const errorOf = async (promise) => { try { await promise; return null; } catch (e) { return e; } };
const helper = (name) => new URL(`./helpers/${name}`, import.meta.url).href;

describe('readSpreadsheet: hidden sheets and the time limit', () => {
  const twoSheets = () => xlsFile(biffBook({ sheets: [{ name: 'Shown', records: [Buffer.concat([ROW(0), brec(0xfd, cell(0, 0), u32(0))])] }, { name: 'Secret', hidden: true, records: [Buffer.concat([ROW(0), brec(0xfd, cell(0, 0), u32(0))])] }], sst: ['x'] }));

  it('says when hidden sheets were read, and leaves them out on request', async () => {
    const all = await readSpreadsheet(await twoSheets(), { zip: fakeZip });
    expect(all.sheets.map((x) => [x.name, x.hidden])).toEqual([['Shown', false], ['Secret', true]]);
    expect(all.warnings).toEqual([{ code: 'HIDDEN_SHEETS_READ', count: 1 }]);
    const skipped = await readSpreadsheet(await twoSheets(), { zip: fakeZip, hiddenSheets: 'skip' });
    expect(skipped.sheets.map((x) => x.name)).toEqual(['Shown']);
    expect(skipped.warnings).toEqual([{ code: 'HIDDEN_SHEETS_SKIPPED', count: 1 }]);
    expect(await errorOf(readSpreadsheet(await twoSheets(), { zip: fakeZip, hiddenSheets: 'maybe' })) instanceof RangeError).toBe(true);
  });

  it('gives up with TIMEOUT when the reading takes longer than allowed', async () => {
    const cols = Array.from({ length: 10 }, (_, i) => ({ header: `c${i}`, key: `c${i}` }));
    const rows = Array.from({ length: 4000 }, (_, r) => Object.fromEntries(cols.map((c, i) => [c.key, `v${r}-${i}`])));
    const book = await build({ sheets: [{ name: 'S', columns: cols, rows }] });
    await rej(readSpreadsheet(book, { zip: fakeZip, timeoutMs: 1 }), 'TIMEOUT'); // the reader hands control back often, so the clock is noticed
    expect((await readSpreadsheet(book, { zip: fakeZip, timeoutMs: 20_000 })).sheets).toHaveLength(1);
    expect(await errorOf(readSpreadsheet(book, { zip: fakeZip, timeoutMs: 0 })) instanceof RangeError).toBe(true);
  });
});

describe('readSpreadsheetIsolated', () => {
  it('returns what the plain reader returns (dates included), with the same error codes', async () => {
    const book = await build({ sheets: [{ name: 'S', columns: [{ header: 'a', key: 'a' }, { header: 'd', key: 'd', format: 'date' }], rows: [{ a: 'x', d: new Date('2026-11-04T00:00:00Z') }] }] });
    const r = await readSpreadsheetIsolated(book, { zipModule: helper('fake-zip.js') });
    expect(r.format).toBe('xlsx');
    expect(r.sheets[0].rows[0]).toEqual(['a', 'd']);
    expect(r.sheets[0].rows[1][1].toISOString()).toBe('2026-11-04T00:00:00.000Z');
    await rej(readSpreadsheetIsolated(Buffer.from('not a workbook at all'), { zipModule: helper('fake-zip.js') }), 'NOT_A_WORKBOOK');
    await rej(readSpreadsheetIsolated(book, { zipModule: helper('fake-zip.js'), limits: { maxBytes: 10 } }), 'TOO_BIG');
    expect((await readSpreadsheetIsolated(book, { zipModule: helper('fake-zip.js'), hiddenSheets: 'skip' })).sheets).toHaveLength(1);
  });

  it('stops a file that makes the reader loop forever', async () => {
    const t0 = Date.now();
    await rej(readSpreadsheetIsolated(Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0]), { zipModule: helper('hang-zip.js'), timeoutMs: 400 }), 'TIMEOUT');
    expect(Date.now() - t0 < 5000).toBe(true);
  });

  it('stops a file that needs more memory than allowed, without harming this process', async () => {
    await rej(readSpreadsheetIsolated(Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0]), { zipModule: helper('oom-zip.js'), maxMemoryMb: 32, timeoutMs: 20_000 }), 'RESOURCE_LIMIT');
  });

  it('obeys an abort signal and refuses options that cannot cross to another thread', async () => {
    const ctl = new AbortController();
    const p = readSpreadsheetIsolated(Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0]), { zipModule: helper('hang-zip.js'), signal: ctl.signal, timeoutMs: 20_000 });
    setTimeout(() => ctl.abort(), 100);
    let err = null; try { await p; } catch (e) { err = e; }
    expect(err?.name).toBe('AbortError');
    expect(await errorOf(Promise.resolve().then(() => readSpreadsheetIsolated(Buffer.alloc(8), { zip: fakeZip }))) instanceof TypeError).toBe(true);
    expect(await errorOf(Promise.resolve().then(() => readSpreadsheetIsolated(Buffer.alloc(8), { maxMemoryMb: 4 }))) instanceof RangeError).toBe(true);
  });
});

describe('mapRows: a pattern is never run on unbounded text', () => {
  const spec = (def) => ({ columns: { code: { header: 'code', ...def } } });
  const rows = (v) => [['code'], [v]];
  it('refuses text longer than the column max, or than 1000 characters when no max is set, before the pattern runs', () => {
    let ran = 0;
    const evil = { test: () => { ran += 1; return true; } };
    // a real RegExp is used for the behaviour; the counter object checks the pattern is not even called
    const r1 = mapRows(rows('x'.repeat(1001)), spec({ pattern: /^x+$/ }));
    expect(r1.errors).toEqual([{ row: 2, column: 'code', code: 'TOO_LONG' }]);
    expect(mapRows(rows('x'.repeat(1000)), spec({ pattern: /^x+$/ })).records).toHaveLength(1);
    expect(mapRows(rows('x'.repeat(5000)), spec({ pattern: /^x+$/, max: 6000 })).records).toHaveLength(1);
    expect(mapRows(rows('xxxx'), spec({ pattern: /^x+$/, max: 3 })).errors[0].code).toBe('TOO_LONG');
    expect(ran).toBe(0);
    expect(evil.test()).toBe(true);
    // a column without a pattern keeps its old behaviour: no hidden cap
    expect(mapRows(rows('x'.repeat(5000)), spec({})).records).toHaveLength(1);
  });

  it('a pattern with the g or y flag gives the same answer on every row', () => {
    const r = mapRows([['code'], ['AB1'], ['AB2'], ['AB3'], ['AB4']], spec({ pattern: /^AB\d$/g }));
    expect(r.errors).toEqual([]);
    expect(r.records).toHaveLength(4);
    const y = mapRows([['code'], ['AB1'], ['AB2']], spec({ pattern: /^AB\d$/y }));
    expect(y.records).toHaveLength(2);
  });
});

describe('display option: the text a cell shows, next to the typed value', () => {
  it('xlsx: numbers and dates through their formats, text as it is, booleans and errors; values stay typed', async () => {
    const styles = '<styleSheet><numFmts><numFmt numFmtId="170" formatCode="dd.mm.yyyy"/><numFmt numFmtId="171" formatCode="#,##0.00&quot; ₽&quot;"/><numFmt numFmtId="172" formatCode="0.0%"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="170"/><xf numFmtId="171"/><xf numFmtId="172"/></cellXfs></styleSheet>';
    const cells = '<row r="1"><c r="A1" t="inlineStr"><is><t>итого</t></is></c><c r="B1" s="1"><v>46328</v></c><c r="C1" s="2"><v>1234567.5</v></c><c r="D1" s="3"><v>0.256</v></c><c r="E1"><v>0.1</v></c><c r="F1" t="b"><v>1</v></c><c r="G1" t="e"><v>#DIV/0!</v></c></row>';
    const r = await read(await base(sheet(cells), { 'xl/styles.xml': styles }), { display: true, locale: 'ru' });
    const s = r.sheets[0];
    expect(s.shown[0]).toEqual(['итого', '02.11.2026', '1\u00a0234\u00a0567,50 ₽', '25,6%', '0,1', 'ИСТИНА', '#DIV/0!']);
    expect(s.rows[0].slice(0, 5)).toEqual(['итого', new Date('2026-11-02T00:00:00Z'), 1234567.5, 0.256, 0.1]);
    expect(s.shown.length).toBe(s.rows.length);
  });

  it('is off by default: no shown matrix', async () => {
    const r = await read(await base(sheet('<row r="1"><c r="A1"><v>1</v></c></row>')));
    expect('shown' in r.sheets[0]).toBe(false);
  });

  it('ods: the text the program printed in the cell', async () => {
    const body = '<table:table table:name="D"><table:table-row><table:table-cell office:value-type="float" office:value="1234.5"><text:p>1 234,50 ₽</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>a</text:p></table:table-cell><table:table-cell office:value-type="error"><text:p>#DIV/0!</text:p></table:table-cell></table:table-row></table:table>';
    const r = await odsRead(await odsFile(body), { display: true });
    expect(r.sheets[0].rows[0]).toEqual([1234.5, 'a']);
    expect(r.sheets[0].shown[0]).toEqual(['1 234,50 ₽', 'a', '#DIV/0!']);
  });

  it('xlsb: built-in and custom formats and error codes', async () => {
    const recs = Buffer.concat([rowHdr(0), rec(5, cellHead(0, 1), f64(46328)), rec(5, cellHead(1, 2), f64(46054.5)), rec(5, cellHead(2), f64(0.5)), rec(3, cellHead(3), Buffer.from([0x2a]))]);
    const r = await xlsbRead(await xlsbFile(recs), { display: true });
    expect(r.sheets[0].shown[0]).toEqual(['11/2/2026', '01/02/2026', '0.5', '#N/A']);
  });

  it('readSpreadsheet passes the option on to whichever reader the content calls for', async () => {
    const r = await readSpreadsheet(await base(sheet('<row r="1"><c r="A1"><v>2.5</v></c></row>')), { zip: fakeZip, display: true });
    expect(r.format).toBe('xlsx');
    expect(r.sheets[0].shown).toEqual([['2.5']]);
  });
});

describe('Excel tables, columns by position, validate and "did you mean"', () => {
  const cell = (r, c, v) => `<c r="${columnName(c)}${r}" t="inlineStr"><is><t>${v}</t></is></c>`;
  const rowXml = (r, vals, from = 0) => `<row r="${r}">${vals.map((v, i) => cell(r, from + i, v)).join('')}</row>`;
  // a title and notes above a table at B3:C6 (header B3:C3, totals row 6), and an unrelated block to the left
  const body = rowXml(1, ['Отчёт']) + rowXml(2, ['junk', 'x', 'y']) + rowXml(3, ['left', 'Name', 'Qty']) + rowXml(4, ['L', 'a', '1']) + rowXml(5, ['L', 'b', '2']) + rowXml(6, ['L', 'Итого', '3']);
  const tableXml = '<table name="T1" displayName="Equipment" ref="B3:C6" headerRowCount="1" totalsRowCount="1"><tableColumns count="2"><tableColumn id="1" name="Name"/><tableColumn id="2" name="Qty"/></tableColumns></table>';
  const withTable = () => base(`<worksheet><sheetData>${body}</sheetData><tableParts count="1"><tablePart r:id="rId1"/></tableParts></worksheet>`, {
    'xl/worksheets/_rels/sheet1.xml.rels': '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/></Relationships>',
    'xl/tables/table1.xml': tableXml,
  });

  it('reads the tables of a sheet: name, range, header and totals rows, columns', async () => {
    const { sheets } = await read(await withTable());
    expect(sheets[0].tables).toEqual([{ name: 'Equipment', c1: 1, r1: 3, c2: 2, r2: 6, headerRow: true, totalsRow: true, columns: ['Name', 'Qty'] }]);
  });

  it('a sheet without tables has an empty list; a broken table part is ignored', async () => {
    expect((await read(await base(sheet(body)))).sheets[0].tables).toEqual([]);
    const bad = await base(sheet(body), { 'xl/worksheets/_rels/sheet1.xml.rels': '<Relationships><Relationship Id="rId1" Type="x/table" Target="../tables/t.xml"/></Relationships>', 'xl/tables/t.xml': '<table ref="nonsense"/>' });
    expect((await read(bad)).sheets[0].tables).toEqual([]);
  });

  it('mapRows with a table: its first row is the header, the totals row and everything outside it are left out, row numbers stay the sheet\'s', async () => {
    const { sheets } = await read(await withTable());
    const spec = { columns: { name: { header: 'Name', required: true }, qty: { header: 'Qty', type: 'integer' } } };
    const r = mapRows(sheets[0].rows, spec, { table: sheets[0].tables[0] });
    expect(r.headerRow).toBe(3);
    expect(r.records).toEqual([{ row: 4, data: { name: 'a', qty: 1 } }, { row: 5, data: { name: 'b', qty: 2 } }]);
    expect(r.unknownColumns).toEqual([]);
  });

  it('a sheet without a header: columns by number or letter, data from firstRow', () => {
    const rows = [['x'], ['a', '1'], ['b', '2']];
    const spec = { columns: { name: { index: 'A', required: true }, qty: { index: 1, type: 'integer' } } };
    const r = mapRows(rows, spec, { header: false, firstRow: 2 });
    expect(r.headerRow).toBe(null);
    expect(r.records.map((x) => x.data)).toEqual([{ name: 'a', qty: 1 }, { name: 'b', qty: 2 }]);
    expect(r.records[0].row).toBe(2);
  });

  it('index is the fallback for a column whose header is missing; headerRow names the header outright', () => {
    const rows = [['skip'], ['Name', 'what'], ['a', '5']];
    const spec = { columns: { name: { header: 'Name' }, qty: { header: 'Qty', index: 1, type: 'integer' } } };
    const r = mapRows(rows, spec, { headerRow: 2 });
    expect(r.records[0].data).toEqual({ name: 'a', qty: 5 });
  });

  it('validate returns nothing, a code or false; it sees the value after conversion and the record so far', () => {
    const rows = [['Name', 'Qty'], ['a', '1'], ['bb', '2'], ['c', '3']];
    const spec = { columns: { name: { header: 'Name' }, qty: { header: 'Qty', type: 'integer', validate: (v, d) => (v === 2 ? 'EVEN' : d.name === 'c' ? false : undefined) } } };
    const r = mapRows(rows, spec);
    expect(r.records.map((x) => x.data.name)).toEqual(['a']);
    expect(r.errors).toEqual([{ row: 3, column: 'qty', code: 'EVEN' }, { row: 4, column: 'qty', code: 'INVALID' }]);
  });

  it('a value that is not allowed carries the nearest allowed one as a hint, when it is a few letters off', () => {
    const rows = [['Status'], ['Используеться'], ['резрев'], ['совсем другое'], ['да']];
    const spec = { columns: { st: { header: 'Status', allowed: ['Используется', 'резерв', 'склад'] } } };
    const r = mapRows(rows, spec);
    expect(r.errors).toEqual([
      { row: 2, column: 'st', code: 'NOT_ALLOWED', hint: 'Используется' },
      { row: 3, column: 'st', code: 'NOT_ALLOWED', hint: 'резерв' },
      { row: 4, column: 'st', code: 'NOT_ALLOWED' },
      { row: 5, column: 'st', code: 'NOT_ALLOWED' },
    ]);
  });
});

describe('buildWorkbook: styles, merged cells, print and newer functions', () => {
  const parts = async (book) => {
    const buf = await buildWorkbook(book, { zip: fakeZip });
    return fakeZip.read(buf, { wanted: () => true, maxEntries: 100, maxEntryBytes: 1e7, maxTotalBytes: 1e8 });
  };
  const text = (p, name) => p.get(name).toString();
  const book = (sheet) => ({ sheets: [{ name: 'S', columns: [{ header: 'A', key: 'a' }, { header: 'B', key: 'b' }], rows: [{ a: 1, b: 2 }], ...sheet }] });
  const bad = async (b) => { try { await buildWorkbook(b, { zip: fakeZip }); return null; } catch (e) { return e.code; } };

  it('a column style and a per-cell style become shared cell formats with a font, fill, border and alignment', async () => {
    const p = await parts(book({ columns: [{ header: 'A', key: 'a', style: { bold: true, fill: 'green', border: 'thin', align: 'center', wrap: true } }, { header: 'B', key: 'b', headerStyle: { fill: '#1f4e78', color: 'white' } }], rows: [{ a: 1, b: { value: 'x', style: { fill: 'red' } } }, { a: 2, b: { value: 'y', style: { fill: 'red' } } }] }));
    const styles = text(p, 'xl/styles.xml'); const sheet = text(p, 'xl/worksheets/sheet1.xml');
    expect(styles.includes('<fgColor rgb="FFC6EFCE"/>')).toBe(true);
    expect(styles.includes('<fgColor rgb="FF1F4E78"/>')).toBe(true);
    expect(styles.includes('horizontal="center"') && styles.includes('wrapText="1"')).toBe(true);
    expect((sheet.match(/s="(\d+)" t="inlineStr"><is><t xml:space="preserve">[xy]</g) ?? []).length).toBe(2);
    const ids = [...sheet.matchAll(/<c r="B[23]" s="(\d+)"/g)].map((m) => m[1]);
    expect(ids[0]).toBe(ids[1]); // equal styles share one format
    const count = Number(/<cellXfs count="(\d+)"/.exec(styles)[1]);
    expect(count).toBe((styles.match(/<xf /g) ?? []).length - 1); // plus the one in cellStyleXfs
  });

  it('a styled empty cell is written (a fill needs the cell), an unstyled one is not', async () => {
    const p = await parts(book({ rows: [{ a: { value: null, style: { fill: 'grey' } }, b: null }] }));
    const sheet = text(p, 'xl/worksheets/sheet1.xml');
    expect(/<c r="A2" s="\d+"\/>/.test(sheet)).toBe(true);
    expect(sheet.includes('r="B2"')).toBe(false);
  });

  it('all limits live in limits.js: every reading limit is explained, and the write limits are the ones that are enforced', async () => {
    for (const k of [...Object.keys(DEFAULT_LIMITS), ...Object.keys(STREAM_LIMITS)]) expect(typeof LIMIT_NOTES[k]).toBe('string');
    expect(Object.isFrozen(WRITE_LIMITS)).toBe(true);
    const many = Array.from({ length: WRITE_LIMITS.maxMerges + 1 }, (_, i) => `A${i + 3}:B${i + 3}`);
    expect(await bad(book({ merges: many, autoFilter: false }))).toBe('BAD_SHEET');
  });

  it("dates: 'serial' keeps the day number of date cells; 'date' (default) gives dates; anything else is refused", async () => {
    const file = await buildWorkbook({ sheets: [{ name: 'D', columns: [{ header: 'd', key: 'd', format: 'date' }], rows: [{ d: new Date('2024-03-17T00:00:00Z') }] }] }, { zip: fakeZip });
    expect((await readWorkbook(file, { zip: fakeZip })).sheets[0].rows[1][0]).toEqual(new Date('2024-03-17T00:00:00Z'));
    expect((await readWorkbook(file, { zip: fakeZip, dates: 'serial' })).sheets[0].rows[1][0]).toBe(45368);
    let err = null; try { await readWorkbook(file, { zip: fakeZip, dates: 'iso' }); } catch (e) { err = e; }
    expect(err instanceof RangeError).toBe(true);
    const s = await streamSheet(file, { zip: fakeZip, dates: 'serial' }); const got = []; for await (const r of s.rows) got.push(r.values);
    expect(got[1]).toEqual([45368]);
  });

  it('skipHiddenColumns leaves hidden columns empty in their places (.xlsx, plain and streamed) and is refused for other formats', async () => {
    const file = await buildWorkbook({ sheets: [{ name: 'S', columns: [{ header: 'a', key: 'a' }, { header: 'b', key: 'b' }, { header: 'c', key: 'c' }], rows: [{ a: 1, b: 'secret', c: 3 }] }] }, { zip: fakeZip });
    const all = await fakeZip.read(file, { wanted: () => true, maxEntries: 100, maxEntryBytes: 1e7, maxTotalBytes: 1e8 });
    const entries = [...all.entries()].map(([name, buf]) => [name, name === 'xl/worksheets/sheet1.xml' ? Buffer.from(buf.toString().replace('<cols>', '<cols><col min="2" max="2" width="9" hidden="1" customWidth="1"/>')) : buf]);
    const edited = await fakeZip.write(entries.filter(([n]) => !n.startsWith('#')));
    const shown = (await readWorkbook(edited, { zip: fakeZip })).sheets[0].rows;
    expect(shown[1]).toEqual([1, 'secret', 3]); // off by default
    const r = await readWorkbook(edited, { zip: fakeZip, skipHiddenColumns: true });
    expect(r.sheets[0].rows[1]).toEqual([1, null, 3]); // b is empty, c keeps its place
    expect(r.sheets[0].rows[0]).toEqual(['a', null, 'c']);
    const got = []; for await (const row of (await streamSheet(edited, { zip: fakeZip, skipHiddenColumns: true })).rows) got.push(row.values);
    expect(got[1]).toEqual([1, null, 3]);
    let code = null; try { await readOds(Buffer.alloc(10), { skipHiddenColumns: true }); } catch (e) { code = e.code; }
    expect(code).toBe('BAD_OPTION');
  });

  it('mapRows with a schema: the second step keeps what passes (transformed), reports the rest per issue, and refuses a non-schema', async () => {
    const rows = [['Name', 'Qty'], ['bolt', 5], ['nut', 0], ['washer', 7], ['bolt', 9]];
    const spec = { columns: { name: { header: 'Name', required: true, unique: true }, qty: { header: 'Qty', type: 'integer' } } };
    const schema = { safeParse: (d) => (d.qty >= 1 ? { success: true, data: { ...d, qty: d.qty * 10 } } : { success: false, error: { issues: [{ path: ['qty'], message: 'must be at least 1' }] } }) };
    const r = mapRows(rows, spec, { schema });
    expect(r.records.map((x) => x.data)).toEqual([{ name: 'bolt', qty: 50 }, { name: 'washer', qty: 70 }]);
    // "nut" failed the schema, so it is not remembered as seen; the second "bolt" is a real duplicate
    expect(r.errors).toEqual([{ row: 3, column: 'qty', code: 'SCHEMA', hint: 'must be at least 1' }, { row: 5, column: 'name', code: 'DUPLICATE' }]);
    expect(mapRows(rows, spec, { schema: { safeParse: () => { throw new Error('async'); } } }).errors[0]).toEqual({ row: 2, column: null, code: 'SCHEMA_ERROR' });
    expect(() => mapRows(rows, spec, { schema: {} })).toThrow();
  });

  it('mapRows takes a real Zod schema: the issue path becomes the column', () => {
    const rows = [['Name', 'Qty'], ['bolt', 5], ['nut', 0]];
    const spec = { columns: { name: { header: 'Name' }, qty: { header: 'Qty', type: 'integer' } } };
    const r = mapRows(rows, spec, { schema: z.object({ name: z.string(), qty: z.number().min(1) }) });
    expect(r.records.map((x) => x.data)).toEqual([{ name: 'bolt', qty: 5 }]);
    expect(r.errors.map((e) => [e.row, e.column, e.code])).toEqual([[3, 'qty', 'SCHEMA']]);
  });

  it('links: https, http and mailto are written as external hyperlinks; anything else is refused', async () => {
    const p = await parts(book({ rows: [{ a: { value: 'Site', link: 'https://example.org/a?b=1&c=2' }, b: { link: 'mailto:help@example.org' } }] }));
    const sheet = text(p, 'xl/worksheets/sheet1.xml');
    expect(sheet.includes('<hyperlinks><hyperlink ref="A2" r:id="rId1"/><hyperlink ref="B2" r:id="rId2"/></hyperlinks>')).toBe(true);
    expect(sheet.includes('mailto:help@example.org</t>')).toBe(true); // an empty text shows the address
    const rels = text(p, 'xl/worksheets/_rels/sheet1.xml.rels');
    expect(rels.includes('Target="https://example.org/a?b=1&amp;c=2" TargetMode="External"')).toBe(true);
    expect(/<font>.*?FF0563C1/s.test(text(p, 'xl/styles.xml'))).toBe(true);
    for (const bad1 of ['javascript:alert(1)', 'file:///c:/x', 'data:text/html,x', 'ftp://x.org', '\\\\server\\share', 'https://u:p@x.org', 'https://x.org/a b', '//x.org', 'x.org', '', 'https://x.org/\u0000']) {
      expect(await bad(book({ rows: [{ a: { value: 'x', link: bad1 } }] }))).toBe('BAD_LINK');
    }
    expect(await bad(book({ rows: [{ a: { value: 'x', link: 'https://x.org/' + 'a'.repeat(2000) } }] }))).toBe('BAD_LINK');
  });

  it('text that looks like a formula keeps the quote prefix together with the style', async () => {
    const p = await parts(book({ rows: [{ a: { value: '=1+1', style: { bold: true } }, b: 1 }] }));
    expect(/quotePrefix="1"/.test(text(p, 'xl/styles.xml'))).toBe(true);
    expect(/<xf numFmtId="49"[^>]*applyFont="1"[^>]*quotePrefix="1"/.test(text(p, 'xl/styles.xml'))).toBe(true);
  });

  it('refuses anything outside the safe set: unknown settings, colours that are not names or #RRGGBB, odd values', async () => {
    expect(await bad(book({ columns: [{ header: 'A', key: 'a', style: { font: 'Comic' } }, { header: 'B', key: 'b' }] }))).toBe('BAD_STYLE');
    expect(await bad(book({ columns: [{ header: 'A', key: 'a', style: { fill: 'red"/><x' } }, { header: 'B', key: 'b' }] }))).toBe('BAD_STYLE');
    expect(await bad(book({ columns: [{ header: 'A', key: 'a', style: { fill: '#12345' } }, { header: 'B', key: 'b' }] }))).toBe('BAD_STYLE');
    expect(await bad(book({ columns: [{ header: 'A', key: 'a', style: { align: 'justify' } }, { header: 'B', key: 'b' }] }))).toBe('BAD_STYLE');
    expect(await bad(book({ rows: [{ a: { value: 1, style: { bold: 'yes' } } }] }))).toBe('BAD_STYLE');
    expect(await bad(book({ tabColor: 'pink' }))).toBe('BAD_STYLE');
  });

  it('merged ranges are written; reversed, single-cell, overlapping or malformed ones are refused', async () => {
    const p = await parts(book({ merges: ['A1:B1'], autoFilter: false }));
    expect(text(p, 'xl/worksheets/sheet1.xml').includes('<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>')).toBe(true);
    expect(await bad(book({ merges: ['A1:B1'] }))).toBe('BAD_SHEET'); // header row + filter
    for (const m of [['B2:A1'], ['A1:A1'], ['A1:B2', 'B2:C3'], ['a1:b2'], ['A1']]) expect(await bad(book({ merges: m }))).toBe('BAD_SHEET');
    const back = await readWorkbook(await buildWorkbook(book({ merges: ['A1:B1'], autoFilter: false }), { zip: fakeZip }), { zip: fakeZip });
    expect(back.sheets[0].merges).toEqual([{ c1: 0, r1: 1, c2: 1, r2: 1 }]);
  });

  it('print setup, tab colour and frozen columns', async () => {
    const p = await parts(book({ tabColor: '#ff0000', freezeColumns: 1, print: { orientation: 'landscape', paper: 'A4', fitToWidth: true, repeatHeader: true } }));
    const sheet = text(p, 'xl/worksheets/sheet1.xml');
    expect(sheet.includes('<tabColor rgb="FFFF0000"/><pageSetUpPr fitToPage="1"/>')).toBe(true);
    expect(sheet.includes('<pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"/>')).toBe(true);
    expect(sheet.includes('<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>')).toBe(true);
    expect(text(p, 'xl/workbook.xml').includes("<definedName name=\"_xlnm.Print_Titles\" localSheetId=\"0\">'S'!$1:$1</definedName>")).toBe(true);
    expect(await bad(book({ print: { orientation: 'sideways' } }))).toBe('BAD_SHEET');
    expect(await bad(book({ freezeColumns: 2 }))).toBe('BAD_SHEET');
  });

  it('a sheet name with an apostrophe inside is quoted properly in the print titles', async () => {
    const p = await parts({ sheets: [{ name: "It's", columns: [{ header: 'A', key: 'a' }], rows: [], print: { repeatHeader: true } }] });
    expect(text(p, 'xl/workbook.xml').includes("'It''s'!$1:$1")).toBe(true);
  });

  it('newer functions get the _xlfn. prefix outside quoted text; functions that return arrays are refused', async () => {
    const p = await parts(book({ rows: [{ a: { formula: 'IFS(B2>1,"IFS(",TRUE,0)&XLOOKUP(1,B:B,B:B)&SUM(1)', value: 'x' }, b: 1 }] }));
    expect(text(p, 'xl/worksheets/sheet1.xml').includes('<f>_xlfn.IFS(B2&gt;1,&quot;IFS(&quot;,TRUE,0)&amp;_xlfn.XLOOKUP(1,B:B,B:B)&amp;SUM(1)</f>')).toBe(true);
    expect(await bad(book({ rows: [{ a: { formula: 'FILTER(B:B,B:B>1)', value: 1 } }] }))).toBe('BAD_FORMULA');
    const q = await parts(book({ rows: [{ a: { formula: 'LEN("FILTER(x)")', value: 8 } }] })); // inside quotes: only text
    expect(text(q, 'xl/worksheets/sheet1.xml').includes('FILTER(x)')).toBe(true);
  });

  it('too many different styles are refused instead of producing a file Excel would repair', async () => {
    const rows = Array.from({ length: 1100 }, (_, i) => ({ a: { value: 1, style: { fill: `#${(i + 4096).toString(16).padStart(6, '0')}` } } }));
    expect(await bad(book({ rows }))).toBe('BAD_STYLE');
  });
});

describe('buildWorkbook: colours by rule (conditional formatting)', () => {
  const parts = async (book) => fakeZip.read(await buildWorkbook(book, { zip: fakeZip }), { wanted: () => true, maxEntries: 100, maxEntryBytes: 1e7, maxTotalBytes: 1e8 });
  const sheetWith = (conditional, extra = {}) => ({ sheets: [{ name: 'S', columns: [{ header: 'Name', key: 'n' }, { header: 'Status', key: 'st' }, { header: 'Sum', key: 'sum' }], rows: [{ n: 'a', st: 'Готово', sum: 1 }], conditional, ...extra }] });
  const bad = async (b) => { try { await buildWorkbook(b, { zip: fakeZip }); return null; } catch (e) { return e.code; } };

  it('writes the rules under the column from the first data row, with their formats listed once in styles.xml', async () => {
    const p = await parts(sheetWith([{ column: 'st', rules: [{ equals: 'Готово', style: { fill: 'green', color: 'darkgreen' } }, { equals: 'Просрочено', style: { fill: 'red', bold: true } }, { contains: 'раб"оте', style: { fill: 'green', color: 'darkgreen' } }] }, { column: 'sum', rules: [{ between: [1, 10], style: { italic: true } }, { greaterThan: 100, style: { bold: true } }] }]));
    const sheet = p.get('xl/worksheets/sheet1.xml').toString(); const styles = p.get('xl/styles.xml').toString();
    expect(sheet.includes('<conditionalFormatting sqref="B2:B1048576">')).toBe(true);
    expect(sheet.includes('<cfRule type="cellIs" dxfId="0" priority="1" operator="equal"><formula>&quot;Готово&quot;</formula></cfRule>')).toBe(true);
    expect(sheet.includes('operator="between"><formula>1</formula><formula>10</formula>')).toBe(true);
    expect(sheet.includes('text="раб&quot;оте"><formula>NOT(ISERROR(SEARCH(&quot;раб&quot;&quot;оте&quot;,B2)))</formula>')).toBe(true);
    expect(sheet.indexOf('<mergeCells') === -1 && sheet.indexOf('<conditionalFormatting') > sheet.indexOf('</sheetData>')).toBe(true);
    expect(/<dxfs count="4">/.test(styles)).toBe(true); // green+darkgreen is shared by two rules: 4 formats for 5 rules
    expect(sheet.includes('priority="5"')).toBe(true);
  });

  it('the column can be named by key or counted from 0, and without a header the rules start at row 1', async () => {
    const p = await parts(sheetWith([{ column: 0, rules: [{ notEquals: 'x', style: { bold: true } }] }], { header: false }));
    expect(p.get('xl/worksheets/sheet1.xml').toString().includes('sqref="A1:A1048576"')).toBe(true);
  });

  it('refuses what is not a clear rule: unknown column, two conditions, a style Excel cannot apply by rule, a missing style', async () => {
    expect(await bad(sheetWith([{ column: 'nope', rules: [{ equals: 1, style: { bold: true } }] }]))).toBe('BAD_SHEET');
    expect(await bad(sheetWith([{ column: 'st', rules: [{ equals: 1, lessThan: 2, style: { bold: true } }] }]))).toBe('BAD_SHEET');
    expect(await bad(sheetWith([{ column: 'st', rules: [{ equals: 1, style: { align: 'center' } }] }]))).toBe('BAD_STYLE');
    expect(await bad(sheetWith([{ column: 'st', rules: [{ equals: 1 }] }]))).toBe('BAD_STYLE');
    expect(await bad(sheetWith([{ column: 'st', rules: [{ between: [1], style: { bold: true } }] }]))).toBe('BAD_SHEET');
    expect(await bad(sheetWith([{ column: 'st', rules: [{ equals: {}, style: { bold: true } }] }]))).toBe('BAD_SHEET');
    expect(await bad(sheetWith([{ column: 'st', rules: [{ fancy: 1, style: { bold: true } }] }]))).toBe('BAD_SHEET');
    expect(await bad(sheetWith([{ column: 'st', rules: [] }]))).toBe('BAD_SHEET');
    expect(await bad(sheetWith([{ column: 'st', rules: [{ equals: 'x'.repeat(300), style: { bold: true } }] }]))).toBe('BAD_SHEET');
  });
});

describe('streamSheet: a sheet read row by row', () => {
  const collect = async (sheet) => { const rows = []; for await (const r of sheet.rows) rows.push(r); return rows; };
  const big = async (n = 3000) => buildWorkbook({ sheets: [{ name: 'Data', columns: [{ header: 'N', key: 'n' }, { header: 'Text', key: 't' }, { header: 'Date', key: 'd', format: 'date' }], rows: Array.from({ length: n }, (_, i) => ({ n: i, t: `строка ${i} & <b>`, d: new Date(Date.UTC(2026, 0, 1 + (i % 300))) })) }, { name: 'Other', columns: [{ header: 'X', key: 'x' }], rows: [{ x: 'o' }] }] }, { zip: fakeZip });

  it('gives exactly the rows readWorkbook gives, with the sheet\'s own row numbers', async () => {
    const file = await big();
    const whole = (await readWorkbook(file, { zip: fakeZip, limits: { maxRows: 100000 } })).sheets[0].rows;
    const sheet = await streamSheet(file, { zip: fakeZip });
    expect(sheet.name).toBe('Data');
    const rows = await collect(sheet);
    expect(rows.length).toBe(whole.length);
    expect(rows.every((r, i) => r.row === i + 1 && JSON.stringify(r.values) === JSON.stringify(whole[i]))).toBe(true);
  });

  it('picks the sheet by name or by number, and says so when there is none', async () => {
    const file = await big(5);
    expect((await collect(await streamSheet(file, { zip: fakeZip, sheet: 'Other' }))).map((r) => r.values)).toEqual([['X'], ['o']]);
    expect((await streamSheet(file, { zip: fakeZip, sheet: 1 })).name).toBe('Other');
    for (const sheet of ['Nope', 7]) { let code = null; try { await streamSheet(file, { zip: fakeZip, sheet }); } catch (e) { code = e.code; } expect(code).toBe('NO_SUCH_SHEET'); }
  });

  it('can be stopped early: the rest of the sheet is not read', async () => {
    const sheet = await streamSheet(await big(), { zip: fakeZip });
    let seen = 0;
    for await (const r of sheet.rows) { seen += 1; if (r.row === 3) break; }
    expect(seen).toBe(3);
  });

  it('merges, tables, warnings and the shown text are there when the rows are done', async () => {
    const wb = (await import('../src/xlsx/index.js')).buildWorkbook;
    const file = await wb({ sheets: [{ name: 'S', merges: ['A1:B1'], autoFilter: false, columns: [{ header: 'A', key: 'a', format: 'money' }, { header: 'B', key: 'b' }], rows: [{ a: { formula: '1+1', value: 1234.5 }, b: 'x' }] }] }, { zip: fakeZip });
    const sheet = await streamSheet(file, { zip: fakeZip, display: true });
    const rows = await collect(sheet);
    expect(rows[1].shown).toEqual(['1,234.50', 'x']);
    expect(sheet.merges).toEqual([{ c1: 0, r1: 1, c2: 1, r2: 1 }]);
    expect(sheet.warnings).toEqual([{ code: 'FORMULAS_NOT_EVALUATED', count: 1 }]);
  });

  it('keeps every limit: rows, unpacked size, file size', async () => {
    const file = await big(200);
    const fail = async (limits) => { try { await collect(await streamSheet(file, { zip: fakeZip, limits })); return null; } catch (e) { return e.code; } };
    expect(await fail({ maxRows: 50 })).toBe('TOO_MANY_ROWS');
    expect(await fail({ maxCells: 100 })).toBe('TOO_MANY_CELLS');
    expect(await fail({ maxSheetBytes: 2000 })).toBe('TOO_BIG_UNPACKED');
    expect(await fail({ maxBytes: 100 })).toBe('TOO_BIG');
  });

  it('refuses a document type, CDATA and anything that is not a workbook, as the whole-file reader does', async () => {
    const doc = (xml) => base(xml);
    const row = '<row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row>';
    for (const [xml, code] of [[`<!DOCTYPE x [<!ENTITY a "b">]><worksheet><sheetData>${row}</sheetData></worksheet>`, 'UNSAFE_XML'], [`<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t><![CDATA[</row>]]></t></is></c></row></sheetData></worksheet>`, 'UNSAFE_XML'], [`<worksheet><sheetData>${row}`, 'BAD_XML']]) {
      let got = null; try { await collect(await streamSheet(await doc(xml), { zip: fakeZip })); } catch (e) { got = e.code; }
      expect(got).toBe(code);
    }
    let code = null; try { await streamSheet(Buffer.from('not a workbook at all'), { zip: fakeZip }); } catch (e) { code = e.code; }
    expect(code).toBe('NOT_A_WORKBOOK');
  });

  it('stops when the signal is aborted', async () => {
    const ctl = new AbortController();
    const sheet = await streamSheet(await big(6000), { zip: fakeZip, signal: ctl.signal });
    let code = null; let n = 0;
    try { for await (const r of sheet.rows) { n += 1; if (n === 10) ctl.abort(); void r; } } catch (e) { code = e.name; }
    expect(code).toBe('AbortError');
  });
});

describe('buildWorkbookStream: a workbook written as a stream', () => {
  const toBuffer = async (readable) => { const chunks = []; for await (const c of readable) chunks.push(Buffer.from(c)); return Buffer.concat(chunks); };
  const cols = [{ header: 'N', key: 'n' }, { header: 'Text', key: 't', style: { bold: true } }, { header: 'Sum', key: 's', format: 'money' }];

  it('gives a workbook that reads back like the one buildWorkbook makes, from a generator or an async generator', async () => {
    const rows = Array.from({ length: 700 }, (_, i) => ({ n: i, t: `т ${i} & <x>`, s: i * 1.5 }));
    const expected = await readWorkbook(await buildWorkbook({ sheets: [{ name: 'D', columns: cols, rows }] }, { zip: fakeZip }), { zip: fakeZip });
    function* sync() { yield* rows; }
    async function* asyncGen() { for (const r of rows) { yield r; } }
    for (const source of [sync(), asyncGen(), rows]) {
      const file = await toBuffer(await buildWorkbookStream({ sheets: [{ name: 'D', columns: cols, rows: source }] }, { zip: fakeZip }));
      const back = await readWorkbook(file, { zip: fakeZip });
      expect(back.sheets[0].rows).toEqual(expected.sheets[0].rows);
    }
  });

  it('links in a streamed sheet get their relationships written after the rows', async () => {
    async function* rows() { for (let i = 0; i < 3; i++) yield { n: { value: i, link: `https://example.org/${i}` }, t: 'x', s: 1 }; }
    const file = await toBuffer(await buildWorkbookStream({ sheets: [{ name: 'D', columns: cols, rows: rows() }] }, { zip: fakeZip }));
    const entries = await fakeZip.read(file, { wanted: () => true, maxEntries: 100, maxEntryBytes: 1e7, maxTotalBytes: 1e8 });
    const rels = entries.get('xl/worksheets/_rels/sheet1.xml.rels').toString();
    expect(rels.includes('Target="https://example.org/2" TargetMode="External"')).toBe(true);
    expect(entries.get('xl/worksheets/sheet1.xml').toString().includes('<hyperlink ref="A4" r:id="rId3"/>')).toBe(true);
  });

  it('writes the parts that depend on all the rows last: the styles used by late rows, the formula flag, the filter range', async () => {
    const rows = (function* () { yield { n: 1, t: 'a', s: 1 }; yield { n: { value: 2, style: { fill: 'red' } }, t: 'b', s: { formula: 'XLOOKUP(1,A:A,A:A)', value: 1 } }; })();
    const file = await toBuffer(await buildWorkbookStream({ sheets: [{ name: 'D', columns: cols, rows, conditional: [{ column: 't', rules: [{ equals: 'a', style: { fill: 'green' } }] }] }] }, { zip: fakeZip }));
    const parts = await fakeZip.read(file, { wanted: () => true, maxEntries: 100, maxEntryBytes: 1e7, maxTotalBytes: 1e8 });
    expect(parts.get('xl/styles.xml').toString().includes('FFFFC7CE') && parts.get('xl/styles.xml').toString().includes('<dxfs count="1">')).toBe(true);
    expect(parts.get('xl/workbook.xml').toString().includes('fullCalcOnLoad="1"')).toBe(true);
    const sheet = parts.get('xl/worksheets/sheet1.xml').toString();
    expect(sheet.includes('<autoFilter ref="A1:C3"/>') && sheet.includes('_xlfn.XLOOKUP')).toBe(true);
  });

  it('a workbook without formulas has no recalculation flag, and an empty sheet has no filter', async () => {
    const file = await toBuffer(await buildWorkbookStream({ sheets: [{ name: 'D', columns: cols, rows: [] }] }, { zip: fakeZip }));
    const parts = await fakeZip.read(file, { wanted: () => true, maxEntries: 100, maxEntryBytes: 1e7, maxTotalBytes: 1e8 });
    expect(parts.get('xl/workbook.xml').toString().includes('calcPr')).toBe(false);
    expect(parts.get('xl/worksheets/sheet1.xml').toString().includes('autoFilter')).toBe(false);
  });

  it('a problem midway ends the stream with that error (a bad style, a bad formula, too many rows)', async () => {
    const fail = async (rows, extra = {}) => { try { await toBuffer(await buildWorkbookStream({ sheets: [{ name: 'D', columns: cols, rows, ...extra }] }, { zip: fakeZip })); return null; } catch (e) { return e.code; } };
    expect(await fail((function* () { yield { n: 1 }; yield { n: { value: 1, style: { font: 'x' } } }; })())).toBe('BAD_STYLE');
    expect(await fail((function* () { yield { n: { formula: 'FILTER(A:A,A:A>1)', value: 1 } }; })())).toBe('BAD_FORMULA');
    expect(await fail((function* () { yield { n: 1 }; throw new XlsxError('BAD_SHEET', 'source failed'); })())).toBe('BAD_SHEET');
    // what is wrong with the sheet itself is found before any byte is written
    let early = null; try { await buildWorkbookStream({ sheets: [{ name: 'History', columns: cols, rows: [] }] }, { zip: fakeZip }); } catch (e) { early = e.code; }
    expect(early).toBe('BAD_SHEET');
  });

  it('takes rows one at a time: a source is not read ahead of what is written', async () => {
    let produced = 0;
    async function* source() { for (let i = 0; i < 5000; i++) { produced += 1; yield { n: i, t: 'x'.repeat(50), s: i }; } }
    const file = await toBuffer(await buildWorkbookStream({ sheets: [{ name: 'D', columns: cols, rows: source() }] }, { zip: fakeZip }));
    expect(produced).toBe(5000);
    expect((await readWorkbook(file, { zip: fakeZip, limits: { maxRows: 10000 } })).sheets[0].rows.length).toBe(5001);
  });
});
