#!/usr/bin/env node
/**
 * Builds docs/index.html from docs/guide/*.md.
 *
 *   node scripts/build-docs.mjs
 *
 * The Markdown converter below is deliberately small and self-written (no network for a package here):
 * headings, paragraphs, lists, tables, fenced code, quotes, inline code/bold/italic/links. If the guides
 * ever need more, replace `mdToHtml` with `marked` - nothing else here depends on it.
 *
 * Links: `[text](other.md#part)` between guides become in-page anchors; links to any other Markdown file of the repository
 * (CHANGELOG, roadmap, audit findings, the READMEs ...) make that file a page of its own under docs/pages/, and a `code span`
 * that is exactly the path of an existing .md file turns into the same link. Links to other repository files point to GitHub.
 *
 * The version in the header is read from packages/core/package.json, the single version source.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(path.join(root, 'packages/core/package.json'), 'utf8')).version;

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const slug = (s) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');

const REPO_URL = (() => {
  try { return JSON.parse(readFileSync(path.join(root, 'packages/core/package.json'), 'utf8')).repository.url.replace(/^git\+/, '').replace(/\.git$/, ''); } catch { return ''; }
})();
import { updateDependencyGuide } from './deps-table.mjs';
updateDependencyGuide(); // the dependency tables come from the package.json files
const guideDir = path.join(root, 'docs/guide');
const guideIds = new Map(readdirSync(guideDir).filter((f) => /^\d+-.*\.md$/.test(f)).map((f) => [path.join(guideDir, f), f.replace(/^\d+-/, '').replace(/\.md$/, '')]));
/** Markdown files other than the guides that got a page of their own: absolute path -> page name. */
const pages = new Map();
const pageQueue = [];
const rel = (abs) => path.relative(root, abs).split(path.sep).join('/');
function pageName(abs) {
  const r = rel(abs).replace(/\.md$/i, '');
  const base = r.split('/').pop().toLowerCase();
  const plain = base === 'readme' ? r.toLowerCase().replace(/[^a-z0-9]+/g, '-') : base.replace(/[^a-z0-9]+/g, '-');
  const taken = [...pages.values()];
  let name = plain;
  if (taken.includes(name) && pages.get(abs) !== name) name = r.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return name.replace(/^-|-$/g, '') || 'page';
}
function registerPage(abs) {
  if (!pages.has(abs)) { pages.set(abs, pageName(abs)); pageQueue.push(abs); }
  return pages.get(abs);
}

/**
 * Where a link written in `fromFile` goes. `where` is 'index' (docs/index.html) or 'page' (docs/pages/*.html).
 * External and in-page links stay as they are.
 */
function resolveLink(href, fromFile, where) {
  if (href.startsWith('#') && href.length > 1) {
    // an anchor inside the same document: headings of a guide carry the guide's id as a prefix
    const own = guideIds.get(fromFile);
    return `#${own ? `${own}-` : ''}${slug(decodeURIComponent(href.slice(1)))}`;
  }
  if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) return href;
  const [pathPart, fragRaw] = href.split('#');
  const frag = fragRaw ? decodeURIComponent(fragRaw) : '';
  const abs = path.resolve(path.dirname(fromFile), decodeURIComponent(pathPart));
  if (!abs.startsWith(root + path.sep) || !existsSync(abs)) return href;
  if (/\.md$/i.test(abs)) {
    if (guideIds.has(abs)) {
      const id = guideIds.get(abs);
      return `${where === 'page' ? '../index.html' : ''}#${id}${frag ? `-${slug(frag)}` : ''}`;
    }
    const name = registerPage(abs);
    return `${where === 'page' ? '' : 'pages/'}${name}.html${frag ? `#${slug(frag)}` : ''}`;
  }
  return REPO_URL ? `${REPO_URL}/blob/main/${rel(abs)}` : href;
}

/** A code span that is exactly the path of an existing .md file of the repository (from the root). */
function mdPathOfCode(code) {
  if (!/^[\w./-]+\.md$/.test(code)) return null;
  const abs = path.resolve(root, code);
  return abs.startsWith(root + path.sep) && existsSync(abs) ? abs : null;
}

function inline(text, ctx = { file: path.join(root, 'README.md'), where: 'index' }) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => {
    const target = mdPathOfCode(c);
    let html = `<code>${esc(c)}</code>`;
    if (target) {
      const guide = guideIds.get(target);
      const href = guide ? `${ctx.where === 'page' ? '../index.html' : ''}#${guide}` : `${ctx.where === 'page' ? '' : 'pages/'}${registerPage(target)}.html`;
      html = `<a href="${href}">${html}</a>`;
    }
    codes.push(html);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${resolveLink(u, ctx.file, ctx.where)}">${t}</a>`);
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}

const splitRow = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

export function mdToHtml(md, prefix = '', shift = 0, ctx = { file: path.join(root, 'README.md'), where: 'index' }) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code${lang ? ` class="lang-${esc(lang)}"` : ''}>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const n = Math.min(6, h[1].length + shift);
      out.push(`<h${n} id="${prefix}${slug(h[2])}">${inline(h[2], ctx)}</h${n}>`);
      i++;
      continue;
    }
    if (/^\|/.test(line) && /^\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(splitRow(lines[i++]));
      out.push(`<div class="tbl"><table><thead><tr>${head.map((c) => `<th>${inline(c, ctx)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, ctx)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${inline(buf.join(' '), ctx)}</blockquote>`);
      continue;
    }
    const li = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const items = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (m) { items.push(m[3]); i++; }
        else if (/^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1] += ` ${lines[i].trim()}`; i++; }
        else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((t) => `<li>${inline(t, ctx)}</li>`).join('')}</${tag}>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    if (ctx.rawHtml && /^\s*</.test(line)) {
      // a block of the repository's own HTML (the README header): passed through as it is
      const raw = [];
      while (i < lines.length && lines[i].trim()) raw.push(lines[i++]);
      // relative image paths of the repository's HTML must lead from docs/pages/ back to the file
      out.push(raw.join('\n').replace(/\ssrc="([^"]+)"/g, (m, u) => (/^([a-z][a-z0-9+.-]*:|\/\/|#|data:)/i.test(u) ? m : ` src="${path.relative(path.join(root, 'docs/pages'), path.resolve(path.dirname(ctx.file), u)).split(path.sep).join('/')}"`)));
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\||>|\s*([-*]|\d+\.)\s)/.test(lines[i])) buf.push(lines[i++]);
    if (!buf.length) { buf.push(lines[i++]); }
    out.push(`<p>${inline(buf.join(' '), ctx)}</p>`);
  }
  return out.join('\n');
}

const files = readdirSync(guideDir).filter((f) => /^\d+-.*\.md$/.test(f)).sort();
const sections = files.map((f) => {
  const md = readFileSync(path.join(guideDir, f), 'utf8');
  const title = /^#\s+(.*)$/m.exec(md)?.[1] ?? f;
  const id = f.replace(/^\d+-/, '').replace(/\.md$/, '');
  const body = mdToHtml(md.replace(/^#\s+.*\n/, ''), `${id}-`, 1, { file: path.join(guideDir, f), where: 'index' });
  return { id, title, body };
});

const logoPath = path.join(root, 'examples/workshop/assets/brand/logo.svg');
const logo = existsSync(logoPath) ? readFileSync(logoPath, 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim() : '';
const shield = (label, msg, color) => `<img alt="${label}" src="https://img.shields.io/badge/${encodeURIComponent(label).replace(/-/g, '--')}-${encodeURIComponent(msg).replace(/-/g, '--')}-${color}?style=flat-square">`;
const skills = 'nodejs,express,sqlite,docker,vitest';

const CSS = `:root{--bg:#0d0f12;--bg1:#15181d;--bg2:#1e2228;--fg:#c9ccd2;--dim:#8a8f99;--accent:#f0975c;--line:rgba(217,123,63,.22);--mono:ui-monospace,Consolas,monospace;--ui:system-ui,'Segoe UI',sans-serif}
@media (prefers-color-scheme:light){:root{--bg:#f4f1ec;--bg1:#eae5da;--bg2:#ddd5c4;--fg:#201d18;--dim:#6b6456;--accent:#a35420;--line:rgba(163,84,32,.28)}}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--fg);font:15.5px/1.7 var(--ui)}
a{color:var(--accent)}code,pre{font-family:var(--mono)}
header.top{display:flex;gap:18px;align-items:center;flex-wrap:wrap;padding:22px 32px;border-bottom:1px solid var(--line);background:var(--bg1)}
header.top .logo{width:56px;height:56px;flex:none}header.top .logo svg{width:100%;height:100%}
header.top h1{margin:0;font-size:24px;color:var(--accent)}header.top p{margin:2px 0 0;color:var(--dim);font-size:13px}
.badges{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;align-items:center}.badges img{height:20px}
.wrap{display:grid;grid-template-columns:250px 1fr;max-width:1240px;margin:0 auto}
nav.toc{position:sticky;top:0;align-self:start;height:100vh;overflow:auto;padding:24px 16px;border-right:1px solid var(--line)}
nav.toc a{display:block;padding:6px 10px;border-radius:4px;color:var(--dim);text-decoration:none;font-size:13px}
nav.toc a:hover{background:var(--bg2);color:var(--accent)}
main{padding:36px 48px 90px;min-width:0}
section{margin-bottom:64px;scroll-margin-top:16px}
section>h2{font-size:26px;color:var(--accent);border-bottom:1px solid var(--line);padding-bottom:10px;margin:0 0 16px}
section h3{font-size:19px;margin:30px 0 10px}section h4{font-size:16px;margin:22px 0 8px}
p,li{max-width:90ch}
code{background:var(--bg2);padding:1px 5px;border-radius:3px;font-size:.88em}
pre{background:var(--bg1);border:1px solid var(--line);border-radius:6px;padding:14px 16px;overflow:auto}pre code{background:none;padding:0}
.tbl{overflow-x:auto;margin:12px 0}table{border-collapse:collapse;font-size:14px;width:100%}
th,td{border:1px solid var(--line);padding:7px 10px;text-align:left;vertical-align:top}th{background:var(--bg2)}
blockquote{margin:12px 0;padding:8px 16px;border-left:3px solid var(--accent);background:var(--bg1)}
@media (max-width:820px){.wrap{grid-template-columns:1fr}nav.toc{position:static;height:auto;border:0}main{padding:24px 16px 60px}header.top{padding:16px}}
nav.toc .grp{margin:16px 10px 4px;color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.back{display:inline-block;margin:0 0 18px;font-size:13px}
main.page{max-width:960px;margin:0 auto}
main.page h1{color:var(--accent);font-size:28px}main.page h2{font-size:22px;margin:34px 0 10px;border-bottom:1px solid var(--line);padding-bottom:6px}main.page h3{font-size:18px;margin:26px 0 8px}main.page h4{font-size:15.5px}
`;

// Documents of the repository that always get a page (the guides link to them by path or by link).
const DOCS = [
  ['packages/core/CHANGELOG.md', 'История изменений'],
  ['docs/dependencies-target.md', 'Целевые зависимости'],
  ['docs/audit-findings.md', 'Находки аудита'],
  ['docs/doc-audit.md', 'Пробелы документации'],
  ['docs/spreadsheet-audit.md', 'Аудит: Excel и CSV'],
  ['docs/roadmap.md', 'Roadmap (исторический)'],
  ['templates/app/README.md', 'Шаблон приложения'],
  ['templates/README.md', 'Шаблоны'],
  ['examples/workshop/README.md', 'Workshop: README'],
  ['apps/README.md', 'Приложения платформы'],
  ['README.md', 'README репозитория'],
];
const docLinks = [];
for (const [relPath, title] of DOCS) {
  const abs = path.join(root, relPath);
  if (!existsSync(abs)) continue;
  docLinks.push({ name: registerPage(abs), title, abs });
}

const html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Документация — DAS-Forge ${version}</title>
<style>
${CSS}
</style>
</head>
<body>
<header class="top">
<div class="logo">${logo}</div>
<div>
<h1>DAS-Forge — документация</h1>
<p>Версия ядра <strong><!--core-version-->${version}<!--/core-version--></strong></p>
<div class="badges">
${shield('core', version, 'f0975c')}
${shield('node', '>=26', '5fa06a')}
${shield('express', '5', '444')}
${shield('zod', '4', '3068b7')}
<img alt="stack" src="https://skillicons.dev/icons?i=${skills}&perline=5" style="height:28px">
</div>
</div>
</header>
<div class="wrap">
<nav class="toc">
${sections.map((s) => `<a href="#${s.id}">${esc(s.title)}</a>`).join('\n')}
<div class="grp">Документы</div>
${docLinks.map((d) => `<a href="pages/${d.name}.html">${esc(d.title)}</a>`).join('\n')}
</nav>
<main>
${sections.map((s) => `<section id="${s.id}">\n<h2>${esc(s.title)}</h2>\n${s.body}\n</section>`).join('\n')}
</main>
</div>
</body>
</html>
`;
writeFileSync(path.join(root, 'docs/index.html'), html);

// Pages for the other Markdown files (links found while converting add more to the queue as they are rendered).
const pagesDir = path.join(root, 'docs/pages');
rmSync(pagesDir, { recursive: true, force: true });
mkdirSync(pagesDir, { recursive: true });
const titles = new Map(docLinks.map((d) => [d.abs, d.title]));
for (let n = 0; n < pageQueue.length; n++) {
  const abs = pageQueue[n];
  const md = readFileSync(abs, 'utf8');
  const heading = /^#\s+(.*)$/m.exec(md)?.[1];
  const title = titles.get(abs) ?? heading?.replace(/<[^>]+>/g, '') ?? rel(abs);
  const isReadme = /README\.md$/i.test(abs);
  const body = mdToHtml(md, '', 0, { file: abs, where: 'page', rawHtml: isReadme });
  const github = REPO_URL ? `<p class="back"><a href="${REPO_URL}/blob/main/${rel(abs)}">${esc(rel(abs))} на GitHub</a></p>` : '';
  writeFileSync(path.join(pagesDir, `${pages.get(abs)}.html`), `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} — DAS-Forge ${version}</title>
<style>
${CSS}
</style>
</head>
<body>
<header class="top">
<div class="logo">${logo}</div>
<div><h1>${esc(title)}</h1><p><a href="../index.html">← Документация DAS-Forge</a> · версия ядра ${version} · <code>${esc(rel(abs))}</code></p></div>
</header>
<main class="page">
${body}
${github}
</main>
</body>
</html>
`);
}
console.log(`docs/index.html: ${sections.length} sections, ${pageQueue.length} pages, version ${version}`);
