import { describe, it, expect } from 'vitest';
import { cspReports, normalizeCspReport } from '../src/http/csp-report.js';
import { securityHeaders } from '../src/http/bootstrap.js';
import { SecurityConfigSchema } from '../src/config/schema.js';

function post(handler, body) {
  return new Promise((resolve) => {
    const req = { body, on(ev, cb) { if (ev === 'end') setTimeout(cb, 0); return this; } };
    const res = { status(c) { this.code = c; return this; }, end() { resolve(this.code); } };
    handler(req, res);
  });
}
const legacy = (dir = 'style-src-attr', blocked = 'inline') => ({ 'csp-report': { 'document-uri': 'https://x/ui', 'effective-directive': dir, 'blocked-uri': blocked, 'line-number': 7, disposition: 'report' } });

describe('csp reports', () => {
  it('normalizes the legacy and the Reporting API shapes', () => {
    expect(normalizeCspReport(legacy())).toMatchObject({ directive: 'style-src-attr', blocked: 'inline', line: 7 });
    expect(normalizeCspReport([{ type: 'csp-violation', body: { effectiveDirective: 'img-src', blockedURL: 'https://evil/x.png' } }])).toMatchObject({ directive: 'img-src', blocked: 'https://evil/x.png' });
    expect(normalizeCspReport('x')).toBe(null);
    expect(normalizeCspReport({ 'csp-report': { 'blocked-uri': 'a'.repeat(500) } }).blocked.length).toBe(200);
  });

  it('answers 204, passes a report on once per directive and address, and limits the total', async () => {
    const got = [];
    let t = 0;
    const h = cspReports({ onReport: (r) => got.push(r), maxPerMinute: 3, now: () => t });
    expect(await post(h, legacy())).toBe(204);
    await post(h, legacy());
    expect(got.length).toBe(1);
    await post(h, legacy('img-src', 'a'));
    await post(h, legacy('img-src', 'b'));
    await post(h, legacy('img-src', 'c'));
    expect(got.length).toBe(3); // over the budget of the minute
    t = 61_000;
    await post(h, legacy('img-src', 'c'));
    expect(got.length).toBe(4); // refused a minute ago by the budget, passes in a fresh minute
    await post(h, legacy('img-src', 'c'));
    expect(got.length).toBe(4); // the same key again within the hour is not repeated
    await post(h, legacy('font-src', 'd'));
    expect(got.length).toBe(5);
  });

  it('survives garbage and a failing sink', async () => {
    const h = cspReports({ onReport: () => { throw new Error('boom'); } });
    expect(await post(h, { nonsense: true })).toBe(204);
    expect(await post(h, legacy())).toBe(204);
  });
});

describe('report-only policy header', () => {
  function run(opts) {
    const headers = {};
    const res = { locals: {}, setHeader: (k, v) => { headers[k] = v; }, getHeader: (k) => headers[k], removeHeader() {} };
    securityHeaders(opts)({ headers: {}, secure: false }, res, () => {});
    return headers;
  }
  it('is absent by default and strict about styles when on', () => {
    expect(run({})['Content-Security-Policy-Report-Only']).toBeUndefined();
    const h = run({ reportOnly: { reportUri: '/r' } })['Content-Security-Policy-Report-Only'];
    expect(h).toContain("style-src 'self' 'nonce-");
    expect(h).not.toContain('unsafe-inline');
    expect(h).toContain('report-uri /r');
  });
  it('refuses a report address that is not a path', () => {
    expect(() => securityHeaders({ reportOnly: { reportUri: 'https://evil/x' } })).toThrow(TypeError);
  });
});

describe('configuration', () => {
  it('has the report-only policy off by default', () => {
    const c = SecurityConfigSchema.parse({});
    expect(c.csp).toEqual({ reportOnly: false, reportPath: '/csp-report' });
  });
});
