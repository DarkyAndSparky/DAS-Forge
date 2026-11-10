/**
 * Paging for admin lists. Every long list shows one page with "back / forward" links, and an "Expand" button
 * that turns the list into one long scrollable list which loads the next pages on its own while you scroll.
 * Without JavaScript the links still work. The page's own table body carries `data-paged="<name>"`; the pager
 * carries `data-pager="<name>"` and `data-next` (the URL of the next page, empty on the last one). The script
 * fetches that URL, takes the rows of the same-named table body and appends them, so a list needs no extra
 * "rows only" route.
 */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const PAGING_TEXTS = {
  ru: { shown: 'Показано {n} из {total}', prev: 'Назад', next: 'Вперёд', expand: 'Развернуть', loading: 'Загрузка…', failed: 'Не удалось загрузить' },
  en: { shown: 'Showing {n} of {total}', prev: 'Back', next: 'Next', expand: 'Expand', loading: 'Loading…', failed: 'Could not load' },
};
export const PAGE_SIZE = 25;

/** `?<param>=N` as a 1-based page and the SQL offset for it. */
export function pageParams(req, param = 'page', size = PAGE_SIZE) {
  const n = Math.trunc(Number(req.query?.[param]));
  const page = Number.isFinite(n) && n >= 1 && n <= 100000 ? n : 1;
  return { page, size, offset: (page - 1) * size };
}

/** The same page with `param` set to `value` (undefined removes it); other query values are kept. */
export function pageUrl(path, query, param, value) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (k !== param && typeof v === 'string' && v !== '') q.set(k, v);
  if (value !== undefined && value !== null) q.set(param, String(value));
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

/**
 * @param {object} o
 * @param {string} o.name - list name (matches `<tbody data-paged="name">`)
 * @param {number} o.shown - rows on this page together with the earlier ones
 * @param {number} o.total
 * @param {string} [o.prevUrl]
 * @param {string} [o.nextUrl]
 * @param {'ru'|'en'} [o.locale]
 * @param {string} [o.nonce] - CSP nonce for the script
 * @param {boolean} [o.withScript=true] - set false on every pager of a page except the first
 */
export function pagerHtml({ name, shown, total, prevUrl, nextUrl, locale = 'ru', nonce, withScript = true }) {
  const t = PAGING_TEXTS[locale] ?? PAGING_TEXTS.ru;
  const status = t.shown.replace('{n}', String(shown)).replace('{total}', String(total));
  const nav = prevUrl || nextUrl
    ? `<span class="adm-pager-nav">${prevUrl ? `<a class="adm-btn" rel="prev" href="${esc(prevUrl)}">${esc(t.prev)}</a> ` : ''}${nextUrl ? `<a class="adm-btn" rel="next" href="${esc(nextUrl)}">${esc(t.next)}</a>` : ''}</span> `
    : '';
  const expand = nextUrl ? `<button type="button" class="adm-btn" data-expand="${esc(name)}" hidden>${esc(t.expand)}</button>` : '';
  const tpl = `data-tpl="${esc(t.shown)}" data-total="${esc(total)}" data-loading="${esc(t.loading)}" data-failed="${esc(t.failed)}"`;
  return `<div class="adm-pager" data-pager="${esc(name)}" data-next="${esc(nextUrl ?? '')}" ${tpl} style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-top:.75rem"><span class="adm-muted adm-pager-status">${esc(status)}</span>${nav}${expand}</div>${withScript ? script(nonce) : ''}`;
}

function script(nonce) {
  const body = `(function(){if(window.__admPager)return;window.__admPager=1;
function unhide(){document.querySelectorAll('[data-expand]').forEach(function(b){b.hidden=false})}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',unhide);else unhide();
function rowsOf(tb){return Array.prototype.filter.call(tb.children,function(tr){return !tr.querySelector('.adm-empty')}).length}
document.addEventListener('click',function(e){
var b=e.target.closest&&e.target.closest('[data-expand]');if(!b)return;
var name=b.getAttribute('data-expand'),pager=b.closest('.adm-pager'),tb=document.querySelector('tbody[data-paged="'+name+'"]');
if(!pager||!tb||!window.IntersectionObserver||!window.fetch)return;
var nav=pager.querySelector('.adm-pager-nav'),status=pager.querySelector('.adm-pager-status');
if(nav)nav.hidden=true;b.hidden=true;
var next=pager.getAttribute('data-next'),busy=false,sentinel=document.createElement('div');pager.appendChild(sentinel);
function show(){status.textContent=pager.dataset.tpl.replace('{n}',rowsOf(tb)).replace('{total}',pager.dataset.total)}
function load(){if(busy||!next)return;busy=true;status.textContent=pager.dataset.loading;
fetch(next,{credentials:'same-origin'}).then(function(r){if(!r.ok)throw 0;return r.text()}).then(function(t){
var d=new DOMParser().parseFromString(t,'text/html'),nb=d.querySelector('tbody[data-paged="'+name+'"]'),np=d.querySelector('.adm-pager[data-pager="'+name+'"]');
if(nb)Array.prototype.slice.call(nb.children).forEach(function(tr){if(!tr.querySelector('.adm-empty'))tb.appendChild(document.importNode(tr,true))});
next=np?np.getAttribute('data-next'):'';busy=false;show();
if(!next){io.disconnect();sentinel.remove()}else if(sentinel.getBoundingClientRect().top<innerHeight+400)load()
}).catch(function(){busy=false;status.textContent=pager.dataset.failed;io.disconnect();if(nav)nav.hidden=false})}
var io=new IntersectionObserver(function(en){if(en[0].isIntersecting)load()},{rootMargin:'400px'});
io.observe(sentinel);show();load()})})();`;
  return `<script${nonce ? ` nonce="${esc(nonce)}"` : ''}>${body}</script>`;
}

/** The pager of one list page: works out the links from the page number, the rows shown and the total. */
export function pagerFor({ req, res, path, name, param = 'page', page, size, count, total, locale, withScript = true }) {
  const shown = (page - 1) * size + count;
  return pagerHtml({
    name, shown, total, locale, withScript, nonce: res?.locals?.cspNonce,
    prevUrl: page > 1 ? pageUrl(path, req.query, param, page > 2 ? page - 1 : undefined) : '',
    nextUrl: shown < total ? pageUrl(path, req.query, param, page + 1) : '',
  });
}
