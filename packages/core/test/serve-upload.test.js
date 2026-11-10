import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';

import { storeUpload, uploadResponseHeaders, sendUpload, safeDownloadName, detectFileType } from '../src/files/index.js';

describe('serving uploads (audit B11)', () => {
  let dir;
  let server;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'su-'));
  });
  afterEach(async () => {
    if (server) await new Promise((r) => server.close(r));
    server = null;
    rmSync(dir, { recursive: true, force: true });
  });

  async function get(handlerName, opts) {
    server = http.createServer(async (req, res) => {
      const ok = await sendUpload(res, dir, handlerName, opts);
      if (!ok) {
        res.statusCode = 404;
        res.end('nope');
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: server.address().port, path: '/' }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      }).on('error', reject);
    });
  }

  it('image: inline, type from the stored extension, hardening headers present', async () => {
    const f = storeUpload(Buffer.from('fake-png-bytes'), dir, 'png');
    const r = await get(f.filename);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['content-disposition']).toMatch(/^inline;/);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toMatch(/sandbox/);
    expect(r.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(r.headers['content-length']).toBe(String('fake-png-bytes'.length));
    expect(r.body.toString()).toBe('fake-png-bytes');
  });

  it('SVG is inline only under the sandbox CSP; inline:false forces a download', async () => {
    const f = storeUpload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), dir, 'svg');
    expect(uploadResponseHeaders(f.filename)['Content-Security-Policy']).toMatch(/default-src 'none'.*sandbox/);
    expect(uploadResponseHeaders(f.filename)['Content-Disposition']).toMatch(/^inline;/);
    expect(uploadResponseHeaders(f.filename, { inline: false })['Content-Disposition']).toMatch(/^attachment;/);
  });

  it('PDF, zip and unknown types are always downloads; unknown is octet-stream', () => {
    expect(uploadResponseHeaders('11111111-1111-1111-1111-111111111111.pdf')['Content-Disposition']).toMatch(/^attachment;/);
    const h = uploadResponseHeaders('11111111-1111-1111-1111-111111111111.zip');
    expect(h['Content-Type']).toBe('application/octet-stream');
    expect(h['Content-Disposition']).toMatch(/^attachment;/);
  });

  it('invalid, traversal and missing names answer false and write nothing', async () => {
    expect(uploadResponseHeaders('../../etc/passwd')).toBeNull();
    expect(uploadResponseHeaders('logo.png')).toBeNull();
    expect(uploadResponseHeaders(undefined)).toBeNull();
    const r = await get('11111111-1111-1111-1111-111111111111.png');
    expect(r.status).toBe(404);
  });

  it('download names: header injection and path characters are stripped, non-ASCII is encoded', () => {
    expect(safeDownloadName('a"b\r\nSet-Cookie: x=1.png')).not.toMatch(/["\r\n]/);
    expect(safeDownloadName('../../x/y\\z.png')).toBe('....xyz.png'.replace(/^\.+/, ''));
    expect(safeDownloadName('', 'fallback')).toBe('fallback');
    const h = uploadResponseHeaders('11111111-1111-1111-1111-111111111111.png', { downloadName: 'Логотип «ООО».png' });
    expect(h['Content-Disposition']).toMatch(/filename="[\x20-\x7e]*"; filename\*=UTF-8''%D0%9B/);
    expect(h['Content-Disposition']).not.toMatch(/[^\x20-\x7e]/);
  });
});

describe('SVG detection (audit B11)', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';
  it('accepts BOM, XML declaration, comments and DOCTYPE before <svg', () => {
    for (const prefix of ['﻿', '<?xml version="1.0"?>\n', '<!-- made by a tool -->\n', '<?xml version="1.0"?><!-- c --><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n', '﻿<?xml version="1.0" encoding="UTF-8"?>\n<!-- a --><!-- b -->\n']) {
      expect(detectFileType(Buffer.from(prefix + svg))?.type).toBe('svg');
    }
  });
  it('does not call other markup SVG', () => {
    expect(detectFileType(Buffer.from('<html><svg/></html>'))).toBeNull();
    expect(detectFileType(Buffer.from('<?xml version="1.0"?><note>svg</note>'))).toBeNull();
    expect(detectFileType(Buffer.from('<svgfoo/>'))).toBeNull();
  });
});
