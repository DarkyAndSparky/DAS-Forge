/**
 * §4.5h item 4 / §4.5j: the client-supplied filename extension and
 * Content-Type header are never trusted - the server determines the
 * real file type from its actual byte content. This is necessary but,
 * per the architecture doc's follow-up note (§4.5h item 4a), NOT
 * sufficient on its own - see zip-guard.js for the office-format
 * zip-bomb layer and image-pipeline.js for the mandatory re-encode
 * step that incidentally defeats image polyglots.
 */

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);

const SIGNATURES = [
  { type: 'png', mime: 'image/png', check: (b) => matches(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { type: 'jpg', mime: 'image/jpeg', check: (b) => matches(b, [0xff, 0xd8, 0xff]) },
  { type: 'gif', mime: 'image/gif', check: (b) => matches(b, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || matches(b, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]) },
  { type: 'bmp', mime: 'image/bmp', check: (b) => matches(b, [0x42, 0x4d]) },
  {
    type: 'webp',
    mime: 'image/webp',
    check: (b) => matches(b, [0x52, 0x49, 0x46, 0x46]) && b.slice(8, 12).toString('ascii') === 'WEBP',
  },
  {
    // HEIC/HEIF (iPhone photos): ISO-BMFF 'ftyp' box with an HEVC-image brand.
    // Decoded by libheif-js (sharp's prebuilt binaries ship no HEVC decoder).
    type: 'heic',
    mime: 'image/heic',
    check: (b) => b.length >= 12 && b.slice(4, 8).toString('ascii') === 'ftyp' && HEIC_BRANDS.has(b.slice(8, 12).toString('ascii')),
  },
  { type: 'pdf', mime: 'application/pdf', check: (b) => matches(b, [0x25, 0x50, 0x44, 0x46, 0x2d]) },
  {
    // Local file header OR an empty-archive end-of-central-directory.
    // OOXML (docx/xlsx/pptx) and plain .zip both land here - see
    // detectOfficeType() in zip-inspect.js to tell them apart.
    type: 'zip',
    mime: 'application/zip',
    check: (b) => matches(b, [0x50, 0x4b, 0x03, 0x04]) || matches(b, [0x50, 0x4b, 0x05, 0x06]),
  },
];

function matches(buffer, signature) {
  if (buffer.length < signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (buffer[i] !== signature[i]) return false;
  }
  return true;
}

/**
 * SVG has no binary magic number (it's XML text) - this is a best-effort
 * text sniff, not a cryptographic guarantee. Combined with the mandatory
 * SVG sanitization step apps must apply (strip <script>/on* handlers,
 * e.g. via DOMPurify) before ever serving an uploaded SVG directly.
 */
function looksLikeSvg(buffer) {
  let head = buffer.slice(0, 4096).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  // Real-world SVG files often start with an XML declaration, comments and/or a
  // DOCTYPE (Inkscape, Illustrator) - skip those before looking for <svg (audit B11).
  for (let guard = 0; guard < 20; guard++) {
    const next = head
      .replace(/^<\?xml[\s\S]*?\?>\s*/i, '')
      .replace(/^<!--[\s\S]*?-->\s*/, '')
      .replace(/^<!doctype[^>[]*(\[[\s\S]*?\])?\s*>\s*/i, '');
    if (next === head) break;
    head = next;
  }
  return /^<svg[\s>]/i.test(head);
}

/**
 * Detects the real file type from content bytes.
 * @param {Buffer} buffer
 * @returns {{type: string, mime: string}|null} null if no known type matched
 */
export function detectFileType(buffer) {
  for (const sig of SIGNATURES) {
    if (sig.check(buffer)) return { type: sig.type, mime: sig.mime };
  }
  if (looksLikeSvg(buffer)) return { type: 'svg', mime: 'image/svg+xml' };
  return null;
}

/**
 * Asserts the detected type is in the allowed list, throwing a plain
 * Error (callers in core/http typically wrap this into a 400/415
 * response) rather than silently trusting what the client claimed.
 *
 * @param {Buffer} buffer
 * @param {string[]} allowedTypes - e.g. ['png','jpg','pdf']
 */
export function assertAllowedFileType(buffer, allowedTypes) {
  const detected = detectFileType(buffer);
  if (!detected || !allowedTypes.includes(detected.type)) {
    throw new Error(
      `Unsupported or undetectable file type (detected: ${detected?.type ?? 'unknown'}, allowed: ${allowedTypes.join(', ')})`
    );
  }
  return detected;
}
