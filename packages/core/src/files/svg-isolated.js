import { createWorkerPool } from './isolated-pool.js';
import { DEFAULT_SVG_MAX_BYTES } from './svg-sanitize.js';

/** Limits of an SVG's shape, checked in one cheap pass before any DOM is built. A real logo or icon is far below them. */
export const SVG_SHAPE_LIMITS = Object.freeze({ maxDepth: 64, maxElements: 5_000, maxAttributes: 10_000 });

const err = (code, message) => Object.assign(new Error(message), { code });

/**
 * One pass over the markup (no DOM): the deepest nesting, the number of elements and of attributes. The sanitizer's
 * time grows with these (audit S-01: 30 000 nested `<g>` took over a minute), so absurd shapes are refused here, in
 * linear time. The count is rough (comments and CDATA are not parsed): whatever slips through meets the worker's time limit.
 */
export function checkSvgShape(text, limits = SVG_SHAPE_LIMITS) {
  const { maxDepth, maxElements, maxAttributes } = { ...SVG_SHAPE_LIMITS, ...limits };
  let depth = 0; let elements = 0; let attributes = 0;
  // A scan with indexOf, not one big pattern: "<a<a<a..." with no ">" made the pattern rescan to the end from every "<" (quadratic).
  let end = -1;
  for (let at = text.indexOf('<'); at !== -1; at = text.indexOf('<', at + 1)) {
    if (end < at) { end = text.indexOf('>', at + 1); if (end === -1) break; }
    const m = /^(\/?)[A-Za-z][^\s>/]*/.exec(text.slice(at + 1, Math.min(end, at + 1 + 256)));
    if (!m) continue;
    const closing = m[1];
    const rest = text.slice(at + 1 + m[0].length, end);
    at = end; // the tag is consumed whole, as the pattern did
    if (closing === '/') { depth = Math.max(0, depth - 1); continue; }
    elements += 1;
    if (elements > maxElements) throw err('SVG_TOO_COMPLEX', `SVG has more than ${maxElements} elements`);
    if (rest) {
      attributes += (rest.match(/=/g)?.length ?? 0);
      if (attributes > maxAttributes) throw err('SVG_TOO_COMPLEX', `SVG has more than ${maxAttributes} attributes`);
    }
    if (!rest.endsWith('/')) {
      depth += 1;
      if (depth > maxDepth) throw err('SVG_TOO_COMPLEX', `SVG is nested deeper than ${maxDepth} levels`);
    }
  }
}

let pool = null;
const getPool = (o) => (pool ??= createWorkerPool({ workerUrl: new URL('./svg-worker.js', import.meta.url), size: o.size ?? 2, queueLimit: o.queueLimit ?? 16, timeoutMs: o.timeoutMs ?? 20_000, maxMemoryMb: o.maxMemoryMb ?? 256, warmup: {} }));

/**
 * `sanitizeSvg` for uploads: the size and shape are checked first, then the real sanitizer (DOMPurify over jsdom) runs
 * in a worker thread of a small shared pool, with a time and memory limit. A hostile SVG can stall that worker, never the
 * server. Errors carry a `code`: `SVG_TOO_LARGE`, `SVG_TOO_COMPLEX`, `POOL_TIMEOUT`, `POOL_BUSY`, `POOL_RESOURCE_LIMIT`,
 * `POOL_WORKER_FAILED`, or the sanitizer's own refusal (`SVG_REJECTED`).
 * The pool options (`size`, `queueLimit`, `timeoutMs`, `maxMemoryMb`) apply when the pool is first created.
 *
 * @param {string} svgString
 * @param {{maxBytes?: number, size?: number, queueLimit?: number, timeoutMs?: number, maxMemoryMb?: number}} [o]
 * @returns {Promise<string>}
 */
export async function sanitizeSvgIsolated(svgString, o = {}) {
  const text = String(svgString).replace(/^﻿/, '');
  const maxBytes = o.maxBytes ?? DEFAULT_SVG_MAX_BYTES;
  if (maxBytes > 0 && Buffer.byteLength(text, 'utf8') > maxBytes) throw err('SVG_TOO_LARGE', `SVG is larger than ${maxBytes} bytes`);
  if (/<!ENTITY/i.test(text)) throw err('SVG_REJECTED', 'SVG with entity declarations is not accepted');
  checkSvgShape(text);
  return getPool(o).run({ text, maxBytes });
}

/** Stops the SVG workers (a test, a graceful shutdown). The next call creates a new pool. */
export async function closeSvgPool() {
  const p = pool; pool = null;
  await p?.close();
}
