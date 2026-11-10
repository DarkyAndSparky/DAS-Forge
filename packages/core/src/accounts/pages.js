/**
 * HTML of the account pages: sign-in (two steps), forgotten password, new password from the e-mailed link, forced password
 * change and the "Account" body. Plain server-rendered markup with small inline scripts that call the JSON routes of
 * `mountAccountRoutes`; no client framework. Words come from `ACCOUNT_TEXTS` (`l`), so an application can reword any of them.
 *
 * The CSP only runs scripts that carry the per-request nonce; every inline script below is authored here and gets it
 * explicitly. A missing nonce (tests, non-HTTP rendering) just yields a plain tag.
 */
import * as ui from '../ui/index.js';

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function nonceAttr(nonce) {
  return nonce ? ` nonce="${escapeHtml(nonce)}"` : '';
}

/** Escaped text lookup for page markup: `const x = text(l); x('loginTitle')`. */
function text(l) {
  return (key) => escapeHtml(l[key]);
}

/** A JSON object literal that is safe inside an inline <script>: `</script>` and HTML comments cannot end it. */
function scriptTexts(obj) {
  return JSON.stringify(obj).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}

/** A page of its own (no menu): brand block, card, language and theme buttons, "Powered by" line. */
export function pageShell(title, bodyHtml, { nonce, locale = 'ru', brand = null, wide = false } = {}) {
  const loc = locale === 'en' ? 'en' : 'ru';
  return `<!DOCTYPE html>
<html lang="${loc}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  ${ui.themeHead({ ...(brand?.theme ?? {}), nonce })}
  <style${nonceAttr(nonce)}>
    body { margin: 0; font-family: system-ui, sans-serif; background: var(--adm-bg); color: var(--adm-text); display: flex; min-height: 100vh; align-items: center; justify-content: center; }
    .bar { position: fixed; top: 12px; right: 16px; display: flex; gap: 8px; align-items: center; }
    .wrap { display: flex; flex-direction: column; align-items: center; gap: 1rem; }
    .card .brand .adm-logo { max-height: 48px; }
    .card { background: var(--adm-surface); border: 1px solid var(--adm-border); border-radius: 12px; padding: 2rem; width: 380px; max-width: calc(100vw - 2rem); box-shadow: 0 8px 30px rgba(0,0,0,.12); }
    h1 { font-size: 1.2rem; margin: 0 0 1.25rem; }
    ${wide ? '.card { width: 560px; }' : ''}
    h2 { font-size: 1rem; margin: 1.5rem 0 .5rem; }
    label { display: block; font-size: 0.85rem; margin: 0.75rem 0 0.25rem; color: var(--adm-text-dim); }
    input { width: 100%; box-sizing: border-box; padding: 0.55rem 0.7rem; border-radius: 6px; border: 1px solid var(--adm-border); background: var(--adm-bg); color: inherit; font: inherit; }
    input:focus { outline: 2px solid var(--adm-accent); outline-offset: 1px; }
    button { margin-top: 1.25rem; width: 100%; padding: 0.6rem; border-radius: 6px; border: none; background: var(--adm-accent); color: var(--adm-accent-text); font: inherit; font-weight: 600; cursor: pointer; }
    button.secondary { background: transparent; color: var(--adm-text); border: 1px solid var(--adm-border); margin-top: 0.5rem; }
    .error { color: var(--adm-danger); font-size: 0.85rem; margin-top: 0.75rem; min-height: 1em; }
    .hint { font-size: 0.8rem; color: var(--adm-text-dim); margin-top: 0.5rem; }
    code, pre { font-family: ui-monospace, monospace; word-break: break-all; }
    pre { background: var(--adm-bg); padding: 0.75rem; border-radius: 6px; white-space: pre-wrap; }
    a { color: var(--adm-accent); }
  </style>
</head>
<body>
  <div class="bar">${ui.langSwitchHtml(loc)}${ui.themeToggleHtml(loc)}</div>
  <div class="wrap">
    <div class="card">
      ${brand?.html ? `<div class="brand" style="display:flex;align-items:center;gap:.6rem;font-weight:600;margin-bottom:1rem">${brand.html}</div>` : ''}
      ${bodyHtml}
    </div>
    ${ui.poweredByHtml(loc)}
  </div>
</body>
</html>`;
}

/**
 * Two-step login form: step 1 posts /login; if the response says
 * mfaRequired, the SAME page swaps to a code field (TOTP or recovery
 * code, same input - /login/totp and /login/recovery both accept a
 * plain code string) that posts to /login/totp first, falling back to
 * /login/recovery if that specific code looks like a recovery code
 * (contains a dash - TOTP codes are always 6 digits).
 */
export function renderLoginPage({ nonce, locale, brand, l, appName = '', homePath = '/ui', passwordChangePath = '/ui/password', registration = false } = {}) {
  const x = text(l);
  const suffix = appName ? ` — ${appName}` : '';
  const T = scriptTexts({ errDisabled: l.loginErrDisabled, errWrong: l.loginErrWrong, errCode: l.loginErrCode });
  return pageShell(`${l.loginTitle}${suffix}`, `
    <h1>${x('loginTitle')}</h1>
    <form id="step1">
      <label for="username">${x('loginUsername')}</label>
      <input id="username" name="username" autocomplete="username" required>
      <label for="password">${x('loginPassword')}</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">${x('loginSubmit')}</button>
      <div class="error" id="error1"></div>
      <p class="hint"><a href="/forgot-password">${x('loginForgot')}</a>${registration ? ` · <a href="/register">${x('registerLink')}</a>` : ''}</p>
    </form>
    <form id="step2" style="display:none">
      <p class="hint">${x('loginMfaHint')}</p>
      <label for="code">${x('loginCode')}</label>
      <input id="code" name="code" autocomplete="one-time-code" required>
      <button type="submit">${x('loginVerify')}</button>
      <div class="error" id="error2"></div>
    </form>
    <script${nonceAttr(nonce)}>
      const T = ${T};
      const step1 = document.getElementById('step1');
      const step2 = document.getElementById('step2');

      step1.addEventListener('submit', async (e) => {
        e.preventDefault();
        document.getElementById('error1').textContent = '';
        const body = {
          username: document.getElementById('username').value,
          password: document.getElementById('password').value,
        };
        const res = await fetch('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await res.json();
        if (!res.ok) {
          document.getElementById('error1').textContent = data.error === 'ACCOUNT_DISABLED' ? T.errDisabled : T.errWrong;
          return;
        }
        if (data.mfaRequired) {
          step1.style.display = 'none';
          step2.style.display = 'block';
          document.getElementById('code').focus();
        } else {
          window.location.href = data.mustChangePassword ? ${JSON.stringify(passwordChangePath)} : ${JSON.stringify(homePath)};
        }
      });

      step2.addEventListener('submit', async (e) => {
        e.preventDefault();
        document.getElementById('error2').textContent = '';
        const code = document.getElementById('code').value.trim();
        const isRecovery = code.includes('-');
        const res = await fetch(isRecovery ? '/login/recovery' : '/login/totp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        });
        const data = await res.json();
        if (!res.ok) {
          document.getElementById('error2').textContent = T.errCode;
          return;
        }
        window.location.href = data.mustChangePassword ? ${JSON.stringify(passwordChangePath)} : ${JSON.stringify(homePath)};
      });
    </script>
  `, { nonce, locale, brand });
}

/**
 * Shown right after the first sign-in with a temporary password: only a new password (twice), no current password -
 * the sign-in that just happened is the proof. Leaves for / on success.
 */
export function renderForcedPasswordPage({ nonce, locale, brand, l, appName = '', homePath = '/ui', passwordChangePath = '/ui/password', minLength = 12 } = {}) {
  const x = text(l);
  const suffix = appName ? ` — ${appName}` : '';
  const T = scriptTexts({ mismatch: l.forcedMismatch, same: l.forcedSame, notAcceptable: l.forcedNotAcceptable, codes: { TOO_SHORT: l.resetTOO_SHORT, TOO_LONG: l.resetTOO_LONG, COMMON: l.resetCOMMON, SAME_AS_USERNAME: l.resetSAME_AS_USERNAME, REUSED: l.resetREUSED, LEAKED: l.resetLEAKED, TOO_FEW_CLASSES: l.resetTOO_FEW_CLASSES, CONTAINS_CONTEXT: l.resetCONTAINS_CONTEXT } });
  return pageShell(`${l.forcedTitle}${suffix}`, `
    <h1>${x('forcedTitle')}</h1>
    <p class="hint">${x('forcedHint')}</p>
    <form id="pwForm">
      <label for="newPassword">${x('forcedNewPassword')}</label>
      <input id="newPassword" type="password" autocomplete="new-password" minlength="${minLength}" maxlength="128" required autofocus>
      <label for="repeatPassword">${x('forcedRepeat')}</label>
      <input id="repeatPassword" type="password" autocomplete="new-password" minlength="${minLength}" maxlength="128" required>
      <button type="submit">${x('forcedSave')}</button>
      <div class="error" id="pwError"></div>
    </form>
    <script${nonceAttr(nonce)}>
      const T = ${T};
      document.getElementById('pwForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const el = document.getElementById('pwError');
        const a = document.getElementById('newPassword').value;
        if (a !== document.getElementById('repeatPassword').value) { el.textContent = T.mismatch; return; }
        const res = await fetch('/password/change', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ newPassword: a }) });
        if (res.ok) { window.location.href = ${JSON.stringify(homePath)}; return; }
        const data = await res.json().catch(() => ({}));
        el.textContent = data.problems && data.problems.includes('same_as_current') ? T.same : (data.problems || []).map((c) => T.codes[c] || T.notAcceptable).join(' ') || T.notAcceptable;
      });
    </script>
  `, { nonce, locale, brand });
}

/**
 * The account page's body (meant to be dropped into core/ui's
 * renderAppShell() as `bodyHtml`, same as routes.js's existing /ui
 * route does - this is NOT a full page itself, see registerRoutes()).
 * Server-rendered with the viewer's OWN data (never another user's -
 * every fetch() below only ever hits endpoints scoped to req.user via
 * the session, same zero-trust property as the API itself); the forms
 * are the thinnest possible wrapper around the Stage B API.
 */
export function renderAccountBody({ user, authenticators, mfaRequiredForRole, nonce, email = null, l, homePath = '/ui', accountPath = '/ui/account', locale = 'ru', minLength = 12 } = {}) {
  const x = text(l);
  const T = scriptTexts({
    pwWrong: l.accountPwWrong, pwDone: l.accountPwDone, pwWeak: l.resetNotAcceptable,
    pwCodes: { TOO_SHORT: l.resetTOO_SHORT, TOO_LONG: l.resetTOO_LONG, COMMON: l.resetCOMMON, SAME_AS_USERNAME: l.resetSAME_AS_USERNAME, REUSED: l.resetREUSED, LEAKED: l.resetLEAKED, TOO_FEW_CLASSES: l.resetTOO_FEW_CLASSES, CONTAINS_CONTEXT: l.resetCONTAINS_CONTEXT },
    emailSaved: l.accountEmailSaved, emailRemoved: l.accountEmailRemoved,
    emailTaken: l.accountEmailTaken, emailInvalid: l.accountEmailInvalid,
    manualSecret: l.accountManualSecret, wrongCode: l.accountWrongCode,
    cannotRemove: l.accountCannotRemove, cannotRemoveTitle: l.accountCannotRemoveTitle,
  });
  const statusText = (s) => (s === 'active' ? x('accountStatusActive') : s === 'pending' ? x('accountStatusPending') : escapeHtml(s));
  const authList = authenticators.length
    ? authenticators
        .map(
          (a) => `<li>
            ${a.name ? escapeHtml(a.name) : x('accountUnnamed')} — <strong>${statusText(a.status)}</strong>
            ${a.status === 'active' ? `<button class="secondary remove-auth" data-id="${escapeHtml(a.id)}">${x('accountRemove')}</button>` : ''}
          </li>`
        )
        .join('')
    : `<li class="hint">${x('accountNoAuth')}</li>`;

  return `
    <h1>${x('accountTitle')} — ${escapeHtml(user.username)}</h1>
    <p><a href="${escapeHtml(homePath)}">&larr; ${x('accountBack')}</a> · <a href="#" id="logoutLink" style="font-weight:600;color:var(--adm-accent,inherit);border:1px solid currentColor;border-radius:6px;padding:.15rem .6rem;text-decoration:none">${x('accountSignOut')}</a></p>
    <script${nonceAttr(nonce)}>
      document.getElementById('logoutLink').addEventListener('click', async (e) => {
        e.preventDefault();
        await fetch('/logout', { method: 'POST' });
        window.location.href = '/login';
      });
    </script>
    <style${nonceAttr(nonce)}>
      .acc-nav{display:flex;flex-wrap:wrap;gap:.25rem;margin:1rem 0;padding:.25rem;border:1px solid var(--adm-border);border-radius:10px;background:var(--adm-surface);width:fit-content;max-width:100%}
      .acc-nav a{padding:.4rem .8rem;border-radius:7px;text-decoration:none;color:var(--adm-text);font-size:.9rem}
      .acc-nav a:hover{background:var(--adm-border)}
      .acc-nav a[aria-current="true"]{background:var(--adm-accent);color:var(--adm-accent-text);font-weight:600}
      .acc-js [data-acc]{display:none}.acc-js [data-acc].acc-on{display:block}
    </style>
    <nav class="acc-nav" aria-label="${x('accountTitle')}">
      <a href="#pw">${x('accountPwTitle')}</a><a href="#email">${x('accountEmailTitle')}</a><a href="#ui">${x('accountUiTitle')}</a><a href="#mfa">${x('accountMfaTitle')}</a>
    </nav>
    <script${nonceAttr(nonce)}>
      (function () {
        var root = document.querySelector('.acc-nav').parentNode, links = document.querySelectorAll('.acc-nav a');
        function show() {
          var id = (location.hash || '#pw').slice(1);
          if (!root.querySelector('[data-acc="' + id + '"]')) id = 'pw';
          root.classList.add('acc-js');
          root.querySelectorAll('[data-acc]').forEach(function (s) { s.classList.toggle('acc-on', s.getAttribute('data-acc') === id); });
          links.forEach(function (a) { if (a.getAttribute('href') === '#' + id) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current'); });
        }
        window.addEventListener('hashchange', show);
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show); else show();
      })();
    </script>
    <section data-acc="pw">
      <h2>${x('accountPwTitle')}</h2>
      <form id="pwForm">
        <label for="currentPassword">${x('accountPwCurrent')}</label>
        <input id="currentPassword" type="password" autocomplete="current-password" required>
        <label for="newPassword">${x('accountPwNew')}</label>
        <input id="newPassword" type="password" autocomplete="new-password" minlength="${minLength}" maxlength="128" required>
        <button type="submit">${x('accountPwSubmit')}</button>
        <div class="error" id="pwError"></div>
      </form>
    </section>

    <section data-acc="email">
      <h2>${x('accountEmailTitle')}</h2>
      <form id="emailForm">
        <label for="accountEmail">${x('accountEmailLabel')}</label>
        <input id="accountEmail" type="email" autocomplete="email" maxlength="254" value="${escapeHtml(email ?? '')}">
        <button type="submit">${x('accountEmailSave')}</button>
        <div class="error" id="emailError"></div>
      </form>
    </section>

    <section data-acc="ui">
      <h2>${x('accountUiTitle')}</h2>
      <p>${x('accountLang')}: <a href="${escapeHtml(accountPath)}?lang=ru"${locale === 'ru' ? ' aria-current="true"><strong>RU</strong>' : '>RU'}</a> · <a href="${escapeHtml(accountPath)}?lang=en"${locale === 'en' ? ' aria-current="true"><strong>EN</strong>' : '>EN'}</a></p>
      <p>${x('accountTheme')}:
        <button type="button" class="secondary" style="width:auto;margin:.25rem .25rem 0 0;padding:.4rem .8rem" data-theme-set="">${x('accountThemeAuto')}</button>
        <button type="button" class="secondary" style="width:auto;margin:.25rem .25rem 0 0;padding:.4rem .8rem" data-theme-set="light">${x('accountThemeLight')}</button>
        <button type="button" class="secondary" style="width:auto;margin:.25rem .25rem 0 0;padding:.4rem .8rem" data-theme-set="dark">${x('accountThemeDark')}</button></p>
      <p class="hint">${x('accountUiHint')}</p>
      <script${nonceAttr(nonce)}>
        document.querySelectorAll('[data-theme-set]').forEach(function (b) {
          b.addEventListener('click', function () {
            var v = b.getAttribute('data-theme-set'), r = document.documentElement;
            if (v) r.setAttribute('data-theme', v); else r.removeAttribute('data-theme');
            try { if (v) localStorage.setItem('adm-theme', v); else localStorage.removeItem('adm-theme'); } catch (e) {}
          });
        });
      </script>
    </section>

    <section data-acc="mfa">
      <h2>${x('accountMfaTitle')}${mfaRequiredForRole ? ` <span class="hint">${x('accountMfaRequired')}</span>` : ''}</h2>
      <ul id="authList">${authList}</ul>
      <button class="secondary" id="enrollBtn">${x('accountAdd')}</button>
      <div id="enrollPanel" style="display:none">
        <p class="hint">${x('accountScan')}</p>
        <div id="enrollQr" style="background:#fff; padding:0.75rem; border-radius:4px; width:fit-content; margin:0 auto;"></div>
        <p class="hint">${x('accountManual')}</p>
        <pre id="enrollUri"></pre>
        <label for="enrollCode">${x('accountCode')}</label>
        <input id="enrollCode" autocomplete="one-time-code">
        <button id="enrollVerifyBtn">${x('accountConfirm')}</button>
        <div class="error" id="enrollError"></div>
      </div>
    </section>

    <section data-acc="mfa">
      <h2>${x('accountRecoveryTitle')}</h2>
      <button class="secondary" id="recoveryBtn">${x('accountRecoveryGenerate')}</button>
      <p class="hint">${x('accountRecoveryHint')}</p>
      <pre id="recoveryCodes" style="display:none"></pre>
    </section>

    <script${nonceAttr(nonce)}>
      const T = ${T};
      async function postJson(url, body) {
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
        const data = await res.json().catch(() => ({}));
        return { ok: res.ok, data };
      }

      document.getElementById('pwForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const el = document.getElementById('pwError');
        el.textContent = '';
        el.style.color = '';
        const { ok, data } = await postJson('/password/change', {
          currentPassword: document.getElementById('currentPassword').value,
          newPassword: document.getElementById('newPassword').value,
        });
        if (ok) { el.style.color = '#6fc97a'; el.textContent = T.pwDone; e.target.reset(); }
        else el.textContent = data && data.error === 'WEAK_PASSWORD' ? (data.problems || []).map((c) => T.pwCodes[c] || T.pwWeak).join(' ') : T.pwWrong;
      });

      document.getElementById('emailForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const el = document.getElementById('emailError');
        const value = document.getElementById('accountEmail').value.trim();
        const { ok, data } = await postJson('/account/email', { email: value === '' ? null : value });
        el.style.color = ok ? '#6fc97a' : '';
        el.textContent = ok ? (value === '' ? T.emailRemoved : T.emailSaved) : (data.error === 'EMAIL_TAKEN' ? T.emailTaken : T.emailInvalid);
      });

      let pendingAuthenticatorId = null;
      document.getElementById('enrollBtn').addEventListener('click', async () => {
        const { ok, data } = await postJson('/totp/enroll/start', { name: 'authenticator' });
        if (!ok) return;
        pendingAuthenticatorId = data.authenticatorId;
        document.getElementById('enrollUri').textContent = data.otpauthUri + '\\n\\n(' + T.manualSecret + ': ' + data.secret + ')';
        document.getElementById('enrollPanel').style.display = 'block';
        const qrBox = document.getElementById('enrollQr');
        qrBox.textContent = '';
        const { ok: qrOk, data: qrData } = await postJson('/totp/enroll/qr.svg', { otpauthUri: data.otpauthUri });
        if (qrOk) qrBox.innerHTML = qrData.svg; // trusted: SVG produced by this server's own QR encoder (/totp/enroll/qr.svg), never user input
      });
      document.getElementById('enrollVerifyBtn').addEventListener('click', async () => {
        const el = document.getElementById('enrollError');
        const { ok } = await postJson('/totp/enroll/verify', {
          authenticatorId: pendingAuthenticatorId,
          code: document.getElementById('enrollCode').value.trim(),
        });
        if (!ok) { el.textContent = T.wrongCode; return; }
        window.location.reload();
      });

      document.querySelectorAll('.remove-auth').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const res = await fetch('/totp/authenticators/' + btn.dataset.id + '/remove', { method: 'POST' });
          if (res.status === 409) { await admDialog.alert(T.cannotRemove, { title: T.cannotRemoveTitle }); return; }
          window.location.reload();
        });
      });

      document.getElementById('recoveryBtn').addEventListener('click', async () => {
        const { ok, data } = await postJson('/recovery-codes/generate', { count: 8 });
        if (!ok) return;
        const pre = document.getElementById('recoveryCodes');
        pre.textContent = data.codes.join('\\n');
        pre.style.display = 'block';
      });
    </script>
  `;
}

/** Asks for a login or e-mail; the server answers 202 the same way whatever was typed. */
export function renderForgotPasswordPage({ nonce, locale, brand, l, appName = '', homePath = '/ui', passwordChangePath = '/ui/password' } = {}) {
  const x = text(l);
  const suffix = appName ? ` — ${appName}` : '';
  const T = scriptTexts({ tooMany: l.forgotTooMany, enterLogin: l.forgotEnterLogin });
  return pageShell(`${l.forgotTitle}${suffix}`, `
    <h1>${x('forgotTitle')}</h1>
    <form id="forgot">
      <label for="login">${x('forgotLogin')}</label>
      <input id="login" name="login" autocomplete="username" maxlength="254" required>
      <button type="submit">${x('forgotSend')}</button>
      <div class="error" id="err"></div>
    </form>
    <p id="done" class="hint" style="display:none">${x('forgotDone')}</p>
    <p class="hint"><a href="/login">${x('forgotBack')}</a></p>
    <script${nonceAttr(nonce)}>
      const T = ${T};
      document.getElementById('forgot').addEventListener('submit', async (e) => {
        e.preventDefault();
        document.getElementById('err').textContent = '';
        const res = await fetch('/password/forgot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ login: document.getElementById('login').value.trim() }),
        });
        if (res.status === 429) { document.getElementById('err').textContent = T.tooMany; return; }
        if (!res.ok) { document.getElementById('err').textContent = T.enterLogin; return; }
        document.getElementById('forgot').style.display = 'none';
        document.getElementById('done').style.display = 'block';
      });
    </script>
  `, { nonce, locale, brand });
}

/**
 * Landing page of the e-mailed link. The token lives in the URL FRAGMENT, so it never
 * reaches server logs or a Referer header; the script reads it, removes it from the
 * address bar and posts it to /password/reset.
 */
export function renderResetPasswordPage({ nonce, locale, brand, l, appName = '', homePath = '/ui', passwordChangePath = '/ui/password' } = {}) {
  const x = text(l);
  const suffix = appName ? ` — ${appName}` : '';
  const T = scriptTexts({
    mismatch: l.resetMismatch, tooMany: l.resetTooMany, notAcceptable: l.resetNotAcceptable,
    codes: { TOO_SHORT: l.resetTOO_SHORT, TOO_LONG: l.resetTOO_LONG, COMMON: l.resetCOMMON, SAME_AS_USERNAME: l.resetSAME_AS_USERNAME, REUSED: l.resetREUSED, LEAKED: l.resetLEAKED, TOO_FEW_CLASSES: l.resetTOO_FEW_CLASSES, CONTAINS_CONTEXT: l.resetCONTAINS_CONTEXT },
  });
  return pageShell(`${l.resetTitle}${suffix}`, `
    <h1>${x('resetTitle')}</h1>
    <form id="reset">
      <label for="p1">${x('resetNewPassword')}</label>
      <input id="p1" type="password" autocomplete="new-password" maxlength="128" required>
      <label for="p2">${x('resetRepeat')}</label>
      <input id="p2" type="password" autocomplete="new-password" maxlength="128" required>
      <button type="submit">${x('resetSave')}</button>
      <div class="error" id="err"></div>
    </form>
    <p id="done" class="hint" style="display:none">${x('resetDone')} <a href="/login">${x('resetSignIn')}</a></p>
    <p id="bad" class="error" style="display:none">${x('resetBad')} <a href="/forgot-password">${x('resetAskNew')}</a></p>
    <script${nonceAttr(nonce)}>
      const T = ${T};
      const m = /(?:^#|&)token=([^&]+)/.exec(location.hash);
      const token = m ? decodeURIComponent(m[1]) : '';
      history.replaceState(null, '', location.pathname);
      const form = document.getElementById('reset');
      if (!token) { form.style.display = 'none'; document.getElementById('bad').style.display = 'block'; }
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const err = document.getElementById('err');
        err.textContent = '';
        const newPassword = document.getElementById('p1').value;
        if (newPassword !== document.getElementById('p2').value) { err.textContent = T.mismatch; return; }
        const res = await fetch('/password/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, newPassword }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) { form.style.display = 'none'; document.getElementById('done').style.display = 'block'; return; }
        if (data.error === 'WEAK_PASSWORD') { err.textContent = (data.problems || []).map((c) => T.codes[c] || T.notAcceptable).join(' '); return; }
        if (res.status === 429) { err.textContent = T.tooMany; return; }
        form.style.display = 'none';
        document.getElementById('bad').style.display = 'block';
      });
    </script>
  `, { nonce, locale, brand });
}

/** Self-registration form. A hidden field and the time spent on the form are the cheap bot filters; the mailed link is the real one. */
export function renderRegisterPage({ nonce, locale, brand, l, appName = '' } = {}) {
  const x = text(l);
  const suffix = appName ? ` — ${appName}` : '';
  const T = scriptTexts({ invalid: l.registerInvalid, weak: l.registerWeak, tooMany: l.registerTooMany, noMail: l.registerNoMail, done: l.registerDone, doneNow: l.registerDoneNow });
  return pageShell(`${l.registerTitle}${suffix}`, `
    <h1>${x('registerTitle')}</h1>
    <form id="reg">
      <label for="u">${x('registerUsername')}</label>
      <input id="u" autocomplete="username" maxlength="64" required>
      <label for="e">${x('registerEmail')}</label>
      <input id="e" type="email" autocomplete="email" maxlength="254" required>
      <label for="p">${x('registerPassword')}</label>
      <input id="p" type="password" autocomplete="new-password" maxlength="128" required>
      <div style="position:absolute;left:-10000px" aria-hidden="true"><label>Website <input id="w" tabindex="-1" autocomplete="off"></label></div>
      <button type="submit">${x('registerSubmit')}</button>
      <div class="error" id="err"></div>
    </form>
    <p id="done" class="hint" style="display:none"></p>
    <p class="hint"><a href="/login">${x('registerBack')}</a></p>
    <script${nonceAttr(nonce)}>
      const T = ${T};
      const opened = Date.now();
      document.getElementById('reg').addEventListener('submit', async (e) => {
        e.preventDefault();
        const err = document.getElementById('err');
        err.textContent = '';
        const res = await fetch('/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: document.getElementById('u').value.trim(), email: document.getElementById('e').value.trim(), password: document.getElementById('p').value, website: document.getElementById('w').value, t: opened }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) { document.getElementById('reg').style.display = 'none'; const d = document.getElementById('done'); d.textContent = res.status === 201 ? T.doneNow : T.done; d.style.display = 'block'; return; }
        if (res.status === 429) err.textContent = T.tooMany;
        else if (data.error === 'WEAK_PASSWORD') err.textContent = T.weak;
        else if (data.error === 'EMAIL_DISABLED') err.textContent = T.noMail;
        else err.textContent = T.invalid;
      });
    </script>
  `, { nonce, locale, brand });
}

/** Landing page of the mailed link; the token is in the URL fragment (never in logs or Referer) and is posted once. */
export function renderRegisterConfirmPage({ nonce, locale, brand, l, appName = '' } = {}) {
  const x = text(l);
  const suffix = appName ? ` — ${appName}` : '';
  return pageShell(`${l.confirmTitle}${suffix}`, `
    <h1>${x('confirmTitle')}</h1>
    <p id="done" class="hint" style="display:none">${x('confirmDone')} <a href="/login">${x('confirmSignIn')}</a></p>
    <p id="bad" class="error" style="display:none">${x('confirmBad')} <a href="/register">${x('registerLink')}</a></p>
    <script${nonceAttr(nonce)}>
      const m = /(?:^#|&)token=([^&]+)/.exec(location.hash);
      const token = m ? decodeURIComponent(m[1]) : '';
      history.replaceState(null, '', location.pathname);
      (async () => {
        if (!token) { document.getElementById('bad').style.display = 'block'; return; }
        const res = await fetch('/register/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
        document.getElementById(res.ok ? 'done' : 'bad').style.display = 'block';
      })();
    </script>
  `, { nonce, locale, brand });
}
