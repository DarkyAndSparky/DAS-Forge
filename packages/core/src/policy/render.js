const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function safeUrl(u) {
  return /^(https?:\/\/|mailto:|\/(?!\/))[^\s"'<>\\]*$/i.test(u) ? u : null;
}

function inline(text) {
  let out = esc(text);
  out = out.replace(/\[([^\]]{1,200})\]\(([^)\s]{1,500})\)/g, (m, label, url) => {
    // url was HTML-escaped above (& -> &amp;), undo for the check only
    const raw = url.replace(/&amp;/g, '&');
    const ok = safeUrl(raw);
    if (!ok) return label;
    const external = /^https?:/i.test(ok);
    return `<a href="${esc(ok)}"${external ? ' rel="noopener noreferrer" target="_blank"' : ''}>${label}</a>`;
  });
  out = out.replace(/\*\*([^*]{1,200})\*\*/g, '<strong>$1</strong>').replace(/`([^`]{1,200})`/g, '<code>$1</code>');
  return out;
}

/**
 * Policy mini-markup -> safe HTML. Supported: `# `/`## `/`### ` headings, `- ` lists, blank-line paragraphs,
 * **bold**, `code`, [text](url) with http(s)/mailto/site-relative URLs only. Everything else is escaped:
 * raw HTML in a text never reaches the page.
 */
export function renderPolicyText(text, vars = {}) {
  const src = String(text ?? '').replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let list = null;
  let para = [];
  const flushPara = () => { if (para.length) { html.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const flushList = () => { if (list) { html.push(`<ul>${list.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>`); list = null; } };
  for (const line of lines) {
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { flushPara(); flushList(); html.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    const li = /^[-*]\s+(.*)$/.exec(line);
    if (li) { flushPara(); (list ??= []).push(li[1]); continue; }
    if (line.trim() === '') { flushPara(); flushList(); continue; }
    flushList();
    para.push(line.trim());
  }
  flushPara(); flushList();
  return html.join('\n');
}
