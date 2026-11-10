import { describe, it, expect } from 'vitest';
import { SecurityConfigSchema } from '../src/config/schema.js';

describe('sign-in lockout defaults', () => {
  it('lock for minutes (not seconds) and for up to a day, and forget after a quiet day', () => {
    const l = SecurityConfigSchema.parse({}).lockout;
    expect(l.maxFailures).toBe(5);
    expect(l.baseLockMs).toBe(5 * 60_000);
    expect(l.maxLockMs).toBe(24 * 3_600_000);
    expect(l.resetAfterMs).toBe(24 * 3_600_000);
  });
});
