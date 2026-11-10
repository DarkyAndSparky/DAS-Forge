import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let deps;
/** jsdom is heavy: load it (synchronously, sanitizeSvg is sync) on first use
 * instead of at import time (audit D03). */
function loadDeps() {
  deps ??= { JSDOM: require('jsdom').JSDOM, createDOMPurify: require('dompurify') };
  return deps;
}

/**
 * SVG is XML, so it can carry <script> tags, on* event-handler
 * attributes, javascript: URLs, and <foreignObject>-embedded HTML -
 * serving an uploaded SVG directly without sanitizing it first is an
 * XSS vector.
 *
 * Uses DOMPurify running against a real (jsdom) DOM, not a regex pass -
 * DOMPurify parses the markup properly and understands SVG's own
 * namespace/attribute quirks, which closes cases a regex-based filter
 * can miss (nested/double-encoded vectors, unusual attribute quoting,
 * namespaced attribute variants, etc.). This is deliberately the real
 * dependency, not a "good enough" hand-rolled filter - sanitizing
 * attacker-controlled markup is exactly the kind of security-critical
 * path where that trade-off isn't worth it.
 *
 * A fresh JSDOM window is created per call rather than shared module-
 * level state - avoids any cross-request state leakage between
 * sanitize calls serving different uploads concurrently.
 */
/** Anything that would make the browser fetch something from elsewhere. */
const EXTERNAL_CSS = /@import|url\(\s*(?!['"]?#)/i;

/** An SVG is parsed into a full DOM (jsdom): refuse big inputs before that (audit I08). Default 1 MiB. */
export const DEFAULT_SVG_MAX_BYTES = 1024 * 1024;

export function sanitizeSvg(svgString, { maxBytes = DEFAULT_SVG_MAX_BYTES } = {}) {
  const text = String(svgString).replace(/^\uFEFF/, '');
  if (maxBytes > 0 && Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw Object.assign(new Error(`SVG is larger than ${maxBytes} bytes`), { code: 'SVG_TOO_LARGE' });
  }
  // Entity declarations are only ever used for entity-expansion tricks in an upload.
  if (/<!ENTITY/i.test(text)) throw new Error('SVG with entity declarations is not accepted');

  const { JSDOM, createDOMPurify } = loadDeps();
  const window = new JSDOM('').window;
  const DOMPurify = createDOMPurify(window);

  // A sanitized SVG may still point at the outside world: <use href="https://evil/x.svg#a">,
  // <image href="http://tracker/pixel">, @import/url() in CSS. Only same-document
  // references (#id) survive (audit B11).
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    for (const attr of ['href', 'xlink:href']) {
      if (node.hasAttribute?.(attr) && !node.getAttribute(attr).trim().startsWith('#')) node.removeAttribute(attr);
    }
    if (node.hasAttribute?.('style') && EXTERNAL_CSS.test(node.getAttribute('style'))) node.removeAttribute('style');
    if (node.nodeName?.toLowerCase() === 'style' && EXTERNAL_CSS.test(node.textContent ?? '')) node.textContent = '';
  });

  const clean = DOMPurify.sanitize(text, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['script', 'foreignObject'],
    FORBID_ATTR: ['onload', 'onerror', 'onclick', 'onmouseover'],
  });

  window.close();
  return clean;
}
