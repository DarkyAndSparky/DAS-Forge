/**
 * core/qr (added 0.1.14): thin wrapper around the `qrcode` npm package
 * (soldair/node-qrcode, verified against its real README + npm
 * registry before pinning - current latest is 1.5.4, server-side
 * `QRCode.toString(text, { type: 'svg' })` needs no canvas/sharp/jsdom,
 * so it doesn't drag anything else in).
 *
 * Added on explicit request: this was deliberately left out of 0.1.13
 * (see examples/workshop's pages.js history) while no real consumer
 * needed it yet. Two now do - TOTP enrollment (scan-to-add, instead of
 * manual secret entry only) and IT Assets' inventory tagging (a
 * physical asset gets a QR sticker that resolves to its record) - so
 * it belongs in the core, not duplicated per-app.
 *
 * Deliberately NOT a raster (PNG) encoder here: SVG is resolution
 * independent (good for both a browser panel and a printed inventory
 * label), has no decoder-compatibility question the way a canvas
 * render would, and keeps this module free of any native/image
 * dependency. An app that specifically needs a PNG (e.g. embedding in
 * a generated PDF label sheet) can rasterize this SVG itself with
 * whatever renderer it already uses (core/files already depends on
 * sharp, which can do `sharp(Buffer.from(svg)).png()`).
 */
let qrPromise;
function loadQrCode() {
  qrPromise ??= import('qrcode').then((m) => m.default ?? m);
  return qrPromise;
}

/**
 * @param {string} text - the raw payload to encode (an otpauth:// URI,
 *   a URL, or any plain string up to the format's capacity).
 * @param {object} [options]
 * @param {'L'|'M'|'Q'|'H'} [options.errorCorrectionLevel='M']
 * @param {number} [options.margin=4] - quiet-zone size, in modules.
 * @param {string} [options.darkColor='#000000ff']
 * @param {string} [options.lightColor='#ffffffff']
 * @param {number} [options.size=256] - width and height of the picture in pixels (0 = leave the size to the
 *   page). The generated SVG only has a `viewBox`; put inline into a shrink-to-fit box it has no width and
 *   collapses to nothing, so the size is written into the root element.
 * @returns {Promise<string>} a standalone `<svg>...</svg>` string.
 */
export async function generateQrSvg(text, options = {}) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('generateQrSvg: text must be a non-empty string');
  }
  const { errorCorrectionLevel = 'M', margin = 4, darkColor = '#000000ff', lightColor = '#ffffffff', size = 256 } = options;
  const QRCode = await loadQrCode();
  const svg = await QRCode.toString(text, {
    type: 'svg',
    errorCorrectionLevel,
    margin,
    color: { dark: darkColor, light: lightColor },
  });
  return withSize(svg, size);
}

/** Adds width/height to the root <svg> when it has none (and a size is wanted). */
export function withSize(svg, size) {
  if (!Number.isFinite(size) || size <= 0) return svg;
  const px = Math.round(size);
  return svg.replace(/<svg\b([^>]*)>/, (m, attrs) => (/\swidth\s*=/.test(attrs) ? m : `<svg width="${px}" height="${px}"${attrs}>`));
}
