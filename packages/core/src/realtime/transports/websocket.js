/**
 * WebSocket transport — DELIBERATELY NOT IMPLEMENTED.
 *
 * Per §9 of the architecture document: "WebSocket не добавляем на
 * старте — только SSE-транспорт в core/realtime; WebSocket остаётся
 * местом расширения (transports/websocket.js), когда появится реальный
 * двунаправленный кейс (chat/collaborative editing), которого сейчас
 * ни у одного из 4 приложений нет."
 *
 * This file exists so the extension point is a real, findable place in
 * the codebase rather than a line in a doc nobody will remember to
 * check - when a genuine bidirectional use case shows up, implement a
 * createWebSocketHandler() here with the same event-bus-backed shape
 * as sse-transport.js's createSseHandler(), so app code migrating from
 * SSE to WebSocket (or supporting both) doesn't need a different mental
 * model, just a different transport plugged into the same bus.
 */
export function createWebSocketHandler() {
  throw new Error(
    'core/realtime WebSocket transport is not implemented yet (by design - see §9 of the ' +
      'architecture doc). Use createSseHandler() from sse-transport.js instead, unless you ' +
      'have a genuine bidirectional realtime requirement (e.g. chat, collaborative editing) ' +
      'that SSE cannot serve - in that case, implement this function here.'
  );
}
