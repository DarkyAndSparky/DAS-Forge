import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createSseHandler, closeAllSseStreams } from '../src/realtime/sse-transport.js';
import { createEventBus } from '../src/realtime/event-bus.js';

function mk(user, headers = {}) {
  const req = new EventEmitter();
  req.user = user ? { id: user } : undefined;
  req.headers = headers;
  const res = new EventEmitter();
  res.chunks = [];
  res.writeHead = (c) => { res.statusCode = c; res.opened = true; };
  res.write = (c) => res.chunks.push(c);
  res.flushHeaders = () => {};
  res.status = (c) => { res.statusCode = c; return res; };
  res.set = () => res;
  res.json = (b) => { res.body = b; return res; };
  return { req, res };
}

afterEach(() => closeAllSseStreams());

describe('SSE authorize / per-user limit / ids (C06)', () => {
  it('authorize=false -> 403 and no stream; true -> stream; throw -> 500', async () => {
    const bus = createEventBus();
    const base = { eventBus: bus, resolveChannel: () => 'c', heartbeatMs: 60_000 };
    const deny = mk(1);
    await createSseHandler({ ...base, authorize: async () => false })(deny.req, deny.res);
    expect(deny.res.statusCode).toBe(403);
    expect(deny.res.opened).toBeUndefined();
    expect(bus.subscriberCount('c')).toBe(0);

    const ok = mk(1);
    await createSseHandler({ ...base, authorize: (req, ch) => ch === 'c' })(ok.req, ok.res);
    expect(ok.res.opened).toBe(true);
    expect(bus.subscriberCount('c')).toBe(1);

    const boom = mk(1);
    await createSseHandler({ ...base, authorize: () => { throw new Error('x'); } })(boom.req, boom.res);
    expect(boom.res.statusCode).toBe(500);
  });

  it('maxClientsPerKey limits one user with 429 and frees the slot on close', async () => {
    const bus = createEventBus();
    const h = createSseHandler({ eventBus: bus, resolveChannel: () => 'c', heartbeatMs: 60_000, maxClientsPerKey: 1 });
    const a = mk(7); await h(a.req, a.res);
    const b = mk(7); await h(b.req, b.res);
    expect(b.res.statusCode).toBe(429);
    const other = mk(8); await h(other.req, other.res);
    expect(other.res.opened).toBe(true);
    a.res.emit('close');
    const c = mk(7); await h(c.req, c.res);
    expect(c.res.opened).toBe(true);
  });

  it('events carry increasing ids; Last-Event-ID triggers getReplay', async () => {
    const bus = createEventBus();
    const seen = [];
    const h = createSseHandler({
      eventBus: bus, resolveChannel: () => 'c', heartbeatMs: 60_000,
      getReplay: (req, last) => { seen.push(last); return [{ missed: 1 }]; },
    });
    const { req, res } = mk(1, { 'last-event-id': '41' });
    await h(req, res);
    bus.publish('c', { live: true });
    expect(seen).toEqual(['41']);
    expect(res.chunks[0]).toBe('id: 1\ndata: {"missed":1}\n\n');
    expect(res.chunks[1]).toBe('id: 2\ndata: {"live":true}\n\n');
  });
});
