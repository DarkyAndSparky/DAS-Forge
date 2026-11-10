import path from 'node:path';
import { createReadStream, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';

import { SAFE_STORED_NAME } from './upload-storage.js';

/**
 * Serving stored uploads safely (audit B11).
 *
 * The stored name carries the DETECTED type as its extension (storeUpload
 * never uses the client's name or claim), so the response type is derived
 * from that - never from anything the uploader sent.
 *
 * Every response gets:
 *   X-Content-Type-Options: nosniff        the browser must not "guess" HTML out of it
 *   Content-Security-Policy: sandbox ...   opened directly, an SVG cannot run script
 *   Cross-Origin-Resource-Policy           other sites cannot embed it
 *   Content-Disposition                    attachment unless it is a plain image
 * Types that are not on the list below are served as an opaque download.
 */
const TYPES = {
  png: { mime: 'image/png', image: true },
  jpg: { mime: 'image/jpeg', image: true },
  webp: { mime: 'image/webp', image: true },
  gif: { mime: 'image/gif', image: true },
  svg: { mime: 'image/svg+xml', image: true },
  pdf: { mime: 'application/pdf', image: false },
};

/** A download name that is safe inside a Content-Disposition header. */
export function safeDownloadName(name, fallback = 'download') {
  const cleaned = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f"\\/:*?<>|]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 150);
  return cleaned || fallback;
}

function contentDisposition(kind, name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Headers for serving the stored file `filename`; null when the name is not
 * one storeUpload could have generated.
 *
 * @param {string} filename - stored name (`<uuid>.<ext>`)
 * @param {object} [opts]
 * @param {string} [opts.downloadName] - name shown to the user (display only, sanitised)
 * @param {boolean} [opts.inline=true] - show images in the page; everything else is a download regardless
 * @returns {Record<string,string>|null}
 */
export function uploadResponseHeaders(filename, { downloadName, inline = true } = {}) {
  if (typeof filename !== 'string' || !SAFE_STORED_NAME.test(filename)) return null;
  const ext = filename.slice(filename.lastIndexOf('.') + 1);
  const known = TYPES[ext];
  const kind = known?.image && inline ? 'inline' : 'attachment';
  const name = safeDownloadName(downloadName, `file.${ext}`);
  return {
    'Content-Type': known?.mime ?? 'application/octet-stream',
    'Content-Disposition': contentDisposition(kind, name),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'private, no-cache',
  };
}

/**
 * Streams a stored upload to `res` with the headers above.
 * @returns {Promise<boolean>} false (nothing written) when the name is invalid or the file is missing - answer 404
 */
export async function sendUpload(res, storageDir, filename, options) {
  const headers = uploadResponseHeaders(filename, options);
  if (!headers) return false;
  const fullPath = path.join(path.resolve(storageDir), filename);
  let size;
  try {
    size = statSync(fullPath).size;
  } catch {
    return false;
  }
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.setHeader('Content-Length', String(size));
  await pipeline(createReadStream(fullPath), res);
  return true;
}
