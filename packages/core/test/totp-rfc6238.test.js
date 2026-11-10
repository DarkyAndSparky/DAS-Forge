import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { generateTotp, verifyTotp, matchTotpStep, buildTotpUri, generateTotpSecret } from '../src/auth/totp.js';

// RFC 6238 Appendix B, SHA-1, secret "12345678901234567890" (base32 below), last 6 digits of the 8-digit codes.
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const VECTORS = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
  [20000000000, '353130'],
];

/** Independent RFC 4226 reference (the previous in-house implementation), to cross-check non-default periods. */
function referenceHotp(counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', Buffer.from('12345678901234567890')).update(buf).digest();
  const o = h[h.length - 1] & 0x0f;
  const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

describe('TOTP against the RFC 6238 test vectors', () => {
  it.each(VECTORS)('at %i the code is %s, and it verifies', (at, code) => {
    expect(generateTotp(SECRET, { at })).toBe(code);
    expect(verifyTotp(SECRET, code, { at })).toBe(true);
    expect(matchTotpStep(SECRET, code, { at })).toBe(Math.floor(at / 30));
  });

  it('accepts a lowercase secret', () => {
    expect(generateTotp(SECRET.toLowerCase(), { at: 59 })).toBe('287082');
  });

  it('a non-default step length matches the reference implementation', () => {
    for (const at of [59, 1_700_000_000, 2_000_000_000]) {
      expect(generateTotp(SECRET, { at, stepSeconds: 60 })).toBe(referenceHotp(Math.floor(at / 60)));
      expect(matchTotpStep(SECRET, referenceHotp(Math.floor(at / 60)), { at, stepSeconds: 60 })).toBe(Math.floor(at / 60));
    }
  });

  it('the window is whole steps either side: 1 by default, 0 and 2 on request', () => {
    const at = 1_700_000_000;
    const step = Math.floor(at / 30);
    const at2 = (n) => generateTotp(SECRET, { at: (step + n) * 30 });
    expect(matchTotpStep(SECRET, at2(-1), { at })).toBe(step - 1);
    expect(matchTotpStep(SECRET, at2(1), { at })).toBe(step + 1);
    expect(matchTotpStep(SECRET, at2(-2), { at })).toBeNull();
    expect(matchTotpStep(SECRET, at2(1), { at, window: 0 })).toBeNull();
    expect(matchTotpStep(SECRET, at2(2), { at, window: 2 })).toBe(step + 2);
    expect(matchTotpStep(SECRET, at2(3), { at, window: 2 })).toBeNull();
  });

  it('rejects wrong, short, long and non-string tokens', () => {
    for (const bad of ['000000', '12345', '1234567', 'abcdef', '', null, undefined, 287082]) {
      expect(matchTotpStep(SECRET, bad, { at: 59 })).toBeNull();
    }
  });

  it('generates a 32-character base32 secret', () => {
    expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });

  it('builds a provisioning URI with the secret, issuer and a decodable label', () => {
    const uri = buildTotpUri(SECRET, { accountName: 'a b@c.example', issuer: 'DAS Forge' });
    const url = new URL(uri);
    expect(url.protocol).toBe('otpauth:');
    expect(url.host).toBe('totp');
    expect(url.searchParams.get('secret')).toBe(SECRET);
    expect(url.searchParams.get('issuer')).toBe('DAS Forge');
    expect(decodeURIComponent(url.pathname)).toContain('a b@c.example');
    expect(new URL(buildTotpUri(SECRET, { accountName: 'x', stepSeconds: 60 })).searchParams.get('period')).toBe('60');
  });

  it('still verifies legacy 10-byte (16-char base32) secrets enrolled before otplib', () => {
    const legacy = 'JBSWY3DPEHPK3PXP';
    const code = generateTotp(legacy, { at: 1_000_000 });
    expect(code).toMatch(/^\d{6}$/);
    expect(matchTotpStep(legacy, code, { at: 1_000_000 })).toBe(Math.floor(1_000_000 / 30));
  });
});
