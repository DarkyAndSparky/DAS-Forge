import { describe, it, expect } from 'vitest';
import { moduleOf, countByModule, compareToBaseline } from '../../../scripts/typecheck-lib.mjs';

describe('typecheck ratchet (E3)', () => {
  it('groups files into modules, also with Windows separators', () => {
    expect(moduleOf('packages/core/src/auth/users.js')).toBe('packages/core/src/auth');
    expect(moduleOf('packages\\core\\src\\auth\\users.js')).toBe('packages/core/src/auth');
    expect(moduleOf('packages/core/src/index.js')).toBe('packages/core/src');
    expect(moduleOf('examples/workshop/src/routes.js')).toBe('examples/workshop');
  });
  it('counts every tsc remark per module', () => {
    const out = [
      "packages/core/src/auth/a.js(3,5): error TS7006: Parameter 'x' implicitly has an 'any' type.",
      "packages/core/src/auth/b.js(9,1): error TS2339: Property 'y' does not exist.",
      "packages/core/src/http/c.js(1,1): error TS2322: Type.",
      'some other line',
    ].join('\n');
    const r = countByModule(out);
    expect(r.total).toBe(3);
    expect(r.byModule).toEqual({ 'packages/core/src/auth': 2, 'packages/core/src/http': 1 });
  });
  it('a module that grew (or is new) is worse, a module that shrank is better', () => {
    const { worse, better } = compareToBaseline({ a: 5, b: 1, c: 2 }, { a: 4, b: 3 });
    expect(worse).toEqual([['a', 4, 5], ['c', 0, 2]]);
    expect(better).toEqual([['b', 3, 1]]);
  });
});
