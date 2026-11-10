import { describe, it, expect } from 'vitest';
import { anonymizeIp } from '../src/logs/ip.js';

describe('anonymizeIp', () => {
  it('keeps the address in full mode', () => {
    expect(anonymizeIp('203.0.113.77')).toBe('203.0.113.77');
    expect(anonymizeIp('203.0.113.77', 'full')).toBe('203.0.113.77');
  });
  it('truncates IPv4 to /24 and IPv4-mapped IPv6 the same way', () => {
    expect(anonymizeIp('203.0.113.77', 'truncate')).toBe('203.0.113.0');
    expect(anonymizeIp('::ffff:203.0.113.77', 'truncate')).toBe('203.0.113.0');
  });
  it('truncates IPv6 to /48', () => {
    expect(anonymizeIp('2001:db8:1:2:3:4:5:6', 'truncate')).toBe('2001:db8:1::');
    expect(anonymizeIp('2001:db8::1', 'truncate')).toBe('2001:db8:0::');
    expect(anonymizeIp('::1', 'truncate')).toBe('0:0:0::');
  });
  it('drops the address in none mode and survives junk', () => {
    expect(anonymizeIp('203.0.113.77', 'none')).toBeUndefined();
    expect(anonymizeIp(undefined, 'truncate')).toBeUndefined();
    expect(anonymizeIp('not-an-ip', 'truncate')).toBe('invalid');
  });
});
