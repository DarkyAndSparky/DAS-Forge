import { describe, it, expect } from 'vitest';
import { applyExposureProfile } from '../src/config/profile.js';
import { hardeningChecks } from '../src/health/index.js';

describe('A1: the internet profile fills in what the application did not write', () => {
  it('turns on the __Host- cookie and sets the auto-ban threshold from the lock-out threshold', () => {
    const { config, applied } = applyExposureProfile({ server: { exposure: 'internet' } });
    expect(config.auth.hostCookiePrefix).toBe(true);
    expect(config.ipBan.maxFailures).toBe(6);
    expect(applied).toEqual(['auth.hostCookiePrefix', 'ipBan.maxFailures']);
    expect(applyExposureProfile({ server: { exposure: 'internet' }, auth: { lockout: { maxFailures: 9 } } }).config.ipBan.maxFailures).toBe(10);
  });
  it('an explicit value always wins, including a weaker one', () => {
    const { config, applied } = applyExposureProfile({ server: { exposure: 'internet' }, auth: { hostCookiePrefix: false }, ipBan: { maxFailures: 30 } });
    expect(config.auth.hostCookiePrefix).toBe(false);
    expect(config.ipBan.maxFailures).toBe(30);
    expect(applied).toEqual([]);
  });
  it('does not touch lan, and does not change the input', () => {
    const lan = { server: { exposure: 'lan' } };
    expect(applyExposureProfile(lan).config).toBe(lan);
    expect(applyExposureProfile({}).applied).toEqual([]);
    const input = { server: { exposure: 'internet' } };
    applyExposureProfile(input);
    expect(input).toEqual({ server: { exposure: 'internet' } });
  });
  it('does not force a second factor for administrators', () => {
    const { config } = applyExposureProfile({ server: { exposure: 'internet' } });
    expect(JSON.stringify(config)).not.toMatch(/mfa|totp|second/i);
  });
  it('doctor: an explicit off cookie fails, the profile default passes', async () => {
    const base = { server: { exposure: 'internet', https: { mode: 'standalone' }, admin: { allowedNets: ['10.0.0.0/8'] } } };
    const get = (r) => r.find((c) => c.name === 'Internet exposure: session cookie');
    expect(get(await hardeningChecks({ appConfig: { ...base, auth: { hostCookiePrefix: false } } })).status).toBe('fail');
    expect(get(await hardeningChecks({ appConfig: { ...base, auth: { hostCookiePrefix: true } } })).status).toBe('ok');
    expect(get(await hardeningChecks({ appConfig: { server: { exposure: 'lan' }, auth: {} } }))).toBeUndefined();
  });
});
