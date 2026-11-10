/**
 * Dates in pages: the server writes `<time class="adm-time" datetime="ISO">27.10.2026 15:57:40 UTC</time>`
 * (readable without JavaScript, always UTC); `TIME_SCRIPT` rewrites the text into the browser's time zone,
 * in the page language's order (ru `27.10.2026 20:57:40`, en `2026-10-27 20:57:40`).
 * The exact UTC moment stays in the tooltip.
 */
const pad = (n) => String(n).padStart(2, '0');
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Parses an ISO string or SQLite `YYYY-MM-DD HH:MM:SS` (read as UTC) into a Date; null if it is not a date. */
export function parseUtc(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const s = String(value ?? '').trim();
  if (!s) return null;
  const naive = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(s);
  const d = new Date(naive ? `${s.replace(' ', 'T')}Z` : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The UTC fallback text in the language's order: ru `27.10.2026 15:57:40 UTC`, en `2026-10-27 15:57:40 UTC`. */
export function formatUtc(d, locale = 'ru') {
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  const date = locale === 'en'
    ? `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
    : `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
  return `${date} ${time} UTC`;
}

/** `<time>` markup for a stored date; an empty or unreadable value gives `empty` (escaped as is for unreadable ones). */
export function timeHtml(value, locale = 'ru', empty = '') {
  const d = parseUtc(value);
  if (!d) return value ? escapeHtml(value) : escapeHtml(empty);
  return `<time class="adm-time" datetime="${d.toISOString()}">${formatUtc(d, locale)}</time>`;
}

export const TIME_SCRIPT = `(function(){
var lang=(document.documentElement.lang||'ru').slice(0,2)==='en'?'sv-SE':'ru-RU';
var f;try{f=new Intl.DateTimeFormat(lang,{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'})}catch(e){return}
var els=document.querySelectorAll('time.adm-time[datetime]');
for(var i=0;i<els.length;i++){var el=els[i];var d=new Date(el.getAttribute('datetime'));if(isNaN(d.getTime()))continue;
el.title=el.textContent;el.textContent=f.format(d).replace(',','')}
})();`;
