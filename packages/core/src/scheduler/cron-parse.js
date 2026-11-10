/**
 * Minimal standard 5-field cron parser (minute hour day-of-month month
 * day-of-week). Supports `*`, exact numbers, lists (`1,2,3`), ranges
 * (`1-5`), and step expressions (star-slash-15, `1-30/5`) - covers
 * every cron expression the architecture doc's default backup schedule
 * (`backup.schedule` in core/config, default `'0 3 * * *'`) and any
 * realistic app-level job need. No seconds field, no vixie-cron
 * special strings (@daily etc.) - deliberately small rather than
 * pulling in a full cron library for 5 fields of integer matching.
 */

const FIELD_RANGES = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (0 and 7 are both Sunday; 7 is folded into 0 after parsing)
];

function parseField(field, [min, max]) {
  if (field === '*') {
    const all = new Set();
    for (let i = min; i <= max; i++) all.add(i);
    return all;
  }

  const values = new Set();
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    // Strict integers only: Number('') is 0 and parseInt('5x') is 5, both
    // used to slip through. A step of 0 made the loop below spin forever
    // at startup (audit B15).
    if (stepPart !== undefined && !/^\d+$/.test(stepPart)) {
      throw new Error(`Invalid cron step in segment: "${part}"`);
    }
    const step = stepPart !== undefined ? Number(stepPart) : 1;
    if (step < 1) throw new Error(`Cron step must be >= 1 in segment: "${part}"`);

    let rangeMin = min;
    let rangeMax = max;
    if (rangePart !== '*') {
      if (rangePart.includes('-')) {
        const bounds = rangePart.split('-');
        if (bounds.length !== 2 || !bounds.every((x) => /^\d+$/.test(x))) {
          throw new Error(`Invalid cron field segment: "${part}"`);
        }
        rangeMin = Number(bounds[0]);
        rangeMax = Number(bounds[1]);
      } else {
        if (!/^\d+$/.test(rangePart)) throw new Error(`Invalid cron field segment: "${part}"`);
        rangeMin = rangeMax = Number(rangePart);
      }
    }

    if (Number.isNaN(rangeMin) || Number.isNaN(rangeMax) || Number.isNaN(step)) {
      throw new Error(`Invalid cron field segment: "${part}"`);
    }
    if (rangeMin < min || rangeMax > max || rangeMin > rangeMax) {
      throw new Error(`Cron field segment "${part}" out of range [${min}, ${max}]`);
    }

    for (let i = rangeMin; i <= rangeMax; i += step) values.add(i);
  }

  return values;
}

/**
 * @param {string} expression - 5-field cron string, e.g. "0 3 * * *"
 * @returns {{minute:Set,hour:Set,dayOfMonth:Set,month:Set,dayOfWeek:Set}}
 */
export function parseCron(expression) {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Cron expression must have 5 fields, got ${fields.length}: "${expression}"`);
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields.map((f, i) => parseField(f, FIELD_RANGES[i]));
  if (dayOfWeek.delete(7)) dayOfWeek.add(0);
  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    // Standard cron quirk: when BOTH day-of-month and day-of-week are
    // restricted (not "*"), a match happens if EITHER matches (OR),
    // not both (AND). When only one (or neither) is restricted, normal
    // AND semantics apply. This trips people up constantly, so it's
    // tracked explicitly here rather than silently doing the "obvious"
    // (wrong) AND-everything thing.
    dayOfMonthIsWildcard: fields[2] === '*',
    dayOfWeekIsWildcard: fields[4] === '*',
  };
}

function matchesDate(parsed, date) {
  if (!parsed.minute.has(date.getMinutes())) return false;
  if (!parsed.hour.has(date.getHours())) return false;
  if (!parsed.month.has(date.getMonth() + 1)) return false;

  const domMatch = parsed.dayOfMonth.has(date.getDate());
  const dowMatch = parsed.dayOfWeek.has(date.getDay());

  if (!parsed.dayOfMonthIsWildcard && !parsed.dayOfWeekIsWildcard) {
    return domMatch || dowMatch;
  }
  return domMatch && dowMatch;
}

const dtfCache = new Map();
function zoneParts(date, timeZone) {
  let dtf = dtfCache.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', weekday: 'short',
    });
    dtfCache.set(timeZone, dtf);
  }
  const out = {};
  for (const p of dtf.formatToParts(date)) out[p.type] = p.value;
  const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    minute: +out.minute, hour: +out.hour % 24, day: +out.day, month: +out.month, dow: WD[out.weekday],
  };
}

function matchesZoned(parsed, z) {
  const domMatch = parsed.dayOfMonth.has(z.day);
  const dowMatch = parsed.dayOfWeek.has(z.dow);
  if (!parsed.dayOfMonthIsWildcard && !parsed.dayOfWeekIsWildcard) return domMatch || dowMatch;
  return domMatch && dowMatch;
}

/** Next run in an IANA time zone (DST-aware: a skipped local hour simply never matches; a repeated one fires twice). */
function getNextRunInZone(parsed, expression, from, timeZone) {
  zoneParts(from, timeZone); // throws RangeError for an unknown zone
  let t = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000;
  const limit = from.getTime() + 2 * 366 * 24 * 60 * 60_000;
  while (t <= limit) {
    const z = zoneParts(new Date(t), timeZone);
    if (!parsed.month.has(z.month) || !matchesZoned(parsed, z)) {
      t += (60 - z.minute) * 60_000; // skip to the next local hour boundary
    } else if (!parsed.hour.has(z.hour)) {
      t += (60 - z.minute) * 60_000;
    } else if (!parsed.minute.has(z.minute)) {
      t += 60_000;
    } else {
      return new Date(t);
    }
  }
  throw new Error(`No matching run time found for cron expression "${expression}" within 2 years`);
}

/**
 * Finds the next matching run time strictly after `from`, by walking
 * forward minute-by-minute. Bounded to 2 years out so a malformed/
 * impossible expression (e.g. Feb 30) fails loudly instead of looping
 * forever.
 *
 * @param {string} expression
 * @param {Date} [from] - defaults to now
 * @param {{timezone?: string}} [opts] - IANA zone (e.g. 'Asia/Yekaterinburg'); default = process local time
 * @returns {Date}
 */
export function getNextRun(expression, from = new Date(), { timezone } = {}) {
  const parsed = parseCron(expression);
  if (timezone) return getNextRunInZone(parsed, expression, from, timezone);
  const candidate = new Date(from.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const maxIterations = 60 * 24 * 366 * 2; // ~2 years of minutes
  for (let i = 0; i < maxIterations; i++) {
    if (matchesDate(parsed, candidate)) return candidate;
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  throw new Error(`No matching run time found for cron expression "${expression}" within 2 years`);
}
