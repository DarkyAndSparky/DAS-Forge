import { describe, it, expect } from 'vitest';
import { assertOutboundUrl, isBlockedHost } from '../src/http/outbound.js';
import { webhookChannel } from '../src/alerts/index.js';
import { createHttpSink } from '../src/logs/sinks.js';
import { findVulnerabilities } from '../src/health/checks/dependencies.js';

const blocked = [
  'http://169.254.169.254/latest/meta-data/',
  'https://169.254.0.1/x',
  'http://2852039166/',                 // 169.254.169.254 written as one decimal number
  'http://0xa9fea9fe/',                 // ... and as hex
  'http://0251.0376.0251.0376/',        // ... and as octal
  'http://[::ffff:169.254.169.254]/',   // IPv4 inside IPv6
  'http://[fe80::1]/',
  'http://[fd00:ec2::254]/',
  'http://metadata.google.internal/computeMetadata/v1/',
  'http://METADATA.GOOGLE.INTERNAL./',
];
const allowed = [
  'https://hooks.example.com/x',
  'http://127.0.0.1:9000/ingest',       // local collector next to the app
  'http://10.0.0.5/ingest',             // collectors inside the company network are the intended use
  'https://192.168.1.20:8443/x',
  'http://[::1]:3100/loki',
  'https://169.255.0.1/x',              // not link-local
];

describe('outbound address check (G-08)', () => {
  it('refuses the link-local and metadata ranges however the address is written', () => {
    for (const u of blocked) expect(() => assertOutboundUrl(u, { protocols: ['https:', 'http:'] })).toThrow(/link-local or metadata/);
  });

  it('allows loopback, private networks and ordinary hosts: on-premises collectors are the intended use', () => {
    for (const u of allowed) expect(assertOutboundUrl(u, { protocols: ['https:', 'http:'] }) instanceof URL).toBe(true);
  });

  it('refuses a wrong scheme and a non-address', () => {
    expect(() => assertOutboundUrl('http://example.com', { protocols: ['https:'] })).toThrow(/only https/);
    expect(() => assertOutboundUrl('file:///etc/passwd', { protocols: ['https:', 'http:'] })).toThrow(/only https or http/);
    expect(() => assertOutboundUrl('not a url')).toThrow(/not a valid URL/);
  });

  it('isBlockedHost accepts the host as URL.hostname gives it (brackets included)', () => {
    expect(isBlockedHost('[fe80::abcd]')).toBe(true);
    expect(isBlockedHost('example.com')).toBe(false);
  });

  it('is applied by the webhook channel, the http log sink and the registry address', async () => {
    expect(() => webhookChannel({ url: 'https://169.254.169.254/hook' })).toThrow(/link-local/);
    expect(() => createHttpSink({ url: 'http://169.254.169.254/ingest' })).toThrow(/link-local/);
    await expect(findVulnerabilities([{ name: 'x', version: '1.0.0' }], { registry: 'http://169.254.169.254', fetchFn: async () => { throw new Error('must not be called'); } })).rejects.toThrow(/link-local/);
  });

  it('the http log sink does not follow redirects', async () => {
    let seen;
    const s = createHttpSink({ url: 'http://127.0.0.1:1/x', fetchImpl: async (_u, init) => { seen = init; return { ok: true, status: 200 }; }, flushIntervalMs: 5, retryBaseMs: 5 });
    s.write?.('{"msg":"hi"}');
    await s.flush?.();
    await s.close?.();
    if (seen) expect(seen.redirect).toBe('error');
  });
});
