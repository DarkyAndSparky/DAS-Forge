/**
 * The standard shape for "what changed" in an audit entry (audit chapter 3, stage D):
 * `meta.changes = { <field>: { from, to } }`. Secrets are masked, long values clipped, and unchanged fields left out,
 * so the log shows exactly what moved and never a password or a token.
 */
const MASK = '••••';
const SECRET = /pass(word)?|secret|token|key|hash|salt|totp|recovery|cookie|authorization/i;

const show = (v) => {
  if (v === undefined) return null;
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'object') { try { return clip(JSON.stringify(v)); } catch { return '[object]'; } }
  return clip(String(v));
};
const clip = (s) => (s.length > 200 ? `${s.slice(0, 200)}…` : s);

/**
 * @param {object} before
 * @param {object} after
 * @param {{fields?: string[], secret?: string[]}} [opts] - `fields`: only these; `secret`: extra names to mask
 * @returns {Record<string, {from: any, to: any}>} only the fields whose value differs; `{}` when nothing changed
 */
export function diffChanges(before, after, { fields, secret = [] } = {}) {
  const b = before ?? {}; const a = after ?? {};
  const names = fields ?? [...new Set([...Object.keys(b), ...Object.keys(a)])];
  const out = {};
  for (const k of names) {
    const same = JSON.stringify(b[k] ?? null) === JSON.stringify(a[k] ?? null);
    if (same) continue;
    const hide = SECRET.test(k) || secret.includes(k);
    out[k] = hide ? { from: MASK, to: MASK } : { from: show(b[k]), to: show(a[k]) };
  }
  return out;
}
