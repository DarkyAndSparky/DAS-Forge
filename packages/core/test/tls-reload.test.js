import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateSelfSignedCert } from '../src/certs/index.js';
import { createTlsReloader } from '../src/http/tls-reload.js';

describe('hot certificate reload (R-04)', () => {
  it('applies a new valid pair to every server, refuses a mismatched one, and retries when the files change', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tlsr-'));
    try {
      const a = await generateSelfSignedCert({ commonName: 'a.test', altNames: ['a.test'] });
      const b = await generateSelfSignedCert({ commonName: 'b.test', altNames: ['b.test'] });
      const certPath = path.join(dir, 'cert.pem'); const keyPath = path.join(dir, 'key.pem');
      writeFileSync(certPath, a.cert); writeFileSync(keyPath, a.key);
      const applied = [];
      const servers = [{ setSecureContext: (p) => applied.push(String(p.cert)) }, { setSecureContext: (p) => applied.push(String(p.cert)) }];
      const events = [];
      const r = createTlsReloader({ certPath, keyPath, servers: () => servers, onReload: (e) => events.push(e), pollMs: 0, sighup: false });
      // new certificate, OLD key: refused, nothing applied
      writeFileSync(certPath, b.cert);
      expect(r.reload()).toBe(false);
      expect(applied.length).toBe(0);
      expect(events[0].ok).toBe(false);
      // the key arrives: now it matches
      writeFileSync(keyPath, b.key);
      expect(r.reload()).toBe(true);
      expect(applied.length).toBe(2);
      expect(applied[0]).toBe(String(b.cert));
      expect(events[1]).toEqual({ ok: true });
      // damaged file: refused, the servers are not touched again
      writeFileSync(certPath, 'not a certificate');
      expect(r.reload()).toBe(false);
      expect(applied.length).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('polling notices a changed file once and does not repeat a refused pair', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tlsr-'));
    try {
      const a = await generateSelfSignedCert({ commonName: 'a.test', altNames: ['a.test'] });
      const certPath = path.join(dir, 'cert.pem'); const keyPath = path.join(dir, 'key.pem');
      writeFileSync(certPath, a.cert); writeFileSync(keyPath, a.key);
      const events = [];
      const r = createTlsReloader({ certPath, keyPath, servers: () => [], onReload: (e) => events.push(e), pollMs: 20, sighup: false }).start();
      writeFileSync(certPath, 'broken');
      const later = new Date(Date.now() + 5000); utimesSync(certPath, later, later);
      await new Promise((res) => setTimeout(res, 150));
      r.stop();
      expect(events.length).toBe(1); // refused once, not every tick
      expect(events[0].ok).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses to be created without paths and a server list', () => {
    expect(() => createTlsReloader({ certPath: 'a' })).toThrow(/required/);
  });
});
