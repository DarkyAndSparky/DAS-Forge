import { StringDecoder } from 'node:string_decoder';
import { XlsxError } from './errors.js';

/** A document type declaration or entity is never legitimate in a spreadsheet part and is how XML bombs are made. */
export function assertSafeXml(text, name) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new XlsxError('UNSAFE_XML', `"${name}" contains a document type declaration`);
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** The five predefined entities and numeric references, nothing else (so nothing is ever expanded or fetched). */
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g, (m, g) => {
    if (g[0] !== '#') return NAMED[g];
    const cp = g[1] === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '';
  });
}

/** Excel writes control characters in text as _xHHHH_ (a literal "_x" is written as _x005F_x). */
export function decodeExcelEscapes(s) {
  return s.replace(/_x([0-9A-Fa-f]{4})_/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
}

const NAME_CHAR = /[\w:.-]/;

const bad = (why) => new XlsxError('BAD_XML', `the XML is not well-formed (${why})`);

/** Reads the attributes of one tag, linearly; `src` is the text between the tag name and ">" (without a final "/"). */
function readAttrs(src) {
  const out = Object.create(null); // names come from the file: no prototype to pollute or shadow
  let i = 0;
  const n = src.length;
  while (i < n) {
    while (i < n && /\s/.test(src[i])) i++;
    if (i >= n) break;
    let j = i;
    while (j < n && NAME_CHAR.test(src[j])) j++;
    if (j === i) throw bad('bad attribute');
    const key = src.slice(i, j);
    i = j;
    while (i < n && /\s/.test(src[i])) i++;
    if (src[i] !== '=') throw bad('attribute without a value');
    i++;
    while (i < n && /\s/.test(src[i])) i++;
    const q = src[i];
    if (q !== '"' && q !== "'") throw bad('attribute value not quoted');
    const end = src.indexOf(q, i + 1);
    if (end < 0) throw bad('attribute value not closed');
    if (!(key in out)) out[key] = decodeEntities(src.slice(i + 1, end));
    i = end + 1;
  }
  return out;
}

/** Local name of an element: "x:row" and "row" are the same thing (producers choose their own prefixes). */
const local = (name) => name.slice(name.indexOf(':') + 1);

/**
 * A linear scanner (no backtracking, so no input makes it slow) for the well-formed parts of a workbook. Yields
 * { type: 'open'|'close'|'text', name, attrs, selfClosing, text }. Element names have no namespace prefix;
 * attribute names keep theirs (use `attr(attrs, 'id')` for "r:id" in whatever prefix the file chose). Anything that
 * is not well-formed, or whose tags do not nest properly, fails with BAD_XML instead of being guessed at.
 */
export function* tokens(xml) {
  const stack = [];
  yield* scan(xml, stack);
  if (stack.length) throw bad('tags not closed');
}

/**
 * The scanner behind `tokens`, with the stack of open elements kept by the caller, so a document can be fed in pieces
 * (each piece must hold whole tags). It does not check at the end that everything was closed.
 */
export function* scan(xml, stack) {
  const n = xml.length;
  let i = 0;
  while (i < n) {
    if (xml.charCodeAt(i) !== 60) { // text up to the next "<"
      let j = xml.indexOf('<', i);
      if (j < 0) j = n;
      const text = xml.slice(i, j);
      if (stack.length && text) yield { type: 'text', text: decodeEntities(text) };
      i = j;
      continue;
    }
    if (xml.startsWith('<!--', i)) { const e = xml.indexOf('-->', i + 4); if (e < 0) throw bad('comment not closed'); i = e + 3; continue; }
    if (xml.startsWith('<![CDATA[', i)) { const e = xml.indexOf(']]>', i + 9); if (e < 0) throw bad('CDATA not closed'); if (stack.length) yield { type: 'text', text: xml.slice(i + 9, e) }; i = e + 3; continue; }
    if (xml[i + 1] === '?') { const e = xml.indexOf('?>', i + 2); if (e < 0) throw bad('instruction not closed'); i = e + 2; continue; }
    if (xml[i + 1] === '!') throw bad('declaration');
    const closing = xml[i + 1] === '/';
    let j = i + (closing ? 2 : 1);
    const nameStart = j;
    while (j < n && NAME_CHAR.test(xml[j])) j++;
    if (j === nameStart || !/[A-Za-z_]/.test(xml[nameStart])) throw bad('bad element name');
    const name = local(xml.slice(nameStart, j));
    if (closing) {
      while (j < n && /\s/.test(xml[j])) j++;
      if (xml[j] !== '>') throw bad('bad closing tag');
      if (stack.pop() !== name) throw bad('tags do not nest');
      yield { type: 'close', name };
      i = j + 1;
      continue;
    }
    // find the end of the tag, skipping quoted values
    let k = j;
    let quote = '';
    for (; k < n; k++) {
      const ch = xml[k];
      if (quote) { if (ch === quote) quote = ''; } else if (ch === '"' || ch === "'") quote = ch; else if (ch === '>') break; else if (ch === '<') throw bad('"<" inside a tag');
    }
    if (k >= n) throw bad('tag not closed');
    const selfClosing = xml[k - 1] === '/';
    const attrs = readAttrs(xml.slice(j, selfClosing ? k - 1 : k));
    yield { type: 'open', name, attrs, selfClosing };
    if (selfClosing) yield { type: 'close', name }; else stack.push(name);
    i = k + 1;
  }
}

const MAX_PIECE = 16 * 1024 * 1024; // a run of XML with no end of a row in it, longer than this, is not a sheet we read
/**
 * Feeds a big XML part (an async iterable of Buffers, e.g. a decompressing stream) to the scanner in pieces that end
 * after a `</row>`, so memory holds one run of rows at a time. Yields the same tokens `tokens` would. A document type,
 * an entity declaration or CDATA is refused (CDATA could hide a `</row>` from the cutting).
 */
export async function* streamTokens(source, name = 'sheet') {
  const decoder = new StringDecoder('utf8');
  const stack = [];
  let pending = '';
  let first = true;
  const piece = function* (text) {
    assertSafeXml(text, name);
    if (text.includes('<![CDATA[')) throw new XlsxError('UNSAFE_XML', `"${name}" holds CDATA, which a streamed sheet does not accept`);
    yield* scan(text, stack);
  };
  for await (const chunk of source) {
    let text = pending + decoder.write(chunk);
    if (first) { text = text.replace(/^\uFEFF/, ''); first = false; }
    const cut = text.lastIndexOf('</row>');
    if (cut < 0) {
      if (text.length > MAX_PIECE) throw new XlsxError('BAD_XML', `"${name}" has too much text without the end of a row`);
      pending = text;
      continue;
    }
    const upto = cut + 6;
    pending = text.slice(upto);
    yield* piece(text.slice(0, upto));
  }
  const rest = pending + decoder.end();
  if (rest) yield* piece(rest);
  if (stack.length) throw bad('tags not closed');
}

/** An attribute by its local name: attr(attrs, 'id') finds "r:id", "rel:id" or "id". */
export function attr(attrs, name) {
  if (name in attrs) return attrs[name];
  for (const k of Object.keys(attrs)) if (k.endsWith(`:${name}`)) return attrs[k];
  return undefined;
}
