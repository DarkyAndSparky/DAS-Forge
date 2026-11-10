import { describe, it, expect } from 'vitest';
import { backoffDelay } from '../src/util/backoff.js';

describe('backoffDelay (equal jitter)', () => {
  it('doubles up to the cap; random=1 gives the full pause, random=0 half of it', () => {
    expect(backoffDelay(1, { baseMs: 100, random: () => 1 })).toBe(100);
    expect(backoffDelay(2, { baseMs: 100, random: () => 1 })).toBe(200);
    expect(backoffDelay(3, { baseMs: 100, random: () => 1 })).toBe(400);
    expect(backoffDelay(3, { baseMs: 100, random: () => 0 })).toBe(200);
    expect(backoffDelay(10, { baseMs: 100, maxMs: 1000, random: () => 1 })).toBe(1000);
  });

  it('always stays within [d/2, d] and actually varies', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
      const v = backoffDelay(4, { baseMs: 100 }); // d = 800
      expect(v >= 400 && v <= 800).toBe(true);
      seen.add(v);
    }
    expect(seen.size > 20).toBe(true);
  });

  it('survives silly input: attempt 0, huge attempt, out-of-range random', () => {
    expect(backoffDelay(0, { baseMs: 100, random: () => 1 })).toBe(100);
    expect(Number.isFinite(backoffDelay(10_000, { baseMs: 100, maxMs: 5000, random: () => 2 }))).toBe(true);
    expect(backoffDelay(10_000, { baseMs: 100, maxMs: 5000, random: () => 2 })).toBe(5000);
  });
});
