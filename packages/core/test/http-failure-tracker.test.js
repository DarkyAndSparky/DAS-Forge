import { describe, it, expect } from 'vitest';
import { createFailureTracker, clientKey } from '../src/http/rate-limit.js';

describe('I02: failure tracker eviction', () => {
  it('flooding with junk keys does not free a locked key', () => {
    let t = 0;
    const tr = createFailureTracker({ maxFailures: 2, baseLockMs: 60_000, maxKeys: 5, now: () => t });
    tr.recordFailure('victim'); tr.recordFailure('victim');
    expect(tr.check('victim').locked).toBe(true);
    for (let i = 0; i < 50; i++) tr.recordFailure(`junk${i}`);
    expect(tr.check('victim').locked).toBe(true);
    expect(tr.size() <= 5).toBe(true);
  });
  it('stays bounded even when every key is locked', () => {
    const tr = createFailureTracker({ maxFailures: 1, baseLockMs: 60_000, maxKeys: 3 });
    for (let i = 0; i < 10; i++) tr.recordFailure(`k${i}`);
    expect(tr.size() <= 3).toBe(true);
  });
  it('IPv6 addresses of one /56 share a key; IPv4 is unchanged', () => {
    expect(clientKey('2001:db8:abcd:12::1')).toBe(clientKey('2001:db8:abcd:12::ffff'));
    expect(clientKey('203.0.113.7')).toBe('203.0.113.7');
    expect(clientKey(undefined)).toBe('unknown');
  });
  it('resetPrefix forgets every key of one prefix and nothing else', () => {
    const tr = createFailureTracker({ maxFailures: 1, baseLockMs: 60_000 });
    tr.recordFailure('alice|1.1.1.1');
    tr.recordFailure('alice|2.2.2.2');
    tr.recordFailure('bob|1.1.1.1');
    expect(tr.resetPrefix('alice|')).toBe(2);
    expect(tr.check('alice|1.1.1.1').locked).toBe(false);
    expect(tr.check('bob|1.1.1.1').locked).toBe(true);
  });
});
