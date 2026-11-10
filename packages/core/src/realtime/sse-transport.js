/**
 * SSE (Server-Sent Events) is the base realtime transport per the
 * architecture decision in §9: WebSocket is NOT added at launch, only
 * reserved as a later extension point (see transports/websocket.js).
 * SSE is one-directional (server→client) over plain HTTP, which covers
 * everything the 4 apps currently need (live status/notification
 * pushes) without the extra connection-upgrade complexity WebSocket
 * would add for no current benefit.
 */

/**
 * Creates an Express route handler that turns a request into a
 * long-lived SSE stream subscribed to one channel on the event bus.
 *
 * @param {object} opts
 * @param {import('./event-bus.js').createEventBus} opts.eventBus - an
 *   event bus instance (return value of createEventBus())
 * @param {(req) => string} opts.resolveChannel - picks which channel
 *   this connection subscribes to, e.g. `(req) => 'asset:' + req.params.id`
 *   or a fixed channel name for a broadcast-style stream. Takes req so
 *   per-user/per-resource channels are possible without a separate
 *   wrapper per route.
 * @param {number} [opts.heartbeatMs=15000] - interval for a comment-only
 *   keep-alive ping (`: heartbeat\n\n`), needed because many reverse
 *   proxies/load balancers silently kill an HTTP connection that's been
 *   idle for 30-60s - this resets that idle timer from the server side.
 * @param {(req) => object} [opts.initialEvent] - optional event sent
 *   immediately on connect (e.g. current state snapshot), before any
 *   live events, so the client doesn't have to wait for the next change
 *   to know where things currently stand.
 */
/** Every open SSE response, so shutdown can end them (audit C01): an open
 * stream keeps server.close() waiting forever. */
const openStreams = new Set();

/**
 * Ends every open SSE stream with a final `event: shutdown` so clients
 * can reconnect elsewhere instead of seeing a dropped connection.
 * Call it from registerGracefulShutdown's `onDrainStart`.
 * @returns {number} how many streams were closed
 */
export function closeAllSseStreams() {
  let n = 0;
  for (const res of [...openStreams]) {
    try {
      res.write('event: shutdown\ndata: {}\n\n');
      res.end();
    } catch {
      /* already gone */
    }
    n++;
  }
  openStreams.clear();
  return n;
}

export function createSseHandler({
  eventBus,
  resolveChannel,
  heartbeatMs = 15_000,
  initialEvent,
  maxClients = 1000,
  maxBufferedBytes = 1024 * 1024,
  authorize,
  reauthorize,
  reauthorizeMs = 60_000,
  maxClientsPerKey = 0,
  clientKey = (req) => String(req.user?.id ?? req.ip ?? 'anon'),
  getReplay,
}) {
  let clients = 0;
  let nextId = 1;
  const perKey = new Map();
  return async (req, res) => {
    // Cheap global cap (audit C06): every stream holds a socket + timer.
    if (clients >= maxClients) {
      res.status(503).set('Retry-After', '5').json({ error: 'TOO_MANY_STREAMS', fields: [] });
      return;
    }
    const channel = resolveChannel(req);

    // Channel authorization (audit C06): runs BEFORE headers go out so a
    // refusal is a real 403 and a throwing hook is a 500, never a hung stream.
    if (authorize) {
      let allowed = false;
      try {
        allowed = (await authorize(req, channel)) === true;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[das-forge] sse authorize threw:', err);
        res.status(500).json({ error: 'SSE_AUTHORIZE_FAILED', fields: [] });
        return;
      }
      if (!allowed) {
        res.status(403).json({ error: 'FORBIDDEN', fields: [] });
        return;
      }
      if (req.destroyed || res.destroyed) return;
    }

    // Per-user (or per-IP) cap so one account cannot exhaust the global pool.
    const key = clientKey(req);
    if (maxClientsPerKey > 0 && (perKey.get(key) ?? 0) >= maxClientsPerKey) {
      res.status(429).set('Retry-After', '5').json({ error: 'TOO_MANY_STREAMS', fields: [] });
      return;
    }
    if (clients >= maxClients) {
      res.status(503).set('Retry-After', '5').json({ error: 'TOO_MANY_STREAMS', fields: [] });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // CORS/proxying is the app's own concern via core/http - this
      // transport doesn't set Access-Control-* itself.
      'X-Accel-Buffering': 'no', // disable nginx response buffering for this stream
    });
    res.flushHeaders?.();

    clients++;
    perKey.set(key, (perKey.get(key) ?? 0) + 1);
    openStreams.add(res);
    let unsubscribe = () => {};
    let heartbeat = null;
    let recheck = null;
    let cleaned = false;

    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      clients--;
      const left = (perKey.get(key) ?? 1) - 1;
      if (left <= 0) perKey.delete(key);
      else perKey.set(key, left);
      openStreams.delete(res);
      if (heartbeat) clearInterval(heartbeat);
      if (recheck) clearInterval(recheck);
      unsubscribe();
    }

    /** Writes a frame; drops a client that stopped reading (backpressure) instead of buffering without bound. */
    function write(chunk) {
      if (res.writableEnded || res.destroyed) return;
      res.write(chunk);
      if (res.writableLength > maxBufferedBytes) {
        cleanup();
        res.destroy();
      }
    }

    function send(event) {
      const payload = typeof event === 'string' ? event : JSON.stringify(event);
      // `id:` lets EventSource send Last-Event-ID on reconnect (C06).
      write(`id: ${nextId++}\ndata: ${payload}\n\n`);
    }

    try {
      // Reconnect support: the app decides what a client that last saw
      // event N missed (it owns the history); core only delivers it.
      const lastId = req.headers?.['last-event-id'];
      if (getReplay && lastId !== undefined) {
        for (const missed of getReplay(req, String(lastId)) ?? []) send(missed); // synchronous on purpose: no gap before subscribe
      }
      if (initialEvent) {
        const snapshot = initialEvent(req);
        if (snapshot !== undefined) send(snapshot);
      }
    } catch (err) {
      // Headers are already out - end the stream instead of leaving it hanging.
      cleanup();
      res.end();
      // eslint-disable-next-line no-console
      console.error('[das-forge] sse initialEvent threw:', err);
      return;
    }

    unsubscribe = eventBus.subscribe(channel, send);
    heartbeat = setInterval(() => write(': heartbeat\n\n'), heartbeatMs);

    // A stream outlives the request that authorized it: a revoked session / disabled user / lost permission must
    // not keep receiving events (audit I10). `reauthorize(req, channel)` must re-read the truth (database), not req.user.
    if (reauthorize && reauthorizeMs > 0) {
      recheck = setInterval(async () => {
        let ok = false;
        try { ok = (await reauthorize(req, channel)) === true; } catch { ok = false; }
        if (ok || cleaned) return;
        try { res.write('event: unauthorized\ndata: {}\n\n'); } catch { /* gone */ }
        cleanup();
        res.end();
      }, reauthorizeMs);
      recheck.unref?.();
    }

    req.on('close', cleanup);
    res.on('close', cleanup);
  };
}
