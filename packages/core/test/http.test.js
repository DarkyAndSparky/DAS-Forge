import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

import { serialize } from '../src/http/serialize.js';
import { validateBody } from '../src/http/validation-middleware.js';
import {
  requireAuth,
  requirePermission,
} from '../src/http/session-middleware.js';
import { renderErrorPage, notFoundHandler } from '../src/http/error-pages.js';
import { requestId, securityHeaders } from '../src/http/bootstrap.js';
import { defineVendorIdentity } from '../src/branding/index.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Header bag that ignores name case (helmet and hand-written code may spell names differently). */
function caseInsensitiveHeaders() {
  const store = new Map();
  return new Proxy({}, {
    get: (_t, k) => (typeof k === 'string' ? store.get(k.toLowerCase()) : undefined),
    set: (_t, k, v) => { store.set(String(k).toLowerCase(), v); return true; },
    deleteProperty: (_t, k) => { store.delete(String(k).toLowerCase()); return true; },
    has: (_t, k) => store.has(String(k).toLowerCase()),
  });
}

function mockRes() {
  const res = {
    statusCode: null,
    headers: caseInsensitiveHeaders(),
    body: null,
    cookies: {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    send(payload) { this.body = payload; return this; },
    type() { return this; },
    setHeader(k, v) { this.headers[k] = v; },
    getHeader(k) { return this.headers[k]; },
    removeHeader(k) { delete this.headers[k]; },
    cookie(name, value) { this.cookies[name] = value; },
    clearCookie(name) { delete this.cookies[name]; },
  };
  return res;
}

describe('serialize', () => {
  it('keeps unlisted fields by default', () => {
    const out = serialize({ id: 1, name: 'x' }, { viewerPermissions: [], fieldPermissions: {} });
    expect(out).toEqual({ id: 1, name: 'x' });
  });

  it('strips a field the viewer lacks permission for', () => {
    const out = serialize(
      { id: 1, name: 'x', cost: 999 },
      { viewerPermissions: ['read:basic'], fieldPermissions: { cost: 'read:finance' } }
    );
    expect(out).toEqual({ id: 1, name: 'x' });
  });

  it('keeps a gated field when the viewer has the permission', () => {
    const out = serialize(
      { id: 1, cost: 999 },
      { viewerPermissions: ['read:finance'], fieldPermissions: { cost: 'read:finance' } }
    );
    expect(out).toEqual({ id: 1, cost: 999 });
  });

  it('works on arrays of entities', () => {
    const out = serialize(
      [{ id: 1, cost: 1 }, { id: 2, cost: 2 }],
      { viewerPermissions: [], fieldPermissions: { cost: 'read:finance' } }
    );
    expect(out).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('accepts a Set for viewerPermissions', () => {
    const out = serialize(
      { cost: 5 },
      { viewerPermissions: new Set(['read:finance']), fieldPermissions: { cost: 'read:finance' } }
    );
    expect(out).toEqual({ cost: 5 });
  });
});

describe('validateBody', () => {
  const schema = z.object({ name: z.string().min(1) });

  it('calls next() and normalizes req.body on success', () => {
    const req = { body: { name: 'Alice' }, path: '/x' };
    const res = mockRes();
    const next = vi.fn();
    validateBody(schema)(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.body).toEqual({ name: 'Alice' });
  });

  it('responds 400 with unified error shape on failure', () => {
    const req = { body: { name: '' }, path: '/x' };
    const res = mockRes();
    const next = vi.fn();
    validateBody(schema)(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(Array.isArray(res.body.fields)).toBe(true);
  });
});

describe('requireAuth / requirePermission', () => {
  it('requireAuth blocks when req.user is missing', () => {
    const req = {};
    const res = mockRes();
    const next = vi.fn();
    requireAuth()(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('requirePermission allows when permission present', () => {
    const req = { user: { permissions: ['admin:write'] } };
    const res = mockRes();
    const next = vi.fn();
    requirePermission('admin:write')(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('requirePermission blocks with 403 when permission missing', () => {
    const req = { user: { permissions: ['read:basic'] } };
    const res = mockRes();
    const next = vi.fn();
    requirePermission('admin:write')(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('error pages', () => {
  const vendor = defineVendorIdentity({
    name: 'it-assets',
    assetsDir: path.join(__dirname, 'fixtures', 'empty-dir'),
  });

  it('renders a self-contained branded error page with the core "Powered by" badge', () => {
    const html = renderErrorPage({
      vendorIdentity: vendor,
      statusCode: 404,
      title: 'Not found',
      message: 'nope',
      requestId: 'req-123',
    });
    expect(html).toContain('404');
    expect(html).toContain('Powered by');
    expect(html).toContain('DAS-Forge');
    expect(html).toContain('req-123');
  });

  it('escapes HTML in title/message to avoid XSS via error content', () => {
    const html = renderErrorPage({
      vendorIdentity: vendor,
      statusCode: 500,
      title: '<script>alert(1)</script>',
      message: 'safe',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('notFoundHandler sends a 404 html response', () => {
    const req = { id: 'r1' };
    const res = mockRes();
    notFoundHandler(vendor)(req, res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('404');
  });
});

describe('requestId middleware', () => {
  it('generates an id when none provided and echoes it in the response header', () => {
    const req = { headers: {} };
    const res = mockRes();
    const next = vi.fn();
    requestId()(req, res, next);
    expect(req.id).toBeTruthy();
    expect(res.headers['X-Request-Id']).toBe(req.id);
    expect(next).toHaveBeenCalled();
  });

  it('reuses an incoming X-Request-Id header', () => {
    const req = { headers: { 'x-request-id': 'upstream-id' } };
    const res = mockRes();
    requestId()(req, res, () => {});
    expect(req.id).toBe('upstream-id');
  });
});

describe('securityHeaders', () => {
  it('sets a same-origin CSP with no unsafe-inline for scripts', () => {
    const req = {};
    const res = mockRes();
    const next = vi.fn();
    securityHeaders()(req, res, next);
    const csp = res.headers['Content-Security-Policy'];
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline\' script-src');
    expect(res.headers['X-Frame-Options']).toBe('DENY');
    expect(next).toHaveBeenCalled();
  });
});
