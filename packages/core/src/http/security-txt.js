/**
 * `GET /.well-known/security.txt` (RFC 9116): tells a researcher where to send a vulnerability report.
 * Public and unauthenticated by design. Nothing is served unless at least one `contact` is configured, so an
 * application never publishes a placeholder.
 *
 * @param {{contact?: string[], policy?: string, expires?: string, preferredLanguages?: string[], canonical?: string}} [cfg]
 * @param {{now?: () => number, path?: string}} [opts]
 */
export function securityTxt(cfg = {}, { now = Date.now, path = '/.well-known/security.txt' } = {}) {
  const contacts = (cfg.contact ?? []).map((c) => String(c).trim()).filter(Boolean)
    .map((c) => (/^(mailto:|https:\/\/|tel:)/i.test(c) ? c : c.includes('@') ? `mailto:${c}` : null))
    .filter(Boolean);
  const line = (k, v) => `${k}: ${String(v).replace(/[\r\n]+/g, ' ')}`;
  return (req, res, next) => {
    if (req.path !== path || (req.method !== 'GET' && req.method !== 'HEAD')) return next();
    if (contacts.length === 0) return next();
    const expires = cfg.expires ?? new Date(now() + 180 * 86_400_000).toISOString();
    const lines = [
      ...contacts.map((c) => line('Contact', c)),
      line('Expires', expires),
      ...(cfg.preferredLanguages?.length ? [line('Preferred-Languages', cfg.preferredLanguages.join(', '))] : []),
      ...(cfg.policy ? [line('Policy', cfg.policy)] : []),
      ...(cfg.canonical ? [line('Canonical', cfg.canonical)] : []),
    ];
    res.set('Cache-Control', 'public, max-age=3600');
    res.type('text/plain; charset=utf-8').send(`${lines.join('\n')}\n`);
  };
}
