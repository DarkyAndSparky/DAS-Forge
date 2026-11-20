import { describe, it, expect } from 'vitest';
import { adminNets } from '../src/http/index.js';
import { ipInNets } from '../src/security/bans.js';

const run = (mw, path, ip) => {
  let out = 'next';
  const res = { statusCode: 200, status(c) { this.statusCode = c; out = c; return this; }, json() { return this; }, send() { return this; }, type() { return this; }, set() { return this; }, setHeader() {}, end() { return this; }, locals: {} };
  mw({ path, ip, headers: {}, id: 'r', method: 'GET', originalUrl: path }, res, () => { out = 'next'; });
  return out;
};

describe('admin by network (A8)', () => {
  it('ipInNets: networks and single addresses, IPv4 and IPv6, mapped addresses', () => {
    expect(ipInNets(['10.0.5.0/24'], '10.0.5.9')).toBe(true);
    expect(ipInNets(['10.0.5.0/24'], '10.0.6.9')).toBe(false);
    expect(ipInNets(['10.0.5.7'], '10.0.5.7')).toBe(true);
    expect(ipInNets(['10.0.5.7'], '10.0.5.8')).toBe(false);
    expect(ipInNets(['2001:db8::/32'], '2001:db8::1')).toBe(true);
    expect(ipInNets(['10.0.5.0/24'], '::ffff:10.0.5.9')).toBe(true);
    expect(ipInNets(['10.0.5.0/24'], undefined)).toBe(false);
    expect(ipInNets([], '10.0.5.9')).toBe(false);
  });
  it('lets the admin prefix through only from the listed networks; other pages stay open', () => {
    const mw = adminNets({ nets: ['10.0.5.0/24', '127.0.0.1'] });
    expect(run(mw, '/admin/users', '10.0.5.20')).toBe('next');
    expect(run(mw, '/admin', '127.0.0.1')).toBe('next');
    expect(run(mw, '/admin/users', '192.168.1.5')).toBe(404);
    expect(run(mw, '/admin', '192.168.1.5')).toBe(404);
    expect(run(mw, '/ui/home', '192.168.1.5')).toBe('next');
    expect(run(mw, '/administrator', '192.168.1.5')).toBe('next');
  });
  it('an empty list lets everyone through; a wrong entry is refused at startup', () => {
    expect(run(adminNets({ nets: [] }), '/admin', '8.8.8.8')).toBe('next');
    expect(() => adminNets({ nets: ['10.0.5.0/99'] })).toThrow(/not a network/);
    expect(() => adminNets({ nets: ['host.example'] })).toThrow(/not a network/);
  });
});
