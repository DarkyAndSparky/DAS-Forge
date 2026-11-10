export class ImageBusyError extends Error {
  constructor() {
    super('Too many images are being processed right now, try again shortly');
    this.name = 'ImageBusyError';
    this.code = 'IMAGE_BUSY';
    this.status = 503;
    this.expose = true;
  }
}

// Decoding is memory-hungry (up to maxInputPixels x 4 bytes of RGBA per HEIC, plus sharp's own buffers):
// only a few images at a time, a bounded queue behind them, 503 beyond it (audit I07).
const gate = { maxConcurrent: 2, maxQueue: 16, active: 0, waiting: [] };

export function configureImageConcurrency({ maxConcurrent, maxQueue } = {}) {
  if (Number.isInteger(maxConcurrent) && maxConcurrent >= 1) gate.maxConcurrent = maxConcurrent;
  if (Number.isInteger(maxQueue) && maxQueue >= 0) gate.maxQueue = maxQueue;
}

export function imageConcurrencyStats() {
  return { active: gate.active, waiting: gate.waiting.length, maxConcurrent: gate.maxConcurrent, maxQueue: gate.maxQueue };
}

/** Runs `fn` inside one image-processing slot (what reencodeImage uses; exported for apps with their own image work and for tests). */
export async function withImageSlot(fn) {
  return limited(fn);
}

async function limited(fn) {
  if (gate.active >= gate.maxConcurrent) {
    if (gate.waiting.length >= gate.maxQueue) throw new ImageBusyError();
    await new Promise((resolve) => gate.waiting.push(resolve));
  } else {
    gate.active++;
  }
  try {
    return await fn();
  } finally {
    const next = gate.waiting.shift();
    if (next) next(); // the slot passes straight to the next waiter
    else gate.active--;
  }
}

let sharpPromise;
/** sharp is native; load it on first use (audit D03). */
function loadSharp() {
  sharpPromise ??= import('sharp').then((m) => m.default ?? m);
  return sharpPromise;
}

/**
 * §4.5h item 4a: every uploaded image passes through a decode→re-encode
 * cycle AT LEAST ONCE, even when the input/output format is unchanged.
 * This isn't primarily about format conversion - it's a security step:
 * sharp parses the image as pixel data and re-serializes it, so any
 * non-image payload smuggled after valid image data (a classic
 * image/zip or image/html polyglot) is dropped as a side effect of
 * re-encoding, without core/files needing its own polyglot detector.
 *
 * This is the ONE module in core/files with a real native dependency
 * (sharp ships prebuilt binaries per platform) - can't be avoided for
 * image processing at this level without reimplementing codecs.
 */

let heifPromise;
/** libheif-js (WASM, no native binary) is loaded on first HEIC upload only. */
function loadHeif() {
  heifPromise ??= import('libheif-js/wasm-bundle').then((m) => m.default ?? m);
  return heifPromise;
}

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);
function isHeic(buffer) {
  return buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp' && HEIC_BRANDS.has(buffer.toString('ascii', 8, 12));
}

/**
 * Decodes the primary image of a HEIC/HEIF file to raw RGBA with libheif-js.
 * The pixel budget is checked BEFORE the RGBA buffer is allocated, so a
 * tiny file that declares a huge canvas cannot exhaust memory.
 * @param {Buffer} buffer
 * @param {{maxInputPixels: number, heif?: object}} opts - `heif` injects the libheif module (tests)
 * @returns {Promise<{data: Buffer, width: number, height: number}>}
 */
export async function decodeHeic(buffer, { maxInputPixels = 50_000_000, heif } = {}) {
  const libheif = heif ?? (await loadHeif());
  const images = new libheif.HeifDecoder().decode(buffer);
  if (!images || images.length === 0) throw new Error('HEIC file contains no image');
  const image = images[0];
  const width = image.get_width();
  const height = image.get_height();
  if (!(width > 0 && height > 0)) throw new Error('HEIC image has no dimensions');
  if (width * height > maxInputPixels) throw new Error(`HEIC image too large (${width}x${height}, limit ${maxInputPixels} pixels)`);
  const rgba = new Uint8ClampedArray(width * height * 4);
  await new Promise((resolve, reject) => {
    image.display({ data: rgba, width, height }, (out) => (out ? resolve(out) : reject(new Error('HEIC decode failed'))));
  });
  return { data: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height };
}

const FORMAT_EXTENSIONS = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', webp: 'webp' };

/**
 * @param {Buffer} buffer - raw uploaded image bytes (already passed
 *   magic-bytes detection - this function trusts that much)
 * @param {object} [opts]
 * @param {'png'|'jpeg'|'webp'} [opts.outputFormat] - defaults to the
 *   input's own format (still re-encoded, just not converted)
 * @param {number} [opts.maxWidth] - downscale if wider (preserves aspect)
 * @param {number} [opts.maxHeight]
 * @param {number} [opts.quality] - for jpeg/webp (1-100)
 * @param {number} [opts.maxInputPixels=50_000_000] - decompression-bomb guard (audit B10): sharp refuses larger images
 * @param {object} [opts.heif] - libheif module override (tests); normally lazy-loaded `libheif-js/wasm-bundle`
 * @returns {Promise<{buffer: Buffer, format: string, width: number, height: number}>}
 */
export function reencodeImage(buffer, options = {}) {
  return limited(() => reencodeImageUnlimited(buffer, options));
}

async function reencodeImageUnlimited(buffer, { outputFormat, maxWidth, maxHeight, quality, maxInputPixels = 50_000_000, heif } = {}) {
  // .rotate() with no argument applies the EXIF orientation and, since
  // sharp drops metadata by default, the re-encode also strips EXIF/GPS.
  const sharp = await loadSharp();
  let pipeline;
  let metadata;
  let sourceIsHeic = false;
  if (isHeic(buffer)) {
    // libheif already applies the irot/imir transforms, and the raw pixels carry no metadata.
    sourceIsHeic = true;
    const raw = await decodeHeic(buffer, { maxInputPixels, heif });
    pipeline = sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 4 }, limitInputPixels: maxInputPixels });
    metadata = { format: 'heic' };
  } else {
    pipeline = sharp(buffer, { failOn: 'error', limitInputPixels: maxInputPixels }).rotate();
    metadata = await pipeline.metadata();
  }

  // HEIC has no web-wide support: it is converted (JPEG by default), never re-stored as HEIC.
  const targetFormat = outputFormat ?? (sourceIsHeic ? 'jpeg' : FORMAT_EXTENSIONS[metadata.format] ?? 'png');

  if (maxWidth || maxHeight) {
    pipeline = pipeline.resize({
      width: maxWidth,
      height: maxHeight,
      fit: 'inside',
      withoutEnlargement: true,
    });
  }

  pipeline = pipeline.toFormat(targetFormat, quality ? { quality } : undefined);

  const outputBuffer = await pipeline.toBuffer();
  const outputMetadata = await sharp(outputBuffer, { limitInputPixels: maxInputPixels }).metadata();

  return {
    buffer: outputBuffer,
    format: targetFormat,
    width: outputMetadata.width,
    height: outputMetadata.height,
  };
}
