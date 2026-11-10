/**
 * One way for guards (auth, CSRF, rate limit, validation, bans) to refuse a request. With
 * `http.errorResponder()` mounted, browsers get the branded page and API clients JSON; without it
 * (unit tests, apps that did not mount it) the plain JSON body is sent, exactly as before.
 */
export function sendError(req, res, status, body) {
  const fn = res.locals?.sendError;
  if (typeof fn === 'function') return fn(status, body);
  return res.status(status).json(body);
}
