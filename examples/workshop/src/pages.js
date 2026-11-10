/**
 * Stage B's interactive UI (0.1.13) - plain server-rendered HTML pages
 * with vanilla inline <script>, no client framework and no build step,
 * matching core/ui's own "smallest real thing, not the aspirational
 * §5.4 framework" stance (see shell.js's header comment). These pages
 * call the Stage B API routes (routes.js) via fetch(); nothing here
 * re-implements any of that logic - a form submit is just JSON over
 * the same endpoints curl could hit.
 *
 * TOTP enrollment renders a real scannable QR code (0.1.14, core/qr,
 * backed by the `qrcode` npm package) via POST /totp/enroll/qr.svg,
 * injected as inline <svg> markup. The otpauth:// URI and raw secret
 * are still shown as selectable text underneath - manual entry stays
 * a real fallback for an authenticator app without a camera/scanner,
 * not just a "QR didn't load" afterthought.
 */

import { ui } from '@das-forge/core';
import { translator, scriptTexts } from './messages.js';

export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * The CSP (core/http securityHeaders) only runs scripts that carry the
 * per-request nonce. Every inline <script> below is TEMPLATE-AUTHORED
 * code, so it gets the nonce explicitly - never add the nonce by
 * rewriting finished HTML, or an injected <script> would be blessed
 * too. A missing nonce (tests, non-HTTP rendering) just yields a plain
 * tag.
 */
function nonceAttr(nonce) {
  return nonce ? ` nonce="${escapeHtml(nonce)}"` : '';
}

/** Escaped text lookup for page markup: `const x = text(locale); x('login.title')`. */
function text(locale) {
  const t = translator(locale === 'en' ? 'en' : 'ru');
  return (key) => escapeHtml(t(key));
}

/**
 * Stage E's Realtime Lab (§0.3) - a small interactive demo of
 * core/realtime's SSE transport on its own dedicated 'lab' channel
 * (separate from the 'assets' channel Demo Records uses), so it can be
 * tried without needing to also create/edit assets. Open two browser
 * tabs on this page to see a message sent from one appear live in both.
 */
export function renderRealtimeBody({ nonce, locale } = {}) {
  const x = text(locale);
  const t = translator(locale === 'en' ? 'en' : 'ru');
  const T = scriptTexts({ connected: t('realtime.connected'), lost: t('realtime.lost'), failed: t('realtime.failed') });
  return `
    <h1>${x('realtime.title')}</h1>
    <p><a href="/ui">&larr; ${x('realtime.back')}</a></p>
    <p class="hint">${x('realtime.hint')}</p>
    <form id="labForm">
      <label for="labMessage">${x('realtime.message')}</label>
      <input id="labMessage" maxlength="500" required>
      <button type="submit">${x('realtime.send')}</button>
      <div class="error" id="labError"></div>
    </form>
    <pre id="labLog" style="min-height: 120px; max-height: 280px; overflow-y: auto;"></pre>
    <script${nonceAttr(nonce)}>
      const T = ${T};
      const log = document.getElementById('labLog');
      function append(line) {
        log.textContent += line + '\\n';
        log.scrollTop = log.scrollHeight;
      }
      const source = new EventSource('/events/lab');
      source.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          if (event.type === 'connected') { append(T.connected); return; }
          if (event.type === 'lab-message') { append(event.at + ' ' + event.from + ': ' + event.message); return; }
          append(JSON.stringify(event));
        } catch {
          append(e.data);
        }
      };
      source.onerror = () => append(T.lost);

      document.getElementById('labForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const el = document.getElementById('labError');
        el.textContent = '';
        const input = document.getElementById('labMessage');
        const res = await fetch('/events/lab/broadcast', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: input.value }),
        });
        if (!res.ok) { el.textContent = T.failed; return; }
        input.value = '';
      });
    </script>
  `;
}

