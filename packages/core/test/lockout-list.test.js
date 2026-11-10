import { describe, it, expect } from 'vitest';
import { createFailureTracker } from '../src/http/rate-limit.js';

describe('failure tracker lockout list (R-08)', () => {
  it('lists only active lockouts, soonest first, and reset lifts one', () => {
    let t = 1_000_000;
    const tr = createFailureTracker({ maxFailures: 2, baseLockMs: 10_000, now: () => t });
    tr.recordFailure('a|1.1.1.1'); // one failure: not locked
    expect(tr.list()).toEqual([]);
    tr.recordFailure('a|1.1.1.1');
    t += 1000;
    tr.recordFailure('b|2.2.2.2'); tr.recordFailure('b|2.2.2.2');
    const list = tr.list();
    expect(list.map((e) => e.key)).toEqual(['a|1.1.1.1', 'b|2.2.2.2']);
    expect(list[0]).toMatchObject({ failures: 2, retryAfterMs: 9000 });
    tr.reset('a|1.1.1.1');
    expect(tr.check('a|1.1.1.1').locked).toBe(false);
    t += 20_000;
    expect(tr.list()).toEqual([]); // expired locks are not shown
  });
});
