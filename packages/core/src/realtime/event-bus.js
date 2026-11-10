/**
 * Transport-agnostic event bus. core/realtime's SSE transport (and any
 * future WebSocket transport, per §9 - not built now) both sit on top
 * of this same publish/subscribe surface, so app code never imports a
 * transport directly - it publishes to a channel and the bus fans out
 * to whichever transports are currently subscribed.
 *
 * Single-process only by design for now: no Redis/NATS backing. Fine
 * for the 4 apps' current single-instance deployment; if horizontal
 * scaling is ever needed, swap this module's internals for a
 * cross-process backend behind the same publish/subscribe signature -
 * callers wouldn't need to change.
 */
export function createEventBus() {
  /** @type {Map<string, Set<(event: object) => void>>} */
  const channels = new Map();

  function subscribe(channel, handler) {
    if (!channels.has(channel)) channels.set(channel, new Set());
    channels.get(channel).add(handler);
    return () => unsubscribe(channel, handler);
  }

  function unsubscribe(channel, handler) {
    const handlers = channels.get(channel);
    if (!handlers) return;
    handlers.delete(handler);
    if (handlers.size === 0) channels.delete(channel);
  }

  /**
   * @param {string} channel
   * @param {object} event - plain object, must be JSON-serializable
   *   (SSE transport sends it as `data: JSON.stringify(event)`)
   */
  function publish(channel, event) {
    const handlers = channels.get(channel);
    if (!handlers) return 0;
    for (const handler of handlers) {
      try {
        handler(event);
      } catch (err) {
        // one bad subscriber must not break delivery to the others or
        // crash the publisher - log and move on
        // eslint-disable-next-line no-console
        console.error(`[das-forge] realtime subscriber threw on channel "${channel}":`, err);
      }
    }
    return handlers.size;
  }

  function subscriberCount(channel) {
    return channels.get(channel)?.size ?? 0;
  }

  return { subscribe, unsubscribe, publish, subscriberCount };
}
