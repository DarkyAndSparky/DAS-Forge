import { describe, it, expect } from 'vitest';
import { securityChecks } from '../src/health/index.js';

describe('age of long-lived keys (R-19)', () => {
  const NOW = Date.parse('2026-11-07T00:00:00Z');
  const base = { auth: { sessionSecret: 'a-long-random-secret-value-1', totpEncryptionKey: 'k'.repeat(32) }, backup: { encryptionKey: 'b'.repeat(20) } };
  const ageOf = (cfg) => Object.fromEntries(securityChecks(cfg, { now: () => NOW }).filter((c) => /age$/.test(c.name)).map((c) => [c.name, c]));

  it('warns on a key older than maxAgeDays, is fine within it, and says so when the date is not recorded', () => {
    const r = ageOf({ ...base, security: { secretsRotation: { maxAgeDays: 365, sessionSecretCreatedAt: '2025-10-01', totpKeyCreatedAt: '2026-09-01' } } });
    expect(r['Session secret age'].status).toBe('warn');
    expect(r['Session secret age'].message).toContain('rotate');
    expect(r['TOTP key age']).toMatchObject({ status: 'ok', message: '67 days old' });
    expect(r['Backup key age'].message).toContain('not recorded');
  });

  it('does not check a key that is not configured', () => {
    const r = ageOf({ auth: { sessionSecret: 'a-long-random-secret-value-1' }, security: { secretsRotation: { maxAgeDays: 365 } } });
    expect(Object.keys(r)).toEqual(['Session secret age']);
  });

  it('without the rotation block (old configs) nothing new is reported', () => {
    expect(Object.keys(ageOf(base))).toEqual([]);
  });
});

describe('step-up warning (R-01)', () => {
  const find = (cfg) => securityChecks(cfg).find((c) => c.name === 'Step-up confirmation');
  it('production without stepUp.enabled warns; enabled or non-production does not', () => {
    expect(find({ env: 'production', security: { stepUp: { enabled: false } } }).status).toBe('warn');
    expect(find({ env: 'production', security: { stepUp: { enabled: true } } })).toBe(undefined);
    expect(find({ env: 'development', security: { stepUp: { enabled: false } } })).toBe(undefined);
    expect(find({ env: 'production' })).toBe(undefined); // an old config object without the block
  });
});
