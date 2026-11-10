const COOKIE = /(?:^|;\s*)das_lang=(ru|en)\b/;

/**
 * One interface language for the whole app: `?lang=ru|en` in any URL switches it and is remembered in a cookie
 * (das_lang, a year, not HttpOnly-sensitive), otherwise the cookie, otherwise Accept-Language, otherwise `fallback`.
 * Sets `req.locale`, which the shell, error pages, policy pages and admin already read. Mount it before everything
 * that renders a page (it does not need cookie-parser).
 *
 * @param {{fallback?: 'ru'|'en', cookieName?: string, secure?: boolean}} [opts]
 */
export function localeMiddleware({ fallback = 'ru', secure = false } = {}) {
  return (req, res, next) => {
    const q = req.query?.lang;
    if (q === 'ru' || q === 'en') {
      req.locale = q;
      try {
        res.cookie?.('das_lang', q, { maxAge: 365 * 24 * 3600 * 1000, sameSite: 'lax', path: '/', secure: secure || req.secure === true });
      } catch { /* a cookie that cannot be set only costs the memory of the choice */ }
      return next();
    }
    const fromCookie = COOKIE.exec(String(req.headers?.cookie ?? ''))?.[1];
    if (fromCookie) { req.locale = fromCookie; return next(); }
    for (const part of String(req.headers?.['accept-language'] ?? '').split(',')) {
      const tag = part.trim().slice(0, 2).toLowerCase();
      if (tag === 'ru' || tag === 'en') { req.locale = tag; return next(); }
    }
    req.locale = fallback;
    return next();
  };
}
