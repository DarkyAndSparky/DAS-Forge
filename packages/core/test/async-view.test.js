import { describe, it, expect } from 'vitest';
import { asyncView } from '../src/util/async-view.js';

describe('asyncView', () => {
  it('uses the Async twin when there is one, the plain method otherwise, plain values as they are', async () => {
    const calls = [];
    const obj = {
      name: 'x',
      get() { calls.push('get'); return 1; },
      async getAsync() { calls.push('getAsync'); return 2; },
      only() { calls.push('only'); return 3; },
      list: ['a'],
    };
    const v = asyncView(obj);
    expect(await v.get()).toBe(2);
    expect(await v.only()).toBe(3);
    expect(v.name).toBe('x');
    expect(v.list).toEqual(['a']);
    expect(calls).toEqual(['getAsync', 'only']);
  });
  it('keeps this bound, leaves null alone, does not wrap twice', async () => {
    const obj = { n: 5, read() { return this.n; }, async readAsync() { return this.n + 1; } };
    const v = asyncView(obj);
    const { read } = v;
    expect(await read()).toBe(6);
    expect(asyncView(null)).toBeNull();
    expect(asyncView(undefined)).toBeUndefined();
    expect(asyncView(v)).toBe(v);
    expect(v?.read).toBeDefined();
  });
  it('an object with only synchronous methods behaves as before under await', async () => {
    const v = asyncView({ add: (a, b) => a + b });
    expect(await v.add(1, 2)).toBe(3);
  });
});
