import { diffChanges } from '../audit/changes.js';
import { pickTexts } from '../i18n/overrides.js';
import { PasswordPolicyError, PASSWORD_PROFILES } from '../auth/password-policy-store.js';
import { requirePasswordChangeForAll } from '../auth/user-admin.js';
import { log } from '../audit/log.js';
import { contextFromRequest } from '../audit/context.js';
import { readForm } from './sections.js';
import { versionField, isStale } from './edit-version.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const PASSWORD_TEXTS = {
  ru: {
    passwordPolicy: 'Парольная политика',
    hint: 'Правила действуют сразу для смены пароля, сброса по ссылке и входа. Уже существующие пароли не проверяются: чтобы все выбрали новый пароль по новым правилам, воспользуйтесь кнопками внизу.',
    profile: 'Профиль', pNist: 'NIST — длинный пароль без правил состава', pFstec: 'ФСТЭК (ориентир) — 12 символов и все четыре класса символов', pCustom: 'Свои значения',
    minLength: 'Минимальная длина', adminMinLength: 'Минимальная длина для администраторов', requireClasses: 'Классы символов (0–4)', maxAgeDays: 'Срок действия пароля, дней (0 — без срока)', historyCount: 'Запрет повторов: сколько прошлых паролей помнить (0–24)',
    classesHint: 'Классы: строчные, заглавные буквы, цифры, остальные знаки. 0 — не требовать.',
    always: 'Всегда', alwaysText: 'Пароль не может совпадать с логином и содержать его, содержать имя приложения и часть e-mail до «@», быть из списка распространённых паролей, совпадать с текущим.',
    save: 'Сохранить', reset: 'Вернуть значения из настроек',
    fstecNote: 'Профиль «ФСТЭК» — ориентир по методическому документу ФСТЭК России от 12.04.2026 (мера ИАФ.3): 12 символов и алфавит от 70 знаков. Профиль включает смену раз в 90 дней и запрет повторов последних 12 паролей (документ требует не повторять никакие прежние, при необходимости поднимите число до 24); сверяйте требования с документом.',
    bulkTitle: 'Потребовать смену пароля', bulkText: 'Выбранные пользователи будут разлогинены и при следующем входе обязаны задать новый пароль. Вашу учётную запись это не затрагивает.',
    bulkAll: 'У всех пользователей', bulkAdmins: 'Только у администраторов', bulkConfirm: 'Разлогинить и потребовать смену пароля?',
    done: 'Сохранено.', bad: 'Не удалось сохранить.', bulkDone: 'Готово. Затронуто учётных записей',
    e_MIN_LENGTH_INVALID: 'Минимальная длина — от 8 символов и не больше предела в настройках.',
    e_ADMIN_MIN_LENGTH_INVALID: 'Длина для администраторов не может быть меньше общей.',
    e_CONFLICT: 'Политику уже изменил другой администратор. Страница обновлена, повторите правку', e_CLASSES_INVALID: 'Классов символов — от 0 до 4.', e_MAX_AGE_INVALID: 'Срок — от 0 до 3650 дней.', e_HISTORY_INVALID: 'Число запоминаемых паролей — от 0 до 24.', e_PROFILE_UNKNOWN: 'Неизвестный профиль.',
  },
  en: {
    passwordPolicy: 'Password policy',
    hint: 'The rules apply at once to password changes, e-mailed resets and sign-in. Existing passwords are not re-checked: use the buttons below to make everyone choose a new one under the new rules.',
    profile: 'Profile', pNist: 'NIST — long password, no composition rules', pFstec: 'FSTEC (guideline) — 12 characters and all four character classes', pCustom: 'Custom values',
    minLength: 'Minimum length', adminMinLength: 'Minimum length for administrators', requireClasses: 'Character classes (0–4)', maxAgeDays: 'Password lifetime, days (0 = unlimited)', historyCount: 'Reuse ban: how many previous passwords to remember (0–24)',
    classesHint: 'Classes: lower-case, upper-case, digits, other symbols. 0 means not required.',
    always: 'Always', alwaysText: 'A password may not equal or contain the login, contain the application name or the part of the e-mail before "@", be on the list of common passwords or equal the current one.',
    save: 'Save', reset: 'Back to the configured values',
    fstecNote: 'The "FSTEC" profile follows the guideline of FSTEC of Russia of 12 April 2026 (measure IAF.3): 12 characters and an alphabet of 70+ symbols. The profile turns on a 90-day change and a ban on reusing the last 12 passwords (the document asks that no earlier password is reused; raise the number to 24 if needed); check the requirements against the document.',
    bulkTitle: 'Require a password change', bulkText: 'The chosen users are signed out and must set a new password at the next sign-in. Your own account is not affected.',
    bulkAll: 'All users', bulkAdmins: 'Administrators only', bulkConfirm: 'Sign out and require a password change?',
    done: 'Saved.', bad: 'Could not save.', bulkDone: 'Done. Accounts affected',
    e_MIN_LENGTH_INVALID: 'The minimum length is at least 8 and not above the configured limit.',
    e_ADMIN_MIN_LENGTH_INVALID: 'The length for administrators cannot be below the general one.',
    e_CONFLICT: 'Another administrator has changed the policy. The page is reloaded, please repeat the change', e_CLASSES_INVALID: 'Character classes: 0 to 4.', e_MAX_AGE_INVALID: 'The lifetime is 0 to 3650 days.', e_HISTORY_INVALID: 'Remembered passwords: 0 to 24.', e_PROFILE_UNKNOWN: 'Unknown profile.',
  },
};

const policyState = (v) => ({ profile: v.profile, minLength: v.minLength, adminMinLength: v.adminMinLength, requireClasses: v.requireClasses, maxAgeDays: v.maxAgeDays, historyCount: v.historyCount });

/** The "Password policy" section: profile and numbers, plus "require a new password" for everyone or for administrators. */
export function mountPasswordPolicySection({ app, db, guard, page: render, basePath, localeOf, texts = {}, stepUp = [], passwordPolicy, adminRoles = [] }) {
  const p = `${basePath}/password-policy`;
  const tx = (req) => pickTexts(PASSWORD_TEXTS, texts['admin-password'], localeOf(req), 'admin-password');
  const audit = (req, action, meta) => log(db, { ...contextFromRequest(req), action, entity: 'password_policy', meta });
  const num = (name, label, v, min, max) => `<label class="adm-field">${esc(label)}<input class="adm-input" type="number" name="${name}" value="${esc(v)}" min="${min}" max="${max}" style="width:8rem;height:2.4rem;box-sizing:border-box"></label>`;

  app.get(p, ...guard, (req, res) => {
    const l = tx(req);
    const v = passwordPolicy.get();
    const msg = req.query?.msg === 'ok' ? `<div class="adm-toast">${esc(l.done)}${req.query.n != null ? ` ${esc(l.bulkDone)}: ${esc(String(req.query.n).slice(0, 8))}` : ''}</div>` : req.query?.msg === 'bad' ? `<div class="adm-toast" style="border-left-color:var(--adm-danger)">${esc(l[`e_${String(req.query.e ?? '')}`] ?? l.bad)}</div>` : '';
    const opt = (val, label) => `<option value="${val}"${v.profile === val ? ' selected' : ''}>${esc(label)}</option>`;
    const form = `<form method="post" action="${p}" class="adm-card" style="display:flex;flex-direction:column;gap:.75rem;max-width:36rem">${versionField(policyState(v))}
<label class="adm-field">${esc(l.profile)}<select class="adm-input" name="profile" style="height:2.4rem;box-sizing:border-box">${opt('nist', l.pNist)}${opt('fstec', l.pFstec)}${opt('custom', l.pCustom)}</select></label>
${num('minLength', l.minLength, v.minLength, 8, v.maxLength)}${num('adminMinLength', l.adminMinLength, v.adminMinLength, 8, v.maxLength)}${num('requireClasses', l.requireClasses, v.requireClasses, 0, 4)}${num('maxAgeDays', l.maxAgeDays, v.maxAgeDays, 0, 3650)}${num('historyCount', l.historyCount, v.historyCount, 0, 24)}
<p class="adm-muted">${esc(l.classesHint)}</p>
<div><button class="adm-btn primary" type="submit">${esc(l.save)}</button></div></form>
<form method="post" action="${p}/reset" style="margin-top:.75rem"><button class="adm-btn" type="submit">${esc(l.reset)}</button></form>`;
    const bulk = (kind, label) => `<form method="post" action="${p}/require-change" style="display:inline-block;margin-right:.5rem" onsubmit="return confirm(${esc(JSON.stringify(l.bulkConfirm))})"><input type="hidden" name="scope" value="${kind}"><button class="adm-btn danger" type="submit">${esc(label)}</button></form>`;
    const bulkHtml = `<div class="adm-card" style="margin-top:1rem"><h2>${esc(l.bulkTitle)}</h2><p class="adm-muted">${esc(l.bulkText)}</p>${bulk('all', l.bulkAll)}${adminRoles.length ? bulk('admins', l.bulkAdmins) : ''}</div>`;
    render(req, res, { active: p, title: l.passwordPolicy, bodyHtml: `${msg}<div class="adm-card" style="margin-bottom:1rem"><p class="adm-muted">${esc(l.hint)}</p><p><strong>${esc(l.always)}:</strong> ${esc(l.alwaysText)}</p><p class="adm-muted">${esc(l.fstecNote)}</p></div>${form}${bulkHtml}` });
  });

  app.post(p, ...guard, ...stepUp, async (req, res, next) => {
    try {
      const f = await readForm(req);
      const before = passwordPolicy.get();
      if (isStale(f, policyState(before))) return res.redirect(303, `${p}?msg=bad&e=CONFLICT`);
      // A ready-made profile fills the numbers; "custom" (or the numbers changed by hand) keeps what was typed.
      const profile = String(f.profile ?? '');
      const typed = { minLength: f.minLength, adminMinLength: f.adminMinLength, requireClasses: f.requireClasses, maxAgeDays: f.maxAgeDays, historyCount: f.historyCount };
      const changedByHand = ['minLength', 'adminMinLength', 'requireClasses', 'maxAgeDays', 'historyCount'].some((k) => typed[k] !== undefined && String(typed[k]) !== String(before[k]));
      const after = passwordPolicy.set(profile !== before.profile && PASSWORD_PROFILES[profile] && !changedByHand ? { profile } : { profile: 'custom', ...typed });
      const keys = ['profile', 'minLength', 'adminMinLength', 'requireClasses', 'maxAgeDays', 'historyCount'];
      audit(req, 'admin.passwordpolicy.set', { changes: diffChanges(before, after, { fields: keys }) });
      res.redirect(303, `${p}?msg=ok`);
    } catch (err) {
      if (err instanceof PasswordPolicyError) return res.redirect(303, `${p}?msg=bad&e=${encodeURIComponent(err.code)}`);
      return next(err);
    }
  });

  app.post(`${p}/reset`, ...guard, ...stepUp, (req, res, next) => {
    try {
      passwordPolicy.reset();
      audit(req, 'admin.passwordpolicy.reset');
      res.redirect(303, `${p}?msg=ok`);
    } catch (err) { next(err); }
  });

  app.post(`${p}/require-change`, ...guard, ...stepUp, async (req, res, next) => {
    try {
      const f = await readForm(req);
      const scope = f.scope === 'admins' && adminRoles.length ? 'admins' : 'all';
      const r = requirePasswordChangeForAll(db, { roles: scope === 'admins' ? adminRoles : null, exceptId: req.user?.id ?? null });
      audit(req, 'admin.passwordpolicy.require_change', { scope, affected: r.affected, revokedSessions: r.revokedSessions });
      res.redirect(303, `${p}?msg=ok&n=${r.affected}`);
    } catch (err) { next(err); }
  });
}
