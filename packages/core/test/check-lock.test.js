import { describe, it, expect } from 'vitest';
import { satisfies } from '../../../scripts/check-lock.mjs';

describe('lock check: version ranges', () => {
  it('caret', () => {
    expect(satisfies('4.6.5', '^4.6.0')).toBe(true);
    expect(satisfies('5.0.0', '^4.6.0')).toBe(false);
    expect(satisfies('4.5.9', '^4.6.0')).toBe(false);
    expect(satisfies('0.45.1', '^0.45.0')).toBe(true);
    expect(satisfies('0.46.0', '^0.45.0')).toBe(false);
    expect(satisfies('0.0.3', '^0.0.3')).toBe(true);
    expect(satisfies('0.0.4', '^0.0.3')).toBe(false);
  });
  it('tilde, exact, comparators, x-ranges and ||', () => {
    expect(satisfies('1.2.9', '~1.2.3')).toBe(true);
    expect(satisfies('1.3.0', '~1.2.3')).toBe(false);
    expect(satisfies('2.0.1', '2.0.1')).toBe(true);
    expect(satisfies('2.0.2', '2.0.1')).toBe(false);
    expect(satisfies('3.1.0', '>=3 <4')).toBe(true);
    expect(satisfies('4.0.0', '>=3 <4')).toBe(false);
    expect(satisfies('1.9.0', '1.x')).toBe(true);
    expect(satisfies('2.0.0', '1.x')).toBe(false);
    expect(satisfies('5.2.1', '^4 || ^5')).toBe(true);
    expect(satisfies('6.0.0', '^4 || ^5')).toBe(false);
  });
  it('does not pass judgement on what it does not understand', () => {
    expect(satisfies('1.0.0', 'latest')).toBe(true);
    expect(satisfies('1.0.0', 'github:user/repo')).toBe(true);
  });
});
