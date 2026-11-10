import { validateUpload } from './validate-upload.js';
import { storeUpload } from './upload-storage.js';
import { verifyZipData } from './zip-verify.js';
import { assertUploadQuota, noteUploadStored } from './upload-quota.js';

const REENCODABLE = new Set(['png', 'jpg', 'webp', 'heic']);
const ZIP_FAMILY = new Set(['zip', 'docx', 'xlsx', 'pptx', 'odt']);

/**
 * The single entry point for taking an upload (audit B10): size limit →
 * magic-bytes detection → zip/office/SVG checks (validateUpload) →
 * mandatory image re-encode → atomic storage under a server-generated name.
 *
 * Re-encoding is what drops polyglot payloads appended after the image
 * data and strips EXIF/GPS; it runs for png/jpg/webp/heic (HEIC is decoded by libheif-js and stored as JPEG unless `outputFormat` says otherwise). `sharp` is loaded
 * lazily (so non-image apps never need the native binary) unless a
 * `reencode` function is injected (tests, or an app with its own pipeline).
 * GIF and BMP have no re-encode path: they are rejected unless explicitly
 * listed in `passthroughTypes`, so unprocessed image bytes are never
 * stored by accident.
 *
 * Order matters for cleanup: the file is written LAST, after every check
 * has passed. The caller is expected to write the DB row next and call
 * `removeUpload(storageDir, filename)` if that fails (no orphan file).
 *
 * @param {Buffer} buffer
 * @param {object} opts
 * @param {string[]} opts.allowedTypes
 * @param {number} opts.maxBytes - REQUIRED (a missing limit is a bug, not "unlimited")
 * @param {string} opts.storageDir
 * @param {object} [opts.zipGuardOptions] - maxEntries / maxUncompressedTotal / maxRatio
 * @param {boolean} [opts.verifyArchiveData=true] - for zip-based types, really inflate every entry (real size budget, CRC, zip-slip names) before accepting; set false only for a trusted source
 * @param {{maxTotalBytes?: number, maxFiles?: number}} [opts.quota] - refuse (Error.code 'QUOTA_EXCEEDED') when the directory would exceed it; 0 = unlimited
 * @param {object} [opts.imageOptions] - maxWidth/maxHeight/quality/outputFormat/maxInputPixels
 * @param {string[]} [opts.passthroughTypes] - image types allowed to be stored without re-encoding
 * @param {(buffer: Buffer, options?: object) => Promise<{buffer: Buffer, format: string}>} [opts.reencode]
 * @returns {Promise<{filename: string, fullPath: string, type: string, mime: string, size: number}>}
 */
export async function acceptUpload(buffer, { allowedTypes, maxBytes, svgMaxBytes, storageDir, zipGuardOptions, imageOptions, passthroughTypes = [], reencode, verifyArchiveData = true, quota } = {}) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('acceptUpload: buffer must be a Buffer');
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new TypeError('acceptUpload: maxBytes (positive integer) is required');
  if (!Array.isArray(allowedTypes) || allowedTypes.length === 0) throw new TypeError('acceptUpload: allowedTypes is required');
  if (!storageDir) throw new TypeError('acceptUpload: storageDir is required');

  const validated = await validateUpload(buffer, { allowedTypes, maxBytes, zipGuardOptions, svgMaxBytes });
  let { type, mime, buffer: out } = validated;

  if (verifyArchiveData && ZIP_FAMILY.has(type)) {
    const check = await verifyZipData(buffer, zipGuardOptions);
    if (!check.ok) throw new Error(`Unsafe archive: ${check.reason}`);
  }

  const isRaster = ['png', 'jpg', 'webp', 'heic', 'gif', 'bmp'].includes(type);
  if (isRaster) {
    if (REENCODABLE.has(type)) {
      const fn = reencode ?? (await import('./image-pipeline.js')).reencodeImage;
      let result;
      try {
        result = await fn(out, imageOptions);
      } catch (err) {
        if (err?.code === 'IMAGE_BUSY') throw err; // overload is not a bad upload: let the caller answer 503
        throw new Error(`Image could not be decoded safely - upload rejected (${err.message})`);
      }
      out = result.buffer;
      // The re-encoded bytes may be a different format (outputFormat option):
      // store under the type that is actually in the buffer.
      const fmt = result.format === 'jpeg' ? 'jpg' : result.format;
      if (fmt && fmt !== type) {
        type = fmt;
        mime = fmt === 'jpg' ? 'image/jpeg' : `image/${fmt}`;
      }
    } else if (!passthroughTypes.includes(type)) {
      throw new Error(`Image type "${type}" cannot be re-encoded safely and is not in passthroughTypes - upload rejected`);
    }
  }

  // Right before the synchronous write, so two uploads cannot both pass the check.
  assertUploadQuota(storageDir, quota, out.length);
  const stored = storeUpload(out, storageDir, type);
  noteUploadStored(storageDir, out.length);
  return { filename: stored.filename, fullPath: stored.fullPath, type, mime, size: out.length };
}
