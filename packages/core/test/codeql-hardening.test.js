import { describe, it, expect } from 'vitest';
import { trimTrailingSlashes } from '../src/util/trim-slashes.js';
import { checkSvgShape } from '../src/files/svg-isolated.js';
import { randomCode, CODE_ALPHABET } from '../src/auth/recovery-codes.js';
import { generateTempPassword } from '../src/auth/user-admin.js';

describe('trimTrailingSlashes', () => {
  it('cuts only the end, and is fast on a long run', () => {
    expect(trimTrailingSlashes('https://a.b///')).toBe('https://a.b');
    expect(trimTrailingSlashes('/a/b')).toBe('/a/b');
    expect(trimTrailingSlashes('///')).toBe('');
    const t = Date.now();
    expect(trimTrailingSlashes(`x${'/'.repeat(200_000)}y`)).toHaveLength(200_002);
    expect(Date.now() - t).toBeLessThan(200);
  });
});
describe('checkSvgShape', () => {
  it('stays linear on an unclosed run of "<a"', () => {
    const t = Date.now();
    checkSvgShape('<a'.repeat(200_000));
    expect(Date.now() - t).toBeLessThan(500);
  });
  it('counts elements, attributes and depth as before', () => {
    expect(() => checkSvgShape('<svg><g><g><g></g></g></g></svg>', { maxDepth: 3 })).toThrow(/nested/);
    expect(() => checkSvgShape('<svg a="1" b="2" c="3"/>', { maxAttributes: 2 })).toThrow(/attributes/);
    expect(() => checkSvgShape('<a/><b/><c/>', { maxElements: 2 })).toThrow(/elements/);
    expect(() => checkSvgShape('<svg><path d="<x"/></svg>', { maxElements: 2 })).not.toThrow(); // "<" inside a value is not a tag
  });
});
describe('random characters', () => {
  it('draw only from their alphabets', () => {
    for (let i = 0; i < 200; i++) {
      expect(randomCode()).toMatch(new RegExp(`^[${CODE_ALPHABET}]{4}-[${CODE_ALPHABET}]{4}$`));
      expect(generateTempPassword(24)).toMatch(/^[A-HJ-NP-Za-km-z2-9]{24}$/);
    }
  });
});

import { readForm } from '../src/admin/sections.js';
describe('keys that reach the prototype', () => {
  it('are left out of a form body', async () => {
    const body = JSON.parse('{"__proto__":"x","constructor":"y","a":"1"}');
    const out = await readForm({ body });
    expect(Object.keys(out)).toEqual(['a']);
    expect(out.a).toBe('1');
  });
});
