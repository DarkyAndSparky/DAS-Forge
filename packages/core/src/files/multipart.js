import { createRequire } from 'node:module';

/** multer is loaded when an upload is first taken, never at import time (audit D03). */
export function loadMulter() {
  try {
    return createRequire(import.meta.url)('multer');
  } catch (err) {
    throw new Error(`multer is not installed (npm install multer): ${err?.message ?? err}`);
  }
}

const MULTIPART = /^multipart\/form-data\b/i;
const MALFORMED = /unexpected end of form|malformed|boundary|multipart|unexpected end of file/i;

const LIMIT_ERRORS = {
  LIMIT_FILE_SIZE: [413, 'FILE_TOO_LARGE'],
  LIMIT_UNEXPECTED_FILE: [400, 'UNEXPECTED_FIELD'],
  LIMIT_FILE_COUNT: [400, 'TOO_MANY_PARTS'],
  LIMIT_PART_COUNT: [400, 'TOO_MANY_PARTS'],
  LIMIT_FIELD_KEY: [400, 'TOO_MANY_PARTS'],
  LIMIT_FIELD_VALUE: [400, 'TOO_MANY_PARTS'],
  LIMIT_FIELD_COUNT: [400, 'TOO_MANY_PARTS'],
};

/**
 * Express middleware that takes ONE file from a multipart/form-data request with multer,
 * in memory and under a hard size limit, and leaves it as `req.upload`:
 * `{ buffer, originalName, declaredType, size }`. What the client claims (name, mime type)
 * is informational only - hand `req.upload.buffer` to `files.acceptUpload`, which decides
 * the real type from the bytes.
 *
 * Refusals are JSON `{error, fields}`: 415 UNSUPPORTED_MEDIA_TYPE (not multipart),
 * 413 FILE_TOO_LARGE, 400 UNEXPECTED_FIELD / NO_FILE / TOO_MANY_PARTS / MALFORMED_MULTIPART.
 *
 * @param {object} opts
 * @param {number} opts.maxBytes - REQUIRED (a missing limit is a bug, not "unlimited")
 * @param {string} [opts.field='file'] - the one form field that may carry the file
 * @param {object} [opts.multer] - the multer module (tests inject a stand-in)
 */
export function createMultipartUpload({ maxBytes, field = 'file', multer } = {}) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new TypeError('createMultipartUpload: maxBytes must be a positive number');
  let handler = null;

  return (req, res, next) => {
    if (!MULTIPART.test(String(req.headers?.['content-type'] ?? ''))) {
      return res.status(415).json({ error: 'UNSUPPORTED_MEDIA_TYPE', fields: [] });
    }
    const m = multer ?? loadMulter();
    handler ??= m({
      storage: m.memoryStorage(),
      limits: { fileSize: maxBytes, files: 1, fields: 10, parts: 12, fieldSize: 64 * 1024 },
    }).single(field);

    handler(req, res, (err) => {
      if (err) {
        const mapped = err.name === 'MulterError' ? LIMIT_ERRORS[err.code] : null;
        if (mapped) return res.status(mapped[0]).json({ error: mapped[1], fields: err.field ? [err.field] : [field] });
        if (MALFORMED.test(String(err.message))) return res.status(400).json({ error: 'MALFORMED_MULTIPART', fields: [] });
        return next(err);
      }
      const file = req.file;
      if (!file?.buffer) return res.status(400).json({ error: 'NO_FILE', fields: [field] });
      req.upload = { buffer: file.buffer, originalName: file.originalname, declaredType: file.mimetype, size: file.size };
      next();
    });
  };
}
