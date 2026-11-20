import { describe, it, expect } from 'vitest';
import { parseId } from '../src/util/parse-id.js';

describe('parseId', () => {
  it('accepts plain positive whole numbers, as text or number', () => {
    expect(parseId('1')).toBe(1);
    expect(parseId('42')).toBe(42);
    expect(parseId(7)).toBe(7);
  });
  it('refuses everything else', () => {
    for (const v of ['', ' ', '0', '-1', '1.5', '1e3', '0x10', 'Infinity', 'NaN', 'abc', '1 ', ' 1', '١٢', '1234567890123456', null, undefined, {}, [], ['1'], true, 0, -3, 1.5, NaN]) {
      expect(parseId(v)).toBe(null);
    }
  });
});
