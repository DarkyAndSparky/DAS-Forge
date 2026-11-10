import compression from 'compression';

/**
 * Response compression on top of the `compression` package.
 *
 * Two things the package does not know about this platform:
 *   - Server-Sent Events: `text/event-stream` counts as "compressible text",
 *     so by default the stream would be buffered by gzip and events would
 *     reach the browser in lumps (or not at all). SSE responses are never
 *     compressed.
 *   - Opt-out per response: a handler that already sends compressed bytes,
 *     or must not be compressed, sets `res.setHeader('X-No-Compression', '1')`.
 *
 * Mount it early (after requestId/accessLog, before routes). Compressing a
 * response that carries secrets next to attacker-controlled text (BREACH) is
 * a known trade-off of HTTP compression in general; the JSON/HTML this
 * platform serves puts the CSRF/session tokens in cookies and headers, not
 * in the compressed body.
 *
 * @param {object} [opts]
 * @param {number} [opts.threshold=1024] smallest body (bytes) worth compressing
 * @param {number} [opts.level] zlib level (default: zlib's)
 * @returns {import('express').RequestHandler}
 */
export function createCompression({ threshold = 1024, level } = {}) {
  return compression({
    threshold,
    ...(level === undefined ? {} : { level }),
    filter(req, res) {
      if (res.getHeader('X-No-Compression')) return false;
      const type = String(res.getHeader('Content-Type') ?? '').toLowerCase();
      if (type.startsWith('text/event-stream')) return false;
      if (String(req.headers?.accept ?? '').toLowerCase().includes('text/event-stream')) return false;
      return compression.filter(req, res);
    },
  });
}
