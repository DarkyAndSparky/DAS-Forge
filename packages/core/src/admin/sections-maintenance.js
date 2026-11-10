import { pickTexts } from '../i18n/overrides.js';
import { timeHtml } from '../ui/time.js';
import { MaintenanceError } from '../maintenance/index.js';
import { AnnouncementError, LEVELS } from '../announcement/index.js';
import { readForm } from './sections.js';
import { versionField, isStale } from './edit-version.js';
import { OPS_TEXTS as L } from './sections-ops.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The "Maintenance mode" section: state, message and expected end, one button to switch on and one to switch off. */
export function mountMaintenanceSection({ app, guard, page: render, basePath, localeOf, texts = {}, stepUp = [], maintenance }) {
  const p = `${basePath}/maintenance`;
  const tx = (req) => pickTexts(L, texts['admin-ops'], localeOf(req), 'admin-ops');

  app.get(p, ...guard, (req, res) => {
    const l = tx(req);
    const st = maintenance.get({ fresh: true });
    const msg = req.query?.msg === 'ok' ? `<div class="adm-toast">${esc(l.done)}</div>` : req.query?.msg === 'bad' ? `<div class="adm-toast" style="border-left-color:var(--adm-danger)">${esc(l[`e_${String(req.query.e ?? '')}`] ?? l.bad)}</div>` : '';
    const state = `<span class="adm-badge ${st.enabled ? 'danger' : 'ok'}">${esc(st.enabled ? l.mOn : l.mOff)}</span>`;
    const since = st.enabled && st.startedAt ? `<p class="adm-muted">${esc(l.mSince)}: ${timeHtml(st.startedAt, localeOf(req))}${st.startedBy ? `, ${esc(l.mBy)}: ${esc(st.startedBy)}` : ''}</p>` : '';
    const until = st.until ? st.until.slice(0, 16) : '';
    const form = `<form method="post" action="${p}/enable" class="adm-card" style="display:flex;flex-direction:column;gap:.75rem;max-width:36rem"><label class="adm-field">${esc(l.mMessage)}<textarea class="adm-input" name="message" rows="3" maxlength="500" style="width:100%;box-sizing:border-box">${esc(st.message ?? '')}</textarea></label><label class="adm-field">${esc(l.mUntil)}<input class="adm-input" type="datetime-local" name="until" value="${esc(until)}" style="height:2.4rem;box-sizing:border-box"></label><div><button class="adm-btn danger" type="submit">${esc(l.mEnable)}</button></div></form>`;
    const off = st.enabled ? `<form method="post" action="${p}/disable" style="margin-top:1rem"><button class="adm-btn primary" type="submit">${esc(l.mDisable)}</button></form>` : '';
    render(req, res, { active: p, title: l.maintenance, bodyHtml: `${msg}<div class="adm-card" style="margin-bottom:1rem"><p>${state}</p>${since}<p class="adm-muted">${esc(l.mHint)}</p></div>${form}${off}` });
  });

  app.post(`${p}/enable`, ...guard, ...stepUp, async (req, res, next) => {
    try {
      const form = await readForm(req);
      const until = String(form.until ?? '').trim();
      const message = String(form.message ?? '');
      const state = maintenance.enable({ message, until: until ? `${until}${until.length === 16 ? ':00' : ''}Z` : null, by: req.user?.username ?? null });
      maintenance.audited(req, 'admin.maintenance.enable', state);
      res.redirect(303, `${p}?msg=ok`);
    } catch (err) {
      if (err instanceof MaintenanceError) return res.redirect(303, `${p}?msg=bad&e=${encodeURIComponent(err.code)}`);
      return next(err);
    }
  });

  app.post(`${p}/disable`, ...guard, ...stepUp, (req, res, next) => {
    try {
      maintenance.disable();
      maintenance.audited(req, 'admin.maintenance.disable');
      res.redirect(303, `${p}?msg=ok`);
    } catch (err) { next(err); }
  });
}

const announceState = (st) => ({ enabled: Boolean(st.enabled), message: st.message ?? null, level: st.level ?? null, until: st.until ?? null });

/** The "Announcement" section: the one-line banner at the top of the application's pages. */
export function mountAnnouncementSection({ app, guard, page: render, basePath, localeOf, texts = {}, stepUp = [], announcement }) {
  const p = `${basePath}/announcement`;
  const tx = (req) => pickTexts(L, texts['admin-ops'], localeOf(req), 'admin-ops');
  const levelName = (l, v) => (v === 'warning' ? l.aWarning : v === 'critical' ? l.aCritical : l.aInfo);

  app.get(p, ...guard, (req, res) => {
    const l = tx(req);
    const locale = localeOf(req);
    const st = announcement.get({ fresh: true });
    const shown = announcement.active();
    const msg = req.query?.msg === 'ok' ? `<div class="adm-toast">${esc(l.done)}</div>` : req.query?.msg === 'bad' ? `<div class="adm-toast" style="border-left-color:var(--adm-danger)">${esc(l[`a_${String(req.query.e ?? '')}`] ?? l.bad)}</div>` : '';
    const badge = shown ? `<span class="adm-badge ok">${esc(l.aOn)}</span>` : st.enabled ? `<span class="adm-badge warn">${esc(l.aExpired)}</span>` : `<span class="adm-badge">${esc(l.aNone)}</span>`;
    const preview = shown ? `<div style="margin-top:.75rem">${announcement.bannerHtml(locale, { nonce: res.locals?.cspNonce })}</div>` : '';
    const until = st.until ? st.until.slice(0, 16) : '';
    const options = LEVELS.map((v) => `<option value="${v}"${st.level === v ? ' selected' : ''}>${esc(levelName(l, v))}</option>`).join('');
    const form = `<form method="post" action="${p}/set" class="adm-card" style="display:flex;flex-direction:column;gap:.75rem;max-width:36rem">${versionField(announceState(st))}<label class="adm-field">${esc(l.aMessage)}<textarea class="adm-input" name="message" rows="2" maxlength="300" style="width:100%;box-sizing:border-box">${esc(st.message ?? '')}</textarea></label><label class="adm-field">${esc(l.aLevel)}<select class="adm-input" name="level">${options}</select></label><label class="adm-field">${esc(l.aUntil)}<input class="adm-input" type="datetime-local" name="until" value="${esc(until)}" style="height:2.4rem;box-sizing:border-box"></label><div><button class="adm-btn primary" type="submit">${esc(l.aPublish)}</button></div></form>`;
    const off = st.enabled ? `<form method="post" action="${p}/clear" style="margin-top:1rem"><button class="adm-btn" type="submit">${esc(l.aClear)}</button></form>` : '';
    render(req, res, { active: p, title: l.announcement, bodyHtml: `${msg}<div class="adm-card" style="margin-bottom:1rem"><p>${badge}</p><p class="adm-muted">${esc(l.aHint)}</p>${preview}</div>${form}${off}` });
  });

  app.post(`${p}/set`, ...guard, ...stepUp, async (req, res, next) => {
    try {
      const form = await readForm(req);
      if (isStale(form, announceState(announcement.get({ fresh: true })))) return res.redirect(303, `${p}?msg=bad&e=CONFLICT`);
      const until = String(form.until ?? '').trim();
      const state = announcement.set({ message: form.message, level: String(form.level ?? 'info'), until: until ? `${until}${until.length === 16 ? ':00' : ''}Z` : null, by: req.user?.username ?? null });
      announcement.audited(req, 'admin.announcement.set', state);
      res.redirect(303, `${p}?msg=ok`);
    } catch (err) {
      if (err instanceof AnnouncementError) return res.redirect(303, `${p}?msg=bad&e=${encodeURIComponent(err.code)}`);
      return next(err);
    }
  });

  app.post(`${p}/clear`, ...guard, ...stepUp, (req, res, next) => {
    try {
      announcement.clear();
      announcement.audited(req, 'admin.announcement.clear');
      res.redirect(303, `${p}?msg=ok`);
    } catch (err) { next(err); }
  });
}
