import { describe, it, expect } from 'vitest';
import { writeCsv, parseCsv, escapeFormula, unescapeFormula, isFormulaText, CsvError } from '../src/csv/index.js';

const fails = (fn, code) => { let e = null; try { fn(); } catch (err) { e = err; } expect(e === null ? 'it did not fail' : e.code).toBe(code); };

describe('csv: writing', () => {
  it('quotes what needs quoting and leaves the rest alone', () => {
    expect(writeCsv([['a', 'b,c', 'd"e', 'f\ng', ' pad ', null, 1.5, true]])).toBe('a,"b,c","d""e","f\ng"," pad ",,1.5,true');
    expect(writeCsv([['x', 'y;z']], { delimiter: ';' })).toBe('x;"y;z"');
  });
  it('neutralises formulas by default, only in text, never in numbers', () => {
    const out = writeCsv([['=1+1', '+7', '-x', '@a', '|cmd', '\tx', -5, 'ok']], { eol: '\n' });
    expect(out).toBe("'=1+1,'+7,'-x,'@a,'|cmd,\"'\tx\"".replace('\"\'\tx\"', "'\tx") + ',-5,ok');
    expect(writeCsv([['=cmd|"/c calc"!A1']])).toBe('"\'=cmd|""/c calc""!A1"');
  });
  it('can be told not to, puts a byte-order mark and uses the line end asked for', () => {
    expect(writeCsv([['=a']], { escapeFormulae: false })).toBe('=a');
    expect(writeCsv([['a'], ['b']], { bom: true, eol: '\n' })).toBe('﻿a\nb');
    expect(writeCsv([['a', 1]], { quoteAll: true })).toBe('"a","1"');
  });
  it('writes dates as ISO text and drops control characters', () => {
    expect(writeCsv([[new Date('2026-11-02T10:00:00Z'), 'a\u0000b\u0007']])).toBe('2026-11-02T10:00:00.000Z,ab');
  });
  it('the escape and its undo agree', () => {
    for (const s of ['=1', '+1', '-1', '@x', '|x', '\tx', 'plain']) expect(unescapeFormula(escapeFormula(s))).toBe(s);
    expect(isFormulaText('plain')).toBe(false);
    expect(unescapeFormula("'quoted'")).toBe("'quoted'");
  });
});

describe('csv: reading', () => {
  it('reads quotes, doubled quotes, line breaks inside fields, CRLF and a final line without an end', () => {
    const r = parseCsv('a,"b ""x"" y","c\nd"\r\n1,2,3\r\n\r\n4,5');
    expect(r.rows).toEqual([['a', 'b "x" y', 'c\nd'], ['1', '2', '3'], ['4', '5']]);
  });
  it('finds the delimiter from the first line', () => {
    expect(parseCsv('a;b;c\n1;2;3').delimiter).toBe(';');
    expect(parseCsv('a\tb\n1\t2').delimiter).toBe('\t');
    expect(parseCsv('a,b\n1,2').delimiter).toBe(',');
    expect(parseCsv('"a;b",c\n1,2').delimiter).toBe(',');
  });
  it('decodes UTF-8 with or without a mark, UTF-16 with a mark, and falls back to windows-1251', () => {
    expect(parseCsv(Buffer.from('﻿имя;город\nИван;Москва')).rows[1]).toEqual(['Иван', 'Москва']);
    expect(parseCsv(Buffer.from('имя;город\nИван;Москва')).encoding).toBe('utf-8');
    const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('имя;город\nИван;Москва', 'utf16le')]);
    expect(parseCsv(u16).rows[1]).toEqual(['Иван', 'Москва']);
    const cp1251 = Buffer.from([0xc8, 0xe2, 0xe0, 0xed, 0x3b, 0xcc, 0xee, 0xf1, 0xea, 0xe2, 0xe0]); // "Иван;Москва"
    const r = parseCsv(cp1251);
    expect(r.rows).toEqual([['Иван', 'Москва']]);
    expect(r.encoding).toBe('windows-1251');
    expect(parseCsv(cp1251, { encoding: 'windows-1251' }).rows[0][0]).toBe('Иван');
    fails(() => parseCsv(cp1251, { encoding: 'no-such-charset' }), 'BAD_ENCODING');
  });
  it('can take the apostrophe off again where a writer would have put it', () => {
    expect(parseCsv("'=1+1,'quoted'", { unescapeFormulae: true }).rows).toEqual([['=1+1', "'quoted'"]]);
    expect(parseCsv("'=1+1").rows).toEqual([["'=1+1"]]);
  });
  it('refuses what is too big, too wide, too long, or not closed', () => {
    fails(() => parseCsv('a,b\n1,2', { limits: { maxBytes: 3 } }), 'TOO_BIG');
    fails(() => parseCsv('1\n2\n3', { limits: { maxRows: 2 } }), 'TOO_MANY_ROWS');
    fails(() => parseCsv('1,2,3', { limits: { maxCols: 2 } }), 'TOO_MANY_COLS');
    fails(() => parseCsv('1,2\n3,4', { limits: { maxCells: 3 } }), 'TOO_MANY_CELLS');
    fails(() => parseCsv('a,"b'), 'UNTERMINATED_QUOTE');
    expect(new CsvError('X', 'y').name).toBe('CsvError');
  });
  it('stays fast on a long quoted field and on many delimiters', () => {
    const t0 = Date.now();
    expect(parseCsv(`"${'a""'.repeat(300000)}"`).rows[0][0].length).toBe(600000);
    expect(parseCsv(','.repeat(150), { limits: { maxCols: 200 } }).rows[0].length).toBe(151);
    expect(Date.now() - t0 < 3000).toBe(true);
  });
  it('round-trips what it writes', () => {
    const rows = [['name', 'note'], ['a "b"', 'x,y\nz'], ['', ' sp ']];
    expect(parseCsv(writeCsv(rows)).rows).toEqual(rows);
  });

  it('excel: a UTF-8 mark and ";" for Russian Excel, the comma for English, and explicit options still win', () => {
    const rows = [['Что', 'Цель'], ['а,б', 'в']];
    const ru = writeCsv(rows, { excel: 'ru' });
    expect(ru.charCodeAt(0)).toBe(0xfeff);
    expect(ru.slice(1)).toBe('Что;Цель\r\nа,б;в'); // a comma needs no quotes when the delimiter is ";"
    expect(writeCsv(rows, { excel: 'en' })).toBe('\ufeffЧто,Цель\r\n"а,б",в');
    expect(writeCsv(rows, { excel: 'ru', delimiter: '\t', bom: false })).toBe('Что\tЦель\r\nа,б\tв');
    expect(writeCsv(rows)).toBe('Что,Цель\r\n"а,б",в');
    // and it reads back (the mark is dropped, the delimiter found)
    expect(parseCsv(Buffer.from(ru, 'utf8')).rows).toEqual(rows);
  });
});

describe('formula neutralisation: hidden and full-width forms (audit S-06)', () => {
  it('catches leading blanks, invisible characters and full-width signs', () => {
    for (const s of [' =1+1', '​=1+1', '﻿=SUM(A1)', '＝1+1', '＋1', '－1', '＠SUM(1)', ' ​ @x']) expect(isFormulaText(s), JSON.stringify(s)).toBe(true);
    expect(escapeFormula(' =1+1')).toBe("' =1+1");
  });
  it('leaves ordinary text alone and round-trips the apostrophe', () => {
    for (const s of ['hello', 'a=b', 'x @ y', ' hello', '']) expect(isFormulaText(s), JSON.stringify(s)).toBe(false);
    for (const s of ['=1+1', ' =1+1', '＝1']) expect(unescapeFormula(escapeFormula(s))).toBe(s);
  });

  describe('exports from 1C and Excel', () => {
    const cp866 = (str) => Buffer.from([...str].map((ch) => { const c = ch.charCodeAt(0); return c >= 0x410 && c <= 0x43f ? c - 0x410 + 0x80 : c >= 0x440 && c <= 0x44f ? c - 0x440 + 0xe0 : c; }));
    const cp1251 = (str) => Buffer.from([...str].map((ch) => { const c = ch.charCodeAt(0); return c >= 0x410 && c <= 0x44f ? c - 0x410 + 0xc0 : c; }));
    const text = 'Наименование;Количество;Примечание\r\nСтол офисный;5;без скидки\r\nКресло рабочее;12;доставка в понедельник\r\n';

    it('tells windows-1251 from cp866 and says it guessed', () => {
      for (const make of [cp1251, cp866]) {
        const r = parseCsv(make(text));
        expect(r.rows[1]).toEqual(['Стол офисный', '5', 'без скидки']);
        expect(r.warnings).toEqual([{ code: 'ENCODING_GUESSED', encoding: make === cp1251 ? 'windows-1251' : 'ibm866' }]);
      }
    });

    it('an explicit fallback encoding is used as given, without a guess', () => {
      const r = parseCsv(cp866(text), { fallbackEncoding: 'ibm866' });
      expect(r.rows[1][0]).toBe('Стол офисный');
      expect(r.warnings).toEqual([]);
    });

    it('finds the delimiter by many lines, knows the pipe, and keeps quoted delimiters out of the count', () => {
      expect(parseCsv('a|b|c\n1|2|3\n').delimiter).toBe('|');
      const r = parseCsv('name;note\n"a, b, c, d";x\n"e, f";y\n');
      expect(r.delimiter).toBe(';');
      expect(r.warnings).toEqual([]);
    });

    it('a delimiter that only the first line has is reported as a guess', () => {
      const r = parseCsv('a,b\nx\ny\nz\n');
      expect(r.warnings.map((w) => w.code)).toContain('DELIMITER_GUESSED');
    });

    it("honours Excel's sep= line and does not return it as data", () => {
      const r = parseCsv('sep=;\nA;B\n1;2\n');
      expect(r.rows).toEqual([['A', 'B'], ['1', '2']]);
      expect(r.warnings).toEqual([{ code: 'SEP_HINT_USED', delimiter: ';' }]);
    });

    it('counts rows of a different width', () => {
      expect(parseCsv('a;b;c\n1;2\n1;2;3;4\n', { delimiter: ';' }).warnings).toEqual([{ code: 'RAGGED_ROWS', count: 2 }]);
    });
  });

  it("a text that already starts with an apostrophe before a formula survives the escape and its undo (found by a random test)", () => {
    for (const v of ["'=1", "''=1", "'@x", '=1', "'abc"]) {
      expect(unescapeFormula(escapeFormula(v))).toBe(v);
      expect(parseCsv(writeCsv([[v, 'z']]), { delimiter: ',', unescapeFormulae: true }).rows[0][0]).toBe(v);
    }
  });
});
