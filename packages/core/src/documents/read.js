import { DocumentError } from './errors.js';
import { defaultZip } from '../xlsx/zip-backend.js';
import { assertSafeXml, tokens, attr } from '../xlsx/xml.js';

/**
 * Readers for word-processor and presentation files: .docx, .pptx (Office Open XML), .odt, .odp (OpenDocument).
 * They take the text, the tables and the basic properties, and tell what else the file carries. They never run, expand
 * or fetch anything: only the XML parts that hold text are unpacked, a document type or entity is refused, macros and
 * encryption are refused by default, and every size is limited. The archive side is the one of the spreadsheet readers
 * (yauzl, with the same checks for duplicate names, absurd compression ratios and sizes).
 */

export const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 20 * 1024 * 1024,
  maxEntries: 2000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
  maxPartBytes: 32 * 1024 * 1024,
  maxChars: 2_000_000,
  maxBlocks: 100_000,
  maxSlides: 1000,
});

const norm = (n) => n.replace(/\\/g, '/').replace(/^\/+/, '');
const ODF_MIME = /^application\/vnd\.oasis\.opendocument\.(text|presentation)(-template)?$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const clean = (s) => s.replace(CONTROL, '');

/** A PDF starts with `%PDF-` within its first kilobyte (readers tolerate a little junk before it). */
export const isPdf = (buffer) => buffer.subarray(0, 1024).includes('%PDF-', 0, 'latin1');

/** Which kind of file this is, from the names of the parts (never from the file name, which the sender chooses). */
function detect(names, mime) {
  if (mime) return /presentation/.test(mime) ? 'odp' : 'odt';
  if (names.has('word/document.xml')) return 'docx';
  if ([...names].some((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))) return 'pptx';
  return null;
}

/** What the file carries besides text. Names are the parts of the archive; `rels` the text of the relationship parts. */
function scanSafety(format, names, rels, manifest) {
  const list = [...names];
  const safety = { macros: false, embedded: [], externalLinks: [], encrypted: false, activeX: false };
  if (format === 'docx' || format === 'pptx') {
    safety.macros = list.some((n) => /(^|\/)vbaProject\.bin$/.test(n) || /(^|\/)vbaData\.xml$/.test(n));
    safety.activeX = list.some((n) => /(^|\/)activeX\//.test(n));
    safety.embedded = list.filter((n) => /(^|\/)(embeddings|oleObject)/.test(n) || /\.(exe|dll|bat|cmd|js|vbs|ps1|scr|jar|lnk)$/i.test(n));
    for (const text of rels) {
      for (const m of text.matchAll(/<Relationship\b[^>]*>/g)) {
        if (!/TargetMode\s*=\s*"External"/i.test(m[0])) continue;
        const target = /Target\s*=\s*"([^"]*)"/.exec(m[0])?.[1] ?? '';
        const type = /Type\s*=\s*"[^"]*\/([A-Za-z]+)"/.exec(m[0])?.[1] ?? 'link';
        safety.externalLinks.push({ kind: type, target: target.slice(0, 300) });
      }
    }
  } else {
    safety.macros = list.some((n) => /^(basic|scripts)\//i.test(n));
    safety.embedded = list.filter((n) => /^(object \d+|objects)\//i.test(n) || /\.(exe|dll|bat|cmd|js|vbs|ps1|scr|jar|lnk)$/i.test(n));
    if (manifest && /encryption-data/.test(manifest)) safety.encrypted = true;
  }
  return safety;
}

const CONFIG = {
  docx: { para: new Set(['p']), text: new Set(['t']), tab: 'tab', br: 'br', table: 'tbl', row: 'tr', cell: 'tc', ooxml: true },
  pptx: { para: new Set(['p']), text: new Set(['t']), tab: null, br: 'br', table: 'tbl', row: 'tr', cell: 'tc', ooxml: true },
  odt: { para: new Set(['p', 'h']), text: null, tab: 'tab', br: 'line-break', table: 'table', row: 'table-row', cell: 'table-cell', ooxml: false },
  odp: { para: new Set(['p', 'h']), text: null, tab: 'tab', br: 'line-break', table: 'table', row: 'table-row', cell: 'table-cell', ooxml: false },
};
const ODF_SKIP = new Set(['annotation', 'tracked-changes', 'sequence-decls', 'variable-decls', 'user-field-decls', 'script']);

/**
 * Walks one XML part and appends what it finds to `out`. Blocks: `{type:'heading', level, text}`,
 * `{type:'paragraph', text}`, `{type:'table', rows: string[][]}`; `slide` tags every block with the slide number.
 */
function walk(xml, format, out, ctx) {
  const cfg = CONFIG[format];
  const tables = []; // open tables (a table in a cell is a table of its own)
  let para = null; // { text, style }
  let inText = 0;
  let skip = 0;
  let run = null; // OOXML run: { text, hidden }
  const push = (b) => {
    if (ctx.blocks >= ctx.limits.maxBlocks) { ctx.truncated = true; return; }
    ctx.blocks++;
    out.push(ctx.slide ? { ...b, slide: ctx.slide } : b);
  };
  const addText = (s) => {
    if (!para || !s) return;
    if (ctx.chars + s.length > ctx.limits.maxChars) { ctx.truncated = true; s = s.slice(0, Math.max(0, ctx.limits.maxChars - ctx.chars)); }
    ctx.chars += s.length;
    if (run) run.text += s; else para.text += s;
  };
  for (const t of tokens(xml)) {
    if (t.type === 'open') {
      if (skip) { skip++; continue; }
      if (!cfg.ooxml && ODF_SKIP.has(t.name)) { skip = 1; continue; }
      if (format === 'odp' && t.name === 'page') ctx.slide++;
      if (cfg.para.has(t.name)) {
        const level = t.name === 'h' ? Number(attr(t.attrs, 'outline-level')) || 1 : 0;
        para = { text: '', level, style: null };
      } else if (cfg.ooxml && t.name === 'pStyle' && para) {
        const m = /^(?:heading|заголовок)\s*(\d)$/i.exec(attr(t.attrs, 'val') ?? '');
        if (m) para.level = Number(m[1]); else if (/^title$/i.test(attr(t.attrs, 'val') ?? '')) para.level = 1;
      } else if (cfg.ooxml && t.name === 'r' && para) run = { text: '', hidden: false };
      else if (cfg.ooxml && t.name === 'vanish' && run && attr(t.attrs, 'val') !== '0' && attr(t.attrs, 'val') !== 'false') run.hidden = true;
      else if (cfg.ooxml && cfg.text.has(t.name) && para) inText++;
      else if (!cfg.ooxml && para && t.name === 's') addText(' '.repeat(Math.min(Number(attr(t.attrs, 'c')) || 1, 1000)));
      else if (cfg.tab && t.name === cfg.tab && para) addText('\t');
      else if (t.name === cfg.br && para) addText('\n');
      else if (t.name === cfg.table) tables.push({ rows: [], row: null, cell: null });
      else if (t.name === cfg.row && tables.length) tables.at(-1).row = [];
      else if (t.name === cfg.cell && tables.length) tables.at(-1).cell = '';
    } else if (t.type === 'text') {
      if (skip || !para) continue;
      if (cfg.ooxml ? inText > 0 : true) addText(clean(t.text));
    } else if (t.type === 'close') {
      if (skip) { skip--; continue; }
      if (cfg.ooxml && cfg.text.has(t.name) && inText) inText--;
      else if (cfg.ooxml && t.name === 'r' && run) {
        if (run.hidden) ctx.hidden = true; else if (para) para.text += run.text;
        run = null;
      } else if (cfg.para.has(t.name) && para) {
        const p = para; para = null; inText = 0;
        const text = p.text.replace(/\s+$/u, '');
        if (tables.length && tables.at(-1).cell !== null) {
          const tb = tables.at(-1);
          if (text) tb.cell += (tb.cell ? '\n' : '') + text;
        } else if (text) push(p.level ? { type: 'heading', level: Math.min(p.level, 6), text } : { type: 'paragraph', text });
      } else if (t.name === cfg.cell && tables.length) {
        const tb = tables.at(-1); if (tb.row) tb.row.push(tb.cell ?? ''); tb.cell = null;
      } else if (t.name === cfg.row && tables.length) {
        const tb = tables.at(-1); if (tb.row) tb.rows.push(tb.row); tb.row = null;
      } else if (t.name === cfg.table && tables.length) {
        const tb = tables.pop();
        if (tb.rows.length) push({ type: 'table', rows: tb.rows });
      }
    }
  }
}

function readMeta(format, xml) {
  const meta = {};
  if (!xml) return meta;
  let cur = null;
  const map = format === 'docx' || format === 'pptx'
    ? { title: 'title', subject: 'subject', creator: 'author', lastModifiedBy: 'lastModifiedBy', created: 'created', modified: 'modified', keywords: 'keywords' }
    : { title: 'title', subject: 'subject', 'initial-creator': 'author', creator: 'lastModifiedBy', 'creation-date': 'created', date: 'modified', keyword: 'keywords' };
  for (const t of tokens(xml)) {
    if (t.type === 'open') cur = map[t.name] ?? null;
    else if (t.type === 'text' && cur) meta[cur] = clean((meta[cur] ?? '') + t.text).slice(0, 500);
    else if (t.type === 'close') cur = null;
  }
  return meta;
}

/**
 * Reads a document into `{ format, text, blocks, metadata, safety, warnings, truncated }`.
 * - `format`: 'docx' | 'pptx' | 'odt' | 'odp', decided by the parts of the archive.
 * - `blocks`: headings, paragraphs and tables in reading order (slides carry `slide: n`); `text` is the same as plain text.
 * - `safety`: `{ macros, embedded, externalLinks, encrypted, activeX }`; `warnings` lists what the caller should know
 *   (`EXTERNAL_LINKS`, `EMBEDDED_OBJECTS`, `HIDDEN_TEXT` - hidden runs are left out of the text, `TRUNCATED`).
 * - A PDF is handed to `readers.pdf` (the reader of `@das-forge/documents-pdf`); without one, `PDF_READER_MISSING`.
 * - Options: `readers`, `macros` ('refuse' by default | 'ignore'), `externalLinks` ('allow' by default | 'refuse'; links are never
 *   followed), `embedded` ('allow' | 'refuse'), `inspectOnly` (no text, just `safety` and `metadata`), `limits`, `signal`.
 * Refusals throw `DocumentError` with `code`: NOT_A_DOCUMENT, TOO_BIG, ENCRYPTED, MACROS, EXTERNAL_LINKS, EMBEDDED_OBJECTS, ...
 * Old binary .doc/.ppt and .rtf are not read (they are not archives).
 */
export async function readDocument(buffer, { macros = 'refuse', externalLinks = 'allow', embedded = 'allow', inspectOnly = false, limits: custom = {}, zip = defaultZip, signal, readers = {} } = {}) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('readDocument: a Buffer is required');
  for (const [k, v, ok] of [['macros', macros, ['refuse', 'ignore']], ['externalLinks', externalLinks, ['allow', 'refuse']], ['embedded', embedded, ['allow', 'refuse']]]) {
    if (!ok.includes(v)) throw new RangeError(`readDocument: ${k} is ${ok.map((x) => `'${x}'`).join(' or ')}`);
  }
  const limits = { ...DEFAULT_LIMITS, ...custom };
  if (buffer.length > limits.maxBytes) throw new DocumentError('TOO_BIG', 'the file is larger than allowed');
  if (isPdf(buffer)) {
    // PDF is not an archive: it is read by a plug-in (`@das-forge/documents-pdf`), which the application passes in `readers.pdf`.
    if (typeof readers.pdf !== 'function') throw new DocumentError('PDF_READER_MISSING', 'the file is a PDF and no PDF reader is installed (see @das-forge/documents-pdf)');
    return await readers.pdf(buffer, { macros, externalLinks, embedded, inspectOnly, limits, signal });
  }
  if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0xd0cf11e0) throw new DocumentError('ENCRYPTED_OR_LEGACY', 'the file is in the old binary container (an encrypted document or a .doc/.ppt), which is not read');
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) throw new DocumentError('NOT_A_DOCUMENT', 'the file is not a document');
  const zl = { maxEntries: limits.maxEntries, maxEntryBytes: limits.maxEntryBytes, maxTotalBytes: limits.maxTotalBytes, maxPartBytes: limits.maxPartBytes };
  const wrap = async (fn) => { try { return await fn(); } catch (e) { if (e?.name === 'XlsxError') throw new DocumentError(e.code === 'NOT_A_WORKBOOK' ? 'NOT_A_DOCUMENT' : e.code, e.message.replace('workbook', 'document')); throw e; } };
  // First pass: names only (nothing unpacked except the small mimetype part), to learn what the file is.
  const probe = await wrap(() => zip.read(buffer, { ...zl, wanted: (n) => norm(n) === 'mimetype' }));
  const names = new Set([...probe.keys()].filter((k) => k.startsWith('#names:')).map((k) => norm(k.slice(7))));
  const mime = probe.get('mimetype')?.toString('latin1').trim() ?? null;
  if (mime && !ODF_MIME.test(mime)) throw new DocumentError('NOT_A_DOCUMENT', 'the file is an OpenDocument file of another kind (not text or presentation)');
  const lower = new Map([...names].map((n) => [n.toLowerCase(), n]));
  const format = detect(new Set(lower.keys()), mime);
  if (!format) throw new DocumentError('NOT_A_DOCUMENT', 'the file is not a text document or a presentation');
  const ooxml = format === 'docx' || format === 'pptx';
  const slidePart = (n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n);
  const notePart = (n) => /^ppt\/notesslides\/notesslide\d+\.xml$/i.test(n);
  const wanted = (raw) => {
    const n = norm(raw).toLowerCase();
    if (ooxml) {
      if (/\.rels$/.test(n)) return true;
      return n === 'docprops/core.xml' || (!inspectOnly && (n === 'word/document.xml' || slidePart(n) || notePart(n)));
    }
    return n === 'meta.xml' || n === 'meta-inf/manifest.xml' || (!inspectOnly && n === 'content.xml');
  };
  const parts = await wrap(() => zip.read(buffer, { ...zl, wanted }));
  const got = new Map();
  for (const [k, v] of parts) if (!k.startsWith('#')) got.set(norm(k).toLowerCase(), v);
  const text = (n) => { const b = got.get(n); if (!b) return null; const s = b.toString('utf8').replace(/^﻿/, ''); assertSafeXmlDoc(s, n); return s; };
  const rels = [...got].filter(([k]) => k.endsWith('.rels')).map(([, v]) => v.toString('utf8'));
  const manifest = text('meta-inf/manifest.xml');
  const safety = scanSafety(format, names, rels, manifest);
  if (safety.encrypted) throw new DocumentError('ENCRYPTED', 'the document is encrypted');
  if (safety.macros && macros !== 'ignore') throw new DocumentError('MACROS', 'the document contains macros');
  if (safety.externalLinks.length && externalLinks === 'refuse') throw new DocumentError('EXTERNAL_LINKS', 'the document refers to outside addresses');
  if (safety.embedded.length && embedded === 'refuse') throw new DocumentError('EMBEDDED_OBJECTS', 'the document holds embedded objects or files');
  signal?.throwIfAborted();
  const metadata = readMeta(format, text(ooxml ? 'docprops/core.xml' : 'meta.xml'));
  const warnings = [];
  if (safety.externalLinks.length) warnings.push({ code: 'EXTERNAL_LINKS', count: safety.externalLinks.length });
  if (safety.embedded.length) warnings.push({ code: 'EMBEDDED_OBJECTS', count: safety.embedded.length });
  if (safety.macros) warnings.push({ code: 'MACROS_IGNORED' });
  if (inspectOnly) return { format, text: '', blocks: [], metadata, safety, warnings, truncated: false };
  const ctx = { limits, chars: 0, blocks: 0, truncated: false, hidden: false, slide: 0 };
  const blocks = [];
  if (format === 'docx') {
    const xml = text('word/document.xml');
    if (!xml) throw new DocumentError('NOT_A_DOCUMENT', 'the document has no body');
    walk(xml, format, blocks, ctx);
  } else if (format === 'pptx') {
    const num = (n) => Number(/(\d+)\.xml$/.exec(n)[1]);
    const slides = [...got.keys()].filter(slidePart).sort((a, b) => num(a) - num(b));
    if (slides.length > limits.maxSlides) throw new DocumentError('TOO_MANY_SLIDES', 'the presentation has too many slides');
    for (const s of slides) {
      signal?.throwIfAborted();
      ctx.slide = num(s);
      walk(text(s), format, blocks, ctx);
      const note = got.has(`ppt/notesslides/notesslide${ctx.slide}.xml`) ? text(`ppt/notesslides/notesslide${ctx.slide}.xml`) : null;
      if (note) { const nb = []; walk(note, format, nb, ctx); for (const b of nb) if (b.type !== 'table' && !/^\d+$/.test(b.text)) blocks.push({ ...b, type: 'note' }); }
    }
  } else {
    const xml = text('content.xml');
    if (!xml) throw new DocumentError('NOT_A_DOCUMENT', 'the document has no content');
    walk(xml, format, blocks, ctx);
  }
  if (ctx.hidden) warnings.push({ code: 'HIDDEN_TEXT' });
  if (ctx.truncated) warnings.push({ code: 'TRUNCATED' });
  const plain = blocks.map((b) => (b.type === 'table' ? b.rows.map((r) => r.join('\t')).join('\n') : b.text)).join('\n\n');
  return { format, text: plain, blocks, metadata, safety, warnings, truncated: ctx.truncated };
}

function assertSafeXmlDoc(s, name) {
  try { assertSafeXml(s, name); } catch (e) { throw new DocumentError('UNSAFE_XML', e.message); }
}

/** Only what the file carries, no text: `readDocument(buffer, { inspectOnly: true, macros: 'ignore' })`. */
export const inspectDocument = (buffer, opts = {}) => readDocument(buffer, { macros: 'ignore', ...opts, inspectOnly: true });
