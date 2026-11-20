import { describe, it, expect } from 'vitest';
import { requireObjectAccess, readPaging, requireAuth, requirePermission, markGuard, isGuard, findUnguardedRoutes, checkAccessMatrix, assertAccessMatrix } from '../src/http/index.js';

function run(mw, req) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; } };
    mw(req, res, (err) => resolve({ next: true, err, req }));
  });
}
const orders = new Map([[1, { id: 1, owner: 'alice' }], [2, { id: 2, owner: 'bob' }]]);
const guard = (extra = {}) => requireObjectAccess({ load: async (_r, id) => orders.get(id), allow: (u, o) => o.owner === u.name, ...extra });

describe('requireObjectAccess', () => {
  it('lets the owner in and hands over the loaded object', async () => {
    const r = await run(guard(), { user: { name: 'alice' }, params: { id: '1' } });
    expect(r.next).toBe(true);
    expect(r.req.object.id).toBe(1);
  });
  it('answers a foreign and a missing record identically, and reports why', async () => {
    const seen = [];
    const g = guard({ onDenied: (_r, i) => seen.push(i.reason) });
    const foreign = await run(g, { user: { name: 'alice' }, params: { id: '2' } });
    const missing = await run(g, { user: { name: 'alice' }, params: { id: '99' } });
    const junk = await run(g, { user: { name: 'alice' }, params: { id: '1e3' } });
    expect(foreign).toEqual(missing);
    expect(foreign.status).toBe(404);
    expect(junk.status).toBe(404);
    expect(seen).toEqual(['forbidden', 'not_found', 'invalid_id']);
  });
  it('asks for sign-in without a user; can answer 403; a failing hook changes nothing; errors go to next', async () => {
    expect((await run(guard(), { params: { id: '1' } })).status).toBe(401);
    expect((await run(guard({ status: 403 }), { user: { name: 'alice' }, params: { id: '2' } })).status).toBe(403);
    expect((await run(guard({ onDenied: () => { throw new Error('x'); } }), { user: { name: 'alice' }, params: { id: '2' } })).status).toBe(404);
    const boom = requireObjectAccess({ load: async () => { throw new Error('db down'); }, allow: () => true });
    expect((await run(boom, { user: { name: 'a' }, params: { id: '1' } })).err.message).toBe('db down');
  });
  it('does not accept a truthy non-boolean as permission, and checks its arguments', async () => {
    const g = guard({ allow: () => 'yes' });
    expect((await run(g, { user: { name: 'alice' }, params: { id: '1' } })).status).toBe(404);
    expect(() => requireObjectAccess({})).toThrow(/required/);
    expect(() => requireObjectAccess({ load() {}, allow() {}, status: 500 })).toThrow(/404 or 403/);
  });
});

describe('readPaging', () => {
  it('caps the page size and the offset', () => {
    expect(readPaging({ limit: '1000000' })).toEqual({ limit: 100, offset: 0 });
    expect(readPaging({ pageSize: '10', offset: '-5' })).toEqual({ limit: 10, offset: 0 });
    expect(readPaging({ limit: 'abc' }, { fallback: 7 })).toEqual({ limit: 7, offset: 0 });
    expect(readPaging(undefined).limit).toBe(25);
  });
});

describe('findUnguardedRoutes', () => {
  const route = (path, method, ...handlers) => ({ route: { path, methods: { [method]: true }, stack: handlers.map((h) => ({ handle: h, method })) } });
  it('marks the guards and finds the routes that have none', () => {
    expect(isGuard(requireAuth())).toBe(true);
    expect(isGuard(requirePermission('x'))).toBe(true);
    expect(isGuard(guard())).toBe(true);
    expect(isGuard(() => {})).toBe(false);
    const plain = () => {};
    const router = { stack: [
      route('/health', 'get', plain),
      route('/open', 'post', plain),
      route('/a', 'get', requirePermission('a'), plain),
      { handle: { stack: [route('/inner', 'get', plain)] }, path: '/api' },
      { handle: requireAuth() },
      route('/after', 'get', plain),
    ] };
    const found = findUnguardedRoutes({ router }, { allow: ['GET /health'] });
    expect(found).toEqual([{ method: 'POST', path: '/open' }, { method: 'GET', path: '/api/inner' }]);
    expect(() => findUnguardedRoutes({})).toThrow(/expected an Express/);
    const g = markGuard(() => {}, 'custom');
    expect(findUnguardedRoutes({ stack: [route('/c', 'get', g)] })).toEqual([]);
  });
});

describe('access matrix', () => {
  const routes = [{ method: 'GET', path: '/orders/1' }];
  const server = (leak) => async ({ as }) => ({ status: as === 'owner' ? 200 : as === 'other' ? (leak ? 200 : 404) : 401 });
  it('passes a correct app and names the leak of a broken one', async () => {
    expect(await checkAccessMatrix({ routes, request: server(false) })).toEqual({ ok: true, checked: 3, violations: [] });
    const bad = await checkAccessMatrix({ routes, request: server(true) });
    expect(bad.ok).toBe(false);
    expect(bad.violations[0]).toMatchObject({ as: 'other', status: 200, path: '/orders/1' });
    await expect(assertAccessMatrix({ routes, request: server(true) })).rejects.toThrow(/as other -> 200/);
    await expect(checkAccessMatrix({ routes: [], request: server(false) })).rejects.toThrow(/non-empty/);
  });
});
