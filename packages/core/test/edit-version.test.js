import { describe, it, expect } from 'vitest';
import { fingerprint, versionField, isStale } from '../src/admin/edit-version.js';

describe('edit-version (G-03)', () => {
  it('fingerprint ignores key order and treats undefined like null', () => {
    expect(fingerprint({ a: 1, b: { c: 2, d: undefined } })).toBe(fingerprint({ b: { d: null, c: 2 }, a: 1 }));
    expect(fingerprint({ a: 1 }) === fingerprint({ a: 2 })).toBe(false);
    expect(fingerprint([1, 2]) === fingerprint([2, 1])).toBe(false);
  });

  it('versionField renders a hidden _v input with the fingerprint', () => {
    const html = versionField({ x: 1 });
    expect(html).toContain('type="hidden"');
    expect(html).toContain('name="_v"');
    expect(html).toContain(fingerprint({ x: 1 }));
  });

  it('isStale: only a form that carries a different fingerprint is stale', () => {
    const now = { x: 1 };
    expect(isStale({ _v: fingerprint(now) }, now)).toBe(false);
    expect(isStale({ _v: fingerprint({ x: 0 }) }, now)).toBe(true);
    expect(isStale({}, now)).toBe(false); // old page or script: not checked
    expect(isStale(undefined, now)).toBe(false);
  });
});
