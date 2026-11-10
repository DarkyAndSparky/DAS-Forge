import { detectFileType } from './magic-bytes.js';
import { checkZipSafety, assertSafeOfficeFile } from './zip-guard.js';
import { detectOfficeType } from './zip-inspect.js';
import { sanitizeSvg } from './svg-sanitize.js';

/**
 * One entry point tying together the §4.5h/4.5h-4a upload-safety
 * layers: size limit → magic-bytes detection → (if zip-based) office
 * structure + zip-bomb check → (if SVG) sanitization. Does NOT handle
 * image re-encoding (image-pipeline.js, separate because it needs the
 * sharp dependency) or storage (upload-storage.js) - this function's
 * job is "is this upload safe to accept at all", not "what do we do
 * with it next".
 *
 * @param {Buffer} buffer
 * @param {object} opts
 * @param {string[]} opts.allowedTypes - e.g. ['png','jpg','pdf','docx']
 * @param {number} [opts.maxBytes]
 * @param {object} [opts.zipGuardOptions] - passed to checkZipSafety()
 * @param {number} [opts.svgMaxBytes=1048576] - larger SVGs are refused before any parsing (audit I08)
 * @returns {Promise<{type: string, mime: string, buffer: Buffer}>} (async since 0.1.74) buffer is the
 *   (possibly SVG-sanitized) content to actually store; type/mime are
 *   the server-detected values, never the client's claims
 */
export async function validateUpload(buffer, { allowedTypes, maxBytes, zipGuardOptions, svgMaxBytes } = {}) {
  if (maxBytes && buffer.length > maxBytes) {
    throw new Error(`File exceeds maximum allowed size (${buffer.length} > ${maxBytes} bytes)`);
  }

  const detected = detectFileType(buffer);
  if (!detected) {
    throw new Error('Could not determine file type from content - upload rejected');
  }

  let resolvedType = detected.type;
  let resolvedMime = detected.mime;
  let outputBuffer = buffer;

  if (detected.type === 'zip') {
    const guard = await checkZipSafety(buffer, zipGuardOptions);
    if (!guard.ok) {
      throw new Error(`Unsafe archive: ${guard.reason}`);
    }
    const officeType = detectOfficeType(guard.entries);
    resolvedType = officeType;
    resolvedMime =
      officeType === 'docx'
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : officeType === 'xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : officeType === 'pptx'
            ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
            : 'application/zip';
  }

  if (detected.type === 'svg') {
    const clean = sanitizeSvg(buffer.toString('utf8'), { maxBytes: svgMaxBytes });
    // A sanitizer that strips everything must not turn into "accepted":
    // an empty/non-<svg> result means the input was not a usable SVG.
    if (!/<svg[\s>]/i.test(clean)) throw new Error('SVG is empty or unusable after sanitization - upload rejected');
    outputBuffer = Buffer.from(clean, 'utf8');
  }

  if (!allowedTypes.includes(resolvedType)) {
    throw new Error(`File type "${resolvedType}" is not allowed (allowed: ${allowedTypes.join(', ')})`);
  }

  return { type: resolvedType, mime: resolvedMime, buffer: outputBuffer };
}

export { assertSafeOfficeFile };
