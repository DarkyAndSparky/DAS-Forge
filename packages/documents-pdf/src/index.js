import { DocumentError } from '@das-forge/core/documents';

export const PDF_LIMITS = Object.freeze({ maxPages: 1000, maxChars: 2_000_000 });

/**
 * PDF reader for the `documents` module of the core. It gives the same result as the readers of word-processor files
 * (`{ format, text, blocks, metadata, safety, warnings, truncated }`) and refuses by the same rules:
 *   - encrypted file: `ENCRYPTED`;
 *   - scripts (JavaScript actions): `MACROS`, unless `macros: 'ignore'` (the scripts are never run);
 *   - attachments: `EMBEDDED_OBJECTS` when `embedded: 'refuse'`;
 *   - links: `EXTERNAL_LINKS` when `externalLinks: 'refuse'` (links are never followed);
 *   - too many pages: `TOO_MANY_PAGES`; text is cut at `maxChars` (`truncated`).
 * Text that paints nothing (the recognised-text layer of a scan, text in a hidden layer) is reported as the warning
 * `HIDDEN_TEXT`; a page range with images and no text is reported as `NO_TEXT_LAYER` (a scan: no OCR is done).
 * The parsing is done by unpdf (PDF.js); it is loaded on first use, so an application that never reads PDF does not
 * need it. For files from people you do not trust, run it in a thread of its own:
 *   readDocumentIsolated(buf, { readerModules: { pdf: '@das-forge/documents-pdf' } })
 *
 * @param {Buffer} buffer
 * @param {object} [o] - those handed over by `readDocument`: macros, externalLinks, embedded, inspectOnly, limits, signal
 * @param {object} [o.engine] - the PDF library (default: `unpdf`); anything with the same functions works, which the tests use
 */
async function loadEngine() {
  try {
    return await import('unpdf');
  } catch (e) {
    throw new DocumentError('PDF_ENGINE_MISSING', `the PDF library is not installed: run "npm install unpdf" (${e?.code ?? e?.message})`);
  }
}

const clip = (v, n = 500) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, n);

export async function readPdf(buffer, { macros = 'refuse', externalLinks = 'allow', embedded = 'allow', inspectOnly = false, limits: custom = {}, signal, engine } = {}) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('readPdf: a Buffer is required');
  const limits = { ...PDF_LIMITS, ...custom };
  const lib = engine ?? await loadEngine();
  signal?.throwIfAborted();
  let pdf;
  try {
    pdf = await lib.getDocumentProxy(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength), { isEvalSupported: false, disableFontFace: true });
  } catch (e) {
    if (e?.name === 'PasswordException') throw new DocumentError('ENCRYPTED', 'the PDF is protected by a password');
    throw new DocumentError('NOT_A_DOCUMENT', `the file is not a readable PDF (${clip(e?.message, 120)})`);
  }
  try {
    if (pdf.numPages > limits.maxPages) throw new DocumentError('TOO_MANY_PAGES', 'the PDF has too many pages');
    // What the file carries besides text. Nothing here runs: PDF.js is only asked what is there.
    const safety = { macros: false, embedded: [], externalLinks: [], encrypted: false, activeX: false };
    try { safety.macros = Boolean(await pdf.hasJSActions?.()) || Boolean((await pdf.getJSActions?.()) && Object.keys(await pdf.getJSActions()).length); } catch { /* unknown: treated as none */ }
    try { safety.embedded = Object.values((await pdf.getAttachments?.()) ?? {}).map((a) => ({ name: clip(a?.filename, 200) })); } catch { /* none */ }
    try { safety.externalLinks = ((await lib.extractLinks?.(pdf))?.links ?? []).flat().filter((u) => /^[a-z][a-z0-9+.-]*:/i.test(u) && !/^#/.test(u)).map((u) => ({ kind: 'link', target: clip(u, 300) })); } catch { /* none */ }
    if (safety.macros && macros !== 'ignore') throw new DocumentError('MACROS', 'the PDF contains scripts');
    if (safety.externalLinks.length && externalLinks === 'refuse') throw new DocumentError('EXTERNAL_LINKS', 'the PDF refers to outside addresses');
    if (safety.embedded.length && embedded === 'refuse') throw new DocumentError('EMBEDDED_OBJECTS', 'the PDF holds attached files');
    signal?.throwIfAborted();
    const info = (await lib.getMeta?.(pdf).catch?.(() => null)) ?? null;
    const metadata = {};
    if (info?.info?.Title) metadata.title = clip(info.info.Title);
    if (info?.info?.Author) metadata.author = clip(info.info.Author);
    const warnings = [];
    if (safety.externalLinks.length) warnings.push({ code: 'EXTERNAL_LINKS', count: safety.externalLinks.length });
    if (safety.embedded.length) warnings.push({ code: 'EMBEDDED_OBJECTS', count: safety.embedded.length });
    if (safety.macros) warnings.push({ code: 'MACROS_IGNORED' });
    if (inspectOnly) return { format: 'pdf', text: '', blocks: [], metadata, safety, warnings, truncated: false };

    const { text: pages } = await lib.extractText(pdf, { mergePages: false });
    const seen = await lib.inspectPages?.(pdf).catch?.(() => null);
    if (seen?.pages?.some((p) => p.invisibleTextLength > 0)) warnings.push({ code: 'HIDDEN_TEXT' });
    const blocks = [];
    let chars = 0;
    let truncated = false;
    for (let i = 0; i < pages.length && !truncated; i++) {
      signal?.throwIfAborted();
      let t = clip(pages[i], limits.maxChars).replace(/\u0000/g, '');
      if (chars + t.length > limits.maxChars) { t = t.slice(0, limits.maxChars - chars); truncated = true; }
      chars += t.length;
      if (t.trim()) blocks.push({ type: 'paragraph', text: t, page: i + 1 });
    }
    if (!blocks.length && seen?.pages?.some((p) => p.imageCount > 0)) warnings.push({ code: 'NO_TEXT_LAYER' });
    if (truncated) warnings.push({ code: 'TRUNCATED' });
    return { format: 'pdf', text: blocks.map((b) => b.text).join('\n\n'), blocks, metadata, safety, warnings, truncated };
  } finally {
    try { await pdf.destroy?.(); } catch { /* the document is already gone */ }
  }
}

export default readPdf;
