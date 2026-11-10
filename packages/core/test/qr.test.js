import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import jsQR from 'jsqr';
import { generateQrSvg, withSize } from '../src/qr/index.js';

/**
 * Can't be live-run in the sandbox this module was written in (no
 * registry access to actually install the real `qrcode` package - see
 * CHANGELOG 0.1.14's honesty note); syntax-checked and written to run
 * for real under the user's own `npm test` once `npm install` has
 * fetched the real dependency.
 */
describe('qr', () => {
  it('writes a pixel size into the root element so a shrink-to-fit box does not collapse it', async () => {
    const svg = await generateQrSvg('https://example.com/assets/1');
    expect(svg).toMatch(/<svg width="256" height="256"/);
    expect(await generateQrSvg('x', { size: 128 })).toMatch(/<svg width="128" height="128"/);
    expect(await generateQrSvg('x', { size: 0 })).not.toMatch(/<svg width=/);
  });

  it('withSize leaves an element that already has a width alone and only touches the root tag', () => {
    expect(withSize('<svg width="10" viewBox="0 0 1 1"><path d="M0 0"/></svg>', 256)).toBe('<svg width="10" viewBox="0 0 1 1"><path d="M0 0"/></svg>');
    expect(withSize('<svg viewBox="0 0 1 1"><svg viewBox="0 0 1 1"/></svg>', 64)).toBe('<svg width="64" height="64" viewBox="0 0 1 1"><svg viewBox="0 0 1 1"/></svg>');
  });

  it('rejects empty input', async () => {
    await expect(generateQrSvg('')).rejects.toThrow();
  });

  it('rejects non-string input', async () => {
    await expect(generateQrSvg(42)).rejects.toThrow();
  });

  it('renders a standalone <svg> for a plain string', async () => {
    const svg = await generateQrSvg('https://example.com/assets/1');
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
  });

  it('renders an otpauth:// URI the same way (TOTP enrollment use case)', async () => {
    const uri = 'otpauth://totp/workshop:alice?secret=JBSWY3DPEHPK3PXP&issuer=workshop';
    const svg = await generateQrSvg(uri);
    expect(svg).toContain('<svg');
  });

  it('honors a custom errorCorrectionLevel without throwing', async () => {
    const svg = await generateQrSvg('text', { errorCorrectionLevel: 'H' });
    expect(svg).toContain('<svg');
  });

  // The strongest check there is: draw the shipped SVG, read it back with a QR decoder.
  async function scan(svg) {
    const { data, info } = await sharp(Buffer.from(svg), { density: 800 })
      .flatten({ background: '#ffffff' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return jsQR(new Uint8ClampedArray(data), info.width, info.height);
  }

  it('the SVG decodes back to exactly the text that was encoded (a URL)', async () => {
    const text = 'https://example.com/assets/1?x=1';
    expect((await scan(await generateQrSvg(text)))?.data).toBe(text);
  });

  it('the otpauth:// enrollment URI survives the round trip', async () => {
    const uri = 'otpauth://totp/workshop:alice?secret=JBSWY3DPEHPK3PXP&issuer=workshop';
    expect((await scan(await generateQrSvg(uri)))?.data).toBe(uri);
  });

  it('a higher error-correction level still decodes', async () => {
    expect((await scan(await generateQrSvg('level H', { errorCorrectionLevel: 'H' })))?.data).toBe('level H');
  });
});
