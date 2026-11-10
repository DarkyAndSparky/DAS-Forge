const MAX_BODY = 8 * 1024;
const cut = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : v == null ? null : String(v).slice(0, n));

/** Brings the two report shapes (legacy `report-uri` and the Reporting API) to one flat record, or null. */
export function normalizeCspReport(body) {
  const first = Array.isArray(body) ? body.find((r) => r && (r.type === 'csp-violation' || r.body)) : body;
  const r = first?.['csp-report'] ?? first?.body ?? null;
  if (!r || typeof r !== 'object') return null;
  return {
    directive: cut(r['effective-directive'] ?? r.effectiveDirective ?? r['violated-directive'] ?? r.violatedDirective),
    blocked: cut(r['blocked-uri'] ?? r.blockedURL ?? r.blockedUri),
    document: cut(r['document-uri'] ?? r.documentURL ?? r.documentUri),
    source: cut(r['source-file'] ?? r.sourceFile),
    line: Number.isInteger(r['line-number'] ?? r.lineNumber) ? (r['line-number'] ?? r.lineNumber) : null,
    disposition: cut(r.disposition, 20),
  };
}

function readBody(req) {
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) return Promise.resolve(req.body);
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
    req.on('error', () => resolve(null));
    req.on('end', () => {
      if (size > MAX_BODY) return resolve(null);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); }
    });
  });
}

/**
 * Receives Content-Security-Policy violation reports (`POST`, content type `application/csp-report` or
 * `application/reports+json`). Always answers 204 and never throws: a browser cannot be told off. To keep a noisy page from
 * flooding the log, the same directive plus blocked address is passed on once per `dedupeMs` and at most
 * `maxPerMinute` reports are passed on in total; the body is capped at 8 KB.
 *
 * @param {object} o
 * @param {(report: object, req: object) => void} o.onReport
 * @param {number} [o.maxPerMinute=60]
 * @param {number} [o.dedupeMs=3600000]
 * @param {() => number} [o.now]
 */
export function cspReports({ onReport, maxPerMinute = 60, dedupeMs = 60 * 60 * 1000, now = Date.now } = {}) {
  if (typeof onReport !== 'function') throw new TypeError('cspReports: onReport is required');
  const seen = new Map();
  let windowStart = 0;
  let inWindow = 0;
  return async (req, res) => {
    try {
      const report = normalizeCspReport(await readBody(req));
      const t = now();
      if (t - windowStart >= 60_000) { windowStart = t; inWindow = 0; }
      if (report && inWindow < maxPerMinute) {
        const key = `${report.directive}|${report.blocked}`;
        if (!(seen.get(key) > t - dedupeMs)) {
          if (seen.size > 500) seen.clear();
          seen.set(key, t);
          inWindow++;
          onReport(report, req);
        }
      }
    } catch { /* a failing sink must not fail the browser's request */ }
    res.status(204).end();
  };
}
