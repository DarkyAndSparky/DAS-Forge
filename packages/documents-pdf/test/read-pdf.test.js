import { describe, it, expect } from 'vitest';
import { readDocument, readDocumentIsolated, DocumentError } from '@das-forge/core/documents';
import readPdf, { readPdf as named } from '../src/index.js';

const PDF = Buffer.from('%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

/** A stand-in for unpdf with the same functions; `o` says what the "file" holds. */
function fake(o = {}) {
  const pages = o.pages ?? ['Первая страница', 'Вторая страница'];
  const proxy = {
    numPages: pages.length,
    hasJSActions: async () => Boolean(o.js),
    getJSActions: async () => (o.js ? { OpenAction: ['app.alert(1)'] } : null),
    getAttachments: async () => (o.attachments ? Object.fromEntries(o.attachments.map((n, i) => [i, { filename: n }])) : null),
    destroy: async () => { fake.destroyed = (fake.destroyed ?? 0) + 1; },
  };
  return {
    getDocumentProxy: async () => { if (o.password) { const e = new Error('No password given'); e.name = 'PasswordException'; throw e; } if (o.broken) throw new Error('Invalid PDF structure'); return proxy; },
    extractText: async () => ({ totalPages: pages.length, text: pages }),
    extractLinks: async () => ({ totalPages: pages.length, links: [o.links ?? [], []] }),
    getMeta: async () => ({ info: { Title: o.title ?? 'Отчёт', Author: 'Анна' }, metadata: null }),
    inspectPages: async () => ({ totalPages: pages.length, pages: pages.map((t, i) => ({ textLength: t.length, invisibleTextLength: o.hidden && i === 0 ? 5 : 0, imageCount: o.scan ? 1 : 0, imageCoverage: o.scan ? 1 : 0 })) }),
  };
}

describe('readPdf', () => {
  it('has the reader as the default and the named export', () => { expect(readPdf).toBe(named); });

  it('returns pages as blocks, plain text and properties in the shape of the other readers', async () => {
    const r = await readPdf(PDF, { engine: fake() });
    expect(r.format).toBe('pdf');
    expect(r.blocks).toEqual([{ type: 'paragraph', text: 'Первая страница', page: 1 }, { type: 'paragraph', text: 'Вторая страница', page: 2 }]);
    expect(r.text).toBe('Первая страница\n\nВторая страница');
    expect(r.metadata).toEqual({ title: 'Отчёт', author: 'Анна' });
    expect(r.warnings).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  it('refuses a password-protected file and a file that is not a PDF', async () => {
    await expect(readPdf(PDF, { engine: fake({ password: true }) })).rejects.toMatchObject({ code: 'ENCRYPTED' });
    await expect(readPdf(PDF, { engine: fake({ broken: true }) })).rejects.toMatchObject({ code: 'NOT_A_DOCUMENT' });
  });

  it('refuses scripts by default and reads on with a warning when told to ignore them', async () => {
    await expect(readPdf(PDF, { engine: fake({ js: true }) })).rejects.toMatchObject({ code: 'MACROS' });
    const r = await readPdf(PDF, { engine: fake({ js: true }), macros: 'ignore' });
    expect(r.safety.macros).toBe(true);
    expect(r.warnings).toContainEqual({ code: 'MACROS_IGNORED' });
  });

  it('reports links and attachments, and refuses them on request', async () => {
    const e = fake({ links: ['https://example.org/a', '#page=2'], attachments: ['x.exe'] });
    const r = await readPdf(PDF, { engine: e });
    expect(r.safety.externalLinks).toEqual([{ kind: 'link', target: 'https://example.org/a' }]);
    expect(r.safety.embedded).toEqual([{ name: 'x.exe' }]);
    await expect(readPdf(PDF, { engine: e, externalLinks: 'refuse' })).rejects.toMatchObject({ code: 'EXTERNAL_LINKS' });
    await expect(readPdf(PDF, { engine: e, embedded: 'refuse' })).rejects.toMatchObject({ code: 'EMBEDDED_OBJECTS' });
  });

  it('says so about text that paints nothing, and about a scan without a text layer', async () => {
    expect((await readPdf(PDF, { engine: fake({ hidden: true }) })).warnings).toContainEqual({ code: 'HIDDEN_TEXT' });
    const scan = await readPdf(PDF, { engine: fake({ pages: ['', ''], scan: true }) });
    expect(scan.blocks).toEqual([]);
    expect(scan.warnings).toContainEqual({ code: 'NO_TEXT_LAYER' });
  });

  it('limits pages and characters', async () => {
    await expect(readPdf(PDF, { engine: fake({ pages: ['a', 'b', 'c'] }), limits: { maxPages: 2 } })).rejects.toMatchObject({ code: 'TOO_MANY_PAGES' });
    const r = await readPdf(PDF, { engine: fake({ pages: ['abcdef', 'ghijkl'] }), limits: { maxChars: 8 } });
    expect(r.truncated).toBe(true);
    expect(r.text.replace(/\n/g, '').length).toBe(8);
    expect(r.warnings).toContainEqual({ code: 'TRUNCATED' });
  });

  it('inspectOnly gives the report without text', async () => {
    const r = await readPdf(PDF, { engine: fake({ attachments: ['a.txt'] }), inspectOnly: true });
    expect(r.text).toBe('');
    expect(r.safety.embedded).toHaveLength(1);
  });

  it('closes the document, also when it refuses', async () => {
    fake.destroyed = 0;
    await readPdf(PDF, { engine: fake() });
    await expect(readPdf(PDF, { engine: fake({ js: true }) })).rejects.toBeInstanceOf(DocumentError);
    expect(fake.destroyed).toBe(2);
  });

  it('says what to do when the PDF library is not installed', async () => {
    await expect(readPdf(PDF)).rejects.toMatchObject({ code: 'PDF_ENGINE_MISSING' });
  });
});

describe('through readDocument', () => {
  it('a PDF without a plugged-in reader is refused with a clear code', async () => {
    await expect(readDocument(PDF)).rejects.toMatchObject({ code: 'PDF_READER_MISSING' });
  });
  it('a PDF goes to readers.pdf with the options of the call', async () => {
    let seen;
    const r = await readDocument(PDF, { macros: 'ignore', readers: { pdf: async (b, o) => { seen = o; return { format: 'pdf', text: 'ok', blocks: [], metadata: {}, safety: {}, warnings: [], truncated: false }; } } });
    expect(r.text).toBe('ok');
    expect(seen.macros).toBe('ignore');
  });
  it('the size limit applies before the reader is asked', async () => {
    await expect(readDocument(Buffer.concat([PDF, Buffer.alloc(100)]), { limits: { maxBytes: 50 }, readers: { pdf: async () => { throw new Error('must not run'); } } })).rejects.toMatchObject({ code: 'TOO_BIG' });
  });
  it('the isolated reader takes a module name, not a function', () => {
    expect(() => readDocumentIsolated(PDF, { readers: { pdf() {} } })).toThrow(/readerModules/);
    expect(() => readDocumentIsolated(PDF, { readerModules: { pdf: 5 } })).toThrow(/readerModules/);
    expect(() => readDocumentIsolated(PDF, { readerModules: { exe: 'x' } })).toThrow(/readerModules/);
  });
  it('the isolated reader loads the named module inside its thread and hands it the options', async () => {
    const spec = new URL('./fixtures/stub-reader.mjs', import.meta.url).href;
    const r = await readDocumentIsolated(PDF, { readerModules: { pdf: spec }, macros: 'ignore' });
    expect(r.text).toBe(`stub:${PDF.length}:ignore`);
  });
});
