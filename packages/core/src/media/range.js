/**
 * The HTTP `Range` header for a file of `size` bytes (RFC 9110, section 14).
 *
 * Only one range is served: several ranges in one request (a known way to make a server do a lot of work for a small request)
 * are answered with the whole file, which the RFC allows. A header that is not understood is ignored in the same way.
 *
 * @param {string|undefined} header
 * @param {number} size
 * @returns {{ start: number, end: number }|'unsatisfiable'|null} `null`: no range, send everything
 */
export function parseRange(header, size) {
  if (typeof header !== 'string' || header === '' || header.length > 200) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // other units, several ranges, rubbish: serve the whole file
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  if (a.length > 15 || b.length > 15) return null;
  if (a === '') { // the last N bytes
    const n = Number(b);
    if (n === 0) return 'unsatisfiable';
    return size === 0 ? 'unsatisfiable' : { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  if (start >= size) return 'unsatisfiable';
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  if (end < start) return null; // an invalid range is ignored
  return { start, end };
}
