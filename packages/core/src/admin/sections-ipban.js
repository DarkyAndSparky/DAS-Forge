import { IpBanPolicyError, IP_BAN_LIMITS, banSchedule } from '../security/ip-ban.js';
import { pickTexts } from '../i18n/overrides.js';
import { diffChanges } from '../audit/changes.js';
import { logAsync } from '../audit/async.js';
import { contextFromRequest } from '../audit/context.js';
import { readForm } from './sections.js';
import { versionField, isStale } from './edit-version.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MIN = 60_000;
const DAY = 86_400_000;

export const IPBAN_TEXTS = {
  ru: {
    title: 'Автоматический бан адресов',
    text: 'Адрес, с которого много раз неверно вводят пароль, банится сам. Бан хранится в базе и переживает перезапуск; срок растёт с каждым новым баном того же адреса. Значения действуют сразу.',
    enabled: 'Включён', maxFailures: 'Неудачных входов до бана', findTime: 'За сколько минут считать', baseBan: 'Первый бан, минут', factor: 'Во сколько раз растёт срок',
    maxBan: 'Предельный срок бана, дней', recidiveCount: 'Рецидив: банов подряд', recidiveWindow: 'Рецидив: за сколько минут', recidiveBan: 'Рецидив: срок бана, дней',
    history: 'Помнить баны, дней', ignore: 'Исключения: адреса и сети (через запятую или с новой строки)', ignoreHint: 'Например 127.0.0.0/8, 10.0.0.0/8, 203.0.113.15. Эти адреса не банятся автоматически.',
    save: 'Сохранить', reset: 'Вернуть исходные значения', resetConfirm: 'Вернуть исходные значения автобана?',
    sched: 'Сроки по порядку', schedN: 'Бан', schedTerm: 'Срок', d: 'д', h: 'ч', m: 'мин',
    done: 'Сохранено.', bad: 'Не удалось сохранить.',
    e_MAX_FAILURES_INVALID: 'Неудачных входов: от 1 до 1000.', e_FIND_TIME_MS_INVALID: 'Окно подсчёта: от 1 минуты до 30 дней.', e_BASE_BAN_MS_INVALID: 'Первый бан: от 1 минуты до 35 дней.',
    e_FACTOR_INVALID: 'Рост срока: целое от 1 до 24.', e_MAX_BAN_MS_INVALID: 'Предельный срок: от 1 минуты до 365 дней.', e_RECIDIVE_COUNT_INVALID: 'Рецидив: от 2 до 50 банов.',
    e_RECIDIVE_WINDOW_MS_INVALID: 'Окно рецидива: от 1 часа до 30 дней.', e_RECIDIVE_BAN_MS_INVALID: 'Срок бана рецидивиста: от 1 минуты до 365 дней.', e_HISTORY_RETENTION_MS_INVALID: 'Память о банах: от 1 до 400 дней.',
    e_MAX_BAN_BELOW_BASE: 'Предельный срок не может быть меньше первого бана.', e_HISTORY_TOO_SHORT: 'Память о банах не может быть короче предельного срока и срока рецидива: нарушитель «забудется» до конца бана.',
    e_IGNORE_INVALID: 'В исключениях есть запись, которая не адрес и не сеть.', e_IGNORE_TOO_LONG: 'Исключений не больше 100.', e_CONFLICT: 'Настройки уже изменил другой администратор. Страница обновлена, повторите правку.',
  },
  en: {
    title: 'Automatic address ban',
    text: 'An address from which a password is mistyped many times is banned by itself. The ban is kept in the database and survives a restart; the term grows with every new ban of the same address. Changes apply at once.',
    enabled: 'Switched on', maxFailures: 'Failed sign-ins before a ban', findTime: 'Counted over how many minutes', baseBan: 'First ban, minutes', factor: 'Term grows by a factor of',
    maxBan: 'Longest ban, days', recidiveCount: 'Repeat offender: bans', recidiveWindow: 'Repeat offender: within minutes', recidiveBan: 'Repeat offender: ban term, days',
    history: 'Remember bans, days', ignore: 'Exceptions: addresses and networks (comma or one per line)', ignoreHint: 'For example 127.0.0.0/8, 10.0.0.0/8, 203.0.113.15. These addresses are never banned automatically.',
    save: 'Save', reset: 'Restore the initial values', resetConfirm: 'Restore the initial values of the automatic ban?',
    sched: 'Terms in order', schedN: 'Ban', schedTerm: 'Term', d: 'd', h: 'h', m: 'min',
    done: 'Saved.', bad: 'Could not save.',
    e_MAX_FAILURES_INVALID: 'Failed sign-ins: 1 to 1000.', e_FIND_TIME_MS_INVALID: 'Counting window: 1 minute to 30 days.', e_BASE_BAN_MS_INVALID: 'First ban: 1 minute to 35 days.',
    e_FACTOR_INVALID: 'Growth: a whole number from 1 to 24.', e_MAX_BAN_MS_INVALID: 'Longest ban: 1 minute to 365 days.', e_RECIDIVE_COUNT_INVALID: 'Repeat offender: 2 to 50 bans.',
    e_RECIDIVE_WINDOW_MS_INVALID: 'Repeat window: 1 hour to 30 days.', e_RECIDIVE_BAN_MS_INVALID: 'Repeat offender term: 1 minute to 365 days.', e_HISTORY_RETENTION_MS_INVALID: 'Ban memory: 1 to 400 days.',
    e_MAX_BAN_BELOW_BASE: 'The longest ban cannot be shorter than the first one.', e_HISTORY_TOO_SHORT: 'The ban memory cannot be shorter than the longest ban and the repeat term: an offender would be forgotten before the ban ends.',
    e_IGNORE_INVALID: 'An exception is neither an address nor a network.', e_IGNORE_TOO_LONG: 'At most 100 exceptions.', e_CONFLICT: 'Another administrator has changed the settings. The page is reloaded, please repeat the change.',
  },
};

const stateOf = (v) => ({ enabled: v.enabled, maxFailures: v.maxFailures, findTimeMs: v.findTimeMs, baseBanMs: v.baseBanMs, factor: v.factor, maxBanMs: v.maxBanMs, recidiveCount: v.recidiveCount, recidiveWindowMs: v.recidiveWindowMs, recidiveBanMs: v.recidiveBanMs, historyRetentionMs: v.historyRetentionMs, ignore: v.ignore });
const KEYS = Object.keys(stateOf({ ignore: [] }));

/** Human term: "1 д 2 ч" / "45 мин". */
export function termText(ms, l) {
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / 3_600_000);
  const m = Math.round((ms % 3_600_000) / MIN);
  return [d ? `${d} ${l.d}` : '', h ? `${h} ${l.h}` : '', m && !d ? `${m} ${l.m}` : ''].filter(Boolean).join(' ') || `0 ${l.m}`;
}

/**
 * The "Automatic address ban" block of the Security page and its routes.
 * @param {string} o.path - path of the Security page
 */
export function mountIpBan({ app, db, guard, stepUp = [], path, ipBan, texts = {}, localeOf }) {
  const base = `${path}/ip-ban`;
  const tx = (req) => pickTexts(IPBAN_TEXTS, texts['admin-ipban'], localeOf(req), 'admin-ipban');
  const audit = async (req, action, meta) => await logAsync(db, { ...contextFromRequest(req), action, entity: 'ip_ban_policy', meta });
  const back = (res, q) => res.redirect(303, `${path}?${q}#ip-ban`);
  const num = (name, label, value, min, max) => `<label class="adm-field">${esc(label)}<input class="adm-input" type="number" name="${name}" value="${esc(value)}" min="${min}" max="${max}" style="width:9rem;height:2.4rem;box-sizing:border-box"></label>`;
  const L = IP_BAN_LIMITS;

  async function block(req) {
    const l = tx(req);
    const v = await ipBan.get();
    const sched = banSchedule(v, 8).map((ms, i) => `<tr><td>${l.schedN} ${i + 1}</td><td>${esc(termText(ms, l))}</td></tr>`).join('');
    const err = req.query?.msg === 'bad' && req.query?.s === 'ip' ? `<div class="adm-toast" style="border-left-color:var(--adm-danger)">${esc(l[`e_${String(req.query.e ?? '')}`] ?? l.bad)}</div>` : req.query?.msg === 'ok' && req.query?.s === 'ip' ? `<div class="adm-toast">${esc(l.done)}</div>` : '';
    return `<div class="adm-card" id="ip-ban" style="margin-top:1rem"><h2>${esc(l.title)}</h2><p class="adm-muted">${esc(l.text)}</p>${err}
<form method="post" action="${base}" style="display:flex;flex-direction:column;gap:.75rem;max-width:40rem">${versionField(stateOf(v))}
<label class="adm-field" style="flex-direction:row;gap:.5rem;align-items:center"><input type="checkbox" name="enabled" value="1"${v.enabled ? ' checked' : ''}> ${esc(l.enabled)}</label>
<div style="display:flex;gap:.75rem;flex-wrap:wrap">${num('maxFailures', l.maxFailures, v.maxFailures, L.maxFailures[0], L.maxFailures[1])}${num('findTimeMin', l.findTime, v.findTimeMs / MIN, 1, L.findTimeMs[1] / MIN)}${num('baseBanMin', l.baseBan, v.baseBanMs / MIN, 1, L.baseBanMs[1] / MIN)}${num('factor', l.factor, v.factor, L.factor[0], L.factor[1])}</div>
<div style="display:flex;gap:.75rem;flex-wrap:wrap">${num('maxBanDays', l.maxBan, v.maxBanMs / DAY, 1, L.maxBanMs[1] / DAY)}${num('recidiveCount', l.recidiveCount, v.recidiveCount, L.recidiveCount[0], L.recidiveCount[1])}${num('recidiveWindowMin', l.recidiveWindow, v.recidiveWindowMs / MIN, 60, L.recidiveWindowMs[1] / MIN)}${num('recidiveBanDays', l.recidiveBan, v.recidiveBanMs / DAY, 1, L.recidiveBanMs[1] / DAY)}${num('historyDays', l.history, v.historyRetentionMs / DAY, 1, L.historyRetentionMs[1] / DAY)}</div>
<label class="adm-field">${esc(l.ignore)}<textarea class="adm-input" name="ignore" rows="3" maxlength="4000">${esc(v.ignore.join('\n'))}</textarea></label><p class="adm-muted">${esc(l.ignoreHint)}</p>
<div><button class="adm-btn primary" type="submit">${esc(l.save)}</button></div></form>
<form method="post" action="${base}/reset" style="margin-top:.75rem" onsubmit="return confirm(${esc(JSON.stringify(l.resetConfirm))})"><button class="adm-btn" type="submit">${esc(l.reset)}</button></form>
<h3 style="margin-top:1.25rem">${esc(l.sched)}</h3><table class="adm-table" style="max-width:20rem"><tbody>${sched}</tbody></table></div>`;
  }

  const toMs = (raw, unit) => { const n = Number(String(raw ?? '').trim()); return Number.isFinite(n) && String(raw).trim() !== '' ? Math.round(n * unit) : 'x'; };

  app.post(base, ...guard, ...stepUp, async (req, res, next) => {
    try {
      const f = await readForm(req);
      const before = await ipBan.get();
      if (isStale(f, stateOf(before))) return back(res, 'msg=bad&s=ip&e=CONFLICT');
      const patch = {
        enabled: f.enabled === '1',
        maxFailures: f.maxFailures,
        findTimeMs: toMs(f.findTimeMin, MIN), baseBanMs: toMs(f.baseBanMin, MIN), factor: f.factor,
        maxBanMs: toMs(f.maxBanDays, DAY), recidiveCount: f.recidiveCount, recidiveWindowMs: toMs(f.recidiveWindowMin, MIN), recidiveBanMs: toMs(f.recidiveBanDays, DAY), historyRetentionMs: toMs(f.historyDays, DAY),
        ignore: String(f.ignore ?? '').slice(0, 4000),
      };
      const after = await ipBan.set(patch);
      await audit(req, 'admin.ipban.set', { changes: diffChanges(before, after, { fields: KEYS }) });
      back(res, 'msg=ok&s=ip');
    } catch (e) {
      if (e instanceof IpBanPolicyError) return back(res, `msg=bad&s=ip&e=${encodeURIComponent(e.code)}`);
      next(e);
    }
  });

  app.post(`${base}/reset`, ...guard, ...stepUp, async (req, res, next) => {
    try {
      await ipBan.reset();
      await audit(req, 'admin.ipban.reset');
      back(res, 'msg=ok&s=ip');
    } catch (e) { next(e); }
  });

  return { block };
}
