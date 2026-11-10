/**
 * Server-rendered pages without a client framework: the sign-in page and the forced password change. Pages that
 * live inside the application shell (home, your own) are just a body handed to `ui.renderAppShell` in routes.js.
 *
 * The CSP only runs scripts that carry the per-request nonce, so every inline <script> here is template-authored
 * code with `nonceAttr(nonce)`; never add a nonce by rewriting finished HTML.
 */
import { ui } from '@das-forge/core';
import { translator, scriptTexts } from './messages.js';

export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const nonceAttr = (nonce) => (nonce ? ` nonce="${escapeHtml(nonce)}"` : '');
const text = (locale) => { const t = translator(locale); return (key) => escapeHtml(t(key)); };

/** The start page body (inside the application shell). */
export function renderHomeBody(user, locale) {
  const t = translator(locale);
  const can = (perm) => user.permissions.includes(perm);
  const cards = [
    ['/ui/notes', 'notes', can('read:notes')],
    ['/admin', 'admin', can('admin.access')],
  ].filter((c) => c[2]);
  return `<h1>${escapeHtml(t('home.signedIn'))} <strong>${escapeHtml(user.username)}</strong></h1>`
    + `<div class="adm-grid">${cards.map(([href, k]) => `<a class="adm-card" href="${href}" style="text-decoration:none;color:inherit"><h2>${escapeHtml(t(`home.${k}Title`))}</h2><p>${escapeHtml(t(`home.${k}Text`))}</p></a>`).join('')}</div>`;
}

/**
 * A page with data: the list comes from the JSON API (`GET /notes`), the form and the delete buttons call
 * `POST /notes` and `DELETE /notes/:id`. Rows are built with textContent, never innerHTML, so a note cannot
 * inject markup. Without `canWrite` the form and the buttons are not even rendered (the API checks it again).
 */
export function renderNotesBody({ nonce, locale, canWrite = false } = {}) {
  const x = text(locale);
  const t = translator(locale);
  const T = scriptTexts({ empty: t('notes.empty'), remove: t('notes.remove'), by: t('notes.by'), failed: t('notes.failed'), canWrite });
  return `
    <h1>${x('notes.title')}</h1>
    <p><a href="/ui">&larr; ${x('notes.back')}</a></p>
    ${canWrite ? `<form id="noteForm" style="display:flex;gap:.5rem;margin:1rem 0">
      <input id="noteBody" maxlength="2000" placeholder="${x('notes.placeholder')}" required style="flex:1">
      <button type="submit" style="width:auto;margin-top:0">${x('notes.add')}</button>
    </form>` : ''}
    <div class="error" id="noteError" role="alert"></div>
    <ul id="noteList" style="list-style:none;padding:0"></ul>
    <script${nonceAttr(nonce)}>
      const T = ${T};
      const list = document.getElementById('noteList');
      const err = document.getElementById('noteError');
      async function load() {
        const res = await fetch('/notes');
        if (!res.ok) { err.textContent = T.failed; return; }
        const notes = await res.json();
        list.textContent = '';
        if (!notes.length) { const li = document.createElement('li'); li.textContent = T.empty; list.appendChild(li); return; }
        for (const n of notes) {
          const li = document.createElement('li');
          li.style.cssText = 'padding:.4rem 0;border-bottom:1px solid var(--adm-border)';
          li.textContent = n.body + ' (' + T.by + ' ' + n.author + ', ' + n.createdAt + ') ';
          if (T.canWrite) {
            const b = document.createElement('button');
            b.type = 'button'; b.textContent = T.remove; b.style.cssText = 'width:auto;margin:0 0 0 .5rem;padding:.2rem .5rem';
            b.addEventListener('click', async () => { const r = await fetch('/notes/' + n.id, { method: 'DELETE' }); if (r.ok) load(); else err.textContent = T.failed; });
            li.appendChild(b);
          }
          list.appendChild(li);
        }
      }
      const form = document.getElementById('noteForm');
      if (form) form.addEventListener('submit', async (e) => {
        e.preventDefault();
        err.textContent = '';
        const input = document.getElementById('noteBody');
        const r = await fetch('/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: input.value }) });
        if (r.ok) { input.value = ''; load(); } else err.textContent = T.failed;
      });
      load();
    </script>
  `;
}
