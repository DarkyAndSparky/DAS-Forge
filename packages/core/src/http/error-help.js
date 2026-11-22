/**
 * The "what you can do" block of an error page and the client-side diagnostics (collected only after the
 * person agrees, shown in full before anything is used, copied or saved to a file - never sent anywhere
 * by the page itself; the person writes to the administrator's address on their own).
 *
 * `kind` tells which situation it is: 'ban', 'rate', 'csrf', 'session', 'forbidden', 'notfound', 'server',
 * 'maintenance', 'generic'. Bans and the like get a minimal set of facts (see `MINIMAL_KINDS`): nothing that
 * could help to get around a block.
 */

/** Kinds whose diagnostics carry only the code, the request id and the time. */
export const MINIMAL_KINDS = new Set(['ban']);

/** The kind of a situation from the status and the guard's error code. */
export function kindOf(statusCode, errorCode = '') {
  if (errorCode === 'BANNED') return 'ban';
  if (errorCode === 'RATE_LIMITED' || statusCode === 429) return 'rate';
  if (errorCode === 'CSRF_REJECTED') return 'csrf';
  if (errorCode === 'UNAUTHENTICATED' || statusCode === 401) return 'session';
  if (errorCode === 'FORBIDDEN' || statusCode === 403) return 'forbidden';
  if (statusCode === 404 || statusCode === 410) return 'notfound';
  if (statusCode === 503) return 'unavailable';
  if (statusCode >= 500) return 'server';
  return 'generic';
}

/** Page texts for situations where the status code's own text would mislead (a ban is not "no rights"). */
const KIND_TEXT = {
  ru: {
    ban: { title: 'Доступ ограничен', message: 'Доступ к сервису для вас сейчас ограничен.', hint: 'Если вы считаете, что это ошибка, обратитесь к администратору и назовите код запроса внизу страницы.' },
    csrf: { title: 'Страница устарела', message: 'Форма была открыта слишком давно или в другой вкладке.', hint: 'Вернитесь назад, обновите страницу и повторите действие.' },
    rate: { title: 'Слишком много попыток', message: 'Сервис временно не принимает ваши запросы.', hint: 'Подождите и повторите.' },
  },
  en: {
    ban: { title: 'Access restricted', message: 'Your access to this service is restricted right now.', hint: 'If you think this is a mistake, contact the administrator and give them the request id at the bottom of the page.' },
    csrf: { title: 'Page expired', message: 'The form was opened too long ago or in another tab.', hint: 'Go back, refresh the page and repeat the action.' },
    rate: { title: 'Too many attempts', message: 'The service is not accepting your requests for a while.', hint: 'Wait and try again.' },
  },
};

/** `{title, message, hint}` overrides for a kind, or undefined. */
export function kindText(kind, locale = 'ru') {
  return KIND_TEXT[locale === 'en' ? 'en' : 'ru'][kind];
}

const L = {
  ru: {
    what: 'Что можно сделать',
    steps: {
      ban: ['Не повторяйте попытки: это не снимет ограничение.', 'Напишите администратору, назовите код запроса и время.', 'Ограничение могли поставить по ошибке, администратор может его проверить.'],
      rate: ['Подождите указанное время и повторите.', 'Не обновляйте страницу много раз подряд: так ожидание только удлиняется.', 'Если ограничение мешает работе, напишите администратору.'],
      csrf: ['Вернитесь назад, обновите страницу (F5) и отправьте форму снова.', 'Не держите форму открытой слишком долго.', 'Если повторяется, включите cookie для этого сайта.'],
      session: ['Войдите снова и повторите действие.', 'Сессия могла истечь или вы вышли в другой вкладке.', 'Если вход не получается, напишите администратору.'],
      forbidden: ['Проверьте, что вы вошли под своей учётной записью.', 'Если доступ нужен, напишите администратору: что вы хотели сделать и на какой странице.', 'Доступ может зависеть от группы или организации.'],
      notfound: ['Проверьте адрес или откройте страницу через меню.', 'Запись могли удалить или она относится к другой организации.'],
      server: ['Повторите через минуту.', 'Если ошибка остаётся, соберите диагностику и отправьте администратору.', 'Часто причина в сети: прокси, VPN или блокировка соединения.'],
      unavailable: ['Подождите минуту и обновите страницу.', 'Если сервис не отвечает долго, соберите диагностику и отправьте администратору.', 'Проверьте сеть, VPN или прокси.'],
      generic: ['Вернитесь назад и повторите действие.', 'Если ошибка остаётся, соберите диагностику и отправьте администратору.'],
    },
    diag: 'Собрать диагностику', consent: 'Я согласен(на) собрать эти данные. Они не отправляются сами: вы можете скопировать их или сохранить в файл.',
    collect: 'Показать данные', copy: 'Скопировать', copied: 'Скопировано', save: 'Скачать файл', previewHint: 'Это всё, что попадёт в файл. Cookie, пароли и содержимое форм не собираются.',
    toAdmin: 'Отправьте файл администратору приложения:', noAdmin: 'Передайте файл администратору приложения.', needJs: 'Для сбора диагностики нужен включённый JavaScript. Назовите администратору код запроса.',
    ref: 'Код обращения',
  },
  en: {
    what: 'What you can do',
    steps: {
      ban: ['Do not retry: it will not lift the restriction.', 'Write to the administrator with the request id and the time.', 'The restriction may have been set by mistake; the administrator can check it.'],
      rate: ['Wait for the time shown and try again.', 'Do not refresh many times in a row: the wait only gets longer.', 'If the limit gets in your way, write to the administrator.'],
      csrf: ['Go back, refresh the page (F5) and submit the form again.', 'Do not keep a form open for too long.', 'If it keeps happening, enable cookies for this site.'],
      session: ['Sign in again and repeat the action.', 'The session may have expired or you signed out in another tab.', 'If you cannot sign in, write to the administrator.'],
      forbidden: ['Check that you are signed in with your own account.', 'If you need access, tell the administrator what you wanted to do and on which page.', 'Access may depend on your group or organization.'],
      notfound: ['Check the address or open the page from the menu.', 'The record may have been deleted or belongs to another organization.'],
      server: ['Try again in a minute.', 'If it persists, collect diagnostics and send them to the administrator.', 'Often the network is the cause: a proxy, a VPN or a blocked connection.'],
      unavailable: ['Wait a minute and refresh the page.', 'If the service does not answer for long, collect diagnostics and send them to the administrator.', 'Check your network, VPN or proxy.'],
      generic: ['Go back and repeat the action.', 'If it persists, collect diagnostics and send them to the administrator.'],
    },
    diag: 'Collect diagnostics', consent: 'I agree to collect this data. It is not sent by itself: you can copy it or save it to a file.',
    collect: 'Show the data', copy: 'Copy', copied: 'Copied', save: 'Download file', previewHint: 'This is everything that goes into the file. Cookies, passwords and form contents are not collected.',
    toAdmin: 'Send the file to the application administrator:', noAdmin: 'Give the file to the application administrator.', needJs: 'Collecting diagnostics needs JavaScript. Tell the administrator the request id.',
    ref: 'Reference',
  },
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** A plausible address only: no spaces, quotes, angle brackets or line breaks. */
export function safeEmail(v) {
  const s = String(v ?? '').trim();
  return /^[^\s"'<>(),;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/.test(s) ? s : '';
}

const CSS = `
  .help { max-width:520px; margin:1rem auto 0; text-align:left; border:1px solid var(--border); border-radius:8px; padding:.75rem 1rem; }
  .help h2 { font-size:1rem; margin:0 0 .4rem; }
  .help ul { margin:0 0 .6rem 1.1rem; padding:0; color:var(--muted); font-size:.9rem; }
  .help details { margin-top:.5rem; }
  .help summary { cursor:pointer; color:var(--adm-accent); }
  .help label.consent { display:flex; gap:.5rem; align-items:flex-start; margin:.5rem 0; font-size:.85rem; }
  .help textarea { width:100%; min-height:9rem; box-sizing:border-box; font:12px ui-monospace,monospace; background:var(--bg); color:var(--fg); border:1px solid var(--border); border-radius:6px; }
  .help button { padding:5px 12px; border:1px solid var(--border); border-radius:6px; background:transparent; color:var(--adm-accent); cursor:pointer; margin-right:6px; }
  .help button:disabled { opacity:.5; cursor:default; }
  .help .small { font-size:.8rem; color:var(--muted); margin:.4rem 0; }
  .help .ref { font-family:ui-monospace,monospace; }
  .help [hidden] { display:none; }
`;

/** CSS of the help block (the page puts it into its own style element). */
export const HELP_CSS = CSS;

/**
 * @param {{kind: string, statusCode: number, requestId?: string, locale?: 'ru'|'en', supportEmail?: string, nonce?: string}} o
 * @returns {string} trusted HTML (inline script carries the nonce when given)
 */
export function helpBlockHtml({ kind = 'generic', statusCode, requestId = '', locale = 'ru', supportEmail = '', nonce = '' }) {
  const t = L[locale === 'en' ? 'en' : 'ru'];
  const steps = (t.steps[kind] ?? t.steps.generic).map((s) => `<li>${esc(s)}</li>`).join('');
  const mail = safeEmail(supportEmail);
  const minimal = MINIMAL_KINDS.has(kind);
  const cfg = JSON.stringify({ k: kind, c: statusCode, r: String(requestId).slice(0, 80), m: minimal ? 1 : 0, t: { copied: t.copied, copy: t.copy } }).replace(/</g, '\\u003c');
  const toAdmin = mail ? `${esc(t.toAdmin)} <a href="mailto:${esc(mail)}">${esc(mail)}</a>` : esc(t.noAdmin);
  return `<section class="help" aria-labelledby="help-h">
<h2 id="help-h">${esc(t.what)}</h2>
<ul>${steps}</ul>
<details id="diag" hidden><summary>${esc(t.diag)}</summary>
<label class="consent"><input type="checkbox" id="diag-ok"> <span>${esc(t.consent)}</span></label>
<button type="button" id="diag-go" disabled>${esc(t.collect)}</button>
<div id="diag-out" hidden>
<p class="small">${esc(t.previewHint)}</p>
<textarea id="diag-text" readonly aria-label="${esc(t.diag)}"></textarea>
<button type="button" id="diag-copy">${esc(t.copy)}</button><button type="button" id="diag-save">${esc(t.save)}</button>
<p class="small">${toAdmin}</p>
</div></details>
<noscript><p class="small">${esc(t.needJs)}${mail ? ` ${toAdmin}` : ''}</p></noscript>
</section>
<script${nonce ? ` nonce="${esc(nonce)}"` : ''}>(function(){var C=${cfg};var d=document.getElementById('diag');if(!d)return;d.hidden=false;
var ok=document.getElementById('diag-ok'),go=document.getElementById('diag-go'),out=document.getElementById('diag-out'),ta=document.getElementById('diag-text');
ok.addEventListener('change',function(){go.disabled=!ok.checked;});
function build(){var L=['kind: '+C.k,'status: '+C.c];if(C.r)L.push('request-id: '+C.r);L.push('time: '+new Date().toISOString());
if(!C.m){var n=navigator,cn=n.connection||{};L.push('path: '+location.pathname,'page-title: '+document.title,'language: '+(n.language||''),'timezone: '+(Intl.DateTimeFormat().resolvedOptions().timeZone||''),'browser: '+(n.userAgent||''),'online: '+(n.onLine?'yes':'no'));
if(cn.effectiveType)L.push('network: '+cn.effectiveType+(cn.saveData?' (data saver)':''));L.push('cookies-enabled: '+(n.cookieEnabled?'yes':'no'),'screen: '+screen.width+'x'+screen.height);}
return L.join('\\n')+'\\n';}
go.addEventListener('click',function(){if(!ok.checked)return;ta.value=build();out.hidden=false;});
document.getElementById('diag-copy').addEventListener('click',function(e){var b=e.target;var done=function(){var o=b.textContent;b.textContent=C.t.copied;setTimeout(function(){b.textContent=o;},1500);};
if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(ta.value).then(done,function(){ta.select();});}else{ta.select();try{document.execCommand('copy');done();}catch(x){}}});
document.getElementById('diag-save').addEventListener('click',function(){var u=URL.createObjectURL(new Blob([ta.value],{type:'text/plain'}));var a=document.createElement('a');a.href=u;a.download='diagnostics-'+(C.r||Date.now())+'.txt';document.body.appendChild(a);a.click();a.remove();setTimeout(function(){URL.revokeObjectURL(u);},1000);});})();</script>`;
}
