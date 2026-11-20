import path from 'node:path';
import { ingestMedia, DEFAULT_MAX_MEDIA_BYTES, MediaRejectedError, STORED_MEDIA_NAME } from './ingest.js';
import { serveMedia } from './serve.js';
import { createFfprobe, MediaProbeError, summarizeProbe } from './probe.js';
import { detectMedia, assertAllowedMedia, MEDIA_TYPES, DEFAULT_MEDIA_TYPES } from './signatures.js';
import { parseRange } from './range.js';
import { unlink } from 'node:fs/promises';

export { ingestMedia, serveMedia, createFfprobe, MediaProbeError, MediaRejectedError, summarizeProbe, detectMedia, assertAllowedMedia, parseRange, MEDIA_TYPES, DEFAULT_MEDIA_TYPES, DEFAULT_MAX_MEDIA_BYTES, STORED_MEDIA_NAME };

export class MediaDisabledError extends Error {
  constructor() { super('MEDIA_DISABLED'); this.name = 'MediaDisabledError'; this.code = 'MEDIA_DISABLED'; }
}

/**
 * The media module (audio and video), off unless `config.media.enabled` is true. Switched off, every call fails with MEDIA_DISABLED,
 * so an application that does not use media has nothing to attack and nothing to configure.
 *
 * Stored files live in `dir`, which should be outside the shared uploads folder (they are big and need their own quota and backup rule).
 * Playing, seeking, subtitles and the right to see a file stay with the application.
 *
 * @param {{ media?: { enabled?: boolean, dir?: string, maxBytes?: number, allowedTypes?: string[], maxDurationSec?: number, ffprobePath?: string, probeTimeoutMs?: number } }} config
 */
export function createMedia(config = {}) {
  const c = config.media ?? config;
  const enabled = c.enabled === true;
  const dir = c.dir ? path.resolve(c.dir) : null;
  const allowedTypes = c.allowedTypes ?? [...DEFAULT_MEDIA_TYPES];
  const maxBytes = c.maxBytes ?? DEFAULT_MAX_MEDIA_BYTES;
  const ffprobe = createFfprobe({ path: c.ffprobePath ?? null, timeoutMs: c.probeTimeoutMs ?? 15_000 });
  const need = () => {
    if (!enabled) throw new MediaDisabledError();
    if (!dir) throw new TypeError('media: `dir` is required when the module is enabled');
    return dir;
  };
  return {
    enabled,
    dir,
    allowedTypes,
    maxBytes,
    ffprobe,
    /** Stores a stream; when ffprobe is configured the file is examined and refused if it is not really media or runs too long. */
    async ingest(source) {
      const d = need();
      const stored = await ingestMedia(source, { dir: d, maxBytes, allowedTypes });
      if (!ffprobe.configured) return { ...stored, info: null };
      try {
        const info = await ffprobe.probe(path.join(d, stored.name), { maxDurationSec: c.maxDurationSec });
        return { ...stored, info };
      } catch (e) {
        await unlink(path.join(d, stored.name)).catch(() => {});
        throw e;
      }
    },
    serve(req, res, name, options) { return serveMedia(req, res, need(), name, options); },
    async remove(name) {
      const d = need();
      if (!STORED_MEDIA_NAME.test(name)) return false;
      try { await unlink(path.join(d, name)); return true; } catch { return false; }
    },
  };
}
