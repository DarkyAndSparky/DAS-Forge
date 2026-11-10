import { tokenCss, THEME_SCRIPT, THEME_BUTTON_CSS, CREATED_BY_CSS, LOGO_CSS, themeToggleHtml } from '../ui/theme.js';
import { poweredByHtml } from '../ui/powered-by.js';
import { brandBlockHtml } from '../branding/appearance.js';
import { langSwitchHtml } from '../ui/lang-switch.js';
import { catalogFor, errorText, resolveLocale } from './error-catalog.js';

/**
 * Branded error pages: the app's logo and name on top (the administrator's "Appearance" when a `brand`
 * callback is given, otherwise the vendor identity's own), the status, what happened and what to do,
 * and the small "Powered by DAS-Forge" line with the core's logo at the bottom.
 */
/**
 * Renders a self-contained branded error page (inline CSS, no external
 * requests - it must work even if static asset serving is what's
 * currently broken).
 *
 * @param {object} opts
 * @param {object} opts.vendorIdentity - the APP's own identity (from
 *   defineVendorIdentity()), not the core's
 * @param {number} opts.statusCode
 * @param {string} opts.title
 * @param {string} opts.message
 * @param {string} [opts.requestId]
 * @param {string} [opts.hint] - what the person can do
 * @param {'ru'|'en'} [opts.locale='ru']
 * @param {{tokens?: object, darkTokens?: object}} [opts.theme] - the app's own theme tokens (ui/theme.js)
 * @param {string} [opts.loginUrl] - where a 401 page sends the person to sign in (adds a primary button)
 * @param {string} [opts.nonce] - CSP nonce for the inline theme script
 * @param {string} [opts.bodyEndHtml] - trusted markup before </body> (cookie notice, footer links)
 * @param {string} [opts.brandHtml] - the brand block (logo + name, see `branding.brandBlockHtml`); without it the vendor identity's own logo and name
 * @param {string} [opts.extraHtml] - trusted markup under the hint (a maintenance notice, say)
 * @param {number} [opts.refreshSec] - reload the page by itself after this many seconds
 */
export function renderErrorPage({ vendorIdentity, statusCode, title, message, requestId, hint, locale = 'ru', theme = {}, bodyEndHtml = '', loginUrl = '', nonce = '', brandHtml = '', extraHtml = '', refreshSec = 0 }) {
  const L = catalogFor(locale);
  const brand = brandHtml || brandBlockHtml(null, vendorIdentity);

  return `<!DOCTYPE html>
<html lang="${locale === 'en' ? 'en' : 'ru'}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${statusCode} — ${escapeHtml(title)}</title>
${refreshSec > 0 ? `<meta http-equiv="refresh" content="${Math.floor(refreshSec)}">\n` : ''}
<style>
  ${tokenCss(theme)}
  ${THEME_BUTTON_CSS}
  ${LOGO_CSS}
  ${CREATED_BY_CSS}
  :root { --bg:var(--adm-bg); --fg:var(--adm-text); --muted:var(--adm-text-dim); --border:var(--adm-border); }
  body {
    margin:0; min-height:100vh; display:flex; flex-direction:column;
    align-items:center; justify-content:center; text-align:center;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    background:var(--bg); color:var(--fg); padding:24px;
  }
  .brand-head { display:flex; align-items:center; justify-content:center; gap:.75rem; margin-bottom:24px; font-size:1.3rem; font-weight:600; }
  .brand-head .adm-logo { max-height:56px; max-width:200px; }
  .extra { max-width:460px; margin:.5rem 0 0; padding:.75rem 1rem; border:1px solid var(--border); border-radius:8px; text-align:left; white-space:pre-line; }
  .code { font-size:4rem; font-weight:700; margin:0; line-height:1; }
  h1 { font-size:1.3rem; margin:8px 0 4px; }
  p.message { color:var(--muted); max-width:460px; }
  p.hint { color:var(--muted); max-width:460px; font-size:0.9rem; margin-top:0; }
  a.login { background:var(--adm-accent); color:#fff !important; border-color:var(--adm-accent) !important; margin-right:8px; }
  .lang-wrap { position:fixed; top:12px; right:16px; display:flex; gap:8px; align-items:center; }
  a.home { display:inline-block; margin-top:12px; padding:6px 14px; border:1px solid var(--border); border-radius:6px; color:var(--adm-accent); text-decoration:none; }
  .created { margin-top:48px; padding-top:16px; border-top:1px solid var(--border); }
  .request-id { margin-top:16px; font-size:0.75rem; color:var(--muted); font-family:ui-monospace,monospace; }
</style>
<script${nonce ? ` nonce="${escapeHtml(nonce)}"` : ''}>${THEME_SCRIPT}</script>
</head>
<body>
  <div class="lang-wrap">${langSwitchHtml(locale)}${themeToggleHtml(locale)}</div>
  <div class="brand-head">${brand}</div>
  <p class="code">${statusCode}</p>
  <h1>${escapeHtml(title)}</h1>
  <p class="message">${escapeHtml(message)}</p>
  ${hint ? `<p class="hint">${escapeHtml(hint)}</p>` : ''}
  ${extraHtml ? `<div class="extra">${extraHtml}</div>` : ''}
  <div>${statusCode === 401 && loginUrl ? `<a class="home login" href="${escapeHtml(loginUrl)}">${escapeHtml(L.login)}</a>` : ''}<a class="home" href="/">${escapeHtml(L.home)}</a></div>
  <div class="created">${poweredByHtml(locale)}</div>
  ${requestId ? `<p class="request-id">${escapeHtml(L.requestId)}: ${escapeHtml(requestId)}</p>` : ''}
${bodyEndHtml}
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** The app's brand block for this request; a failing callback only drops the app's own branding. */
function brandOf(brand, req) {
  try { return typeof brand === 'function' ? String(brand(req) ?? '') : ''; } catch { return ''; }
}

function wantsJson(req) {
  const accept = String(req.headers?.accept ?? '');
  const byAccept = /application\/json/.test(accept) && !/text\/html/.test(accept.split('application/json')[0] ?? '');
  return byAccept || String(req.headers?.['content-type'] ?? '').includes('application/json') || String(req.path ?? req.url ?? '').startsWith('/api/');
}

function pickLocale(req, locale) {
  if (typeof locale === 'function') return locale(req) === 'en' ? 'en' : 'ru';
  return resolveLocale(req, locale === 'en' ? 'en' : 'ru');
}

/**
 * Express 404 handler factory. API clients (Accept: application/json, JSON body, /api/ paths) get JSON,
 * browsers the branded page; language: opts.locale ('ru'|'en'|(req)=>...) as the default, overridden by
 * req.locale / Accept-Language; opts.theme carries the app's theme tokens.
 */
export function notFoundHandler(vendorIdentity, { locale = 'ru', theme = {}, bodyEnd = null, loginUrl = '', brand = null } = {}) {
  return (req, res) => {
    const loc = pickLocale(req, locale);
    const text = errorText(404, loc);
    if (wantsJson(req)) {
      return res.status(404).json({ error: 'NOT_FOUND', message: text.message, fields: [], requestId: req.id });
    }
    res.status(404).type('html').send(
      renderErrorPage({ vendorIdentity, statusCode: 404, title: text.title, message: text.message, hint: text.hint, requestId: req.id, locale: loc, theme, loginUrl, nonce: res.locals?.cspNonce, brandHtml: brandOf(brand, req), bodyEndHtml: bodyEnd?.(req, res, loc) ?? '' })
    );
  };
}

/**
 * Express error-handling middleware factory (must take 4 args).
 *
 * Audit C04: hands off to Express's default handler when the response has
 * already started (SSE/stream - writing a second response would throw
 * ERR_HTTP_HEADERS_SENT); only trusts a 4xx/5xx status from the error;
 * answers JSON to API clients (Accept prefers JSON) and HTML to browsers;
 * and exposes `err.message` ONLY for errors that opt in with
 * `expose: true` (body-parser sets it for its 4xx errors) - everything
 * else gets the catalog text for the status (ru/en, error-catalog.js).
 * Every 5xx is logged with the request id, which the client also sees,
 * so a user report can be matched to a line.
 *
 * @param {object} vendorIdentity
 * @param {{logger?: {error: Function, warn: Function}, locale?: 'ru'|'en'|Function, theme?: object}} [opts]
 */
export function errorPageHandler(vendorIdentity, { logger, locale = 'ru', theme = {}, bodyEnd = null, loginUrl = '', brand = null } = {}) {
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);

    const raw = Number(err?.statusCode ?? err?.status);
    const statusCode = Number.isInteger(raw) && raw >= 400 && raw <= 599 ? raw : 500;
    const expose = statusCode < 500 && err?.expose === true && err.message;

    const log = req.log ?? logger;
    if (statusCode >= 500) log?.error?.({ err, requestId: req.id, path: req.path }, 'unhandled error');

    const loc = pickLocale(req, locale);
    const text = errorText(statusCode, loc);
    const message = expose ? err.message : text.message;

    if (wantsJson(req)) {
      if (statusCode === 429 || statusCode === 503) res.setHeader?.('Retry-After', String(err?.retryAfterSec ?? 5));
      return res.status(statusCode).json({ error: statusCode === 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR', message, fields: [], requestId: req.id });
    }

    res.status(statusCode).type('html').send(
      renderErrorPage({ vendorIdentity, statusCode, title: text.title, message, hint: text.hint, requestId: req.id, locale: loc, theme, loginUrl, nonce: res.locals?.cspNonce, brandHtml: brandOf(brand, req), bodyEndHtml: bodyEnd?.(req, res, loc) ?? '' })
    );
  };
}

/**
 * Middleware that lets the guards (requireAuth, requirePermission, CSRF, rate limiter, validation, bans)
 * answer with the branded page when the client is a browser, instead of raw JSON. API clients keep the
 * JSON body the guard built (plus Retry-After for 429/503). Mount it right after requestId().
 *
 * @param {object} vendorIdentity
 * @param {{locale?: 'ru'|'en'|Function, theme?: object, bodyEnd?: (req, res, locale) => string, loginUrl?: string, brand?: (req) => string}} [opts] - `brand` returns the brand block (`branding.brandBlockHtml(db, vendorIdentity)`)
 */
export function errorResponder(vendorIdentity, { locale = 'ru', theme = {}, bodyEnd = null, loginUrl = '', brand = null } = {}) {
  return (req, res, next) => {
    res.locals = res.locals ?? {};
    res.locals.sendError = (status, body = {}) => {
      if (res.headersSent) return undefined;
      const loc = pickLocale(req, locale);
      const text = errorText(status, loc);
      if (typeof body.retryAfterSec === 'number') res.setHeader?.('Retry-After', String(body.retryAfterSec));
      // Guards answer with a page ONLY when the client asks for HTML (a browser navigation always does);
      // curl, scripts and fetch() without an Accept header keep getting the JSON they expect.
      if (wantsJson(req) || !/text\/html/i.test(String(req.headers?.accept ?? ''))) return res.status(status).json(body);
      return res.status(status).type('html').send(
        renderErrorPage({ vendorIdentity, statusCode: status, title: text.title, message: text.message, hint: text.hint, requestId: req.id, locale: loc, theme, loginUrl, nonce: res.locals?.cspNonce, brandHtml: brandOf(brand, req), bodyEndHtml: bodyEnd?.(req, res, loc) ?? '' })
      );
    };
    next();
  };
}
