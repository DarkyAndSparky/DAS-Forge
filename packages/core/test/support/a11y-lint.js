/**
 * Small structural accessibility check for server-rendered HTML (a subset of what axe-core finds; no dependency).
 * It looks only at the markup: contrast, focus order and screen-reader behaviour still need a manual check.
 * Returns a list of problems, empty when none were found.
 */
const attrsOf = (tag) => {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return out;
};
const textOf = (html) => html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

export function a11yIssues(html, { page = true } = {}) {
  const issues = [];
  const src = String(html);
  if (page) {
    if (!/<html[^>]*\blang\s*=\s*["']?[a-z]{2}/i.test(src)) issues.push('html: no lang attribute');
    if (!/<title[^>]*>\s*[^<\s][^<]*<\/title>/i.test(src)) issues.push('head: empty or missing title');
    const h1 = (src.match(/<h1[\s>]/gi) ?? []).length;
    if (h1 !== 1) issues.push(`headings: ${h1} h1 elements (expected 1)`);
  }
  let prev = 0;
  for (const m of src.matchAll(/<h([1-6])[\s>]/gi)) {
    const lvl = Number(m[1]);
    if (prev && lvl > prev + 1) issues.push(`headings: h${prev} followed by h${lvl}`);
    prev = lvl;
  }
  if (/<meta[^>]+name=["']viewport["'][^>]*(user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b)/i.test(src)) issues.push('viewport: zoom is disabled');
  for (const m of src.matchAll(/<img\b[^>]*>/gi)) if (!('alt' in attrsOf(m[0]))) issues.push(`img: no alt (${m[0].slice(0, 60)})`);
  const ids = [...src.matchAll(/<[a-z][^>]*\sid\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  for (const id of new Set(ids.filter((v, i) => ids.indexOf(v) !== i))) issues.push(`id: duplicate "${id}"`);
  const labelFor = new Set([...src.matchAll(/<label\b[^>]*\sfor\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]));
  const wrapped = [...src.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/gi)].map((m) => m[1]).join('\n');
  for (const m of src.matchAll(/<(input|textarea|select)\b[^>]*>/gi)) {
    const a = attrsOf(m[0]);
    if (m[1].toLowerCase() === 'input' && ['hidden', 'submit', 'button', 'reset', 'image'].includes((a.type ?? 'text').toLowerCase())) continue;
    const named = a['aria-label'] || a['aria-labelledby'] || a.title || (a.id && labelFor.has(a.id)) || wrapped.includes(m[0]);
    if (!named) issues.push(`${m[1]}: no label (${m[0].slice(0, 60)})`);
  }
  for (const m of src.matchAll(/<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const a = attrsOf(m[2]);
    if (m[1].toLowerCase() === 'a' && !('href' in a)) continue;
    const inner = m[3];
    const named = textOf(inner) || a['aria-label'] || a['aria-labelledby'] || a.title || /<img\b[^>]*\salt\s*=\s*["'][^"']+["']/i.test(inner);
    if (!named) issues.push(`${m[1]}: no accessible name (${m[0].slice(0, 60)})`);
  }
  return issues;
}
