import { ensureSettingsTable } from '../branding/company-branding.js';
import { renderErrorPage, catalogForMaintenance } from './page.js';
import { log } from '../audit/log.js';

const KEY = 'maintenance';
const MESSAGE_MAX = 500;
const DEFAULT_RETRY_SEC = 300;

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** What a stored state looks like when nothing was ever switched on. */
const OFF = Object.freeze({ enabled: false, message: null, until: null, startedAt: null, startedBy: null });

function readState(db) {
  ensureSettingsTable(db);
  const row = db.get(`SELECT value FROM app_settings WHERE key = ?`, [KEY]);
  if (!row) return { ...OFF };
  try {
    const v = JSON.parse(row.value);
    return {
      enabled: v.enabled === true,
      message: typeof v.message === 'string' && v.message ? v.message : null,
      until: typeof v.until === 'string' && !Number.isNaN(Date.parse(v.until)) ? v.until : null,
      startedAt: typeof v.startedAt === 'string' ? v.startedAt : null,
      startedBy: typeof v.startedBy === 'string' ? v.startedBy : null,
    };
  } catch {
    return { ...OFF };
  }
}

function writeState(db, state) {
  ensureSettingsTable(db);
  db.run(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [KEY, JSON.stringify(state)]);
}

/** Thrown for a bad input of `enable()`; `code` is MESSAGE_TOO_LONG or UNTIL_INVALID. */
export class MaintenanceError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'MaintenanceError';
    this.code = code;
  }
}

/**
 * Maintenance mode: while it is on, everyone except administrators gets a 503 "work in progress" page
 * (JSON `{ error: 'MAINTENANCE' }` for API clients) with a `Retry-After` header; the sign-in pages,
 * `/health` and the logo stay reachable so an administrator can still get in and switch it off. The state
 * lives in the database (`app_settings`), so it survives a restart and is the same for every process
 * that shares the file; each process re-reads it at most every `cacheMs`.
 *
 * @param {object} o
 * @param {object} o.db
 * @param {number} [o.cacheMs=2000]
 * @param {() => number} [o.now]
 */
export function createMaintenance({ db, cacheMs = 2000, now = () => Date.now() } = {}) {
  if (!db) throw new TypeError('createMaintenance: db is required');
  let cached = null;
  let cachedAt = 0;

  function get({ fresh = false } = {}) {
    const t = now();
    if (!fresh && cached && t - cachedAt < cacheMs) return cached;
    try { cached = readState(db); } catch { cached = cached ?? { ...OFF }; }
    cachedAt = t;
    return cached;
  }

  /**
   * Switches the mode on. `until` (ISO date, optional) is shown to visitors as the expected end and sets
   * Retry-After; it does NOT switch the mode off by itself.
   */
  function enable({ message = null, until = null, by = null } = {}) {
    const text = message === null || message === undefined ? '' : String(message).trim();
    if (text.length > MESSAGE_MAX) throw new MaintenanceError('MESSAGE_TOO_LONG', `message must be at most ${MESSAGE_MAX} characters`);
    let end = null;
    if (until !== null && until !== undefined && until !== '') {
      const ms = Date.parse(until);
      if (Number.isNaN(ms)) throw new MaintenanceError('UNTIL_INVALID', 'until must be a date');
      end = new Date(ms).toISOString();
    }
    const state = { enabled: true, message: text || null, until: end, startedAt: new Date(now()).toISOString(), startedBy: by };
    writeState(db, state);
    cached = state;
    cachedAt = now();
    return state;
  }

  function disable() {
    writeState(db, { ...OFF });
    cached = { ...OFF };
    cachedAt = now();
    return cached;
  }

  /** Seconds a client should wait: until the expected end (clamped to 30 s .. 1 h), else five minutes. */
  function retryAfterSec(state = get()) {
    if (!state.until) return DEFAULT_RETRY_SEC;
    const left = Math.ceil((Date.parse(state.until) - now()) / 1000);
    return Math.min(3600, Math.max(30, Number.isFinite(left) ? left : DEFAULT_RETRY_SEC));
  }

  /**
   * Express middleware; mount it AFTER the session middleware (it needs `req.user`) and before the routes.
   * @param {object} o
   * @param {object} o.vendorIdentity
   * @param {string} [o.permission='admin.access'] - holders pass through
   * @param {string[]} [o.allowPaths] - path prefixes that stay open
   * @param {(req) => boolean} [o.bypass] - extra pass-through rule
   * @param {(req) => string} [o.brand] - brand block, see `branding.brandBlockHtml`
   * @param {(req, res, locale) => string} [o.bodyEnd]
   * @param {object} [o.theme]
   */
  function middleware({ vendorIdentity, permission = 'admin.access', allowPaths = ['/health', '/login', '/logout', '/branding/logo', '/policy'], bypass = null, brand = null, bodyEnd = null, theme = {} } = {}) {
    return (req, res, next) => {
      const state = get();
      if (!state.enabled) return next();
      const path = String(req.path ?? req.url ?? '');
      if (allowPaths.some((p) => path === p || path.startsWith(`${p}/`))) return next();
      if (req.user?.permissions?.includes?.(permission)) return next();
      if (bypass?.(req)) return next();

      const retry = retryAfterSec(state);
      res.setHeader?.('Retry-After', String(retry));
      res.setHeader?.('Cache-Control', 'no-store');
      const accept = String(req.headers?.accept ?? '');
      const wantsHtml = /text\/html/i.test(accept) && !/application\/json/i.test(accept.split('text/html')[0] ?? '');
      if (!wantsHtml) {
        return res.status(503).json({ error: 'MAINTENANCE', message: state.message ?? 'The service is under maintenance.', until: state.until, retryAfterSec: retry, fields: [] });
      }
      const locale = req.locale === 'en' ? 'en' : req.locale === 'ru' ? 'ru' : (/^en/i.test(String(req.headers?.['accept-language'] ?? '')) ? 'en' : 'ru');
      const text = catalogForMaintenance(locale);
      const parts = [];
      if (state.message) parts.push(`<div>${escapeHtml(state.message)}</div>`);
      if (state.until) parts.push(`<div class="adm-muted" style="margin-top:.4rem">${escapeHtml(text.until)}: <time datetime="${escapeHtml(state.until)}">${escapeHtml(state.until.slice(0, 16).replace('T', ' '))} UTC</time></div>`);
      let brandHtml = '';
      try { brandHtml = typeof brand === 'function' ? String(brand(req) ?? '') : ''; } catch { brandHtml = ''; }
      return res.status(503).type('html').send(renderErrorPage({
        vendorIdentity, statusCode: 503, title: text.title, message: text.message, hint: text.hint, locale, theme,
        requestId: undefined, brandHtml, extraHtml: parts.join(''), refreshSec: 30, nonce: res.locals?.cspNonce,
        bodyEndHtml: bodyEnd?.(req, res, locale) ?? '',
      }));
    };
  }

  /** `enable`/`disable` plus an audit entry; `actor` is the administrator's login. */
  function audited(req, action, { message, until } = {}) {
    try { log(db, { actor: req?.user?.username ?? null, action, entity: 'maintenance', requestId: req?.id, ip: req?.ip, meta: { message: message ?? null, until: until ?? null } }); } catch { /* best effort */ }
  }

  return { get, enable, disable, retryAfterSec, middleware, audited };
}
