import { pageParams, pagerFor } from './paging.js';
import { pickTexts } from '../i18n/overrides.js';
import { timeHtml } from '../ui/time.js';
import {
  UserAdminError, isAnonymizedUser, listUsers, createManagedUser, changeUserRole, renameUser, setUserEmail, setUserDisabled, resetUserPassword, forceUserLogout, resetUserMfa, removeUser, generateTempPassword,
} from '../auth/user-admin.js';
import { createHash } from 'node:crypto';
import { findUserById } from '../auth/users.js';
import { listAuthenticators } from '../auth/authenticators.js';
import { generateRecoveryCodes } from '../auth/recovery-codes.js';
import { createPasswordResetToken } from '../auth/password-reset.js';
import { log } from '../audit/log.js';
import { contextFromRequest } from '../audit/context.js';
import { readForm, emptyRow } from './sections.js';
import { inactiveUsers, userCard } from './user-activity.js';
import { describeAgent } from '../auth/devices.js';
import { OPS_TEXTS as L } from './sections-ops.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Fingerprint of the editable part of an account. The edit forms carry it (`_v`); when the form is saved the fingerprint of the
 * CURRENT row must be the same, otherwise someone else changed the account after the form was opened and saving would silently
 * overwrite their change (G-03). A form without `_v` (an old page, a script) is not checked.
 */
export function userVersion(u) {
  return createHash('sha256').update(JSON.stringify([u.username, u.email ?? null, u.role, u.disabled ? 1 : 0])).digest('hex').slice(0, 16);
}

/** A refusal that has a text of its own (`e_<CODE>`), thrown by the section itself rather than by core/auth. */
class Refuse extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/**
 * The "Users" section: the list with search and enable/disable, and, when `manage` is given,
 * the full account administration: create, change role, reset the password (temporary one or
 * a link by e-mail), sign out of all sessions, anonymize or delete. Every operation goes
 * through core/auth's user-admin functions, so the rules (unique logins, the last active
 * administrator is protected, sessions are revoked when privileges change) are the same as in
 * the `user ...` CLI commands; each one is recorded in the audit log. Passwords and reset
 * tokens never reach the audit log.
 *
 * @param {object} [manage] - without it the section only lists and enables/disables
 * @param {{hashPassword: Function}} manage.authProvider - hashes temporary passwords
 * @param {string[]} manage.roles - roles an administrator may assign
 * @param {string} [manage.adminRole='admin'] - the role that must never run out
 * @param {{service?: {enabled: boolean, sendPasswordReset: Function}, baseUrl?: string, resetPath?: string, ttlMinutes?: number}} [manage.email] - for "reset by e-mail"
 * @param {boolean} [manage.allowDelete=false] - offer "delete completely" next to "anonymize"
 * @param {(user: object) => void} [manage.onUnlock] - clears the app's sign-in failure counters for that user; adds the "Lift the sign-in lock" action
 * @param {(user: object) => void} [manage.onPasswordReset] - e.g. clear the app's login-failure counters for that user
 */
/**
 * One confirmation dialog for every "remove" button of the page. The text depends on the chosen mode,
 * and the confirm button stays disabled for a few seconds so the warning cannot be clicked through.
 * The same script opens the per-user "Actions" dialog; dialogs sit above the table, so no card clips them.
 */
function confirmDialog(l, nonce, allowDelete) {
  const data = `data-anon="${esc(l.warnAnon)}" data-delete="${esc(l.warnDelete)}" data-ok="${esc(l.confirmRemove)}"`;
  const script = `(function(){document.addEventListener('click',function(e){var t=e.target.closest&&e.target.closest('.adm-open,.adm-close');if(!t)return;if(t.classList.contains('adm-open'))document.getElementById(t.dataset.target).showModal();else t.closest('dialog').close()});var d=document.getElementById('admConfirm');if(!d||!d.showModal)return;var msg=d.querySelector('.adm-msg'),ok=d.querySelector('.adm-ok'),no=d.querySelector('.adm-cancel'),form=null,timer=null;
function stop(){if(timer){clearInterval(timer);timer=null}}
function open(f,user){form=f;var mode=f.elements.mode.value;msg.textContent=(mode==='delete'?d.dataset.delete:d.dataset.anon).replace('{u}',user);d.dataset.mode=mode;var n=5;ok.disabled=true;ok.textContent=d.dataset.ok+' ('+n+')';stop();timer=setInterval(function(){n--;if(n<=0){stop();ok.disabled=false;ok.textContent=d.dataset.ok}else{ok.textContent=d.dataset.ok+' ('+n+')'}},1000);d.showModal()}
document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('.adm-remove');if(!b)return;e.preventDefault();open(b.form,b.dataset.user)});
no.addEventListener('click',function(){stop();d.close()});d.addEventListener('close',stop);
ok.addEventListener('click',function(){if(ok.disabled||!form)return;form.elements.confirm.value='1';form.submit()})})();`;
  return `<dialog id="admConfirm" ${data} style="max-width:28rem;border:1px solid var(--adm-danger);border-radius:10px;background:var(--adm-surface);color:var(--adm-text);padding:1.25rem"><p class="adm-msg" style="margin-top:0;font-weight:600"></p><div style="display:flex;gap:.5rem;justify-content:flex-end"><button type="button" class="adm-btn adm-cancel">${esc(l.cancel)}</button><button type="button" class="adm-btn danger adm-ok" disabled>${esc(l.confirmRemove)}</button></div></dialog><script${nonce}>${script}</script>`;
}

export function mountUsersSection({ app, db, guard, page: render, basePath, localeOf, texts = {}, stepUp = [], manage = null }) {
  const path_ = `${basePath}/users`;
  const adminRole = manage?.adminRole ?? 'admin';
  const roles = manage?.roles ?? [];
  const mailService = manage?.email?.service;
  const mailReady = Boolean(mailService?.enabled && manage?.email?.baseUrl);
  const tx = (req) => pickTexts(L, texts['admin-ops'], localeOf(req), 'admin-ops');
  const audit = (req, action, id, meta) => log(db, { ...contextFromRequest(req), action, entity: 'user', entityId: id, meta });
  const isSelf = (req, id) => req.user?.id === id;

  /**
   * The user is told by e-mail about what an administrator did to their account (audit R-22). It never blocks or fails the action:
   * a missing address, a disabled mail service or a delivery error just means `notified: false` in the audit record. Letters carry no
   * password, no code and no link that would let the reader do more than the account owner could.
   */
  async function notifyUser(req, user, kind, vars = {}) {
    if (!mailService?.enabled || !user?.email) return false;
    const l = tx(req);
    const locale = localeOf(req);
    const fill = (t) => String(t).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
    try {
      if (kind === 'disable') await mailService.sendAccountBanned({ to: user.email, reason: l.mailBanReason, until: null, locale });
      else if (kind === 'enable') await mailService.sendAccountUnbanned({ to: user.email, locale });
      else await mailService.sendSystemNotice({ to: user.email, subject: l[`mail${kind}Subject`], message: fill(l[`mail${kind}Body`]), locale });
      return true;
    } catch {
      return false;
    }
  }

  function toast(l, query) {
    if (query?.msg === 'ok') return `<div class="adm-toast">${esc(l.done)}</div>`;
    if (query?.msg === 'bulk') return `<div class="adm-toast">${esc(l.disabledN)} ${esc(Number(query.n) || 0)}${Number(query.s) > 0 ? `; ${esc(l.skippedN)} ${esc(Number(query.s))}` : ''}</div>`;
    if (query?.msg === 'bad') {
      const text = l[`e_${String(query.e ?? '')}`] ?? l.bad;
      return `<div class="adm-toast" style="border-left-color:var(--adm-danger)">${esc(text)}</div>`;
    }
    return '';
  }

  const roleOptions = (current) => roles.map((r) => `<option value="${esc(r)}"${r === current ? ' selected' : ''}>${esc(r)}</option>`).join('');

  function actionsCell(l, u) {
    const row = 'display:flex;gap:.5rem;align-items:center;flex-wrap:wrap';
    const ctl = 'height:2.4rem;box-sizing:border-box';
    const f = (action, title, inner, { danger = false } = {}) => `<form method="post" action="${path_}/${u.id}/${action}" style="padding:.85rem 0;border-top:1px solid var(--adm-border);${danger ? 'border-left:3px solid var(--adm-danger);padding-left:.75rem;' : ''}"><div style="font-weight:600;margin-bottom:.5rem">${esc(title)}</div>${inner}</form>`;
    const profile = f('profile', l.editProfile, `<input type="hidden" name="_v" value="${userVersion(u)}"><div style="display:flex;flex-direction:column;gap:.5rem"><input class="adm-input" style="${ctl}" name="username" value="${esc(u.username)}" required minlength="3" maxlength="64" aria-label="${esc(l.username)}"><input class="adm-input" style="${ctl}" name="email" type="email" value="${esc(u.email ?? '')}" maxlength="320" aria-label="${esc(l.email)}" placeholder="${esc(l.email)}"><div><button class="adm-btn" type="submit">${esc(l.save)}</button></div></div>`);
    const role = roles.length ? f('role', l.changeRole, `<input type="hidden" name="_v" value="${userVersion(u)}"><div style="${row}"><select class="adm-input" style="${ctl};flex:1" name="role">${roleOptions(u.role)}</select><button class="adm-btn" type="submit">${esc(l.save)}</button></div>`) : '';
    const reset = u.disabled ? '' : f('reset', l.resetPwd, `<label style="display:block;margin-bottom:.35rem"><input type="radio" name="mode" value="temporary" checked> ${esc(l.modeTemp)}</label>${mailReady && u.email ? `<label style="display:block;margin-bottom:.35rem"><input type="radio" name="mode" value="email"> ${esc(l.modeMail)}</label>` : ''}<button class="adm-btn" type="submit">${esc(l.resetPwd)}</button>`);
    const out = f('logout', l.forceOut, `<label style="display:block;margin-bottom:.5rem"><input type="checkbox" name="requireChange" value="1"> ${esc(l.requireChange)}</label><button class="adm-btn" type="submit">${esc(l.forceOut)}</button>`);
    const mfa = f('reset-mfa', l.resetMfa, `<p class="adm-muted" style="margin:.25rem 0 .5rem">${esc(l.resetMfaHint)}</p><button class="adm-btn danger" type="submit">${esc(l.resetMfa)}</button>`)
      + f('recovery-codes', l.newCodes, `<p class="adm-muted" style="margin:.25rem 0 .5rem">${esc(l.newCodesHint)}</p><button class="adm-btn" type="submit">${esc(l.newCodes)}</button>`);
    const unlock = manage.onUnlock && !u.disabled ? f('unlock', l.unlockLogin, `<p class="adm-muted" style="margin:.25rem 0 .5rem">${esc(l.unlockHint)}</p><button class="adm-btn" type="submit">${esc(l.unlockBtn)}</button>`) : '';
    const remove = f('remove', l.removeUser, `<div style="${row}"><select class="adm-input" style="${ctl};flex:1" name="mode"><option value="anonymize">${esc(l.modeAnon)}</option>${manage.allowDelete ? `<option value="delete">${esc(l.modeDel)}</option>` : ''}</select><input type="hidden" name="confirm" value=""><noscript><label><input type="checkbox" name="confirm" value="1"> ${esc(l.confirmBox)}</label></noscript><button class="adm-btn danger adm-remove" type="submit" data-user="${esc(u.username)}">${esc(l.removeUser)}</button></div>`, { danger: true });
    return `<button type="button" class="adm-btn adm-open" data-target="adm-u-${u.id}">${esc(l.actions)}</button><dialog id="adm-u-${u.id}" style="width:30rem;max-width:92vw;max-height:90vh;overflow:auto;border:1px solid var(--adm-border);border-radius:10px;background:var(--adm-surface);color:var(--adm-text);padding:1rem 1.25rem"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.25rem"><div><strong style="font-size:1.1rem">${esc(u.username)}</strong> <span class="adm-badge ${u.disabled ? 'danger' : 'ok'}">${esc(u.disabled ? l.disabled : l.active)}</span></div><button type="button" class="adm-btn adm-close" aria-label="${esc(l.cancel)}">×</button></div>${profile}${role}${reset}${mfa}${unlock}${out}${remove}</dialog>`;
  }

  app.get(path_, ...guard, (req, res) => {
    const l = tx(req);
    const search = String(req.query?.q ?? '').slice(0, 64);
    const pg = pageParams(req);
    const { items, total } = listUsers(db, { search, limit: pg.size, offset: pg.offset });
    const rows = items.map((u) => {
      if (isAnonymizedUser(u)) return `<tr class="adm-muted"><td>${esc(u.username)}</td><td></td><td>${esc(u.role)}</td><td><span class="adm-badge">${esc(l.anonymized)}</span></td><td></td><td>${timeHtml(u.createdAt, localeOf(req))}</td><td></td></tr>`;
      const toggle = `<form method="post" action="${path_}/${u.id}/${u.disabled ? 'enable' : 'disable'}" style="display:inline"><button class="adm-btn ${u.disabled ? '' : 'danger'}" type="submit">${esc(u.disabled ? l.enable : l.disable)}</button></form>`;
      const more = manage && !isSelf(req, u.id) ? actionsCell(l, u) : '';
      return `<tr><td><a href="${path_}/${u.id}">${esc(u.username)}</a></td><td>${esc(u.email ?? '')}</td><td>${esc(u.role)}</td><td><span class="adm-badge ${u.disabled ? 'danger' : 'ok'}">${esc(u.disabled ? l.disabled : l.active)}</span></td><td>${u.activeAuthenticators ? '✓' : ''}</td><td>${timeHtml(u.createdAt, localeOf(req))}</td><td><div style="display:flex;gap:.5rem;align-items:center;justify-content:flex-end;flex-wrap:wrap">${isSelf(req, u.id) ? '' : toggle}${more}</div></td></tr>`;
    }).join('') || emptyRow(7, l.emptyUsers);
    const createForm = manage
      ? `<form method="post" action="${path_}/create" class="adm-card adm-filters"><strong style="flex-basis:100%">${esc(l.newUser)}</strong><label class="adm-field">${esc(l.username)}<input class="adm-input" name="username" required minlength="3" maxlength="64"></label><label class="adm-field">${esc(l.email)}<input class="adm-input" name="email" type="email" maxlength="320"></label><label class="adm-field">${esc(l.role)}<select class="adm-input" name="role">${roleOptions(roles[roles.length - 1])}</select></label><button class="adm-btn primary" type="submit">${esc(l.create)}</button></form>`
      : '';
    const nonce = res.locals?.cspNonce ? ` nonce="${esc(res.locals.cspNonce)}"` : '';
    const dialog = manage ? confirmDialog(l, nonce, manage.allowDelete) : '';
    render(req, res, { active: path_, title: l.users, bodyHtml: `${toast(l, req.query)}${createForm}<p><a href="${path_}/inactive">${esc(l.inactiveLink)}</a>${manage?.lockouts ? ` · <a href="${path_}/lockouts">${esc(l.lockoutsLink)}</a>` : ''}</p><form method="get" class="adm-card adm-filters"><label class="adm-field">${esc(l.search)}<input class="adm-input" name="q" value="${esc(search)}" maxlength="64"></label><button class="adm-btn primary" type="submit">${esc(l.find)}</button></form><div class="adm-card"><p class="adm-muted">${esc(l.total)}: ${esc(total)}</p><table class="adm-table"><thead><tr><th>${esc(l.username)}</th><th>${esc(l.email)}</th><th>${esc(l.role)}</th><th>${esc(l.status)}</th><th>${esc(l.mfa)}</th><th>${esc(l.created)}</th><th></th></tr></thead><tbody data-paged="users">${rows}</tbody></table>${pagerFor({ req, res, path: path_, name: 'users', ...pg, count: items.length, total, locale: localeOf(req) })}</div>${dialog}` });
  });

  /** Wraps a POST handler: a refusal or a UserAdminError becomes a toast on the list, anything else goes to the error handler. */
  const act = (handler, { form = true } = {}) => async (req, res, next) => {
    try {
      await handler(req, res, form ? await readForm(req) : {});
    } catch (err) {
      if (err instanceof Refuse || err instanceof UserAdminError) return res.redirect(303, `${path_}?msg=bad&e=${encodeURIComponent(err.code)}`);
      next(err);
    }
  };
  const ok = (res) => res.redirect(303, `${path_}?msg=ok`);
  const targetId = (req) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw new Refuse('NOT_FOUND');
    const target = findUserById(db, id);
    if (!target || isAnonymizedUser(target)) throw new Refuse('NOT_FOUND'); // an anonymized account is a closed record
    return id;
  };
  const notSelf = (req, id) => { if (isSelf(req, id)) throw new Refuse('SELF'); };

  /** The one page that shows a temporary password; no redirect, so it is never in a URL or history. */
  function showPassword(req, res, l, { title, username, password }) {
    render(req, res, { active: path_, title, bodyHtml: `<div class="adm-card"><h2>${esc(title)}</h2><p>${esc(l.username)}: <strong>${esc(username)}</strong></p><p>${esc(l.password)}: <code style="font-size:1.2em;user-select:all">${esc(password)}</code></p><p class="adm-muted">${esc(l.tempShown)}</p><p><a class="adm-btn" href="${path_}">${esc(l.back)}</a></p></div>` });
  }


  // The report and the card are read-only; only the bulk disable below changes anything.
  const clampDays = (v) => Math.min(3650, Math.max(1, Math.trunc(Number(v)) || 90));

  app.get(`${path_}/inactive`, ...guard, (req, res) => {
    const l = tx(req);
    const days = clampDays(req.query?.days);
    const list = inactiveUsers(db, { days });
    const rows = list.map((u) => `<tr><td><a href="${path_}/${u.id}">${esc(u.username)}</a></td><td>${esc(u.email ?? '')}</td><td>${esc(u.role)}</td><td>${u.lastActivityAt ? timeHtml(u.lastActivityAt, localeOf(req)) : esc(l.never)}</td><td>${u.idleDays ?? '—'}</td></tr>`).join('') || emptyRow(5, l.inactiveNone);
    const bulk = list.length ? `<form method="post" action="${path_}/inactive/disable"><input type="hidden" name="days" value="${days}"><button class="adm-btn danger" type="submit" data-confirm="${esc(l.disableAll)}?">${esc(l.disableAll)} (${list.length})</button></form>` : '';
    render(req, res, { active: path_, title: l.inactiveTitle, bodyHtml: `${toast(l, req.query)}<p class="adm-muted">${esc(l.inactiveHint)}</p><form method="get" class="adm-card adm-filters"><label class="adm-field">${esc(l.daysLbl)}<input class="adm-input" name="days" type="number" min="1" max="3650" value="${days}"></label><button class="adm-btn primary" type="submit">${esc(l.find)}</button></form><div class="adm-card"><table class="adm-table"><thead><tr><th>${esc(l.username)}</th><th>${esc(l.email)}</th><th>${esc(l.role)}</th><th>${esc(l.lastActivity)}</th><th>${esc(l.idleLbl)}</th></tr></thead><tbody>${rows}</tbody></table></div>${bulk}<p><a class="adm-btn" href="${path_}">${esc(l.toList)}</a></p>` });
  });

  app.post(`${path_}/inactive/disable`, ...guard, ...stepUp, act(async (req, res, form) => {
    const days = clampDays(form.days);
    let done = 0;
    let skipped = 0;
    for (const u of inactiveUsers(db, { days })) {
      if (isSelf(req, u.id)) { skipped++; continue; }
      try {
        const r = setUserDisabled(db, u.id, true, { adminRole });
        const notified = await notifyUser(req, findUserById(db, u.id), 'disable');
        audit(req, 'admin.user.disable', u.id, { username: u.username, revokedSessions: r.revokedSessions, reason: `inactive_${days}d`, notified });
        done++;
      } catch (e) {
        if (!(e instanceof UserAdminError)) throw e;
        skipped++; // the last active administrator is protected
      }
    }
    audit(req, 'admin.user.disable_inactive', 0, { days, disabled: done, skipped });
    res.redirect(303, `${path_}/inactive?days=${days}&msg=bulk&n=${done}&s=${skipped}`);
  }));

  if (manage?.lockouts) {
    app.get(`${path_}/lockouts`, ...guard, (req, res) => {
      const l = tx(req);
      const rows = manage.lockouts.list().map((e) => `<tr><td>${esc(l.lockKinds?.[e.kind] ?? e.kind)}</td><td><code>${esc(e.key)}</code></td><td>${esc(e.failures)}</td><td>${esc(Math.ceil(e.retryAfterMs / 1000))}</td><td><form method="post" action="${path_}/lockouts/unlock"><input type="hidden" name="kind" value="${esc(e.kind)}"><input type="hidden" name="key" value="${esc(e.key)}"><button class="adm-btn" type="submit">${esc(l.lockLift)}</button></form></td></tr>`).join('') || emptyRow(5, l.lockNone);
      render(req, res, { active: path_, title: l.lockoutsTitle, bodyHtml: `${toast(l, req.query)}<p class="adm-muted">${esc(l.lockoutsHint)}</p><div class="adm-card"><table class="adm-table"><thead><tr><th>${esc(l.lockKind)}</th><th>${esc(l.lockKey)}</th><th>${esc(l.lockFails)}</th><th>${esc(l.lockLeft)}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div><p><a class="adm-btn" href="${path_}">${esc(l.toList)}</a></p>` });
    });

    app.post(`${path_}/lockouts/unlock`, ...guard, ...stepUp, act(async (req, res, form) => {
      const kind = String(form.kind ?? '').slice(0, 16);
      const key = String(form.key ?? '').slice(0, 400);
      if (!manage.lockouts.unlock(kind, key)) throw new Refuse('NOT_FOUND');
      audit(req, 'admin.user.unlock', null, { kind, key, via: 'lockouts' });
      res.redirect(303, `${path_}/lockouts?msg=ok`);
    }));
  }

  app.get(`${path_}/:id`, ...guard, (req, res, next) => {
    const l = tx(req);
    const id = Number(req.params.id);
    const card = Number.isInteger(id) && id > 0 ? userCard(db, id) : null;
    if (!card || isAnonymizedUser(card.user)) return next();
    const loc = localeOf(req);
    const t = (v) => (v ? timeHtml(v, loc) : esc(l.never));
    const u = card.user;
    const kv = (k, v) => `<tr><th style="text-align:left;width:14rem">${esc(k)}</th><td>${v}</td></tr>`;
    const tbl = (head, body, cols) => `<table class="adm-table"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${body || emptyRow(cols, l.noRows)}</tbody></table>`;
    const sess = card.sessions.map((s) => `<tr><td>${t(s.created_at)}</td><td>${t(s.last_seen_at)}</td><td>${t(s.expires_at)}</td></tr>`).join('');
    const devs = card.devices.map((d) => `<tr><td>${esc(describeAgent(d.user_agent ?? ''))}</td><td>${esc(d.first_ip ?? '')}</td><td>${t(d.first_seen_at)}</td><td>${t(d.last_seen_at)}</td></tr>`).join('');
    const evs = card.recent.map((e) => `<tr><td>${t(e.created_at)}</td><td><a href="${basePath}/audit/event/${e.id}">${esc(e.action)}</a></td><td>${esc(e.result)}</td><td>${esc(e.ip ?? '')}</td></tr>`).join('');
    const body = `<div class="adm-card"><h2>${esc(u.username)}</h2><table class="adm-table"><tbody>${kv(l.email, esc(u.email ?? '—'))}${kv(l.role, esc(u.role))}${kv(l.status ?? 'Status', `<span class="adm-badge ${u.disabled ? 'danger' : 'ok'}">${esc(u.disabled ? l.disabled : l.active)}</span>`)}${kv(l.created, t(u.created_at))}${kv(l.lastLogin, t(card.lastLoginAt))}${kv(l.lastActivity, t(card.lastActivityAt))}${kv(l.pwdChanged, t(card.passwordChangedAt))}${kv(l.factorsLbl, esc(card.activeFactors > 0 ? `${l.factorsOn} (${card.activeFactors})` : l.factorsOff))}</tbody></table></div>`
      + `<div class="adm-card"><h2>${esc(l.cardSessions)}</h2>${tbl([l.created, l.lastSeenLbl, l.expiresLbl], sess, 3)}</div>`
      + `<div class="adm-card"><h2>${esc(l.cardDevices)}</h2>${tbl([l.deviceLbl, l.ipLbl, l.firstSeen, l.lastSeenLbl], devs, 4)}</div>`
      + `<div class="adm-card"><h2>${esc(l.cardEvents)}</h2>${tbl([l.created, l.actionLbl, l.resultLbl, l.ipLbl], evs, 4)}</div><p><a class="adm-btn" href="${path_}">${esc(l.toList)}</a></p>`;
    render(req, res, { active: path_, title: `${l.cardTitle}: ${u.username}`, bodyHtml: body });
  });

  for (const [verb, flag] of [['disable', true], ['enable', false]]) {
    app.post(`${path_}/:id/${verb}`, ...guard, ...stepUp, act(async (req, res) => {
      const id = targetId(req);
      if (flag) notSelf(req, id);
      const r = setUserDisabled(db, id, flag, { adminRole });
      const notified = await notifyUser(req, findUserById(db, id), verb);
      audit(req, `admin.user.${verb}`, id, { username: r.user?.username, revokedSessions: r.revokedSessions, notified });
      ok(res);
    }, { form: false }));
  }

  if (!manage) return;
  if (typeof manage.authProvider?.hashPassword !== 'function') throw new TypeError('admin users: manage.authProvider.hashPassword is required');
  if (!Array.isArray(roles) || roles.length === 0) throw new TypeError('admin users: manage.roles must list the assignable roles');

  app.post(`${path_}/create`, ...guard, ...stepUp, act(async (req, res, form) => {
    const l = tx(req);
    const temporaryPassword = generateTempPassword();
    const user = createManagedUser(db, {
      username: String(form.username ?? '').trim(),
      email: String(form.email ?? '').trim() || null,
      role: String(form.role ?? ''),
      passwordHash: await manage.authProvider.hashPassword(temporaryPassword),
      allowedRoles: roles,
    });
    audit(req, 'admin.user.create', user.id, { username: user.username, role: user.role });
    showPassword(req, res, l, { title: l.accountCreated, username: user.username, password: temporaryPassword });
  }));

  app.post(`${path_}/:id/profile`, ...guard, ...stepUp, act(async (req, res, form) => {
    const id = targetId(req);
    notSelf(req, id);
    const before = findUserById(db, id);
    if (!before) throw new Refuse('NOT_FOUND');
    if (form._v && form._v !== userVersion(before)) throw new Refuse('CONFLICT');
    const changes = {};
    const username = String(form.username ?? '').trim();
    const email = String(form.email ?? '').trim() || null;
    if (username !== before.username) {
      renameUser(db, id, username);
      changes.username = { from: before.username, to: username };
    }
    if (email !== (before.email ?? null)) {
      setUserEmail(db, id, email);
      changes.email = true;
    }
    if (Object.keys(changes).length > 0) audit(req, 'admin.user.update', id, { changes });
    ok(res);
  }));

  app.post(`${path_}/:id/role`, ...guard, ...stepUp, act(async (req, res, form) => {
    const id = targetId(req);
    notSelf(req, id);
    const before = findUserById(db, id);
    if (!before) throw new Refuse('NOT_FOUND');
    if (form._v && form._v !== userVersion(before)) throw new Refuse('CONFLICT');
    const role = String(form.role ?? '');
    if (role !== before.role) {
      changeUserRole(db, id, role, { adminRole, allowedRoles: roles });
      const notified = await notifyUser(req, before, 'Role', { from: before.role, to: role });
      audit(req, 'admin.user.update', id, { changes: { role: { from: before.role, to: role } }, notified });
    }
    ok(res);
  }));

  app.post(`${path_}/:id/reset`, ...guard, ...stepUp, act(async (req, res, form) => {
    const l = tx(req);
    const id = targetId(req);
    const user = findUserById(db, id);
    if (!user) throw new Refuse('NOT_FOUND');
    if (user.disabled) throw new Refuse('ACCOUNT_DISABLED');
    if (form.mode === 'email') {
      if (!mailReady) throw new Refuse('EMAIL_UNAVAILABLE');
      if (!user.email) throw new Refuse('NO_EMAIL');
      const ttlMinutes = manage.email.ttlMinutes ?? 30;
      const { token } = createPasswordResetToken(db, user.id, { ttlMinutes });
      const resetUrl = `${String(manage.email.baseUrl).replace(/\/+$/, '')}${manage.email.resetPath ?? '/reset-password'}#token=${token}`;
      try {
        await mailService.sendPasswordReset({ to: user.email, resetUrl, expiresInMinutes: ttlMinutes, locale: localeOf(req) });
      } catch {
        throw new Refuse('EMAIL_FAILED');
      }
      audit(req, 'admin.user.reset_password', id, { mode: 'email' });
      return ok(res);
    }
    notSelf(req, id); // resetting your own password here would end this very session; use the account page
    const temporaryPassword = generateTempPassword();
    const r = resetUserPassword(db, id, await manage.authProvider.hashPassword(temporaryPassword));
    manage.onPasswordReset?.(user);
    const notified = await notifyUser(req, user, 'Reset');
    audit(req, 'admin.user.reset_password', id, { mode: 'temporary', revokedSessions: r.revokedSessions, notified });
    showPassword(req, res, l, { title: l.tempTitle, username: user.username, password: temporaryPassword });
  }));

  app.post(`${path_}/:id/unlock`, ...guard, ...stepUp, act(async (req, res) => {
    const id = targetId(req);
    const user = findUserById(db, id);
    if (!user) throw new Refuse('NOT_FOUND');
    if (typeof manage.onUnlock !== 'function') throw new Refuse('FORBIDDEN');
    manage.onUnlock(user);
    audit(req, 'admin.user.unlock', id);
    ok(res);
  }));

  app.post(`${path_}/:id/logout`, ...guard, ...stepUp, act(async (req, res, form) => {
    const id = targetId(req);
    notSelf(req, id);
    const r = forceUserLogout(db, id, { requirePasswordChange: form.requireChange === '1' });
    const notified = await notifyUser(req, findUserById(db, id), 'Logout');
    audit(req, 'admin.user.force_logout', id, { revokedSessions: r.revokedSessions, requirePasswordChange: r.mustChangePassword, notified });
    ok(res);
  }));

  app.post(`${path_}/:id/reset-mfa`, ...guard, ...stepUp, act(async (req, res) => {
    const id = targetId(req);
    notSelf(req, id); // your own factor is changed on the account page
    const user = findUserById(db, id);
    const r = resetUserMfa(db, id);
    const notified = await notifyUser(req, user, 'Mfa');
    audit(req, 'admin.user.reset_mfa', id, { removedAuthenticators: r.removedAuthenticators, revokedSessions: r.revokedSessions, notified });
    ok(res);
  }, { form: false }));

  app.post(`${path_}/:id/recovery-codes`, ...guard, ...stepUp, act(async (req, res) => {
    const l = tx(req);
    const id = targetId(req);
    notSelf(req, id);
    const user = findUserById(db, id);
    if (!listAuthenticators(db, id).some((a) => a.type === 'totp' && a.status === 'active')) throw new Refuse('NO_ACTIVE_MFA');
    const codes = await generateRecoveryCodes(db, id);
    const notified = await notifyUser(req, user, 'Codes');
    audit(req, 'admin.user.recovery_codes', id, { count: codes.length, notified });
    res.set?.('Cache-Control', 'no-store');
    render(req, res, { active: path_, title: l.codesTitle, bodyHtml: `<div class="adm-card"><h2>${esc(l.codesTitle)}</h2><p>${esc(l.username)}: <strong>${esc(user.username)}</strong></p><ul style="font-size:1.1em;user-select:all">${codes.map((c) => `<li><code>${esc(c)}</code></li>`).join('')}</ul><p class="adm-muted">${esc(l.codesShown)}</p><p><a class="adm-btn" href="${path_}">${esc(l.back)}</a></p></div>` });
  }, { form: false }));

  app.post(`${path_}/:id/remove`, ...guard, ...stepUp, act(async (req, res, form) => {
    const id = targetId(req);
    notSelf(req, id);
    if (form.confirm !== '1') throw new Refuse('CONFIRM');
    const mode = form.mode === 'delete' ? 'delete' : 'anonymize';
    if (mode === 'delete' && !manage.allowDelete) throw new Refuse('FORBIDDEN');
    const r = removeUser(db, id, { mode, adminRole });
    audit(req, 'admin.user.delete', id, { username: r.username, mode });
    ok(res);
  }));
}
