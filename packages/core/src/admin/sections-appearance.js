import { getCompanyBranding, setCompanyBranding } from '../branding/company-branding.js';
import { pickTexts } from '../i18n/overrides.js';
import { brandingUploadDir } from '../branding/appearance.js';
import { createMultipartUpload } from '../files/multipart.js';
import { acceptUpload } from '../files/accept-upload.js';
import { removeUpload } from '../files/upload-storage.js';
import { THEME_TOKENS } from '../ui/theme.js';
import { log } from '../audit/log.js';
import { contextFromRequest } from '../audit/context.js';
import { readForm } from './sections.js';
import { versionField, isStale } from './edit-version.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const L = {
  ru: {
    title: 'Оформление', name: 'Название', nameHint: 'Показывается в шапке меню вместо названия по умолчанию. Пусто — название по умолчанию.',
    save: 'Сохранить', reset: 'Сбросить', logo: 'Логотип', logoHint: 'PNG, JPG или SVG, до 2 МБ. Высота в меню — до 34 px. Если задан один логотип, он используется в обеих темах.',
    light: 'Светлая тема', dark: 'Тёмная тема', none: 'не задан', upload: 'Загрузить', remove: 'Убрать', file: 'Файл',
    accent: 'Цвет акцента', accentHint: 'Цвет кнопок, активного пункта меню и ссылок. Задаётся отдельно для светлой и тёмной темы.',
    accentLight: 'Акцент (светлая тема)', accentDark: 'Акцент (тёмная тема)', default: 'по умолчанию', done: 'Готово', bad: 'Не удалось: проверьте данные', conflict: 'Эти настройки уже изменил другой администратор. Страница обновлена, повторите правку',
    big: 'Файл слишком большой', preview: 'Предпросмотр', previewHint: 'Так будет выглядеть меню и кнопки. Предпросмотр обновляется сразу, до сохранения; выбранный файл показывается до загрузки.', pvTab1: 'Обзор', pvTab2: 'Раздел', pvTab3: 'Ещё', pvCard: 'Карточка', pvCardHint: 'описание', pvButton: 'Кнопка', pvUser: 'admin', confirmReset: 'Вернуть название и цвета по умолчанию?', confirmRemove: 'Убрать логотип?',
  },
  en: {
    title: 'Appearance', name: 'Name', nameHint: 'Shown at the top of the menu instead of the default name. Empty = the default name.',
    save: 'Save', reset: 'Reset', logo: 'Logo', logoHint: 'PNG, JPG or SVG, up to 2 MB. Menu height is up to 34 px. A single logo is used for both themes.',
    light: 'Light theme', dark: 'Dark theme', none: 'not set', upload: 'Upload', remove: 'Remove', file: 'File',
    accent: 'Accent color', accentHint: 'Color of buttons, the active menu item and links. Set separately for the light and dark theme.',
    accentLight: 'Accent (light theme)', accentDark: 'Accent (dark theme)', default: 'default', done: 'Done', bad: 'Failed: check the input', conflict: 'Another administrator has changed these settings. The page is reloaded, please repeat the change',
    big: 'The file is too large', preview: 'Preview', previewHint: 'How the menu and buttons will look. The preview updates at once, before saving; a chosen file is shown before it is uploaded.', pvTab1: 'Overview', pvTab2: 'Section', pvTab3: 'More', pvCard: 'Card', pvCardHint: 'description', pvButton: 'Button', pvUser: 'admin', confirmReset: 'Restore the default name and colors?', confirmRemove: 'Remove the logo?',
  },
};

const HEX = /^#[0-9a-fA-F]{6}$/;
/** What each form of the page was filled from (see edit-version.js): the name, and the two accent colours. */
const nameState = (b) => ({ name: b.name ?? null });
const colorState = (b) => ({ accent: b.accent ?? null, accentDark: b.accentDark ?? null });
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

/**
 * "Appearance" admin section: company name, light/dark logos and accent colors, stored in the generic
 * `app_settings` table (company branding). Uploads go through `files.acceptUpload` (magic bytes, SVG sanitizing,
 * mandatory image re-encode) into a `branding/` sub-directory of the uploads directory.
 */
export function mountAppearanceSection({ app, db, guard, page: render, basePath, localeOf, texts = {}, stepUp = [], appearance }) {
  const path = `${basePath}/appearance`;
  const dir = brandingUploadDir(appearance.uploadsDir);
  const maxBytes = appearance.maxBytes ?? MAX_LOGO_BYTES;
  const defaultName = appearance.fallbackName ?? '';
  const upload = createMultipartUpload({ field: 'logo', maxBytes, multer: appearance.multer });

  const back = (res, kind) => res.redirect(303, `${path}?msg=${kind}`);
  const audit = (req, action, meta) => log(db, { ...contextFromRequest(req), action: `admin.appearance.${action}`, entity: 'branding', meta });

  app.get(path, ...guard, (req, res) => {
    const l = pickTexts(L, texts['admin-appearance'], localeOf(req), 'admin-appearance');
    const b = getCompanyBranding(db);
    const note = { ok: l.done, bad: l.bad, big: l.big, conflict: l.conflict }[req.query?.msg];
    const toast = note ? `<div class="adm-toast"${req.query.msg === 'ok' ? '' : ' style="border-left-color:var(--adm-danger)"'}>${esc(note)}</div>` : '';
    const v = b.updatedAt ? `?v=${encodeURIComponent(Date.parse(b.updatedAt) || 0)}` : '';
    const logoCell = (theme, file) => `<div class="adm-field" style="min-width:260px"><strong>${esc(theme === 'light' ? l.light : l.dark)}</strong>
${file ? `<img src="/branding/logo/${theme}${v}" alt="" style="max-height:48px;max-width:220px;object-fit:contain;padding:.4rem;border:1px solid var(--adm-border);border-radius:8px;background:${theme === 'dark' ? '#101216' : '#ffffff'}">` : `<span class="adm-muted">${esc(l.none)}</span>`}
<form method="post" action="${path}/logo/${theme}" enctype="multipart/form-data" style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
<input type="file" name="logo" data-pv-file="${theme}" accept="image/png,image/jpeg,image/svg+xml" required aria-label="${esc(l.file)}">
<button class="adm-btn primary" type="submit">${esc(l.upload)}</button></form>
${file ? `<form method="post" action="${path}/logo/${theme}/remove"><button class="adm-btn danger" type="submit" data-confirm="${esc(l.confirmRemove)}">${esc(l.remove)}</button></form>` : ''}</div>`;
    const logoFor = (theme) => (theme === 'dark' ? b.logoFileDark ?? b.logoFile : b.logoFile ?? b.logoFileDark);
    const panel = (theme) => {
      const tk = THEME_TOKENS[theme];
      const accent = (theme === 'dark' ? b.accentDark : b.accent) ?? tk.accent;
      const style = `--pv-bg:${tk.bg};--pv-surface:${tk.surface};--pv-border:${tk.border};--pv-text:${tk.text};--pv-dim:${tk['text-dim']};--pv-nav:${tk.nav};--pv-nav-text:${tk['nav-text']};--pv-accent:${accent};--pv-accent-text:${tk['accent-text']}`;
      const img = logoFor(theme) ? `<img data-pv-logo="${theme}" src="/branding/logo/${theme}${v}" alt="">` : `<img data-pv-logo="${theme}" alt="" hidden>`;
      const card = `<div class="pv-card"><b>${esc(l.pvCard)}</b><i></i><small>${esc(l.pvCardHint)}</small></div>`;
      return `<div class="pv" data-pv="${theme}" style="${style}" aria-hidden="true"><div class="pv-head"><div class="pv-brand">${img}<span data-pv-name>${esc(b.name || defaultName)}</span></div><span class="pv-dot">0</span><span class="pv-chip">${esc(l.pvUser)}</span></div><div class="pv-tabs"><span class="on">${esc(l.pvTab1)}</span><span>${esc(l.pvTab2)}</span><span>${esc(l.pvTab3)}</span></div><div class="pv-body">${card}${card}${card}</div><div class="pv-foot"><span class="pv-btn">${esc(l.pvButton)}</span></div></div>`;
    };
    const nonce = res.locals?.cspNonce ? ` nonce="${esc(res.locals.cspNonce)}"` : '';
    const pvCss = `<style${nonce}>.pv-cols{display:flex;gap:1.5rem;flex-wrap:wrap;margin:.5rem 0 1rem}.pv-col{flex:1;min-width:280px;max-width:420px}.pv{border:1px solid var(--pv-border);border-radius:10px;overflow:hidden;background:var(--pv-bg);color:var(--pv-text);margin:.4rem 0 .6rem;font-size:.8rem}.pv-head{display:flex;align-items:center;gap:.5rem;padding:.5rem .75rem;background:var(--pv-nav);color:var(--pv-nav-text);border-bottom:1px solid var(--pv-border)}.pv-brand{display:flex;align-items:center;gap:.4rem;font-weight:700;flex:1;min-width:0}.pv-brand span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--pv-accent)}.pv-brand img{max-height:22px;max-width:70px;object-fit:contain}.pv-brand img[hidden]{display:none}.pv-dot{background:var(--pv-accent);color:var(--pv-accent-text);border-radius:999px;padding:0 .4rem;font-size:.7rem}.pv-chip{border:1px solid var(--pv-border);border-radius:999px;padding:0 .45rem;font-size:.7rem}.pv-tabs{display:flex;gap:1rem;padding:.4rem .75rem 0;background:var(--pv-surface);border-bottom:1px solid var(--pv-border)}.pv-tabs span{padding-bottom:.35rem;color:var(--pv-dim);border-bottom:2px solid transparent}.pv-tabs .on{color:var(--pv-accent);border-bottom-color:var(--pv-accent);font-weight:600}.pv-body{display:flex;gap:.5rem;padding:.6rem .75rem;background:var(--pv-bg)}.pv-card{flex:1;background:var(--pv-surface);border:1px solid var(--pv-border);border-left:3px solid var(--pv-accent);border-radius:6px;padding:.4rem .5rem;display:flex;flex-direction:column;gap:.25rem}.pv-card i{display:block;width:16px;height:2px;background:var(--pv-accent)}.pv-card small{color:var(--pv-dim)}.pv-foot{padding:0 .75rem .6rem;background:var(--pv-bg)}.pv-btn{display:inline-block;padding:.25rem .8rem;border-radius:6px;background:var(--pv-accent);color:var(--pv-accent-text)}.pv-swatch{display:flex;align-items:center;gap:.5rem}</style>`;
    const pvScript = `<script${nonce}>(function(){var q=function(s){return document.querySelector(s)},all=function(s){return document.querySelectorAll(s)};
var name=q('input[name=name]');if(name)name.addEventListener('input',function(){var v=name.value.trim()||name.placeholder;all('[data-pv-name]').forEach(function(e){e.textContent=v})});
[['accent','light'],['accentDark','dark']].forEach(function(p){var i=q('input[name='+p[0]+']');var el=q('.pv[data-pv='+p[1]+']');if(i&&el)i.addEventListener('input',function(){el.style.setProperty('--pv-accent',i.value)})});
all('input[type=file][data-pv-file]').forEach(function(i){i.addEventListener('change',function(){var f=i.files&&i.files[0];if(!f||!/^image\\//.test(f.type))return;var r=new FileReader();r.onload=function(){var img=q('[data-pv-logo='+i.dataset.pvFile+']');if(img){img.src=r.result;img.hidden=false}};r.readAsDataURL(f)})})})();</script>`;
    const body = `${toast}${pvCss}
<div class="adm-card" style="margin-bottom:1rem"><h2>${esc(l.name)}</h2><p class="adm-muted">${esc(l.nameHint)}</p>
<form method="post" action="${path}/name" style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">${versionField(nameState(b))}
<input class="adm-input" name="name" maxlength="100" value="${esc(b.name ?? '')}" placeholder="${esc(defaultName)}" aria-label="${esc(l.name)}" style="min-width:280px">
<button class="adm-btn primary" type="submit">${esc(l.save)}</button></form></div>
<div class="adm-card" style="margin-bottom:1rem"><h2>${esc(l.logo)}</h2><p class="adm-muted">${esc(l.logoHint)}</p>
<div style="display:flex;gap:2rem;flex-wrap:wrap">${logoCell('light', b.logoFile)}${logoCell('dark', b.logoFileDark)}</div></div>
<div class="adm-card"><h2>${esc(l.accent)}</h2><p class="adm-muted">${esc(l.accentHint)}</p><p class="adm-muted">${esc(l.previewHint)}</p>
<form method="post" action="${path}/colors">${versionField(colorState(b))}<div class="pv-cols">
<div class="pv-col"><strong>${esc(l.light)}</strong>${panel('light')}<label class="pv-swatch">${esc(l.accentLight)}<input type="color" name="accent" value="${esc(b.accent ?? THEME_TOKENS.light.accent)}"></label></div>
<div class="pv-col"><strong>${esc(l.dark)}</strong>${panel('dark')}<label class="pv-swatch">${esc(l.accentDark)}<input type="color" name="accentDark" value="${esc(b.accentDark ?? THEME_TOKENS.dark.accent)}"></label></div></div>
<button class="adm-btn primary" type="submit">${esc(l.save)}</button></form>
<form method="post" action="${path}/reset" style="margin-top:1rem"><button class="adm-btn" type="submit" data-confirm="${esc(l.confirmReset)}">${esc(l.reset)}</button></form></div>`;
    render(req, res, { active: path, title: l.title, bodyHtml: body + pvScript });
  });

  app.post(`${path}/name`, ...guard, ...stepUp, async (req, res) => {
    const form = await readForm(req);
    if (isStale(form, nameState(getCompanyBranding(db)))) return back(res, 'conflict');
    const name = String(form.name ?? '').trim();
    try {
      setCompanyBranding(db, { name: name === '' ? null : name }, { actor: req.user?.username });
      audit(req, 'name', { set: name !== '' });
      return back(res, 'ok');
    } catch { return back(res, 'bad'); }
  });

  app.post(`${path}/colors`, ...guard, ...stepUp, async (req, res) => {
    const form = await readForm(req);
    if (isStale(form, colorState(getCompanyBranding(db)))) return back(res, 'conflict');
    const pick = (v) => (HEX.test(String(v ?? '')) ? String(v).toLowerCase() : null);
    const accent = pick(form.accent);
    const accentDark = pick(form.accentDark);
    if (!accent || !accentDark) return back(res, 'bad');
    try {
      setCompanyBranding(db, { accent, accentDark }, { actor: req.user?.username });
      audit(req, 'colors', { accent, accentDark });
      return back(res, 'ok');
    } catch { return back(res, 'bad'); }
  });

  app.post(`${path}/reset`, ...guard, ...stepUp, (req, res) => {
    try {
      setCompanyBranding(db, { name: null, accent: null, accentDark: null }, { actor: req.user?.username });
      audit(req, 'reset', {});
      return back(res, 'ok');
    } catch { return back(res, 'bad'); }
  });

  const themeKey = (t) => (t === 'light' ? 'logoFile' : t === 'dark' ? 'logoFileDark' : null);

  // The multipart middleware answers with JSON; in this page flow a refusal must come back as a message instead.
  const asRedirect = (res) => new Proxy(res, {
    get(target, prop) {
      if (prop === 'status') return (code) => ({ json: () => back(target, code === 413 ? 'big' : 'bad') });
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });

  app.post(`${path}/logo/:theme`, ...guard, ...stepUp, (req, res, next) => {
    if (!themeKey(req.params.theme)) return back(res, 'bad');
    return upload(req, asRedirect(res), next);
  }, async (req, res) => {
    const key = themeKey(req.params.theme);
    if (!key) return back(res, 'bad');
    let stored;
    try {
      stored = await acceptUpload(req.upload.buffer, { allowedTypes: ['png', 'jpg', 'svg'], maxBytes, storageDir: dir, imageOptions: { maxWidth: 1024, maxHeight: 1024 }, ...(appearance.acceptOptions ?? {}) });
    } catch (err) {
      return back(res, /too large|size/i.test(String(err?.message)) ? 'big' : 'bad');
    }
    const previous = getCompanyBranding(db)[key];
    try {
      setCompanyBranding(db, { [key]: stored.filename }, { actor: req.user?.username });
    } catch {
      removeUpload(dir, stored.filename);
      return back(res, 'bad');
    }
    if (previous && previous !== stored.filename) removeUpload(dir, previous);
    audit(req, 'logo', { theme: req.params.theme, type: stored.type });
    return back(res, 'ok');
  });

  app.post(`${path}/logo/:theme/remove`, ...guard, ...stepUp, (req, res) => {
    const key = themeKey(req.params.theme);
    if (!key) return back(res, 'bad');
    const previous = getCompanyBranding(db)[key];
    try {
      setCompanyBranding(db, { [key]: null }, { actor: req.user?.username });
    } catch { return back(res, 'bad'); }
    if (previous) removeUpload(dir, previous);
    audit(req, 'logo_removed', { theme: req.params.theme });
    return back(res, 'ok');
  });
  return path;
}

export { L as APPEARANCE_TEXTS };
