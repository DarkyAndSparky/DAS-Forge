import { ensureSettingsTable } from '../branding/company-branding.js';
import { log } from '../audit/log.js';

const KEY = 'announcement';
const MESSAGE_MAX = 300;
export const LEVELS = Object.freeze(['info', 'warning', 'critical']);

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const OFF = Object.freeze({ enabled: false, message: null, level: 'info', until: null, id: null, updatedAt: null, updatedBy: null });

function readState(db) {
  ensureSettingsTable(db);
  const row = db.get(`SELECT value FROM app_settings WHERE key = ?`, [KEY]);
  if (!row) return { ...OFF };
  try {
    const v = JSON.parse(row.value);
    return {
      enabled: v.enabled === true && typeof v.message === 'string' && v.message !== '',
      message: typeof v.message === 'string' && v.message ? v.message : null,
      level: LEVELS.includes(v.level) ? v.level : 'info',
      until: typeof v.until === 'string' && !Number.isNaN(Date.parse(v.until)) ? v.until : null,
      id: typeof v.id === 'string' ? v.id : null,
      updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : null,
      updatedBy: typeof v.updatedBy === 'string' ? v.updatedBy : null,
    };
  } catch {
    return { ...OFF };
  }
}

/** Thrown for a bad input of `set()`; `code` is MESSAGE_REQUIRED, MESSAGE_TOO_LONG, LEVEL_INVALID or UNTIL_INVALID. */
export class AnnouncementError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'AnnouncementError';
    this.code = code;
  }
}

const CSS = `.adm-ann{display:flex;align-items:flex-start;gap:.75rem;padding:.6rem 1rem;border-bottom:1px solid var(--adm-border);background:var(--adm-surface);color:var(--adm-text);font-size:.9rem;border-left:4px solid var(--adm-accent)}
.adm-ann-warning{border-left-color:var(--adm-warn)}.adm-ann-critical{border-left-color:var(--adm-danger)}
.adm-ann-text{flex:1;min-width:0;overflow-wrap:anywhere}.adm-ann-until{color:var(--adm-text-dim);margin-left:.5rem}
.adm-ann-close{flex:none;border:0;background:transparent;color:var(--adm-text-dim);font-size:1.2rem;line-height:1;cursor:pointer;padding:0 .25rem}
.adm-ann-close:hover{color:var(--adm-text)}`;

/**
 * A one-line announcement shown at the top of the application's pages ("planned work tonight at 22:00").
 * One announcement at a time: text (at most 300 characters), a level (`info`, `warning`, `critical`) and an
 * optional end time after which it disappears by itself. `info` and `warning` can be dismissed by the reader
 * (remembered in their browser until the text changes); `critical` stays. The state lives in the database
 * (`app_settings`), so it survives a restart and is shared by every process; each process re-reads it at
 * most every `cacheMs`.
 *
 * @param {object} o
 * @param {object} o.db
 * @param {number} [o.cacheMs=2000]
 * @param {() => number} [o.now]
 */
export function createAnnouncement({ db, cacheMs = 2000, now = () => Date.now() } = {}) {
  if (!db) throw new TypeError('createAnnouncement: db is required');
  let cached = null;
  let cachedAt = 0;

  function get({ fresh = false } = {}) {
    const t = now();
    if (!fresh && cached && t - cachedAt < cacheMs) return cached;
    try { cached = readState(db); } catch { cached = cached ?? { ...OFF }; }
    cachedAt = t;
    return cached;
  }

  /** The announcement to show right now, or null (none, or its end time has passed). */
  function active() {
    const s = get();
    if (!s.enabled) return null;
    if (s.until && Date.parse(s.until) <= now()) return null;
    return s;
  }

  function set({ message, level = 'info', until = null, by = null } = {}) {
    const text = String(message ?? '').trim();
    if (!text) throw new AnnouncementError('MESSAGE_REQUIRED', 'message is required');
    if (text.length > MESSAGE_MAX) throw new AnnouncementError('MESSAGE_TOO_LONG', `message must be at most ${MESSAGE_MAX} characters`);
    if (!LEVELS.includes(level)) throw new AnnouncementError('LEVEL_INVALID', `level must be one of ${LEVELS.join(', ')}`);
    let end = null;
    if (until !== null && until !== undefined && until !== '') {
      const ms = Date.parse(until);
      if (Number.isNaN(ms)) throw new AnnouncementError('UNTIL_INVALID', 'until must be a date');
      end = new Date(ms).toISOString();
    }
    const t = now();
    const state = { enabled: true, message: text, level, until: end, id: `${t.toString(36)}`, updatedAt: new Date(t).toISOString(), updatedBy: by };
    ensureSettingsTable(db);
    db.run(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [KEY, JSON.stringify(state)]);
    cached = state;
    cachedAt = t;
    return state;
  }

  function clear() {
    ensureSettingsTable(db);
    db.run(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [KEY, JSON.stringify({ ...OFF })]);
    cached = { ...OFF };
    cachedAt = now();
    return cached;
  }

  /**
   * The banner markup for the top of a page, or '' when there is nothing to show. Put it in front of the page
   * content (`ui.renderAppShell({ bannerHtml })`). `nonce` is the CSP nonce of the page.
   * @param {'ru'|'en'} [locale]
   * @param {{nonce?: string}} [o]
   */
  function bannerHtml(locale = 'ru', { nonce } = {}) {
    const s = active();
    if (!s) return '';
    const n = nonce ? ` nonce="${escapeHtml(nonce)}"` : '';
    const closable = s.level !== 'critical';
    const until = s.until ? `<span class="adm-ann-until">${locale === 'en' ? 'until' : 'до'} <time class="adm-time" datetime="${escapeHtml(s.until)}">${escapeHtml(s.until.slice(0, 16).replace('T', ' '))} UTC</time></span>` : '';
    const label = locale === 'en' ? 'Dismiss' : 'Скрыть';
    return `<style${n}>${CSS}</style><div class="adm-ann adm-ann-${s.level}" role="${s.level === 'info' ? 'status' : 'alert'}" data-ann-id="${escapeHtml(s.id)}"><div class="adm-ann-text">${escapeHtml(s.message)}${until}</div>${closable ? `<button type="button" class="adm-ann-close" aria-label="${label}" title="${label}">&times;</button>` : ''}</div>`
      + `<script${n}>(function(){var b=document.querySelector('.adm-ann');if(!b)return;var id=b.getAttribute('data-ann-id'),c=b.querySelector('.adm-ann-close');try{if(c&&localStorage.getItem('adm-ann-dismissed')===id){b.style.display='none';return}}catch(e){}if(c)c.addEventListener('click',function(){b.style.display='none';try{localStorage.setItem('adm-ann-dismissed',id)}catch(e){}})})();</script>`;
  }

  function audited(req, action, { message, level, until } = {}) {
    try { log(db, { actor: req?.user?.username ?? null, action, entity: 'announcement', requestId: req?.id, ip: req?.ip, meta: { message: message ?? null, level: level ?? null, until: until ?? null } }); } catch { /* best effort */ }
  }

  return { get, active, set, clear, bannerHtml, audited };
}
