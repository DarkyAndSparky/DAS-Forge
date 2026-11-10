import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

import { createEventBus } from '../src/realtime/event-bus.js';
import { createSseHandler } from '../src/realtime/sse-transport.js';
import { createWebSocketHandler } from '../src/realtime/transports/websocket.js';

describe('createEventBus', () => {
  let bus;

  beforeEach(() => {
    bus = createEventBus();
  });

  it('delivers a published event to a subscriber on the same channel', () => {
    const handler = vi.fn();
    bus.subscribe('asset:1', handler);
    bus.publish('asset:1', { type: 'updated' });
    expect(handler).toHaveBeenCalledWith({ type: 'updated' });
  });

  it('does not deliver to a different channel', () => {
    const handler = vi.fn();
    bus.subscribe('asset:1', handler);
    bus.publish('asset:2', { type: 'updated' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('supports multiple subscribers on one channel', () => {
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe('chan', a);
    bus.subscribe('chan', b);
    bus.publish('chan', { x: 1 });
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it('unsubscribe (via returned fn) stops delivery', () => {
    const handler = vi.fn();
    const unsubscribe = bus.subscribe('chan', handler);
    unsubscribe();
    bus.publish('chan', {});
    expect(handler).not.toHaveBeenCalled();
  });

  it('publish returns the subscriber count and 0 for an unknown channel', () => {
    bus.subscribe('chan', () => {});
    bus.subscribe('chan', () => {});
    expect(bus.publish('chan', {})).toBe(2);
    expect(bus.publish('nobody-listening', {})).toBe(0);
  });

  it('one throwing subscriber does not prevent delivery to others', () => {
    const good = vi.fn();
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    bus.subscribe('chan', bad);
    bus.subscribe('chan', good);
    expect(() => bus.publish('chan', {})).not.toThrow();
    expect(good).toHaveBeenCalledOnce();
  });

  it('subscriberCount reflects current subscriptions', () => {
    expect(bus.subscriberCount('chan')).toBe(0);
    const unsub = bus.subscribe('chan', () => {});
    expect(bus.subscriberCount('chan')).toBe(1);
    unsub();
    expect(bus.subscriberCount('chan')).toBe(0);
  });
});

/** Minimal fake Express req/res for SSE testing, without pulling in Express. */
function fakeReqRes() {
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.writtenHeaders = null;
  res.chunks = [];
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    res.writtenHeaders = headers;
  };
  res.write = (chunk) => res.chunks.push(chunk);
  res.flushHeaders = () => {};
  return { req, res };
}

describe('createSseHandler', () => {
  it('writes SSE headers and subscribes to the resolved channel', () => {
    const bus = createEventBus();
    const handler = createSseHandler({ eventBus: bus, resolveChannel: () => 'asset:1' });
    const { req, res } = fakeReqRes();

    handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.writtenHeaders['Content-Type']).toBe('text/event-stream');
    expect(bus.subscriberCount('asset:1')).toBe(1);
  });

  it('forwards published events as data: frames', () => {
    const bus = createEventBus();
    const handler = createSseHandler({ eventBus: bus, resolveChannel: () => 'chan' });
    const { req, res } = fakeReqRes();
    handler(req, res);

    bus.publish('chan', { type: 'ping' });

    expect(res.chunks.some((c) => c.includes('data: ') && c.includes('"type":"ping"'))).toBe(true);
  });

  it('sends an initial snapshot event before any live events', () => {
    const bus = createEventBus();
    const handler = createSseHandler({
      eventBus: bus,
      resolveChannel: () => 'chan',
      initialEvent: () => ({ snapshot: true }),
    });
    const { req, res } = fakeReqRes();
    handler(req, res);

    expect(res.chunks[0]).toContain('"snapshot":true');
  });

  it('unsubscribes and clears the heartbeat when the connection closes', () => {
    vi.useFakeTimers();
    const bus = createEventBus();
    const handler = createSseHandler({ eventBus: bus, resolveChannel: () => 'chan', heartbeatMs: 1000 });
    const { req, res } = fakeReqRes();
    handler(req, res);

    expect(bus.subscriberCount('chan')).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(res.chunks.some((c) => c.includes('heartbeat'))).toBe(true);

    req.emit('close');
    expect(bus.subscriberCount('chan')).toBe(0);

    const chunksBeforeMoreTime = res.chunks.length;
    vi.advanceTimersByTime(5000);
    expect(res.chunks.length).toBe(chunksBeforeMoreTime); // heartbeat stopped firing

    vi.useRealTimers();
  });

  it('does not deliver events published on a different channel', () => {
    const bus = createEventBus();
    const handler = createSseHandler({ eventBus: bus, resolveChannel: () => 'chan-a' });
    const { req, res } = fakeReqRes();
    handler(req, res);

    bus.publish('chan-b', { type: 'noise' });

    expect(res.chunks.some((c) => c.includes('noise'))).toBe(false);
  });
});

describe('createWebSocketHandler (extension point)', () => {
  it('throws a clear not-implemented-by-design error', () => {
    expect(() => createWebSocketHandler()).toThrow(/not implemented/i);
    expect(() => createWebSocketHandler()).toThrow(/§9/);
  });
});
