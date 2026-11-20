/**
 * Audio and video types recognised by what the file really contains, never by its name or the client's Content-Type.
 * The check reads the first bytes only; it says "this starts like an MP4", not "this is a safe MP4" (a probe with ffprobe and the
 * size and duration limits do the rest).
 */
const IMAGE_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'avif', 'avis']);
const AUDIO_BRANDS = new Set(['M4A ', 'M4B ', 'M4P ']);

/** `type` is the stored extension; `kind` is 'audio' or 'video'. */
export const MEDIA_TYPES = Object.freeze({
  mp4: { mime: 'video/mp4', kind: 'video' },
  m4a: { mime: 'audio/mp4', kind: 'audio' },
  mov: { mime: 'video/quicktime', kind: 'video' },
  webm: { mime: 'video/webm', kind: 'video' },
  mkv: { mime: 'video/x-matroska', kind: 'video' },
  ogv: { mime: 'video/ogg', kind: 'video' },
  ogg: { mime: 'audio/ogg', kind: 'audio' },
  mp3: { mime: 'audio/mpeg', kind: 'audio' },
  aac: { mime: 'audio/aac', kind: 'audio' },
  wav: { mime: 'audio/wav', kind: 'audio' },
  flac: { mime: 'audio/flac', kind: 'audio' },
  avi: { mime: 'video/x-msvideo', kind: 'video' },
});

/** What is accepted unless the app narrows it: the formats every browser plays. The rarer containers (mkv, mov, avi, ogv) are opt-in. */
export const DEFAULT_MEDIA_TYPES = Object.freeze(['mp4', 'webm', 'm4a', 'mp3', 'ogg', 'wav', 'flac', 'aac']);

const ascii = (b, from, to) => b.toString('latin1', from, to);

/**
 * @param {Buffer} buf - at least the first 64 bytes (more is fine)
 * @returns {{ type: string, mime: string, kind: 'audio'|'video' }|null}
 */
export function detectMedia(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  const hit = (type) => ({ type, ...MEDIA_TYPES[type] });

  // ISO base media (mp4, m4a, mov): a size, then "ftyp", then the brand.
  if (ascii(buf, 4, 8) === 'ftyp') {
    const brand = ascii(buf, 8, 12);
    if (IMAGE_BRANDS.has(brand)) return null; // a picture, handled by the image pipeline
    if (brand === 'qt  ') return hit('mov');
    return hit(AUDIO_BRANDS.has(brand) ? 'm4a' : 'mp4');
  }
  // EBML (webm, mkv): the DocType string sits in the header.
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    const head = ascii(buf, 0, Math.min(buf.length, 64));
    if (head.includes('webm')) return hit('webm');
    if (head.includes('matroska')) return hit('mkv');
    return null;
  }
  if (ascii(buf, 0, 4) === 'OggS') return ascii(buf, 0, Math.min(buf.length, 128)).includes('theora') ? hit('ogv') : hit('ogg');
  if (ascii(buf, 0, 4) === 'fLaC') return hit('flac');
  if (ascii(buf, 0, 4) === 'RIFF') {
    const form = ascii(buf, 8, 12);
    if (form === 'WAVE') return hit('wav');
    if (form === 'AVI ') return hit('avi');
    return null;
  }
  if (ascii(buf, 0, 3) === 'ID3') return hit('mp3');
  // A bare frame: 11 bits of sync, then the version and layer. Layer "00" is ADTS (AAC), a valid layer is MP3.
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) {
    const version = (buf[1] >> 3) & 3;
    const layer = (buf[1] >> 1) & 3;
    if (version === 1) return null; // reserved
    if (layer === 0) return hit('aac');
    return hit('mp3');
  }
  return null;
}

/** Throws unless `type` is in `allowed`. */
export function assertAllowedMedia(found, allowed = DEFAULT_MEDIA_TYPES) {
  if (!found || !allowed.includes(found.type)) {
    const e = new Error('MEDIA_TYPE_NOT_ALLOWED');
    e.code = 'MEDIA_TYPE_NOT_ALLOWED';
    throw e;
  }
  return found;
}
