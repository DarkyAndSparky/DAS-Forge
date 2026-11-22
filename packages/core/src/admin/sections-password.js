import { asyncDb } from '../database/async.js';
import { requirePasswordChangeForAllAsync } from '../auth/index.js';
import { diffChanges } from '../audit/changes.js';
import { pickTexts } from '../i18n/overrides.js';
import { PasswordPolicyError } from '../auth/password-policy-store.js';
import { logAsync } from '../audit/async.js';
import { contextFromRequest } from '../audit/context.js';
import { readForm } from './sections.js';
import { versionField, isStale } from './edit-version.js';
import { mountPasswordDictionary, DICT_TEXTS } from './sections-password-dictionary.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const BASE_TEXTS = {
  ru: {
    passwordPolicy: 'Парольная политика',
    hint: 'Правила действуют сразу для смены пароля, сброса по ссылке и входа. Уже существующие пароли не проверяются: чтобы все выбрали новый пароль по новым правилам, воспользуйтесь кнопками внизу.',
    minLength: 'Минимальная длина', adminMinLength: 'Минимальная длина для администраторов', requireClasses: 'Классы символов (0–4)', maxAgeDays: 'Срок действия пароля, дней (0 — без срока)', historyCount: 'Запрет повторов: сколько прошлых паролей помнить (0–24)',
    classesHint: 'Классы: строчные, заглавные буквы, цифры, остальные знаки. 0 — не требовать.',
    mfaTitle: 'Второй фактор по ролям', mfaText: 'Для отмеченной роли второй фактор обязателен. Пользователь без фактора при следующем входе попадает только на страницу его настройки; пока код не подтверждён, другие страницы закрыты. Тем, у кого указана почта, уходит письмо. Роли, для которых второй фактор требует разработчик приложения (в коде или в настройке `auth.totp.requiredRoles`), остаются обязательными независимо от переключателей: администратор может только добавлять роли.',
    mfaFixed: 'Задано разработчиком, снять нельзя', mfaRole: 'Роль', mfaState: 'Второй фактор', mfaOn: 'Обязателен', mfaOff: 'Не требуется', mfaEnable: 'Сделать обязательным', mfaDisable: 'Отключить требование', mfaConfirm: 'Сделать второй фактор обязательным для этой роли?', mfaNone: 'Приложение не передало список ролей.', mfaMailed: 'Писем отправлено',
    storeTitle: 'Как хранятся пароли', storeText: 'Пароль нигде не хранится в открытом виде: в базе лежит только хэш argon2id (память 19 МиБ, 2 прохода, 1 поток; значения задаются настройкой auth.argon2), у каждого пароля своя соль. Старые схемы хэшей проверяются и при первом удачном входе заменяются на argon2id. Для истории паролей хранятся хэши, а не сами пароли; сброс по ссылке, сессии и коды восстановления тоже хранятся в виде хэшей. Секреты второго фактора зашифрованы ключом приложения.',
    always: 'Всегда', alwaysText: 'Пароль не может совпадать с логином и содержать его, содержать имя приложения и часть e-mail до «@», быть из списка распространённых паролей, совпадать с текущим.',
    save: 'Сохранить', reset: 'Вернуть значения из настроек',
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
    minLength: 'Minimum length', adminMinLength: 'Minimum length for administrators', requireClasses: 'Character classes (0–4)', maxAgeDays: 'Password lifetime, days (0 = unlimited)', historyCount: 'Reuse ban: how many previous passwords to remember (0–24)',
    classesHint: 'Classes: lower-case, upper-case, digits, other symbols. 0 means not required.',
    mfaTitle: 'Second factor by role', mfaText: 'For a role switched on here a second factor is required. A user with none is taken, at the next sign-in, only to the page where one is set up; other pages stay closed until a code is confirmed. Users with an e-mail address get a letter. Roles the application developer requires (in code or in `auth.totp.requiredRoles`) stay required whatever these switches say: an administrator can only add roles.',
    mfaFixed: 'Set by the developer, cannot be removed', mfaRole: 'Role', mfaState: 'Second factor', mfaOn: 'Required', mfaOff: 'Not required', mfaEnable: 'Make required', mfaDisable: 'Remove the requirement', mfaConfirm: 'Make a second factor required for this role?', mfaNone: 'The application passed no list of roles.', mfaMailed: 'Letters sent',
    storeTitle: 'How passwords are stored', storeText: 'A password is never kept in clear: the database holds only an argon2id hash (19 MiB of memory, 2 passes, 1 thread; the values are set by auth.argon2), each with its own salt. Older hash schemes are checked and replaced with argon2id at the first successful sign-in. The password history keeps hashes, not passwords; reset links, sessions and recovery codes are stored as hashes too. Second-factor secrets are encrypted with the application key.',
    always: 'Always', alwaysText: 'A password may not equal or contain the login, contain the application name or the part of the e-mail before "@", be on the list of common passwords or equal the current one.',
    save: 'Save', reset: 'Back to the configured values',
    bulkTitle: 'Require a password change', bulkText: 'The chosen users are signed out and must set a new password at the next sign-in. Your own account is not affected.',
    bulkAll: 'All users', bulkAdmins: 'Administrators only', bulkConfirm: 'Sign out and require a password change?',
    done: 'Saved.', bad: 'Could not save.', bulkDone: 'Done. Accounts affected',
    e_MIN_LENGTH_INVALID: 'The minimum length is at least 8 and not above the configured limit.',
    e_ADMIN_MIN_LENGTH_INVALID: 'The length for administrators cannot be below the general one.',
    e_CONFLICT: 'Another administrator has changed the policy. The page is reloaded, please repeat the change', e_CLASSES_INVALID: 'Character classes: 0 to 4.', e_MAX_AGE_INVALID: 'The lifetime is 0 to 3650 days.', e_HISTORY_INVALID: 'Remembered passwords: 0 to 24.', e_PROFILE_UNKNOWN: 'Unknown profile.',
  },
};
export const PASSWORD_TEXTS = { ru: { ...BASE_TEXTS.ru, ...DICT_TEXTS.ru }, en: { ...BASE_TEXTS.en, ...DICT_TEXTS.en } };

const policyState = (v) => ({ minLength: v.minLength, adminMinLength: v.adminMinLength, requireClasses: v.requireClasses, maxAgeDays: v.maxAgeDays, historyCount: v.historyCount });

/** The "Password policy" section: profile and numbers, plus "require a new password" for everyone or for administrators. */
export function mountPasswordPolicySection({ app, db, guard, page: render, basePath, localeOf, texts = {}, stepUp = [], passwordPolicy, adminRoles = [], roles = [], mfaRoles = null, mfaFixedRole = null, emailService = null }) {
  const p = `${basePath}/password-policy`;
  const tx = (req) => pickTexts(PASSWORD_TEXTS, texts['admin-password'], localeOf(req), 'admin-password');
  const audit = async (req, action, meta) => await logAsync(db, { ...contextFromRequest(req), action, entity: 'password_policy', meta });
  const num = (name, label, v, min, max) => `<label class="adm-field">${esc(label)}<input class="adm-input" type="number" name="${name}" value="${esc(v)}" min="${min}" max="${max}" style="width:8rem;height:2.4rem;box-sizing:border-box"></label>`;

  const dict = passwordPolicy.dictionary ? mountPasswordDictionary({ app, db, guard, stepUp, p, dictionary: passwordPolicy.dictionary, tx, localeOf }) : null;

  app.get(p, ...guard, async (req, res, next) => {
   try {
    const l = tx(req);
    const v = await passwordPolicy.get();
    const msg = req.query?.msg === 'ok' ? `<div class="adm-toast">${esc(l.done)}${req.query.n != null ? ` ${esc(l.bulkDone)}: ${esc(String(req.query.n).slice(0, 8))}` : ''}</div>` : req.query?.msg === 'bad' ? `<div class="adm-toast" style="border-left-color:var(--adm-danger)">${esc(l[`e_${String(req.query.e ?? '')}`] ?? l.bad)}</div>` : '';
    const form = `<form method="post" action="${p}" class="adm-card" style="display:flex;flex-direction:column;gap:.75rem;max-width:36rem">${versionField(policyState(v))}
${num('minLength', l.minLength, v.minLength, 8, v.maxLength)}${num('adminMinLength', l.adminMinLength, v.adminMinLength, 8, v.maxLength)}${num('requireClasses', l.requireClasses, v.requireClasses, 0, 4)}${num('maxAgeDays', l.maxAgeDays, v.maxAgeDays, 0, 3650)}${num('historyCount', l.historyCount, v.historyCount, 0, 24)}
<p class="adm-muted">${esc(l.classesHint)}</p>
<div><button class="adm-btn primary" type="submit">${esc(l.save)}</button></div></form>
<form method="post" action="${p}/reset" style="margin-top:.75rem"><button class="adm-btn" type="submit">${esc(l.reset)}</button></form>`;
    const bulk = (kind, label) => `<form method="post" action="${p}/require-change" style="display:inline-block;margin-right:.5rem" onsubmit="return confirm(${esc(JSON.stringify(l.bulkConfirm))})"><input type="hidden" name="scope" value="${kind}"><button class="adm-btn danger" type="submit">${esc(label)}</button></form>`;
    const bulkHtml = `<div class="adm-card" style="margin-top:1rem"><h2>${esc(l.bulkTitle)}</h2><p class="adm-muted">${esc(l.bulkText)}</p>${bulk('all', l.bulkAll)}${adminRoles.length ? bulk('admins', l.bulkAdmins) : ''}</div>`;
    const enabled = new Set(mfaRoles ? mfaRoles.list() : []);
    const mfaRow = (role) => (mfaFixedRole?.(role) ? `<tr><td>${esc(role)}</td><td>${esc(l.mfaOn)}</td><td class="adm-muted">${esc(l.mfaFixed)}</td></tr>` : mfaRow0(role));
    const mfaRow0 = (role) => `<tr><td>${esc(role)}</td><td>${enabled.has(role) ? esc(l.mfaOn) : esc(l.mfaOff)}</td><td><form method="post" action="${p}/mfa-roles" onsubmit="return ${enabled.has(role) ? 'true' : `confirm(${esc(JSON.stringify(l.mfaConfirm))})`}"><input type="hidden" name="role" value="${esc(role)}"><input type="hidden" name="required" value="${enabled.has(role) ? '0' : '1'}"><button class="adm-btn${enabled.has(role) ? '' : ' danger'}" type="submit">${esc(enabled.has(role) ? l.mfaDisable : l.mfaEnable)}</button></form></td></tr>`;
    const mfaHtml = mfaRoles ? `<div class="adm-card" style="margin-top:1rem"><h2>${esc(l.mfaTitle)}</h2><p class="adm-muted">${esc(l.mfaText)}</p>${roles.length ? `<table class="adm-table"><thead><tr><th>${esc(l.mfaRole)}</th><th>${esc(l.mfaState)}</th><th></th></tr></thead><tbody>${roles.map(mfaRow).join('')}</tbody></table>` : `<p class="adm-muted">${esc(l.mfaNone)}</p>`}</div>` : '';
    const dictHtml = dict ? await dict.block(req, res) : '';
    const storeHtml = `<div class="adm-card" style="margin-top:1rem"><h2>${esc(l.storeTitle)}</h2><p class="adm-muted">${esc(l.storeText)}</p></div>`;
    await render(req, res, { active: p, title: l.passwordPolicy, bodyHtml: `${msg}<div class="adm-card" style="margin-bottom:1rem"><p class="adm-muted">${esc(l.hint)}</p><p><strong>${esc(l.always)}:</strong> ${esc(l.alwaysText)}</p></div>${form}${bulkHtml}${mfaHtml}${dictHtml}${storeHtml}` });
   } catch (err) { next(err); }
  });

  app.post(p, ...guard, ...stepUp, async (req, res, next) => {
    try {
      const f = await readForm(req);
      const before = await passwordPolicy.get();
      if (isStale(f, policyState(before))) return res.redirect(303, `${p}?msg=bad&e=CONFLICT`);
      const typed = { minLength: f.minLength, adminMinLength: f.adminMinLength, requireClasses: f.requireClasses, maxAgeDays: f.maxAgeDays, historyCount: f.historyCount };
      const after = await passwordPolicy.set({ profile: 'custom', ...typed });
      const keys = ['minLength', 'adminMinLength', 'requireClasses', 'maxAgeDays', 'historyCount'];
      await audit(req, 'admin.passwordpolicy.set', { changes: diffChanges(before, after, { fields: keys }) });
      res.redirect(303, `${p}?msg=ok`);
    } catch (err) {
      if (err instanceof PasswordPolicyError) return res.redirect(303, `${p}?msg=bad&e=${encodeURIComponent(err.code)}`);
      return next(err);
    }
  });

  app.post(`${p}/reset`, ...guard, ...stepUp, async (req, res, next) => {
    try {
      await passwordPolicy.reset();
      await audit(req, 'admin.passwordpolicy.reset');
      res.redirect(303, `${p}?msg=ok`);
    } catch (err) { next(err); }
  });

  app.post(`${p}/require-change`, ...guard, ...stepUp, async (req, res, next) => {
    try {
      const f = await readForm(req);
      const scope = f.scope === 'admins' && adminRoles.length ? 'admins' : 'all';
      const r = await requirePasswordChangeForAllAsync(db, { roles: scope === 'admins' ? adminRoles : null, exceptId: req.user?.id ?? null });
      await audit(req, 'admin.passwordpolicy.require_change', { scope, affected: r.affected, revokedSessions: r.revokedSessions });
      res.redirect(303, `${p}?msg=ok&n=${r.affected}`);
    } catch (err) { next(err); }
  });

  app.post(`${p}/mfa-roles`, ...guard, ...stepUp, async (req, res, next) => {
    try {
      const f = await readForm(req);
      const role = String(f.role ?? '');
      if (!mfaRoles || !roles.includes(role)) return res.redirect(303, `${p}?msg=bad`);
      const required = f.required === '1';
      if (!required && mfaFixedRole?.(role)) return res.redirect(303, `${p}?msg=bad`);
      const r = mfaRoles.setRole(role, required);
      if (!r.changed) return res.redirect(303, `${p}?msg=ok`);
      await audit(req, 'admin.mfaroles.set', { role, required });
      // Switching a role ON: tell the users of that role who have no second factor yet and an address to write to.
      let mailed = 0;
      if (required && emailService?.enabled && typeof emailService.sendMfaRequired === 'function') {
        const rows = await asyncDb(db).all(
          `SELECT u.id, u.email FROM users u WHERE u.role = ? AND u.disabled = 0 AND u.email IS NOT NULL AND u.email <> ''
             AND NOT EXISTS (SELECT 1 FROM authenticators a WHERE a.user_id = u.id AND a.type = 'totp' AND a.status = 'active')
           LIMIT 1000`, [role]);
        for (const u of rows) {
          try { await emailService.sendMfaRequired({ to: u.email, locale: localeOf(req) }); mailed += 1; } catch { /* one bad address must not stop the others */ }
        }
      }
      res.redirect(303, `${p}?msg=ok&n=${mailed}`);
    } catch (err) { next(err); }
  });
}
