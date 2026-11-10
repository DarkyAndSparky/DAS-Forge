import { describe, it, expect } from 'vitest';
import { securityHeaders } from '../src/http/bootstrap.js';
import { securityChecks } from '../src/health/checks/security.js';

describe('HSTS preload and the doctor check for the redirect', () => {
  function hstsHeader(opts) {
    const headers = {};
    const res = { setHeader: (k, v) => { headers[k] = v; }, getHeader: () => undefined, removeHeader() {}, locals: {}, on() {} };
    securityHeaders(opts)({ secure: true, headers: {}, method: 'GET' }, res, () => {});
    return headers['Strict-Transport-Security'];
  }
  it('adds preload only with includeSubDomains and at least a year', () => {
    expect(hstsHeader({ hsts: { includeSubDomains: true, preload: true } })).toBe('max-age=31536000; includeSubDomains; preload');
    expect(() => securityHeaders({ hsts: { preload: true } })).toThrow(/preload/);
    expect(() => securityHeaders({ hsts: { includeSubDomains: true, preload: true, maxAgeSeconds: 60 } })).toThrow(/preload/);
  });
  it('doctor: ok with a redirect, warn when it is off, ok behind a proxy', () => {
    const base = { auth: { sessionSecret: 'x'.repeat(24) }, env: 'development' };
    const find = (server) => securityChecks({ ...base, server }).find((c) => c.name === 'HTTP to HTTPS');
    expect(find({ port: 9002, https: { mode: 'self-signed' } }).status).toBe('ok');
    expect(find({ port: 9002, httpRedirectPort: false, https: { mode: 'self-signed' } }).status).toBe('warn');
    expect(find({ port: 9002, httpRedirectPort: 9002, https: { mode: 'self-signed' } }).status).toBe('fail');
    expect(find({ port: 9002, https: { mode: 'reverse-proxy' } }).status).toBe('ok');
  });
});
