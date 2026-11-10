import { parseCron } from './cron-parse.js';

const DAYS = {
  ru: ['воскресенье', 'понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу'],
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
};
const pad = (n) => String(n).padStart(2, '0');

/** The field name table shown for expressions that have no short wording. */
const FIELDS = {
  ru: ['минута', 'час', 'день месяца', 'месяц', 'день недели'],
  en: ['minute', 'hour', 'day of month', 'month', 'day of week'],
};

/**
 * A plain-language reading of a 5-field cron expression ("every day at 03:05"). Common shapes get a sentence;
 * anything else is spelled out field by field, so the text is never wrong, only less pretty.
 *
 * @param {string} expression
 * @param {'ru'|'en'} [locale='ru']
 */
export function describeCron(expression, locale = 'ru') {
  const ru = locale !== 'en';
  const f = String(expression ?? '').trim().split(/\s+/);
  try { parseCron(String(expression)); } catch { return ru ? 'некорректное расписание' : 'invalid schedule'; }
  const [mi, ho, dom, mon, dow] = f;
  const num = (x) => /^\d+$/.test(x);
  const time = num(mi) && num(ho) ? `${pad(ho)}:${pad(mi)}` : null;

  if (mi === '*' && ho === '*' && dom === '*' && mon === '*' && dow === '*') return ru ? 'каждую минуту' : 'every minute';
  let m = /^\*\/(\d+)$/.exec(mi);
  if (m && ho === '*' && dom === '*' && mon === '*' && dow === '*') return ru ? `каждые ${m[1]} мин` : `every ${m[1]} minutes`;
  if (num(mi) && ho === '*' && dom === '*' && mon === '*' && dow === '*') return ru ? `каждый час, в ${mi} мин` : `every hour, at minute ${mi}`;
  m = /^\*\/(\d+)$/.exec(ho);
  if (num(mi) && m && dom === '*' && mon === '*' && dow === '*') return ru ? `каждые ${m[1]} ч, в ${mi} мин` : `every ${m[1]} hours, at minute ${mi}`;
  if (time && dom === '*' && mon === '*' && dow === '*') return ru ? `каждый день в ${time}` : `every day at ${time}`;
  if (time && dom === '*' && mon === '*' && num(dow)) {
    const d = Number(dow) % 7;
    return ru ? `каждую неделю: в ${DAYS.ru[d]}, ${time}` : `every week on ${DAYS.en[d]} at ${time}`;
  }
  if (time && num(dom) && mon === '*' && dow === '*') return ru ? `каждый месяц ${dom}-го числа в ${time}` : `monthly on day ${dom} at ${time}`;
  const parts = f.map((v, i) => `${FIELDS[locale === 'en' ? 'en' : 'ru'][i]}: ${v}`);
  return parts.join(', ');
}
