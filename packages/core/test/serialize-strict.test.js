import { describe, it, expect } from 'vitest';
import { serialize, findUnmappedFields } from '../src/http/serialize.js';

describe('serialize strict (allowlist) mode (audit A19)', () => {
  const row = { id: 1, name: 'x', cost: 9, secretNote: 's' };
  const map = { id: true, name: true, cost: 'read:finance' };

  it('drops fields that are not listed, whoever the viewer is', () => {
    expect(serialize(row, { viewerPermissions: ['read:finance'], fieldPermissions: map, strict: true })).toEqual({ id: 1, name: 'x', cost: 9 });
  });

  it('still gates listed fields by permission', () => {
    expect(serialize(row, { viewerPermissions: [], fieldPermissions: map, strict: true })).toEqual({ id: 1, name: 'x' });
  });

  it('works on arrays and keeps the default mode unchanged', () => {
    expect(serialize([row, row], { viewerPermissions: [], fieldPermissions: map, strict: true })).toEqual([{ id: 1, name: 'x' }, { id: 1, name: 'x' }]);
    expect(serialize(row, { viewerPermissions: [], fieldPermissions: map })).toEqual({ id: 1, name: 'x', secretNote: 's' });
  });

  it('`true` means public in the default mode too; an empty value counts as unlisted', () => {
    expect(serialize(row, { viewerPermissions: [], fieldPermissions: { cost: 'read:finance', secretNote: true } }).secretNote).toBe('s');
    expect(serialize({ a: 1 }, { viewerPermissions: [], fieldPermissions: { a: '' }, strict: true })).toEqual({});
    expect(serialize({ a: 1 }, { viewerPermissions: [], fieldPermissions: { a: false }, strict: true })).toEqual({});
  });

  it('Object.prototype names are data, not permission entries; __proto__ stays a plain key', () => {
    const out = serialize({ constructor: 'c', toString: 't', hasOwnProperty: 'h' }, { viewerPermissions: [], fieldPermissions: {} });
    expect(out.constructor).toBe('c');
    expect(Object.keys(out).sort()).toEqual(['constructor', 'hasOwnProperty', 'toString']);
    const evil = JSON.parse('{"__proto__": {"admin": true}, "id": 1}');
    const cleaned = serialize(evil, { viewerPermissions: [], fieldPermissions: { id: true, __proto__: true }, strict: true });
    expect(Object.getPrototypeOf(cleaned)).toBe(Object.prototype);
    expect(cleaned.admin).toBeUndefined();
  });

  it('findUnmappedFields lists what the map does not cover (for a coverage test)', () => {
    expect(findUnmappedFields(row, map)).toEqual(['secretNote']);
    expect(findUnmappedFields([{ a: 1 }, { b: 2, id: 1 }], { id: true })).toEqual(['a', 'b']);
    expect(findUnmappedFields(null, map)).toEqual([]);
    expect(findUnmappedFields({ id: 1 }, { id: '' })).toEqual(['id']);
  });
});
