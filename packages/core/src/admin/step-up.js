import { pageShell } from '../accounts/pages.js';
import { findUserById } from '../auth/users.js';
import { listAuthenticators, verifyTotpLogin } from '../auth/authenticators.js';
import { log } from '../audit/log.js';
import { contextFromRequest } from '../audit/context.js';
import { readForm } from './sections.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const T = {
  ru: { title: 'Подтверждение', hint: 'Это действие опасно. Подтвердите себя заново: пароль (и код из приложения, если он у вас включён). Подтверждение действует несколько минут.', password: 'Пароль', code: 'Код из приложения', submit: 'Подтвердить', bad: 'Неверные данные. Попробуйте ещё раз.', locked: 'Слишком много попыток. Подождите несколько минут.', cancel: 'Назад' },
  en: { title: 'Confirmation', hint: 'This action is dangerous. Confirm it is you again: your password (and the code from your authenticator app, if you use one). The confirmation lasts a few minutes.', password: 'Password', code: 'Authenticator code', submit: 'Confirm', bad: 'Wrong details. Try again.', locked: 'Too many attempts. Wait a few minutes.', cancel: 'Back' },
};

/** Only a path on this site: never an address with a host, never `//`, never a backslash. */
export function safeNext(v, fallback = '/') {
  const s = String(v ?? '');
  return /^\/(?![/\\])[\w\-./?=&%~:]*$/.test(s) && s.length <= 300 ? s : fallback;
}

/**
 * Fresh re-authentication for dangerous admin actions (audit R-01). `middleware` goes into `createAdmin({ stepUp: [..] })`: when the
 * administrator has not confirmed within `maxAgeMs`, a POST is answered with a redirect to the confirmation page (or 401
 * `STEP_UP_REQUIRED` for fetch/JSON), and the action is NOT performed. The confirmation is a password, plus a current TOTP code when
 * the user has an active authenticator; five wrong answers in `lockMs` block further tries. The mark lives in the server-side session.
 *
 * @param {object} o
 * @param {object} o.db
 * @param {{verifyPassword: (stored: string, plain: string) => Promise<{valid: boolean}>}} o.authProvider
 * @param {string|string[]|null} [o.totpKey] - the key(s) the authenticators are sealed with (`auth.totpEncryptionKey`)
 * @param {number} [o.maxAgeMs=600000]
 * @param {string} [o.path='/admin/confirm']
 */
export function createStepUp({ db, authProvider, totpKey = null, maxAgeMs = 600_000, path = '/admin/confirm', now = () => Date.now(), lockMs = 300_000, maxFailures = 5 } = {}) {
  if (!db || !authProvider) throw new TypeError('createStepUp: db and authProvider are required');
  const failures = new Map(); // userId -> { n, first }
  const lang = (req) => (req.query?.lang === 'en' ? 'en' : req.query?.lang === 'ru' ? 'ru' : (req.locale === 'en' ? 'en' : 'ru'));
  const isFresh = (req) => Number.isFinite(req.session?.stepUpAt) && now() - req.session.stepUpAt < maxAgeMs && req.session.stepUpUser === req.user?.id;
  const locked = (id) => { const f = failures.get(id); return Boolean(f && f.n >= maxFailures && now() - f.first < lockMs); };

  function middleware(req, res, next) {
    if (isFresh(req)) return next();
    const wantsJson = String(req.headers?.accept ?? '').includes('application/json') && !String(req.headers?.accept ?? '').includes('text/html');
    if (wantsJson) return res.status(401).json({ error: 'STEP_UP_REQUIRED', confirm: path });
    let back = '/';
    try { const r = new URL(String(req.headers?.referer ?? ''), 'http://x'); back = safeNext(`${r.pathname}`, '/'); } catch { /* none */ }
    return res.redirect(303, `${path}?next=${encodeURIComponent(back)}`);
  }

  function render(req, res, { error = '', next: nx = '/' } = {}) {
    const locale = lang(req);
    const l = T[locale];
    const needCode = listAuthenticators(db, req.user.id).some((a) => a.type === 'totp' && a.status === 'active');
    res.set?.('Cache-Control', 'no-store');
    res.status(error === 'locked' ? 429 : 200).type('html').send(pageShell(l.title, `
      <h1>${esc(l.title)}</h1>
      <p class="hint">${esc(l.hint)}</p>
      <form method="post" action="${esc(path)}">
        <input type="hidden" name="next" value="${esc(nx)}">
        <label for="password">${esc(l.password)}</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
        ${needCode ? `<label for="code">${esc(l.code)}</label><input id="code" name="code" autocomplete="one-time-code" inputmode="numeric" required>` : ''}
        <button type="submit">${esc(l.submit)}</button>
        ${error ? `<div class="error">${esc(error === 'locked' ? l.locked : l.bad)}</div>` : ''}
        <p class="hint"><a href="${esc(nx)}">${esc(l.cancel)}</a></p>
      </form>`, { nonce: res.locals?.cspNonce, locale }));
  }

  function mount(app, { requireAuth }) {
    app.get(path, requireAuth(), (req, res) => render(req, res, { next: safeNext(req.query?.next) }));
    app.post(path, requireAuth(), async (req, res) => {
      const form = await readForm(req);
      const nx = safeNext(form.next);
      const id = req.user.id;
      if (locked(id)) return render(req, res, { error: 'locked', next: nx });
      const user = findUserById(db, id);
      let ok = false;
      if (user && user.passwordHash) {
        const pw = await authProvider.verifyPassword(user.passwordHash, String(form.password ?? '').slice(0, 1024));
        ok = Boolean(pw.valid);
        const hasTotp = listAuthenticators(db, id).some((a) => a.type === 'totp' && a.status === 'active');
        if (ok && hasTotp) ok = Boolean(verifyTotpLogin(db, id, String(form.code ?? '').replace(/\s/g, '').slice(0, 12), { encryptionKey: totpKey }));
      }
      if (!ok) {
        const f = failures.get(id);
        failures.set(id, !f || now() - f.first >= lockMs ? { n: 1, first: now() } : { n: f.n + 1, first: f.first });
        log(db, { ...contextFromRequest(req), action: 'admin.stepup', entity: 'user', entityId: String(id), result: 'failure' });
        return render(req, res, { error: 'bad', next: nx });
      }
      failures.delete(id);
      req.session.stepUpAt = now();
      req.session.stepUpUser = id;
      log(db, { ...contextFromRequest(req), action: 'admin.stepup', entity: 'user', entityId: String(id), result: 'success' });
      const go = () => res.redirect(303, nx);
      if (typeof req.session.save === 'function') req.session.save(() => go()); else go();
    });
  }

  return { middleware, mount, isFresh, path, maxAgeMs };
}
