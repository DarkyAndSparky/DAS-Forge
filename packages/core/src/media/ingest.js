import { createWriteStream } from 'node:fs';
import { mkdir, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { detectMedia, DEFAULT_MEDIA_TYPES } from './signatures.js';

export const DEFAULT_MAX_MEDIA_BYTES = 500 * 1024 * 1024;
const SNIFF_BYTES = 4096;

export class MediaRejectedError extends Error {
  /** @param {'MEDIA_TYPE_NOT_ALLOWED'|'MEDIA_TOO_LARGE'|'MEDIA_EMPTY'} code */
  constructor(code) { super(code); this.name = 'MediaRejectedError'; this.code = code; }
}

/** The name a stored media file gets: random, with the detected type as its extension. */
export const STORED_MEDIA_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{2,5}$/;

/**
 * Stores an uploaded stream on disk without holding it in memory (a video is gigabytes). The first bytes decide the type; the size is
 * counted while it arrives and the upload is dropped the moment it is too big or does not start like an allowed type. Nothing the
 * client says (file name, Content-Type) is used. The file is written under a temporary name and renamed only when complete.
 *
 * @param {import('node:stream').Readable} source - the request body or a multipart file stream
 * @param {{ dir: string, maxBytes?: number, allowedTypes?: string[] }} o
 * @returns {Promise<{ name: string, type: string, mime: string, kind: 'audio'|'video', size: number, sha256: string }>}
 */
export async function ingestMedia(source, { dir, maxBytes = DEFAULT_MAX_MEDIA_BYTES, allowedTypes = DEFAULT_MEDIA_TYPES } = {}) {
  if (!dir || typeof dir !== 'string') throw new TypeError('ingestMedia: dir is required');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${randomUUID()}.part`);
  const hash = createHash('sha256');
  let size = 0;
  let found = null;
  let head = [];
  let headLen = 0;

  const decide = (self) => {
    const buf = Buffer.concat(head);
    head = [];
    if (buf.length === 0) throw new MediaRejectedError('MEDIA_EMPTY');
    const t = detectMedia(buf);
    if (!t || !allowedTypes.includes(t.type)) throw new MediaRejectedError('MEDIA_TYPE_NOT_ALLOWED');
    found = t;
    self.push(buf);
  };

  const guard = new Transform({
    transform(chunk, _enc, cb) {
      try {
        size += chunk.length;
        if (size > maxBytes) throw new MediaRejectedError('MEDIA_TOO_LARGE');
        hash.update(chunk);
        if (found) return cb(null, chunk);
        head.push(chunk);
        headLen += chunk.length;
        if (headLen >= SNIFF_BYTES) decide(this);
        cb();
      } catch (e) { cb(e); }
    },
    flush(cb) {
      try { if (!found) decide(this); cb(); } catch (e) { cb(e); }
    },
  });

  try {
    await pipeline(source, guard, createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
    const name = `${randomUUID()}.${found.type}`;
    await rename(tmp, path.join(dir, name));
    return { name, type: found.type, mime: found.mime, kind: found.kind, size, sha256: hash.digest('hex') };
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}
