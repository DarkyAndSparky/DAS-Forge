import { pickTexts } from '../i18n/overrides.js';
import { log } from '../audit/log.js';
import { contextFromRequest } from '../audit/context.js';
import { isAnonymizedUser } from '../auth/user-admin.js';
import { readForm } from './sections.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MAX_SUBJECT = 150;
const MAX_MESSAGE = 5000;
const MAX_RECIPIENTS = 5000;

export const BROADCAST_TEXTS = {
  ru: {
    broadcast: 'Рассылка',
    hint: 'Служебное письмо пользователям, например о плановых работах. Каждому уходит отдельное письмо (адреса других получателей не видны), через очередь почты с повторами. Получатели: действующие учётные записи с адресом e-mail. Для рассылки о работах без почты есть «Объявление».',
    off: 'Почта выключена: настройте раздел email в конфигурации. Отправка недоступна.',
    language: 'Язык письма', allRoles: 'Все роли', role: 'Кому', subject: 'Тема', message: 'Текст письма', recipients: 'Получателей',
    sendTest: 'Отправить тест мне', sendAll: 'Отправить всем', confirm: 'Отправить письмо получателям?', noEmail: 'У вашей учётной записи нет адреса e-mail: тест отправить некуда.',
    done: 'Готово.', sentTo: 'Поставлено в очередь', skipped: 'пропущено (лимит на адрес)', failed: 'не удалось', bad: 'Не удалось отправить.',
    e_SUBJECT_INVALID: 'Тема обязательна, до 150 знаков, в одну строку.', e_MESSAGE_INVALID: 'Текст обязателен, до 5000 знаков.', e_LOCALE_INVALID: 'Неизвестный язык.', e_ROLE_INVALID: 'Неизвестная роль.', e_NO_RECIPIENTS: 'Нет получателей.', e_TOO_MANY: 'Слишком много получателей за один раз (не более 5000).', e_MAIL_OFF: 'Почта выключена.', e_NO_EMAIL: 'У вашей учётной записи нет адреса e-mail.',
    testSent: 'Тестовое письмо поставлено в очередь.',
  },
  en: {
    broadcast: 'Broadcast',
    hint: 'A service e-mail to users, for example about planned maintenance. Each person gets a separate mail (other addresses are not visible), through the mail queue with retries. Recipients: active accounts that have an e-mail address. For maintenance notices without e-mail use "Announcement".',
    off: 'E-mail is off: set up the email section of the configuration. Sending is unavailable.',
    language: 'Language of the mail', allRoles: 'All roles', role: 'To', subject: 'Subject', message: 'Message', recipients: 'Recipients',
    sendTest: 'Send a test to me', sendAll: 'Send to everyone', confirm: 'Send the mail to the recipients?', noEmail: 'Your account has no e-mail address: there is nowhere to send the test.',
    done: 'Done.', sentTo: 'Queued', skipped: 'skipped (per-address limit)', failed: 'failed', bad: 'Could not send.',
    e_SUBJECT_INVALID: 'A subject is required, up to 150 characters, one line.', e_MESSAGE_INVALID: 'A message is required, up to 5000 characters.', e_LOCALE_INVALID: 'Unknown language.', e_ROLE_INVALID: 'Unknown role.', e_NO_RECIPIENTS: 'No recipients.', e_TOO_MANY: 'Too many recipients at once (at most 5000).', e_MAIL_OFF: 'E-mail is off.', e_NO_EMAIL: 'Your account has no e-mail address.',
    testSent: 'The test mail is queued.',
  },
};

class BroadcastError extends Error {
  constructor(code) { super(code); this.code = code; }
}

/** The "Broadcast" section: one service e-mail to all active users or to one role, with a test to yourself first. */
export function mountBroadcastSection({ app, db, guard, page: render, basePath, localeOf, texts = {}, stepUp = [], mail, roles = [] }) {
  const p = `${basePath}/broadcast`;
  const tx = (req) => pickTexts(BROADCAST_TEXTS, texts['admin-broadcast'], localeOf(req), 'admin-broadcast');
  const field = 'height:2.4rem;box-sizing:border-box';

  function recipientsFor(role) {
    const rows = db.all(`SELECT id, username, email, role, disabled FROM users WHERE email IS NOT NULL AND email != '' AND disabled = 0 ORDER BY id`);
    return rows.filter((u) => !isAnonymizedUser(u) && (!role || u.role === role));
  }

  function readInput(f) {
    const subject = String(f.subject ?? '').trim();
    const message = String(f.message ?? '').trim();
    const locale = String(f.locale ?? 'ru');
    const role = String(f.role ?? '');
    if (!subject || subject.length > MAX_SUBJECT || /[\r\n]/.test(subject)) throw new BroadcastError('SUBJECT_INVALID');
    if (!message || message.length > MAX_MESSAGE) throw new BroadcastError('MESSAGE_INVALID');
    if (locale !== 'ru' && locale !== 'en') throw new BroadcastError('LOCALE_INVALID');
    if (role && !roles.includes(role)) throw new BroadcastError('ROLE_INVALID');
    return { subject, message, locale, role };
  }

  const audit = (req, action, meta) => log(db, { ...contextFromRequest(req), action, entity: 'broadcast', meta });
  const toast = (l, req) => (req.query?.msg === 'ok'
    ? `<div class="adm-toast">${esc(l.done)} ${req.query.t ? esc(l.testSent) : `${esc(l.sentTo)}: ${esc(String(req.query.n ?? 0).slice(0, 6))}; ${esc(l.skipped)}: ${esc(String(req.query.s ?? 0).slice(0, 6))}; ${esc(l.failed)}: ${esc(String(req.query.f ?? 0).slice(0, 6))}`}</div>`
    : req.query?.msg === 'bad' ? `<div class="adm-toast" style="border-left-color:var(--adm-danger)">${esc(l[`e_${String(req.query.e ?? '')}`] ?? l.bad)}</div>` : '');

  app.get(p, ...guard, (req, res) => {
    const l = tx(req);
    const on = Boolean(mail.service?.enabled);
    const count = recipientsFor('').length;
    const roleOpts = `<option value="">${esc(l.allRoles)}</option>${roles.map((r) => `<option value="${esc(r)}">${esc(r)} (${recipientsFor(r).length})</option>`).join('')}`;
    const form = `<form method="post" action="${p}/send" class="adm-card" style="display:flex;flex-direction:column;gap:.75rem;max-width:40rem">
<label class="adm-field">${esc(l.role)}<select class="adm-input" name="role" style="${field}">${roleOpts}</select></label>
<label class="adm-field">${esc(l.language)}<select class="adm-input" name="locale" style="${field}"><option value="ru">Русский</option><option value="en">English</option></select></label>
<label class="adm-field">${esc(l.subject)}<input class="adm-input" name="subject" required maxlength="${MAX_SUBJECT}" style="${field}"></label>
<label class="adm-field">${esc(l.message)}<textarea class="adm-input" name="message" rows="8" required maxlength="${MAX_MESSAGE}"></textarea></label>
<div style="display:flex;gap:.5rem;flex-wrap:wrap"><button class="adm-btn" type="submit" formaction="${p}/test"${on ? '' : ' disabled'}>${esc(l.sendTest)}</button><button class="adm-btn danger" type="submit" data-confirm="${esc(l.confirm)}"${on ? '' : ' disabled'}>${esc(l.sendAll)}</button></div></form>`;
    render(req, res, { active: p, title: l.broadcast, bodyHtml: `${toast(l, req)}<div class="adm-card" style="margin-bottom:1rem"><p class="adm-muted">${esc(l.hint)}</p>${on ? '' : `<p><span class="adm-badge warn">${esc(l.off)}</span></p>`}<p>${esc(l.recipients)}: <strong>${count}</strong></p></div>${form}` });
  });

  async function deliver(list, input) {
    let queued = 0; let skipped = 0; let failed = 0;
    for (const u of list) {
      try {
        const r = await mail.service.sendSystemNotice({ to: u.email, subject: input.subject, message: input.message, locale: input.locale });
        if (r?.queued || r?.sent) queued++; else skipped++;
      } catch { failed++; }
    }
    return { queued, skipped, failed };
  }

  app.post(`${p}/send`, ...guard, ...stepUp, async (req, res, next) => {
    try {
      if (!mail.service?.enabled) throw new BroadcastError('MAIL_OFF');
      const input = readInput(await readForm(req, MAX_MESSAGE + 4096));
      const list = recipientsFor(input.role);
      if (!list.length) throw new BroadcastError('NO_RECIPIENTS');
      if (list.length > MAX_RECIPIENTS) throw new BroadcastError('TOO_MANY');
      const r = await deliver(list, input);
      audit(req, 'admin.broadcast.send', { recipients: list.length, ...r, role: input.role || null, locale: input.locale, subject: input.subject.slice(0, 100) });
      res.redirect(303, `${p}?msg=ok&n=${r.queued}&s=${r.skipped}&f=${r.failed}`);
    } catch (err) {
      if (err instanceof BroadcastError) return res.redirect(303, `${p}?msg=bad&e=${encodeURIComponent(err.code)}`);
      return next(err);
    }
  });

  app.post(`${p}/test`, ...guard, ...stepUp, async (req, res, next) => {
    try {
      if (!mail.service?.enabled) throw new BroadcastError('MAIL_OFF');
      const input = readInput(await readForm(req, MAX_MESSAGE + 4096));
      const me = req.user?.id != null ? db.get('SELECT email FROM users WHERE id = ?', [req.user.id]) : null;
      if (!me?.email) throw new BroadcastError('NO_EMAIL');
      await deliver([{ email: me.email }], input);
      audit(req, 'admin.broadcast.test', { locale: input.locale });
      res.redirect(303, `${p}?msg=ok&t=1`);
    } catch (err) {
      if (err instanceof BroadcastError) return res.redirect(303, `${p}?msg=bad&e=${encodeURIComponent(err.code)}`);
      return next(err);
    }
  });
}
