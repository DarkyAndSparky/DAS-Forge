// Property tests (fast-check): instead of examples picked by hand, random inputs - the property must hold for all of them.
// fast-check is a dev dependency (`npm install --save-dev fast-check` at the repository root). Without it these tests are
// skipped, so a checkout that has not run `npm install` yet still passes. A failure prints a seed: rerun with
// `FC_SEED=<seed> npm test` to get the same case again.
import { describe, it, expect } from 'vitest';
import { writeCsv, parseCsv, escapeFormula, unescapeFormula, CsvError } from '../src/csv/index.js';
import { readWorkbook, XlsxError, createFormatter } from '../src/xlsx/index.js';
import { fakeZip } from './helpers/fake-zip.js';

let fc = null;
try { fc = (await import('fast-check')).default ?? (await import('fast-check')); } catch { /* not installed */ }
const maybe = fc ? describe : describe.skip;
const params = { numRuns: Number(process.env.FC_RUNS ?? 200), ...(process.env.FC_SEED ? { seed: Number(process.env.FC_SEED) } : {}) };

// characters that make trouble in CSV and spreadsheets, mixed with ordinary ones, Cyrillic and an emoji (two UTF-16 units)
const ALPHABET = [...'ab 1,;"\'=+-@|\t\r\nЖя😀'];
const text = () => (fc ? fc.array(fc.constantFrom(...ALPHABET), { maxLength: 14 }).map((a) => a.join('')) : null);

maybe('property: csv', () => {
  it('what writeCsv writes, parseCsv reads back, for any delimiter', () => {
    fc.assert(fc.property(
      fc.array(fc.array(text(), { minLength: 3, maxLength: 3 }), { minLength: 1, maxLength: 6 }),
      fc.constantFrom(',', ';', '\t'),
      (rows, delimiter) => {
        const out = parseCsv(writeCsv(rows, { delimiter }), { delimiter, unescapeFormulae: true });
        expect(out.rows).toEqual(rows);
      },
    ), params);
  });

  it('the formula escape and its undo agree on any text', () => {
    fc.assert(fc.property(text(), (s) => { expect(unescapeFormula(escapeFormula(s))).toBe(s); }), params);
  });

  it('parseCsv on any bytes returns rows or fails with CsvError, nothing else', () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
      try { parseCsv(bytes); } catch (e) { expect(e).toBeInstanceOf(CsvError); }
    }), params);
  });

  it('automatic delimiter detection always names one of the four', () => {
    fc.assert(fc.property(text(), (s) => {
      try { expect([',', ';', '\t', '|']).toContain(parseCsv(s).delimiter); } catch (e) { expect(e).toBeInstanceOf(CsvError); } // an unclosed quote is a legitimate refusal
    }), params);
  });
});

const TYPES = '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>';
const WB = '<workbook xmlns:r="x"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>';
const RELS = '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>';
const book = (sheetXml, styles) => fakeZip.write(Object.entries({ '[Content_Types].xml': TYPES, 'xl/workbook.xml': WB, 'xl/_rels/workbook.xml.rels': RELS, 'xl/worksheets/sheet1.xml': sheetXml, ...(styles ? { 'xl/styles.xml': styles } : {}) }).map(([n, t]) => [n, Buffer.from(t)]));

maybe('property: xlsx', () => {
  const attr = () => fc.constantFrom('n', 's', 'b', 'e', 'str', 'inlineStr', 'd', undefined);
  const cell = () => fc.record({ col: fc.integer({ min: 0, max: 30 }), t: attr(), v: text(), f: fc.boolean(), s: fc.integer({ min: 0, max: 3 }) });
  const esc = (x) => x.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const sheetOf = (rows) => `<worksheet><sheetData>${rows.map((cells, i) => `<row r="${i + 1}">${cells.map((c) => `<c r="${String.fromCharCode(65 + (c.col % 26))}${i + 1}"${c.t ? ` t="${c.t}"` : ''} s="${c.s}">${c.f ? `<f>${esc(c.v)}</f>` : ''}<v>${esc(c.v)}</v></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`;
  const STYLES = '<styleSheet><numFmts><numFmt numFmtId="170" formatCode="dd.mm.yyyy"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="170"/><xf numFmtId="4"/></cellXfs></styleSheet>';

  it('whatever the cells hold, the reader returns a result or fails with XlsxError - in both modes', async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.array(cell(), { maxLength: 6 }), { maxLength: 8 }), fc.boolean(), async (rows, cells) => {
      try {
        const r = await readWorkbook(await book(sheetOf(rows), STYLES), { zip: fakeZip, cells, extras: cells });
        for (const row of r.sheets[0].rows) expect(Array.isArray(row)).toBe(true);
        if (cells) for (const c of r.sheets[0].cells) expect(['string', 'number', 'boolean', 'date', 'error', 'blank']).toContain(c.type);
      } catch (e) { expect(e).toBeInstanceOf(XlsxError); }
    }), { ...params, numRuns: Math.min(params.numRuns, 100) });
  });

  it('cell mode and the plain mode agree on the values', async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.array(cell(), { maxLength: 5 }), { maxLength: 6 }), async (rows) => {
      let plain; let withCells;
      try {
        const buf = await book(sheetOf(rows), STYLES);
        plain = (await readWorkbook(buf, { zip: fakeZip })).sheets[0].rows;
        withCells = (await readWorkbook(buf, { zip: fakeZip, cells: true })).sheets[0].rows;
      } catch (e) { expect(e).toBeInstanceOf(XlsxError); return; }
      expect(withCells).toEqual(plain);
    }), { ...params, numRuns: Math.min(params.numRuns, 100) });
  });

  it('the number formatter returns text (or null) for any format code and number, and never throws', () => {
    const fmt = createFormatter();
    fc.assert(fc.property(fc.double({ noNaN: true }), fc.array(fc.constantFrom(...[...'0#?.,%;[]"\\@*_dmyhsAMPE+-/: Redv$₽']), { maxLength: 20 }).map((a) => a.join('')), (n, code) => {
      const out = fmt.show(n, code);
      expect(out === null || typeof out === 'string').toBe(true);
    }), params);
  });
});
