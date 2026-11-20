import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { MEDIA_TYPES } from './signatures.js';
import { STORED_MEDIA_NAME } from './ingest.js';
import { parseRange } from './range.js';

function disposition(name) {
  const cleaned = String(name).replace(/[\u0000-\u001f\u007f"\\/:*?<>|]/g, '').replace(/^\.+/, '').trim().slice(0, 150) || 'media';
  const ascii = cleaned.replace(/[^\x20-\x7e]/g, '_');
  const enc = encodeURIComponent(cleaned).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename="${ascii}"; filename*=UTF-8''${enc}`;
}

/**
 * Sends a stored media file the way a player needs it: byte ranges (so it can seek), a validator (so it can cache) and a `Content-Type`
 * taken from the stored extension, never from anything the uploader sent. The caller has already decided that this user may see this
 * file; this only does the delivery.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} dir - where `ingestMedia` stored it
 * @param {string} name - the stored name (`<uuid>.<ext>`); anything else is a 404
 * @param {{ downloadName?: string }} [o]
 * @returns {Promise<number>} the status sent: 200, 206, 304, 404, 416 or 405
 */
export async function serveMedia(req, res, dir, name, { downloadName } = {}) {
  const send = (code, headers = {}, body) => {
    res.statusCode = code;
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.end(body);
    return code;
  };
  const method = String(req.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return send(405, { Allow: 'GET, HEAD' });
  const ext = typeof name === 'string' ? name.slice(name.lastIndexOf('.') + 1) : '';
  const info = MEDIA_TYPES[ext];
  if (!info || !STORED_MEDIA_NAME.test(name)) return send(404);
  const file = path.join(dir, name);
  let st;
  try { st = await stat(file); } catch { return send(404); }
  if (!st.isFile()) return send(404);

  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const base = {
    'Content-Type': info.mime,
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Last-Modified': st.mtime.toUTCString(),
    'Cache-Control': 'private, no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Disposition': disposition(downloadName ?? name),
  };

  const inm = req.headers?.['if-none-match'];
  if (inm && inm.split(',').map((s) => s.trim()).some((t) => t === etag || t === '*')) return send(304, { ETag: etag, 'Cache-Control': base['Cache-Control'] });

  // A range is honoured only when the file is still the one the client started with.
  const ifRange = req.headers?.['if-range'];
  const range = ifRange && ifRange.trim() !== etag ? null : parseRange(req.headers?.range, st.size);
  if (range === 'unsatisfiable') return send(416, { 'Content-Range': `bytes */${st.size}` });

  const start = range ? range.start : 0;
  const end = range ? range.end : st.size - 1;
  const length = st.size === 0 ? 0 : end - start + 1;
  const headers = { ...base, 'Content-Length': String(length) };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  res.statusCode = range ? 206 : 200;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (method === 'HEAD' || length === 0) { res.end(); return res.statusCode; }
  try {
    await pipeline(createReadStream(file, { start, end }), res);
  } catch (e) {
    // The player closed the connection (seeking does this all the time): not an error. Anything else after the headers went out can only end the response.
    if (!res.writableEnded) res.destroy(e.code === 'ERR_STREAM_PREMATURE_CLOSE' ? undefined : e);
  }
  return range ? 206 : 200;
}
