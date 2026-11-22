import { describe, it, expect } from 'vitest';
import { hostGuard, hostPolicyFromConfig, normalizeHost } from '../src/http/host-guard.js';
import { hardeningChecks } from '../src/health/checks/hardening.js';

const run = (mw, host, extra = {}) => {
  const out = { next: false, status: null };
  const req = { headers: { host, ...(extra.headers ?? {}) }, path: extra.path ?? '/login', ip: '1.2.3.4' };
  const res = { locals: { sendError: (s, b) => { out.status = s; out.body = b; } } };
  mw(req, res, () => { out.next = true; });
  return out;
};

describe('host guard (audit S-08)', () => {
  it('normalizes names', () => {
    expect(normalizeHost('Example.COM:8443')).toBe('example.com');
    expect(normalizeHost('[::1]:3000')).toBe('::1');
    expect(normalizeHost('a.b.')).toBe('a.b');
    expect(normalizeHost(undefined)).toBe('');
  });
  it('lets localhost and listed names through, answers 421 to others', () => {
    const mw = hostGuard({ allowedHosts: ['App.Example.com'] });
    for (const h of ['localhost:3000', '127.0.0.1', '[::1]:9', 'app.example.com:443']) expect(run(mw, h).next, h).toBe(true);
    for (const h of ['evil.example', 'app.example.com.evil.example', undefined]) { const r = run(mw, h); expect(r.next, String(h)).toBe(false); expect(r.status).toBe(421); expect(r.body.error).toBe('HOST_REJECTED'); }
  });
  it('warn lets through but reports once a minute per name', () => {
    let t = 0; const seen = [];
    const mw = hostGuard({ mode: 'warn', onViolation: (v) => seen.push(v), now: () => t });
    expect(run(mw, 'evil.example').next).toBe(true);
    run(mw, 'evil.example'); expect(seen).toHaveLength(1);
    t = 61_000; run(mw, 'evil.example'); expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ host: 'evil.example', mode: 'warn' });
  });
  it('off does nothing; X-Forwarded-Host counts only when the proxy is trusted', () => {
    expect(run(hostGuard({ mode: 'off' }), 'evil.example').next).toBe(true);
    const h = { 'x-forwarded-host': 'evil.example' };
    expect(run(hostGuard({ allowedHosts: ['ok.example'] }), 'ok.example', { headers: h }).next).toBe(true);
    expect(run(hostGuard({ allowedHosts: ['ok.example'], trustProxy: true }), 'ok.example', { headers: h }).status).toBe(421);
  });
  it('exempt path is always answered', () => {
    expect(run(hostGuard({ exemptPaths: ['/health'] }), 'evil.example', { path: '/health' }).next).toBe(true);
  });
  it('auto: enforce once a name is configured (allowedHosts or email.baseUrl), otherwise warn', () => {
    expect(hostPolicyFromConfig({ server: {} }).mode).toBe('warn');
    expect(hostPolicyFromConfig({ server: { allowedHosts: ['a.example'] } }).mode).toBe('enforce');
    expect(hostPolicyFromConfig({ server: {}, email: { baseUrl: 'https://site.example/x' } })).toMatchObject({ mode: 'enforce', names: ['site.example'] });
    expect(hostPolicyFromConfig({ server: { hostCheck: 'off', allowedHosts: ['a'] } }).mode).toBe('off');
    expect(hostPolicyFromConfig({ server: { hostCheck: 'enforce' } }).mode).toBe('enforce');
  });
  it('health panel warns when no name is set', async () => {
    const f = async (appConfig) => (await hardeningChecks({ appConfig })).find((c) => c.name === 'Host-name check');
    expect((await f({ server: {} })).status).toBe('warn');
    expect((await f({ server: { allowedHosts: ['a.example'] } })).status).toBe('ok');
  });
});

describe('TOTP key warning (audit R-03)', () => {
  const f = async (appConfig) => (await hardeningChecks({ appConfig })).find((c) => c.name === 'TOTP encryption key');
  it('warns when second factor is on and no key of its own is set', async () => {
    expect((await f({ server: {}, auth: { totp: { enabled: true } } })).status).toBe('warn');
    expect(await f({ server: {}, auth: { totp: { enabled: true }, totpEncryptionKey: 'k'.repeat(20) } })).toBeUndefined();
    expect(await f({ server: {}, auth: { totp: { enabled: false } } })).toBeUndefined();
  });
});
