import { describe, it, expect } from 'vitest';
import { helpBlockHtml, kindOf, safeEmail, kindText } from '../src/http/error-help.js';
import { renderErrorPage, errorResponder } from '../src/http/error-pages.js';
import { CompanyBrandingSchema } from '../src/branding/schema.js';

const vendor = { name: 'T', getLogo: () => null, readLogo: () => null };
function mockRes() {
  return { statusCode: null, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, type() { return this; }, send(b) { this.body = b; return this; }, json(b) { this.body = b; this.isJson = true; return this; }, setHeader(k, v) { this.headers[k] = v; } };
}

describe('error pages: help block and diagnostics', () => {
  it('maps statuses and guard codes to a situation', () => {
    expect(kindOf(403, 'BANNED')).toBe('ban');
    expect(kindOf(429)).toBe('rate');
    expect(kindOf(403, 'CSRF_REJECTED')).toBe('csrf');
    expect(kindOf(401)).toBe('session');
    expect(kindOf(403)).toBe('forbidden');
    expect(kindOf(404)).toBe('notfound');
    expect(kindOf(503)).toBe('unavailable');
    expect(kindOf(500)).toBe('server');
    expect(kindOf(422)).toBe('generic');
  });

  it('shows the support address only when it looks like an address', () => {
    expect(safeEmail('help@corp.example')).toBe('help@corp.example');
    for (const bad of ['', 'a b@c.example', 'a"@c.example', '<x@c.example>', 'x@c', 'x@c.example\r\nBcc: y@z.example', 'javascript:alert(1)']) expect(safeEmail(bad)).toBe('');
    expect(helpBlockHtml({ kind: 'server', statusCode: 500, supportEmail: 'help@corp.example' })).toContain('mailto:help@corp.example');
    expect(helpBlockHtml({ kind: 'server', statusCode: 500, supportEmail: '"><script>x</script>' })).not.toContain('mailto:');
    expect(helpBlockHtml({ kind: 'server', statusCode: 500 })).toContain('администратору приложения');
  });

  it('keeps diagnostics behind consent and never sends anything by itself', () => {
    const h = helpBlockHtml({ kind: 'server', statusCode: 500, requestId: 'req-1', nonce: 'n0nce' });
    expect(h).toContain('id="diag-ok"');
    expect(h).toContain('id="diag-go" disabled');
    expect(h).toContain('<script nonce="n0nce">');
    expect(h).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|document\.cookie/);
  });

  it('a ban collects only the code, the request id and the time', () => {
    const h = helpBlockHtml({ kind: 'ban', statusCode: 403, requestId: 'r-9' });
    expect(h).toContain('m":1');
    const s = helpBlockHtml({ kind: 'server', statusCode: 500, requestId: 'r-9' });
    expect(s).toContain('m":0');
  });

  it('escapes a hostile request id', () => {
    const h = helpBlockHtml({ kind: 'server', statusCode: 500, requestId: '</script><img src=x onerror=alert(1)>' });
    expect(h).not.toContain('</script><img');
    expect(h).not.toContain('<img src=x');
  });

  it('every page of the list carries the steps; a ban page does not say "no rights"', () => {
    for (const [status, error, needle] of [[401, 'UNAUTHENTICATED', 'Войдите снова'], [403, 'FORBIDDEN', 'группы или организации'], [403, 'BANNED', 'Не повторяйте попытки'], [403, 'CSRF_REJECTED', 'F5'], [429, 'RATE_LIMITED', 'Подождите указанное время'], [404, 'NOT_FOUND', 'Проверьте адрес']]) {
      const res = mockRes();
      errorResponder(vendor)({ headers: { accept: 'text/html' }, path: '/', id: 'rid-1' }, res, () => {});
      res.locals.sendError(status, { error, fields: [], retryAfterSec: error === 'RATE_LIMITED' ? 200 : undefined });
      expect(res.statusCode).toBe(status);
      expect(res.body).toContain(needle);
      expect(res.body).toContain('rid-1');
      if (error === 'BANNED') { expect(res.body).toContain('Доступ ограничен'); expect(res.body).not.toContain('нет прав'); }
      if (error === 'RATE_LIMITED') expect(res.body).toContain('Повторите через 4 мин');
    }
  });

  it('API clients still get plain JSON and no HTML help', () => {
    const res = mockRes();
    errorResponder(vendor)({ headers: { accept: 'application/json' }, path: '/' }, res, () => {});
    res.locals.sendError(403, { error: 'BANNED', fields: [] });
    expect(res.isJson).toBe(true);
    expect(res.body).toEqual({ error: 'BANNED', fields: [] });
  });

  it('the help block can be left out and the page still renders', () => {
    const html = renderErrorPage({ vendorIdentity: vendor, statusCode: 500, title: 't', message: 'm', help: false });
    expect(html).not.toContain('id="diag"');
    expect(renderErrorPage({ vendorIdentity: vendor, statusCode: 500, title: 't', message: 'm' })).toContain('id="diag"');
  });

  it('English texts exist for every kind', () => {
    expect(kindText('ban', 'en').title).toBe('Access restricted');
    expect(helpBlockHtml({ kind: 'forbidden', statusCode: 403, locale: 'en' })).toContain('What you can do');
  });

  it('the branding schema accepts a good address and refuses a bad one', () => {
    expect(CompanyBrandingSchema.parse({ supportEmail: 'it@corp.example' }).supportEmail).toBe('it@corp.example');
    expect(CompanyBrandingSchema.parse({}).supportEmail).toBe(null);
    expect(CompanyBrandingSchema.safeParse({ supportEmail: 'not an address' }).success).toBe(false);
  });
});
