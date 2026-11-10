import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import * as auth from '../auth/index.js';
import * as devices from '../auth/devices.js';
import * as http from '../http/index.js';
import * as audit from '../audit/index.js';
import * as qr from '../qr/index.js';
import { pickTexts } from '../i18n/overrides.js';
import { themeWithBranding, brandBlockHtml } from '../branding/index.js';
import { ACCOUNT_TEXTS } from './texts.js';
import { createRegistrationStore } from './registration.js';
import { createDirectoryLinks } from './directory.js';
import { renderRegisterPage, renderRegisterConfirmPage, renderLoginPage, renderForgotPasswordPage, renderResetPasswordPage, renderForcedPasswordPage, renderAccountBody } from './pages.js';

export { ACCOUNT_TEXTS, createRegistrationStore, createDirectoryLinks };

const LoginSchema = z.object({
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(1024),
});

const TotpCodeSchema = z.object({
  code: z.string().min(6).max(6),
});

const RecoveryCodeLoginSchema = z.object({
  code: z.string().min(1),
});

const ChangePasswordSchema = z.object({
  // Optional ONLY while a temporary password is pending (the session itself came from the temporary-password sign-in).
  currentPassword: z.string().min(1).max(1024).optional(),
  // Length/strength is judged by the password policy (config auth.passwordPolicy, changeable in the admin panel); here only a sanity cap.
  newPassword: z.string().min(1).max(1024),
});

const RegisterSchema = z.object({
  username: z.string().min(1).max(128),
  email: z.string().min(3).max(254),
  password: z.string().min(1).max(1024),
  website: z.string().max(200).optional(), // hidden field: a person leaves it empty
  t: z.number().optional(), // when the form was opened
});
const RegisterConfirmSchema = z.object({ token: z.string().min(1).max(200) });

const AccountEmailSchema = z.object({ email: z.string().max(254).nullable() });

const ForgotPasswordSchema = z.object({
  login: z.string().min(1).max(254),
});

const ResetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  newPassword: z.string().min(1).max(1024),
});

const TotpEnrollStartSchema = z.object({
  name: z.string().min(1).max(100).nullable().default(null),
});

const TotpEnrollVerifySchema = z.object({
  authenticatorId: z.number().int().positive(),
  code: z.string().min(6).max(6),
});

const TotpEnrollQrSchema = z.object({
  otpauthUri: z.string().min(1).startsWith('otpauth://'),
});

const RecoveryGenerateSchema = z.object({
  count: z.number().int().min(1).max(20).default(8),
});

/** Minutes a password-verified-but-not-yet-MFA'd session survives unused before the user has to start the login over.
 * Short on purpose: this is a step-up window, not a real session. */
const MFA_PENDING_TTL_MS = 5 * 60_000;

/** What /me may return about the logged-in user (serialize strict allowlist, audit A19). */
const ME_FIELDS = { id: true, username: true, role: true, permissions: true, mustChangePassword: true };

/** Paths a user with a pending forced password change may still use (the app adds its own with `allowDuringPasswordChange`). */
const PASSWORD_CHANGE_ALLOWED_PATHS = ['/password/change', '/logout', '/me', '/login', '/', '/favicon.ico'];

function activeTotpAuthenticators(db, userId) {
  return auth.listAuthenticators(db, userId).filter((a) => a.type === 'totp' && a.status === 'active');
}

/**
 * Account routes of an application: sign-in (password, TOTP, recovery code), sign-out, `/me`, password change and reset by
 * e-mail, own e-mail, TOTP enrolment, recovery codes, the brute-force limits around them and the forced password change.
 * They answer JSON. The pages are the core's own (`/login`, `/forgot-password`, `/reset-password`, the forced password page and, with
 * `accountShell`, the "Account" page), reworded with `texts` and replaceable one by one with `pages`.
 *
 * @param {object} app - Express application; mount after the session middleware
 * @param {object} o
 * @param {object} o.db
 * @param {object} o.authProvider - `auth.createAuthProvider()`
 * @param {object} [o.appConfig] - uses `auth` (sessionTtlMs, passwordPolicy, sessionSecret, totpEncryptionKey, previous*), `security` (loginRateLimit, lockout), `email.baseUrl`
 * @param {{authenticate: (username: string, password: string) => Promise<{ok: boolean, code?: string, username?: string, email?: string|null, role?: string}>, source?: string, allowedRoles?: string[]}} [o.directory] - LDAP/AD sign-in (`ldap.createLdapAuthenticator()`): an unknown username, or an account created from the directory, is checked there; local accounts keep their own password
 * @param {object} [o.bans] - `security.createBans()`; a banned username gets no session
 * @param {(info: object) => void} [o.onLock] - called when a lock-out starts
 * @param {object} [o.emailService] - `email.createEmailService()`; password reset mail needs it enabled
 * @param {object} [o.logger]
 * @param {(role: string) => string[]} o.permissionsForRole - the application's role to permission policy
 * @param {(role: string) => boolean} [o.mfaRequiredForRole] - roles that must always keep one active factor
 * @param {{login?: Function|false, forgotPassword?: Function|false, resetPassword?: Function|false, forcedPassword?: Function|false}} [o.pages] - own `(req, res) => html` for a page, or `false` to not mount it; a missing key means the core's page
 * @param {{ru?: object, en?: object}} [o.texts] - reworded texts (keys of `ACCOUNT_TEXTS`)
 * @param {string} [o.appName=''] - added to the page titles ("Sign in — My App")
 * @param {object} [o.vendorIdentity] - `branding.defineVendorIdentity()`; the pages show the administrator's name and logo, else this identity's
 * @param {object} [o.theme] - the application's theme tokens for the pages
 * @param {(req) => {theme?: object, html?: string}} [o.brand] - replaces the default brand block and theme
 * @param {(req, res, o: {title: string, bodyHtml: string, activePath: string}) => string} [o.accountShell] - wraps the "Account" body in the application's page; when given the core mounts `GET {accountPath}`
 * @param {string} [o.accountPath='/ui/account']
 * @param {string} [o.homePath='/ui'] - where `/` sends a signed-in user
 * @param {string} [o.passwordChangePath='/ui/password'] - where a browser is sent while a password change is forced
 * @param {string[]} [o.allowDuringPasswordChange] - extra paths open while a password change is forced
 * @returns {{ forgetLoginFailures: (username: string) => void, userPublicShape: (user: object) => object, totpKey: string[] }}
 */
export function mountAccountRoutes(app, {
  db, authProvider, directory = null, appConfig = {}, bans = null, onLock = null, emailService = null, logger = null,
  permissionsForRole, mfaRequiredForRole = () => false, pages = {}, texts = {}, appName = '', vendorIdentity = null, theme = {}, brand = null, accountShell = null, accountPath = '/ui/account',
  homePath = '/ui', passwordChangePath = '/ui/password', allowDuringPasswordChange = [],
}) {
  if (!db) throw new TypeError('mountAccountRoutes: db is required');
  if (!authProvider) throw new TypeError('mountAccountRoutes: authProvider is required');
  if (typeof permissionsForRole !== 'function') throw new TypeError('mountAccountRoutes: permissionsForRole is required');
  const uuidv4 = randomUUID;
  const directoryLinks = directory ? createDirectoryLinks(db) : null;
  const allowedPaths = new Set([...PASSWORD_CHANGE_ALLOWED_PATHS, passwordChangePath, ...allowDuringPasswordChange, ...(accountShell ? [accountPath] : [])]);

  function userPublicShape(user) {
    return { id: user.id, username: user.username, role: user.role, permissions: permissionsForRole(user.role) };
  }

  /**
   * Issues the REAL post-login session and lets express-session set the cookie - shared by the plain-password path (no MFA
   * enrolled) and both step-up completions (TOTP code, recovery code). `establishSession` always starts a brand-new session
   * id (session-fixation protection, §4.5h): whatever session the request arrived with is destroyed, a pending MFA session
   * is never promoted in place.
   */
  async function issueFullSession(req, { user, ttlMs }, res = null) {
    await http.establishSession(req, {
      userId: user.id,
      // mustChangePassword rides in the session snapshot so a route-level guard can enforce it without a DB read per request (audit A06).
      user: { ...userPublicShape(user), mustChangePassword: Boolean(user.mustChangePassword) },
      maxAgeMs: ttlMs,
    });
    if (res) noteDevice(req, res, user);
  }

  /** Recognises the browser by its `das_device` cookie; a browser not seen before for this account is reported to the owner by e-mail. Never breaks the sign-in. */
  function noteDevice(req, res, user) {
    try {
      const seen = devices.recognizeDevice(db, { userId: user.id, deviceId: req.cookies?.[devices.DEVICE_COOKIE], ip: req.ip, userAgent: req.headers?.['user-agent'] });
      res.cookie(devices.DEVICE_COOKIE, seen.deviceId, { httpOnly: true, sameSite: 'lax', secure: Boolean(req.secure), maxAge: devices.DEVICE_COOKIE_MAX_AGE_MS, path: '/' });
      if (!seen.isNew || seen.firstEver) return;
      const device = devices.describeAgent(req.headers?.['user-agent']);
      logAudit(req, { actor: user.username, action: 'auth.login.new_device', entity: 'user', entityId: user.id, meta: { device } });
      if (appConfig.auth?.newDeviceNotice === false || !emailService?.enabled || !auth.findUserById(db, user.id)?.email) return;
      void emailService.sendNewDeviceLogin({ to: auth.findUserById(db, user.id).email, when: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC', ip: req.ip ?? '?', device, locale: req.locale === 'en' ? 'en' : 'ru' })
        .catch((err) => logger?.warn?.('new device mail failed', { code: err?.code }));
    } catch (err) {
      logger?.warn?.('device recognition failed', { message: err?.message });
    }
  }

  // Best-effort audit entry that takes request id and address from the request; a failing log must never break the request.
  function logAudit(req, { actor, action, entity = null, entityId = null, result = 'success', meta = {} }) {
    try {
      audit.log(db, { actor, action, entity, entityId, result, meta, requestId: req.id, ip: req.ip });
    } catch {
      // best-effort
    }
  }

  // --- Hardening (audit wave 1): brute-force protection, Secure cookies,
  // forced password change. All state is per-process (see core/http
  // rate-limit.js for that documented limitation).
  const securityCfg = appConfig?.security ?? {};
  const sessionTtlMs = appConfig?.auth?.sessionTtlMs ?? 1000 * 60 * 60 * 8;
  // The rules an administrator can change in the admin panel (stored in the database); the configuration is the starting point.
  const passwordRules = auth.createPasswordPolicy({ db, config: appConfig?.auth?.passwordPolicy ?? {}, appName, blocklistFile: appConfig?.auth?.passwordBlocklistFile });
  const isAdminUser = (u) => (permissionsForRole(u.role) ?? []).includes('admin.access');
  // A10: TOTP secrets are encrypted at rest with a key derived from the
  // session secret (rotating that secret requires re-enrolling TOTP).
  const sessionSecret = appConfig?.auth?.sessionSecret;
  // First key encrypts, all of them can decrypt: a dedicated auth.totpEncryptionKey (if set), then the
  // session secrets - so rotating sessionSecret no longer locks TOTP users out (audit K02). On start
  // every secret is brought under the first key.
  const totpKey = [
    appConfig?.auth?.totpEncryptionKey,
    ...(appConfig?.auth?.previousTotpEncryptionKeys ?? []),
    sessionSecret,
    ...(appConfig?.auth?.previousSessionSecrets ?? []),
  ].filter((k) => typeof k === 'string' && k.length >= 16);
  if (totpKey.length > 0) {
    try { auth.sealExistingTotpSecrets(db, totpKey); } catch { /* tables may not exist yet; sealed on next start */ }
  }
  const loginRateCfg = securityCfg.loginRateLimit ?? { windowMs: 60_000, max: 10 };
  const lockoutCfg = securityCfg.lockout ?? { maxFailures: 5, baseLockMs: 5 * 60_000, maxLockMs: 24 * 3_600_000, resetAfterMs: 24 * 3_600_000 };

  const loginLimiter = http.createRateLimiter(loginRateCfg);
  // Keyed by the ATTEMPTED username (lowercased) so an unknown name locks
  // exactly like a real one - the lockout is not an enumeration oracle.
  //
  // Two budgets on the name (audit K03): the strict one is per (name, IP), so a stranger typing wrong passwords for
  // "admin" locks only his own address, not the administrator; the per-name one is several times wider, so a guess
  // spread over many addresses is still stopped, and reaching it writes an `auth.lockout` audit entry.
  const loginPairFailures = http.createFailureTracker({ ...lockoutCfg, onLock });
  const loginUserFailures = http.createFailureTracker({ ...lockoutCfg, onLock, maxFailures: lockoutCfg.maxFailures * 6, maxLockMs: Math.min(lockoutCfg.maxLockMs, 3_600_000) }); // by login alone: capped at 1 h, so a stranger cannot keep the real owner out for a day
  // Per-IP budget is wider: it stops one source spraying many usernames,
  // without punishing a shared NAT for a couple of typos.
  const loginIpFailures = http.createFailureTracker({ ...lockoutCfg, onLock, maxFailures: lockoutCfg.maxFailures * 4 });
  // Shared by /login/totp and /login/recovery, keyed by user id, so the
  // pending-session cookie can be re-minted but the budget cannot.
  const mfaFailures = http.createFailureTracker({ ...lockoutCfg, onLock, baseLockMs: Math.max(lockoutCfg.baseLockMs, 60_000) });

  function tooManyAttempts(res, retryAfterMs) {
    const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
    res.setHeader?.('Retry-After', String(retryAfterSec));
    return res.status(429).json({ error: 'TOO_MANY_ATTEMPTS', fields: [], retryAfterSec });
  }

  // Unknown usernames must cost the same argon2 time as real ones, or
  // response timing enumerates accounts (audit A09). Lazily hashed once.
  let dummyHash;
  const getDummyHash = () => (dummyHash ??= authProvider.hashPassword(uuidv4()));

  // A temporary/bootstrap password gives access to NOTHING but the
  // password-change flow until it is changed (audit A06). Registered
  // before every route below, after the global sessionMiddleware.
  app.use((req, res, next) => {
    if (req.user?.mustChangePassword && !allowedPaths.has(req.path ?? req.url)) {
      // A browser opening any page is taken to the password-change page; scripts and fetch() keep the JSON.
      if ((req.method === 'GET' || req.method === 'HEAD') && /text\/html/i.test(String(req.headers?.accept ?? ''))) return res.redirect(302, passwordChangePath);
      return res.status(403).json({ error: 'PASSWORD_CHANGE_REQUIRED', fields: [] });
    }
    next();
  });

  // Entry point: signed in -> the app, otherwise the sign-in page. No favicon of its own (204, not a 404 in the log).
  app.get('/', (req, res) => res.redirect(302, req.user ? homePath : '/login'));
  app.get('/favicon.ico', (req, res) => res.status(204).end());

  // --- Pages -----------------------------------------------------------------------------------------------
  const localeOf = (req) => (req.locale === 'en' ? 'en' : 'ru');
  const textsOf = (req) => pickTexts(ACCOUNT_TEXTS, texts, localeOf(req), 'accounts');
  const brandOf = (req) => {
    if (brand) { const b = brand(req) ?? {}; return { theme: b.theme ?? theme, html: b.html ?? '' }; }
    let themed = theme;
    try { themed = themeWithBranding(db, theme); } catch { /* the page still renders with the plain theme */ }
    let html = '';
    try { html = vendorIdentity ? brandBlockHtml(db, vendorIdentity) : ''; } catch { /* no brand block */ }
    return { theme: themed, html };
  };
  // The shortest password this person may choose (administrators may be held to a longer one): read from the live password policy.
  const minLengthFor = (req) => {
    const p = passwordRules.get();
    try { return req?.user && isAdminUser(req.user) ? p.adminMinLength : p.minLength; } catch { return p.minLength; }
  };
  const withMin = (l, min) => ({ ...l, forcedNewPassword: String(l.forcedNewPassword ?? '').replace('{min}', min), accountPwNew: String(l.accountPwNew ?? '').replace('{min}', min) });
  const common = (req, res) => ({ registration: Boolean(appConfig?.auth?.registration?.enabled), nonce: res.locals?.cspNonce, locale: localeOf(req), brand: brandOf(req), l: withMin(textsOf(req), minLengthFor(req)), minLength: minLengthFor(req), appName, homePath, passwordChangePath });
  const pageRoute = (key, path, render, { noCache = false } = {}) => {
    if (pages[key] === false) return;
    const own = pages[key];
    app.get(path, (req, res) => {
      if (noCache) {
        // no-referrer + no-store: the page is reached through a one-time link
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Cache-Control', 'no-store');
      }
      res.type('html').send(own ? own(req, res) : render(common(req, res)));
    });
  };
  pageRoute('login', '/login', renderLoginPage);
  pageRoute('forgotPassword', '/forgot-password', renderForgotPasswordPage);
  pageRoute('resetPassword', '/reset-password', renderResetPasswordPage, { noCache: true });

  // --- Self-registration (auth.registration.enabled): the account exists only after the mailed link is opened ---------------
  const regCfg = appConfig?.auth?.registration ?? { enabled: false };
  if (regCfg.enabled) {
    const store = createRegistrationStore(db);
    const needMail = regCfg.requireEmailConfirmation !== false;
    const regCommon = (req, res) => ({ ...common(req, res), registration: true });
    app.get('/register', (req, res) => res.type('html').send(renderRegisterPage(regCommon(req, res))));
    app.get('/register/confirm', (req, res) => {
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Cache-Control', 'no-store');
      res.type('html').send(renderRegisterConfirmPage(regCommon(req, res)));
    });
    app.post('/register', loginLimiter, http.validateBody(RegisterSchema), async (req, res) => {
      const { username, email, password, website, t } = req.body;
      const ip = req.ip ?? null;
      // bot filters: a filled hidden field or an instantly submitted form look like success but do nothing
      if ((website ?? '') !== '' || (typeof t === 'number' && Date.now() - t < (regCfg.minFillMs ?? 2000))) {
        logAudit(req, { actor: null, action: 'auth.registration_bot', result: 'failure', meta: { reason: website ? 'honeypot' : 'too_fast' } });
        return res.status(202).json({ ok: true });
      }
      if (needMail && !emailService?.enabled) return res.status(503).json({ error: 'EMAIL_DISABLED' });
      try { auth.validateUsername(username); } catch { return res.status(400).json({ error: 'INVALID', fields: ['username'] }); }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'INVALID', fields: ['email'] });
      const weak = await passwordRules.checkFull(password, { username, email, isAdmin: false }, {});
      if (!weak.ok) return res.status(400).json({ error: 'WEAK_PASSWORD', fields: ['password'], problems: weak.problems });
      // budgets: a few requests per address per hour, one mail per e-mail per ten minutes (silently the same answer)
      if (store.recent({ ip, sinceMs: 3_600_000 }) >= 5) return res.status(429).json({ error: 'RATE_LIMITED' });
      if (store.recent({ email, sinceMs: 600_000 }) >= 1) return res.status(202).json({ ok: true });
      // taken username or e-mail: the same answer as success (no way to learn who is registered)
      if (auth.findUserByUsername(db, username) || auth.findUserByEmail(db, email)) {
        logAudit(req, { actor: null, action: 'auth.registration_refused', result: 'failure', meta: { reason: 'taken' } });
        return res.status(202).json({ ok: true });
      }
      const passwordHash = await authProvider.hashPassword(password);
      if (!needMail) {
        try {
          auth.createManagedUser(db, { username, email, role: regCfg.role ?? 'operator', passwordHash, mustChangePassword: false });
        } catch { return res.status(400).json({ error: 'INVALID', fields: ['username'] }); }
        logAudit(req, { actor: username, action: 'auth.registered', meta: { confirmed: false } });
        return res.status(201).json({ ok: true });
      }
      const token = store.add({ username, email, passwordHash, ip, ttlHours: regCfg.ttlHours ?? 24 });
      const verifyUrl = `${String(appConfig?.email?.baseUrl ?? '').replace(/\/+$/, '')}/register/confirm#token=${token}`;
      void emailService.sendEmailVerification({ to: email, verifyUrl, locale: localeOf(req) }).catch((err) => logger?.warn?.('registration mail failed', { code: err?.code }));
      logAudit(req, { actor: null, action: 'auth.registration_requested' });
      res.status(202).json({ ok: true });
    });
    app.post('/register/confirm', loginLimiter, http.validateBody(RegisterConfirmSchema), (req, res) => {
      const pending = store.consume(req.body.token);
      if (!pending) return res.status(400).json({ error: 'INVALID_TOKEN' });
      try {
        auth.createManagedUser(db, { username: pending.username, email: pending.email, role: regCfg.role ?? 'operator', passwordHash: pending.passwordHash, mustChangePassword: false });
      } catch { return res.status(400).json({ error: 'INVALID_TOKEN' }); } // taken in the meantime
      logAudit(req, { actor: pending.username, action: 'auth.registered', meta: { confirmed: true } });
      res.json({ ok: true });
    });
  }

  // The forced password change page (the one a temporary password leads to).
  if (pages.forcedPassword !== false) {
    app.get(passwordChangePath, http.requireAuth(), (req, res) => {
      if (!req.user.mustChangePassword) return res.redirect(302, accountShell ? accountPath : homePath);
      res.type('html').send(pages.forcedPassword ? pages.forcedPassword(req, res) : renderForcedPasswordPage(common(req, res)));
    });
  }

  // "Account": password, own e-mail, authenticators, recovery codes, inside the application's own page.
  if (accountShell) {
    app.get(accountPath, http.requireAuth(), (req, res) => {
      const l = withMin(textsOf(req), minLengthFor(req));
      const authenticators = auth.listAuthenticators(db, req.user.id).filter((a) => a.type === 'totp');
      const bodyHtml = renderAccountBody({
        user: req.user, authenticators, email: auth.findUserById(db, req.user.id)?.email ?? null,
        mfaRequiredForRole: mfaRequiredForRole(req.user.role), nonce: res.locals?.cspNonce, l, homePath, accountPath, locale: localeOf(req), minLength: minLengthFor(req),
      });
      res.type('html').send(accountShell(req, res, { title: `${l.accountTitle}${appName ? ` — ${appName}` : ''}`, bodyHtml, activePath: accountPath }));
    });
  }

  // --- Auth: step 1 - username/password -----------------------------
  //
  // Two outcomes, same endpoint: a user with no active TOTP factor
  // gets a full session immediately (unchanged from before Stage B).
  // A user WITH an active factor instead gets a short-lived "pending"
  // session (session.data has no `user` key, so req.user stays unset
  // and requireAuth() blocks every normal route with it - only
  // /login/totp and /login/recovery below know how to read it) and
  // must complete step 2 before getting the real thing.
  app.post('/login', loginLimiter, http.validateBody(LoginSchema), async (req, res) => {
    const nameKey = req.body.username.toLowerCase();
    const ipKey = http.clientKey(req.ip);
    const pairKey = `${nameKey}|${ipKey}`;
    const locked = [loginPairFailures.check(pairKey), loginUserFailures.check(nameKey), loginIpFailures.check(ipKey)].find((c) => c.locked);
    if (locked) {
      logAudit(req, { actor: req.body.username, action: 'auth.login', result: 'failure', meta: { reason: 'locked_out' } });
      return tooManyAttempts(res, locked.retryAfterMs);
    }
    const failLogin = () => {
      loginPairFailures.recordFailure(pairKey);
      if (loginUserFailures.recordFailure(nameKey).locked) {
        logAudit(req, { actor: req.body.username, action: 'auth.lockout', result: 'failure', meta: { scope: 'username' } });
      }
      loginIpFailures.recordFailure(ipKey);
    };

    let user = auth.findUserByUsername(db, req.body.username);
    let result = null;
    const link = user && directoryLinks ? directoryLinks.get(user.id) : null;
    if (directory && (!user || link)) {
      // Unknown name or an account the directory manages: the directory decides. A local account never reaches here.
      const d = await directory.authenticate(req.body.username, req.body.password).catch((e) => ({ ok: false, code: 'UNAVAILABLE', error: e?.message }));
      if (!d.ok) {
        if (d.code !== 'UNAVAILABLE') failLogin(); // a directory outage is not the user's fault: it must not lock anyone out
        logAudit(req, { actor: req.body.username, action: 'auth.login', ...(user ? { entity: 'user', entityId: user.id } : {}), result: 'failure', meta: { reason: `directory_${String(d.code ?? 'failed').toLowerCase()}` } });
        return res.status(401).json({ error: 'INVALID_CREDENTIALS', fields: [] }); // one answer for "wrong password", "no such user" and "directory down"
      }
      if (!user) {
        try {
          const hash = await authProvider.hashPassword(`${uuidv4()}${uuidv4()}`); // random: the directory is the only way in
          const mk = (email) => auth.createManagedUser(db, { username: d.username ?? req.body.username, email, role: d.role, passwordHash: hash, allowedRoles: directory.allowedRoles, mustChangePassword: false });
          try { user = mk(d.email ?? null); } catch { user = mk(null); } // the mail address may already belong to another account
          directoryLinks.link(user.id, directory.source ?? 'ldap', d.dn);
          logAudit(req, { actor: user.username, action: 'auth.directory.provision', entity: 'user', entityId: user.id, meta: { role: user.role } });
        } catch (e) {
          failLogin();
          logAudit(req, { actor: req.body.username, action: 'auth.login', result: 'failure', meta: { reason: 'directory_provision_failed' } });
          return res.status(401).json({ error: 'INVALID_CREDENTIALS', fields: [] });
        }
      }
      result = { valid: true, needsRehash: false };
    } else if (!user) {
      await authProvider.verifyPassword(await getDummyHash(), req.body.password); // timing parity, result ignored
      failLogin();
      // actor is the ATTEMPTED username, not a real account - audit
      // search still needs it (who/what was being probed), even though
      // it never resolved to a real user row.
      logAudit(req, { actor: req.body.username, action: 'auth.login', result: 'failure', meta: { reason: 'unknown_user' } });
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', fields: [] });
    }

    result ??= await authProvider.verifyPassword(user.passwordHash, req.body.password);
    if (!result.valid) {
      failLogin();
      logAudit(req, {
        actor: user.username,
        action: 'auth.login',
        entity: 'user',
        entityId: user.id,
        result: 'failure',
        meta: { reason: 'wrong_password' },
      });
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', fields: [] });
    }

    // Checked AFTER verifying the password, not before - an attacker
    // probing usernames learns nothing extra from the disabled check
    // that a timing difference on the password step wouldn't already
    // leak in principle, and a real admin-disabled account's username
    // is already known inside the org (an admin disabled it on
    // purpose), unlike an unregistered username.
    if (user.disabled) {
      logAudit(req, {
        actor: user.username,
        action: 'auth.login',
        entity: 'user',
        entityId: user.id,
        result: 'failure',
        meta: { reason: 'account_disabled' },
      });
      return res.status(403).json({ error: 'ACCOUNT_DISABLED', fields: [] });
    }

    // A banned username gets no session at all (the ban middleware only sees a user AFTER sign-in, so without
    // this check a banned user would be signed in and then answered 403 on every page).
    if (bans?.check({ username: user.username })) {
      logAudit(req, { actor: user.username, action: 'auth.login', entity: 'user', entityId: user.id, result: 'failure', meta: { reason: 'banned' } });
      return res.status(403).json({ error: 'BANNED', fields: [] });
    }

    // A13: logging in never inherits a session id the browser already holds (a
    // planted/stale cookie must not become the logged-in one): issueFullSession /
    // the pending-MFA session below both regenerate the id.

    loginPairFailures.reset(pairKey);
    loginUserFailures.reset(nameKey); // correct password: forget this username's misses (the IP budget keeps its own history)

    if (result.needsRehash) {
      // Lazy legacy-password migration (core/auth's pattern, see
      // §core-auth in docs/index.html) - transparent to the user.
      const newHash = await authProvider.hashPassword(req.body.password);
      auth.updatePasswordHash(db, user.id, newHash);
    }

    // A password older than the policy allows must be replaced: same mechanism as a forced change.
    if (!user.mustChangePassword && passwordRules.isExpired(user.id)) {
      db.run(`UPDATE users SET must_change_password = 1 WHERE id = ?`, [user.id]);
      user.mustChangePassword = true;
      logAudit(req, { actor: user.username, action: 'auth.password_expired', entity: 'user', entityId: user.id });
    }

    const factors = activeTotpAuthenticators(db, user.id);
    if (factors.length === 0) {
      await issueFullSession(req, { user, ttlMs: sessionTtlMs }, res);
      logAudit(req, { actor: user.username, action: 'auth.login', entity: 'user', entityId: user.id });
      return res.json({ ok: true, mfaRequired: false, mustChangePassword: user.mustChangePassword });
    }

    // No `user` and no `userId`: req.user stays empty, so requireAuth() blocks every normal
    // route with this session; only the two MFA completions below read `pendingUserId`.
    await http.establishSession(req, {
      data: { mfaPending: true, pendingUserId: user.id },
      maxAgeMs: MFA_PENDING_TTL_MS,
    });
    // Not a failure (the password WAS correct) and not a completed
    // login either - its own action name, so an audit reader can tell
    // "password ok, waiting on MFA" apart from both outcomes.
    logAudit(req, { actor: user.username, action: 'auth.login.pending', entity: 'user', entityId: user.id });
    res.json({ ok: true, mfaRequired: true });
  });

  // --- Auth: step 2a - TOTP code --------------------------------------
  app.post('/login/totp', http.validateBody(TotpCodeSchema), async (req, res) => {
    if (!req.session?.mfaPending) {
      return res.status(401).json({ error: 'NO_PENDING_LOGIN', fields: [] });
    }
    const userId = req.session.pendingUserId;

    const mfaLock = mfaFailures.check(String(userId));
    if (mfaLock.locked) {
      await http.endSession(req, res);
      return tooManyAttempts(res, mfaLock.retryAfterMs);
    }

    const matchedId = auth.verifyTotpLogin(db, userId, req.body.code, { encryptionKey: totpKey });
    if (!matchedId) {
      logAudit(req, { actor: null, action: 'auth.login.totp', entity: 'user', entityId: userId, result: 'failure' });
      const miss = mfaFailures.recordFailure(String(userId));
      if (miss.locked) {
        // Too many wrong codes: burn the pending session so the attacker
        // must redo the password step, and the lock outlives the session.
        await http.endSession(req, res);
        return tooManyAttempts(res, miss.retryAfterMs);
      }
      return res.status(401).json({ error: 'INVALID_CODE', fields: [] });
    }
    mfaFailures.reset(String(userId));

    // The pending session is single-use: issueFullSession regenerates the id, which destroys
    // it, so a leaked/replayed pending cookie can't be used for a second completion attempt.
    const user = auth.findUserById(db, userId);
    await issueFullSession(req, { user, ttlMs: sessionTtlMs }, res);
    logAudit(req, { actor: user.username, action: 'auth.login.totp', entity: 'user', entityId: user.id });
    res.json({ ok: true, mustChangePassword: user.mustChangePassword });
  });

  // --- Auth: step 2b - recovery code (lost-device path, §22) --------
  app.post('/login/recovery', http.validateBody(RecoveryCodeLoginSchema), async (req, res) => {
    if (!req.session?.mfaPending) {
      return res.status(401).json({ error: 'NO_PENDING_LOGIN', fields: [] });
    }
    const userId = req.session.pendingUserId;

    const mfaLock = mfaFailures.check(String(userId));
    if (mfaLock.locked) {
      await http.endSession(req, res);
      return tooManyAttempts(res, mfaLock.retryAfterMs);
    }

    const ok = await auth.verifyAndConsumeRecoveryCode(db, userId, req.body.code);
    if (!ok) {
      logAudit(req, { actor: null, action: 'auth.login.recovery', entity: 'user', entityId: userId, result: 'failure' });
      const miss = mfaFailures.recordFailure(String(userId));
      if (miss.locked) {
        await http.endSession(req, res);
        return tooManyAttempts(res, miss.retryAfterMs);
      }
      return res.status(401).json({ error: 'INVALID_CODE', fields: [] });
    }
    mfaFailures.reset(String(userId));

    const user = auth.findUserById(db, userId);
    await issueFullSession(req, { user, ttlMs: sessionTtlMs }, res);
    logAudit(req, { actor: user.username, action: 'auth.login.recovery', entity: 'user', entityId: user.id });
    res.json({ ok: true, mustChangePassword: user.mustChangePassword });
  });

  app.post('/logout', async (req, res) => {
    // req.user may be unset (a still-pending session bailing out of the
    // TOTP step never populated it) - fall back to the session's raw
    // userId so a logout from mid-MFA still gets an actor, not a blank.
    const actor = req.user?.username ?? null;
    const userId = req.user?.id ?? req.session?.pendingUserId ?? null;
    // Works equally on a full session or a still-pending one (e.g. the
    // user bails out of the TOTP step), and without any session at all.
    await http.endSession(req, res);
    if (appConfig.auth?.clearSiteDataOnLogout === true && req.secure) res.setHeader('Clear-Site-Data', '"cache", "storage"'); // browsers ignore it over plain HTTP
    if (userId) logAudit(req, { actor, action: 'auth.logout', entity: 'user', entityId: userId });
    res.json({ ok: true });
  });

  // --- req.user comes ONLY from the server-verified session ---------
  app.get('/me', http.requireAuth(), (req, res) => {
    // Allowlist (audit A19): a field added to the session snapshot later stays private
    // until it is listed here.
    res.json(http.serialize(req.user, { viewerPermissions: req.user.permissions, fieldPermissions: ME_FIELDS, strict: true }));
  });

  // --- Password change: requires the CURRENT password, not just an
  // active session (§4.5h - changing a password is sensitive enough
  // that session possession alone isn't proof of intent) -------------
  app.post('/password/change', http.requireAuth(), http.validateBody(ChangePasswordSchema), async (req, res) => {
    const user = auth.findUserById(db, req.user.id);
    // With a pending temporary password the sign-in that just happened IS the proof; otherwise the current password is required.
    const mustChange = Boolean(user.mustChangePassword);
    if (!mustChange && !req.body.currentPassword) return res.status(400).json({ error: 'VALIDATION_ERROR', fields: ['currentPassword'] });
    const result = mustChange ? { valid: true } : await authProvider.verifyPassword(user.passwordHash, req.body.currentPassword);
    if (!result.valid) {
      logAudit(req, {
        actor: req.user.username,
        action: 'auth.password_change',
        entity: 'user',
        entityId: req.user.id,
        result: 'failure',
      });
      return res.status(401).json({ error: 'WRONG_CURRENT_PASSWORD', fields: ['currentPassword'] });
    }

    const policy = await passwordRules.checkFull(req.body.newPassword, {
      username: user.username,
      email: user.email,
      currentPassword: req.body.currentPassword,
      isAdmin: isAdminUser(user),
    }, { userId: user.id, verify: authProvider.verifyPassword, currentHash: user.passwordHash });
    if (policy.ok && mustChange && (await authProvider.verifyPassword(user.passwordHash, req.body.newPassword)).valid) {
      return res.status(400).json({ error: 'WEAK_PASSWORD', fields: ['newPassword'], problems: ['same_as_current'] });
    }
    if (!policy.ok) {
      return res.status(400).json({ error: 'WEAK_PASSWORD', fields: ['newPassword'], problems: policy.problems });
    }

    const newHash = await authProvider.hashPassword(req.body.newPassword);
    auth.updatePasswordHash(db, req.user.id, newHash, { clearMustChange: true });
    // Every session issued under the OLD password dies - including this
    // one (audit A05/A13) - and the caller gets a brand-new session with
    // the refreshed snapshot (mustChangePassword now false).
    auth.destroyUserSessions(db, req.user.id);
    await issueFullSession(req, { user: auth.findUserById(db, req.user.id), ttlMs: sessionTtlMs });
    logAudit(req, { actor: req.user.username, action: 'auth.password_change', entity: 'user', entityId: req.user.id });
    res.json({ ok: true });
  });

  // --- Own e-mail address (used for password-reset links) -------------
  app.post('/account/email', http.requireAuth(), http.validateBody(AccountEmailSchema), (req, res) => {
    const email = req.body.email === null || req.body.email.trim() === '' ? null : req.body.email.trim();
    try {
      auth.setUserEmail(db, req.user.id, email);
    } catch (err) {
      const taken = /taken|exists|in use|already/i.test(String(err?.message ?? ''));
      return res.status(taken ? 409 : 400).json({ error: taken ? 'EMAIL_TAKEN' : 'INVALID_EMAIL', fields: ['email'] });
    }
    logAudit(req, { actor: req.user.username, action: 'account.email_change', entity: 'user', entityId: req.user.id });
    res.json({ ok: true, email });
  });

  // --- Forgotten password, by e-mail ---------------------------------
  // POST /password/forgot always answers the same 202, whether or not the
  // account exists, has an address, is disabled, or the mailer is off - the
  // endpoint must not tell anybody which logins are real. The work happens
  // AFTER the response so even timing says nothing.
  app.post('/password/forgot', loginLimiter, http.validateBody(ForgotPasswordSchema), (req, res) => {
    const login = req.body.login.trim();
    res.status(202).json({ ok: true });

    void (async () => {
      if (!emailService?.enabled) return;
      const user = auth.findUserByUsername(db, login) ?? auth.findUserByEmail(db, login);
      if (!user || user.disabled || !user.email) return;
      const ttlMinutes = 30;
      const { token } = auth.createPasswordResetToken(db, user.id, { ttlMinutes });
      // Token in the URL FRAGMENT: it is never sent to a server, so it cannot land in
      // access logs or Referer headers; the page reads it and POSTs it to /password/reset.
      const resetUrl = `${String(appConfig?.email?.baseUrl ?? '').replace(/\/+$/, '')}/reset-password#token=${token}`;
      await emailService.sendPasswordReset({ to: user.email, resetUrl, expiresInMinutes: ttlMinutes });
      logAudit(req, { actor: null, action: 'auth.password_reset_requested', entity: 'user', entityId: user.id });
    })().catch((err) => logger?.warn?.('password reset mail failed', { code: err?.code }));
  });

  app.post('/password/reset', loginLimiter, http.validateBody(ResetPasswordSchema), async (req, res) => {
    const invalid = () => res.status(400).json({ error: 'INVALID_TOKEN', fields: ['token'] });
    const peeked = auth.peekPasswordResetToken(db, req.body.token);
    const user = peeked ? auth.findUserById(db, peeked.userId) : null;
    if (!user || user.disabled) return invalid();

    // Judge the password BEFORE the token is burnt: a too-weak first try must not cost the link.
    const policy = await passwordRules.checkFull(req.body.newPassword, { username: user.username, email: user.email, isAdmin: isAdminUser(user) }, { userId: user.id, verify: authProvider.verifyPassword, currentHash: user.passwordHash });
    if (!policy.ok) return res.status(400).json({ error: 'WEAK_PASSWORD', fields: ['newPassword'], problems: policy.problems });

    if (!auth.consumePasswordResetToken(db, req.body.token)) return invalid();

    const newHash = await authProvider.hashPassword(req.body.newPassword);
    auth.updatePasswordHash(db, user.id, newHash, { clearMustChange: true });
    auth.destroyUserSessions(db, user.id); // whoever held the old password is signed out everywhere
    loginPairFailures.resetPrefix(`${user.username.toLowerCase()}|`);
    loginUserFailures.reset(user.username.toLowerCase()); // a lockout from forgetting the password ends here
    logAudit(req, { actor: user.username, action: 'auth.password_reset', entity: 'user', entityId: user.id });
    if (emailService?.enabled && user.email) {
      void emailService.sendPasswordChanged({ to: user.email }).catch((err) => logger?.warn?.('password changed mail failed', { code: err?.code }));
    }
    res.json({ ok: true });
  });

  // --- TOTP enrollment (§5) ------------------------------------------
  app.get('/totp/authenticators', http.requireAuth(), (req, res) => {
    const list = auth
      .listAuthenticators(db, req.user.id)
      .filter((a) => a.type === 'totp')
      .map(({ id, status, name, createdAt, lastUsedAt }) => ({ id, status, name, createdAt, lastUsedAt }));
    res.json(list);
  });

  // Returns the secret/otpauth URI PLAINTEXT, once - same "shown once,
  // never retrievable again" pattern as recovery codes.
  app.post('/totp/enroll/start', http.requireAuth(), http.validateBody(TotpEnrollStartSchema), (req, res) => {
    const result = auth.startTotpEnrollment(db, req.user.id, {
      name: req.body.name,
      accountName: req.user.username,
      encryptionKey: totpKey,
    });
    res.json(result);
  });

  // core/qr (0.1.14): renders the otpauth:// URI as a scannable SVG.
  // POST, not GET - the URI carries the enrollment secret in plaintext,
  // and a GET would put it in the query string (server access logs,
  // Referer headers, browser history); the client already holds the
  // URI from /totp/enroll/start's own response body, so this just
  // turns it into a picture, it doesn't expose anything new.
  app.post('/totp/enroll/qr.svg', http.requireAuth(), http.validateBody(TotpEnrollQrSchema), async (req, res) => {
    const svg = await qr.generateQrSvg(req.body.otpauthUri);
    res.json({ svg });
  });

  app.post('/totp/enroll/verify', http.requireAuth(), http.validateBody(TotpEnrollVerifySchema), (req, res) => {
    const ok = auth.verifyTotpEnrollment(db, req.body.authenticatorId, req.body.code, { userId: req.user.id, encryptionKey: totpKey });
    if (!ok) {
      logAudit(req, {
        actor: req.user.username,
        action: 'auth.totp_enroll',
        entity: 'user',
        entityId: req.user.id,
        result: 'failure',
      });
      return res.status(400).json({ error: 'INVALID_CODE', fields: ['code'] });
    }
    logAudit(req, { actor: req.user.username, action: 'auth.totp_enroll', entity: 'user', entityId: req.user.id });
    res.json({ ok: true });
  });

  app.post('/totp/authenticators/:id/remove', http.requireAuth(), (req, res) => {
    const result = auth.removeAuthenticator(db, req.user.id, Number(req.params.id), {
      mfaRequired: mfaRequiredForRole(req.user.role),
    });
    if (!result.ok) {
      const status = result.reason === 'not_found' ? 404 : 409;
      return res.status(status).json({ error: result.reason.toUpperCase(), fields: [] });
    }
    logAudit(req, { actor: req.user.username, action: 'auth.totp_remove', entity: 'user', entityId: req.user.id });
    res.json({ ok: true });
  });

  // --- Recovery codes (§22) -------------------------------------------
  app.post('/recovery-codes/generate', http.requireAuth(), http.validateBody(RecoveryGenerateSchema), async (req, res) => {
    const codes = await auth.generateRecoveryCodes(db, req.user.id, { count: req.body.count });
    logAudit(req, {
      actor: req.user.username,
      action: 'auth.recovery_codes_generate',
      entity: 'user',
      entityId: req.user.id,
      meta: { count: req.body.count },
    });
    res.json({ codes }); // plaintext, shown once - cannot be retrieved again
  });

  app.get('/recovery-codes/remaining', http.requireAuth(), (req, res) => {
    res.json({ remaining: auth.countRemainingRecoveryCodes(db, req.user.id) });
  });

  return {
    /** Forgets the failed-login counters of one user (an administrator just reset that password). */
    forgetLoginFailures(username) {
      const name = String(username).toLowerCase();
      loginPairFailures.resetPrefix(`${name}|`);
      loginUserFailures.reset(name);
    },
    /** Active sign-in lock-outs for the administration: `[{kind, key, failures, retryAfterMs}]` (memory only, audit R-08). */
    lockouts() {
      const trackers = { pair: loginPairFailures, user: loginUserFailures, ip: loginIpFailures, mfa: mfaFailures };
      return Object.entries(trackers).flatMap(([kind, tr]) => tr.list().map((e) => ({ kind, ...e })));
    },
    /** Lifts one lock-out. @returns {boolean} whether there was one */
    unlockLockout(kind, key) {
      const tr = { pair: loginPairFailures, user: loginUserFailures, ip: loginIpFailures, mfa: mfaFailures }[kind];
      if (!tr || !tr.list().some((e) => e.key === key)) return false;
      tr.reset(key);
      return true;
    },
    userPublicShape,
    totpKey,
  };
}
