/**
 * Number formats as a spreadsheet shows them: "#,##0.00", "0%", "dd.mm.yyyy", "[h]:mm", "0.0,,\"M\"", fractions,
 * scientific, text sections, conditions. `createFormatter().show(value, code)` returns the text a person sees in the
 * cell. It never evaluates anything: a format code is only ever read, one character at a time, never run.
 *
 * What is not done (and shown plainly as the number or text itself): colours (read and dropped), fill characters
 * (`*x`), locale-specific calendars, and the fake 29 February 1900 (serial 60 shows as 28 Feb).
 */

const LOCALES = {
  en: {
    decimal: '.', thousands: ',', trueText: 'TRUE', falseText: 'FALSE',
    months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
    monthsGen: null,
    monthsShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    daysShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    am: 'AM', pm: 'PM', longDate: 'dddd, mmmm d, yyyy', longTime: 'h:mm:ss AM/PM', shortDate: 'm/d/yyyy', shortDateTime: 'm/d/yyyy h:mm',
  },
  ru: {
    decimal: ',', thousands: ' ', trueText: 'ИСТИНА', falseText: 'ЛОЖЬ',
    months: ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'],
    monthsGen: ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'],
    monthsShort: ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'],
    days: ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'],
    daysShort: ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'],
    am: 'AM', pm: 'PM', longDate: 'd mmmm yyyy "г."', longTime: 'h:mm:ss', shortDate: 'dd.mm.yyyy', shortDateTime: 'dd.mm.yyyy h:mm',
  },
};

/** The built-in format codes by number (the ones that depend on the user's system settings are given for `en`). */
export function builtinCode(id, locale = 'en') {
  const L = LOCALES[locale] ?? LOCALES.en;
  switch (id) {
    case 0: return 'General';
    case 1: return '0';
    case 2: return '0.00';
    case 3: return '#,##0';
    case 4: return '#,##0.00';
    case 5: return '"$"#,##0_);\\("$"#,##0\\)';
    case 6: return '"$"#,##0_);[Red]\\("$"#,##0\\)';
    case 7: return '"$"#,##0.00_);\\("$"#,##0.00\\)';
    case 8: return '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)';
    case 9: return '0%';
    case 10: return '0.00%';
    case 11: return '0.00E+00';
    case 12: return '# ?/?';
    case 13: return '# ??/??';
    case 14: return L.shortDate;
    case 15: return 'd-mmm-yy';
    case 16: return 'd-mmm';
    case 17: return 'mmm-yy';
    case 18: return 'h:mm AM/PM';
    case 19: return 'h:mm:ss AM/PM';
    case 20: return 'h:mm';
    case 21: return 'h:mm:ss';
    case 22: return L.shortDateTime;
    case 37: return '#,##0_);\\(#,##0\\)';
    case 38: return '#,##0_);[Red]\\(#,##0\\)';
    case 39: return '#,##0.00_);\\(#,##0.00\\)';
    case 40: return '#,##0.00_);[Red]\\(#,##0.00\\)';
    case 41: return '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)';
    case 42: return '_("$"* #,##0_);_("$"* \\(#,##0\\);_("$"* "-"_);_(@_)';
    case 43: return '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)';
    case 44: return '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)';
    case 45: return 'mm:ss';
    case 46: return '[h]:mm:ss';
    case 47: return 'mm:ss.0';
    case 48: return '##0.0E+0';
    case 49: return '@';
    default: return id >= 27 && id <= 36 ? L.shortDate : id >= 50 && id <= 58 ? L.shortDate : undefined;
  }
}

// ---- reading a format code ----------------------------------------------------------------------------------------

const cache = new Map();

/** Splits a code at its unquoted ";" (at most four sections), keeping the characters of each. */
function splitSections(code) {
  const out = []; let cur = ''; let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"') { const e = code.indexOf('"', i + 1); const stop = e < 0 ? code.length : e + 1; cur += code.slice(i, stop); i = stop; continue; }
    if (ch === '\\' || ch === '_' || ch === '*') { cur += code.slice(i, i + 2); i += 2; continue; }
    if (ch === '[') { const e = code.indexOf(']', i + 1); const stop = e < 0 ? code.length : e + 1; cur += code.slice(i, stop); i = stop; continue; }
    if (ch === ';') { out.push(cur); cur = ''; i += 1; if (out.length === 3) { out.push(code.slice(i)); return out; } continue; }
    cur += ch; i += 1;
  }
  out.push(cur);
  return out;
}

const CONDITION = /^([<>]=?|=|<>)\s*(-?\d+(?:\.\d+)?)$/;

function parseSection(src) {
  const tokens = []; let cond = null; let hasDate = false; let hasText = false; let hasNumber = false; let era = 0;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === '"') { const e = src.indexOf('"', i + 1); const stop = e < 0 ? n : e; tokens.push({ t: 'lit', v: src.slice(i + 1, stop) }); i = stop + 1; continue; }
    if (ch === '\\') { if (i + 1 < n) tokens.push({ t: 'lit', v: src[i + 1] }); i += 2; continue; }
    if (ch === '_') { if (i + 1 < n) tokens.push({ t: 'lit', v: ' ' }); i += 2; continue; }
    if (ch === '*') { i += 2; continue; } // fill: not reproduced
    if (ch === '[') {
      const e = src.indexOf(']', i + 1); const stop = e < 0 ? n : e; const body = src.slice(i + 1, stop); i = stop + 1;
      if (/^(h+|m+|s+)$/i.test(body)) { tokens.push({ t: 'elapsed', u: body[0].toLowerCase(), n: body.length }); hasDate = true; }
      else if (CONDITION.test(body)) { const m = CONDITION.exec(body); cond = { op: m[1], v: Number(m[2]) }; }
      else if (body[0] === '$') { if (/^\$-0*404$/i.test(body.split(']')[0])) era = 1911; const cur = /^\$([^-\]]*)/.exec(body)?.[1]; if (cur) tokens.push({ t: 'lit', v: cur }); }
      continue; // colours, locale codes, DBNum...
    }
    if (ch === '@') { tokens.push({ t: 'text' }); hasText = true; i += 1; continue; }
    if (ch === '0' || ch === '#' || ch === '?') { tokens.push({ t: 'digit', v: ch }); hasNumber = true; i += 1; continue; }
    if (ch === '.') { tokens.push({ t: 'point' }); i += 1; continue; }
    if (ch === ',') { tokens.push({ t: 'comma' }); i += 1; continue; }
    if (ch === '%') { tokens.push({ t: 'percent' }); i += 1; continue; }
    if (ch === '/' ) { tokens.push({ t: 'slash' }); i += 1; continue; }
    if ((ch === 'E' || ch === 'e') && (src[i + 1] === '+' || src[i + 1] === '-')) { tokens.push({ t: 'exp', plus: src[i + 1] === '+' }); hasNumber = true; i += 2; continue; }
    if ((ch === 'e' || ch === 'E') && !hasNumber) { let j = i; while (j < n && src[j].toLowerCase() === 'e') j++; tokens.push({ t: 'd', u: 'e', n: j - i, era }); hasDate = true; i = j; continue; }
    if (/[ymdhsYMDHS]/.test(ch)) {
      let j = i; while (j < n && src[j].toLowerCase() === ch.toLowerCase()) j++;
      tokens.push({ t: 'd', u: ch.toLowerCase(), n: j - i }); hasDate = true; i = j; continue;
    }
    if (/^AM\/PM/i.test(src.slice(i, i + 5))) { tokens.push({ t: 'ampm', long: true }); hasDate = true; i += 5; continue; }
    if (/^A\/P/i.test(src.slice(i, i + 3))) { tokens.push({ t: 'ampm', long: false }); hasDate = true; i += 3; continue; }
    if (/^general/i.test(src.slice(i, i + 7))) { tokens.push({ t: 'general' }); i += 7; continue; }
    tokens.push({ t: 'lit', v: ch }); i += 1;
  }
  return { tokens, cond, hasDate, hasText, hasNumber, general: tokens.length === 1 && tokens[0].t === 'general' };
}

function parseCode(code) {
  let p = cache.get(code);
  if (p) return p;
  p = { sections: splitSections(code).map(parseSection) };
  if (cache.size > 500) cache.clear();
  cache.set(code, p);
  return p;
}

// ---- numbers ------------------------------------------------------------------------------------------------------

/** The decimal digits of |x| to 15 significant digits, as {int, frac} strings (no exponent form, no float noise). */
function plainDigits(x) {
  const [m, e] = Math.abs(x).toExponential(14).split('e');
  const digits = m.replace('.', ''); const exp = Number(e);
  if (exp >= 0) { const int = digits.slice(0, exp + 1).padEnd(exp + 1, '0'); return { int, frac: digits.slice(exp + 1) }; }
  return { int: '0', frac: '0'.repeat(-exp - 1) + digits };
}

/** Rounds {int, frac} half away from zero to `d` decimals. */
function roundTo({ int, frac }, d) {
  if (frac.length <= d) return { int, frac: frac.padEnd(d, '0') };
  const up = frac.charCodeAt(d) >= 53;
  let all = (int + frac.slice(0, d)).split('').map(Number);
  if (up) { let k = all.length - 1; while (k >= 0) { if (all[k] === 9) { all[k] = 0; k -= 1; } else { all[k] += 1; break; } } if (k < 0) all = [1, ...all]; }
  const s = all.join('');
  return { int: s.slice(0, s.length - d) || '0', frac: s.slice(s.length - d) };
}

function groupThousands(int, sep) { return int.replace(/\B(?=(\d{3})+$)/g, sep); }

function general(x, L) {
  if (x === 0) return '0';
  const a = Math.abs(x); let s;
  if (a >= 1e11 || a < 1e-4) s = a.toExponential(5).replace(/\.?0+e/, 'e').replace('e', 'E').replace(/E([+-])(\d)$/, 'E$10$2');
  else { s = Number(a.toPrecision(15)).toString(); }
  return (x < 0 ? '-' : '') + s.replace('.', L.decimal);
}

function bestFraction(x, maxDen) {
  let best = { n: Math.round(x), d: 1 }; let err = Math.abs(x - best.n);
  for (let d = 2; d <= maxDen && err > 1e-12; d++) { const n = Math.round(x * d); const e = Math.abs(x - n / d); if (e < err - 1e-12) { best = { n, d }; err = e; } }
  return best;
}

function renderNumber(tokens, value, L, hasSign) {
  let x = Math.abs(value);
  const percents = tokens.filter((t) => t.t === 'percent').length;
  x *= 100 ** percents;
  const pointAt = tokens.findIndex((t) => t.t === 'point');
  const expAt = tokens.findIndex((t) => t.t === 'exp');
  const slashAt = tokens.findIndex((t) => t.t === 'slash');
  const digitsIdx = tokens.map((t, i) => (t.t === 'digit' ? i : -1)).filter((i) => i >= 0);
  const lastDigit = digitsIdx.length ? digitsIdx[digitsIdx.length - 1] : -1;
  const firstDigit = digitsIdx.length ? digitsIdx[0] : -1;
  // commas right after the last digit placeholder divide by 1000 each; commas between digit placeholders group thousands
  let scale = 0; let grouping = false;
  const dropped = new Set();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].t !== 'comma') continue;
    if (i > firstDigit && i < lastDigit) { grouping = true; dropped.add(i); }
    else if (i > lastDigit && lastDigit >= 0 && tokens.slice(lastDigit + 1, i).every((t) => t.t === 'comma')) { scale += 1; dropped.add(i); }
  }
  x /= 1000 ** scale;
  const out = [];
  const sign = hasSign && value < 0 ? '-' : '';

  if (slashAt >= 0) { // fractions: "# ?/?" "?/8"
    const numPlaceholders = tokens.slice(0, slashAt).filter((t) => t.t === 'digit');
    const denTokens = tokens.slice(slashAt + 1);
    const denDigits = denTokens.filter((t) => t.t === 'digit' && t.v !== '#' || false);
    const fixedDen = (() => { const lits = []; for (const t of denTokens) { if (t.t === 'lit' && /^\d+$/.test(t.v)) lits.push(t.v); else if (t.t === 'digit') break; } return lits.length ? Number(lits.join('')) : null; })();
    const denWidth = denTokens.filter((t) => t.t === 'digit').length;
    const hasWhole = tokens.slice(0, slashAt).some((t) => t.t === 'lit' && t.v === ' ') && numPlaceholders.length > 1;
    const numWidth = hasWhole ? numPlaceholders.length - 0 : numPlaceholders.length;
    const whole = hasWhole ? Math.floor(x) : 0; const rest = hasWhole ? x - whole : x;
    const maxDen = fixedDen ?? 10 ** Math.max(1, denWidth) - 1;
    let { n, d } = fixedDen ? { n: Math.round(rest * fixedDen), d: fixedDen } : bestFraction(rest, maxDen);
    let w = whole;
    if (hasWhole && n === d) { w += 1; n = 0; }
    const intText = hasWhole ? (w === 0 && n !== 0 ? '' : String(w)) : '';
    const fracWidthNum = tokens.slice(0, slashAt).filter((t) => t.t === 'digit').length - (hasWhole ? 1 : 0);
    const fracText = n === 0 && hasWhole ? ' '.repeat(String(d).length + Math.max(1, fracWidthNum) + 1) : `${String(n).padStart(Math.max(1, fracWidthNum), ' ')}/${String(d).padEnd(denWidth, ' ')}`;
    let wrote = false;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.t === 'lit') { if (!(i > slashAt && fixedDen && /^\d+$/.test(t.v))) out.push(t.v); }
      else if (t.t === 'digit' && !wrote) { out.push(hasWhole ? `${intText}` : ''); wrote = true; if (!hasWhole) out.push(fracText); }
      else if (t.t === 'slash' || t.t === 'digit') { /* consumed */ if (t.t === 'slash' && hasWhole) { /* placed below */ } }
    }
    if (hasWhole) { const spaceAt = out.indexOf(' '); const text = `${out.slice(0, spaceAt < 0 ? out.length : spaceAt).join('')}${spaceAt < 0 ? '' : ' '}${fracText.trim() ? fracText : fracText}`; return sign + text; }
    return sign + out.join('');
  }

  if (expAt >= 0) { // scientific
    const mant = tokens.slice(0, expAt); const expDigits = tokens.slice(expAt + 1).filter((t) => t.t === 'digit').length;
    const P = Math.max(1, mant.filter((t, i) => t.t === 'digit' && i < (mant.findIndex((m) => m.t === 'point') < 0 ? mant.length : mant.findIndex((m) => m.t === 'point'))).length);
    const D = pointAt >= 0 ? mant.slice(pointAt).filter((t) => t.t === 'digit').length : 0;
    let e = x === 0 ? 0 : Math.floor(Math.log10(x)); e -= ((e % P) + P) % P;
    let m = roundTo(plainDigits(x === 0 ? 0 : x / 10 ** e), D);
    if (m.int.length > P) { e += P; m = roundTo(plainDigits(x / 10 ** e), D); }
    let mi = 0;
    for (const t of mant) {
      if (t.t === 'lit') out.push(t.v);
      else if (t.t === 'point') out.push(L.decimal);
      else if (t.t === 'digit') out.push(m.int.padStart(P, '0')[mi] ?? m.frac[mi - P] ?? '0'), mi += 1;
    }
    const ex = String(Math.abs(e)).padStart(expDigits, '0');
    const expTok = tokens[expAt];
    out.push(`E${e < 0 ? '-' : expTok.plus ? '+' : ''}${ex}`);
    for (const t of tokens.slice(expAt + 1)) if (t.t === 'lit') out.push(t.v);
    return sign + out.join('');
  }

  const D = pointAt >= 0 ? tokens.slice(pointAt + 1).filter((t, k, a) => t.t === 'digit').length : 0;
  const rounded = roundTo(plainDigits(x), D);
  let { int, frac } = rounded;
  const intTokens = []; const fracTokens = [];
  tokens.forEach((t, i) => { if (t.t === 'digit') (pointAt >= 0 && i > pointAt ? fracTokens : intTokens).push(i); });
  const zeros = intTokens.filter((i) => tokens[i].v === '0').length;
  const questions = intTokens.filter((i) => tokens[i].v === '?').length;
  if (int === '0' && zeros === 0) int = '';
  // trailing fraction placeholders: # drops a trailing zero, ? turns it into a space
  const fracChars = frac.split('');
  for (let k = fracTokens.length - 1; k >= 0; k--) {
    const v = tokens[fracTokens[k]].v;
    if (fracChars[k] === '0' && v !== '0') fracChars[k] = v === '?' ? ' ' : '';
    else break;
  }
  const interleaved = intTokens.length > 1 && tokens.slice(intTokens[0], intTokens[intTokens.length - 1]).some((t, j) => !['digit', 'comma'].includes(t.t));
  const intDigits = int.padStart(zeros, '0');
  const printedInt = grouping ? groupThousands(intDigits, L.thousands) : intDigits;
  let fi = 0;
  let placedInt = false; let intPos = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (dropped.has(i)) continue;
    if (t.t === 'lit') out.push(t.v);
    else if (t.t === 'percent') out.push('%');
    else if (t.t === 'point') out.push(L.decimal);
    else if (t.t === 'text') out.push('');
    else if (t.t === 'digit') {
      if (pointAt >= 0 && i > pointAt) { out.push(fracChars[fi] ?? ''); fi += 1; }
      else if (!interleaved) { if (!placedInt) { out.push(questions && !zeros ? int.padStart(intTokens.length, ' ') : printedInt); placedInt = true; } }
      else {
        const posFromRight = intTokens.length - 1 - intPos; const ch = intDigits[intDigits.length - 1 - posFromRight];
        const extra = intPos === 0 ? intDigits.slice(0, Math.max(0, intDigits.length - intTokens.length)) : '';
        out.push(extra + (ch ?? (t.v === '0' ? '0' : t.v === '?' ? ' ' : '')));
        intPos += 1;
      }
    }
  }
  if (pointAt >= 0 && D > 0 && fracChars.every((c) => c === '') && tokens.slice(pointAt + 1).every((t) => t.t !== 'digit' || t.v === '#')) { /* "5." stays, as in Excel */ }
  return sign + out.join('');
}

// ---- dates and times ----------------------------------------------------------------------------------------------

function renderDate(tokens, serial, L, date1904) {
  if (!Number.isFinite(serial) || serial < 0) return '########';
  const fracDigits = (() => { const i = tokens.findIndex((t) => t.t === 'd' && t.u === 's'); const j = tokens.findIndex((t, k) => k > i && t.t === 'point'); return i >= 0 && j === i + 1 ? tokens.slice(j + 1).filter((t) => t.t === 'digit').length : 0; })();
  const fracPoint = (() => { const i = tokens.findIndex((t) => t.t === 'd' && t.u === 's'); return i >= 0 && tokens[i + 1]?.t === 'point' ? i + 1 : -1; })();
  let days = Math.floor(serial); let ms = Math.round((serial - days) * 86_400_000);
  const step = 10 ** (3 - Math.min(3, fracDigits));
  ms = Math.round(ms / step) * step;
  if (ms >= 86_400_000) { days += 1; ms -= 86_400_000; }
  const hasAmPm = tokens.some((t) => t.t === 'ampm');
  let y; let mo; let d; let wd;
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const shift = !date1904 && days >= 1 && days < 61 ? 86_400_000 : 0;
  const dt = new Date(base + days * 86_400_000 + shift);
  if (Number.isNaN(dt.getTime())) return '########';
  y = dt.getUTCFullYear(); mo = dt.getUTCMonth(); d = dt.getUTCDate(); wd = dt.getUTCDay();
  const h24 = Math.floor(ms / 3_600_000); const mi = Math.floor(ms / 60_000) % 60; const se = Math.floor(ms / 1000) % 60; const sub = ms % 1000;
  const out = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.t === 'lit') out.push(t.v);
    else if (t.t === 'elapsed') {
      const total = serial * 86400; // seconds since the base day, with the fraction
      const v = t.u === 'h' ? Math.floor(Math.round(serial * 86400) / 3600) : t.u === 'm' ? Math.floor(Math.round(serial * 86400) / 60) : Math.round(serial * 86400);
      out.push(String(v).padStart(t.n, '0'));
      void total;
    } else if (t.t === 'ampm') out.push(h24 < 12 ? (t.long ? L.am : 'A') : (t.long ? L.pm : 'P'));
    else if (t.t === 'point') out.push(fracDigits && k === fracPoint ? L.decimal : '.');
    else if (t.t === 'comma') out.push(',');
    else if (t.t === 'slash') out.push('/');
    else if (t.t === 'percent') out.push('%');
    else if (t.t === 'digit' && fracDigits) out.push(String(sub).padStart(3, '0')[tokens.slice(0, k).filter((x) => x.t === 'digit').length] ?? '0');
    else if (t.t === 'd') {
      if (t.u === 'e') out.push(String(y - (t.era ?? 0)));
      else if (t.u === 'y') out.push(t.n <= 2 ? String(y % 100).padStart(2, '0') : String(y).padStart(4, '0'));
      else if (t.u === 'd') out.push(t.n === 1 ? String(d) : t.n === 2 ? String(d).padStart(2, '0') : t.n === 3 ? L.daysShort[wd] : L.days[wd]);
      else if (t.u === 'h') { const hh = hasAmPm ? (h24 % 12 === 0 ? 12 : h24 % 12) : h24; out.push(t.n === 1 ? String(hh) : String(hh).padStart(2, '0')); }
      else if (t.u === 's') out.push(t.n === 1 ? String(se) : String(se).padStart(2, '0'));
      else if (t.u === 'm') {
        // "m" is a minute right after an hour and right before seconds, otherwise a month
        let minute = false;
        for (let b = k - 1; b >= 0; b--) { const p = tokens[b]; if (p.t === 'd') { minute = p.u === 'h'; break; } if (p.t === 'elapsed') { minute = p.u === 'h'; break; } }
        if (!minute) for (let f = k + 1; f < tokens.length; f++) { const p = tokens[f]; if (p.t === 'd') { minute = p.u === 's'; break; } if (p.t === 'elapsed') { minute = p.u === 's'; break; } }
        if (minute) out.push(t.n === 1 ? String(mi) : String(mi).padStart(2, '0'));
        else if (t.n === 1) out.push(String(mo + 1));
        else if (t.n === 2) out.push(String(mo + 1).padStart(2, '0'));
        else if (t.n === 3) out.push(L.monthsShort[mo]);
        else if (t.n === 4) {
          const before = tokens.slice(0, k).reverse().find((p) => p.t !== 'lit' || p.v.trim() !== '');
          out.push(L.monthsGen && before?.t === 'd' && before.u === 'd' && before.n <= 2 ? L.monthsGen[mo] : L.months[mo]);
        } else out.push(L.months[mo][0]);
      }
    } else if (t.t === 'text') out.push('');
  }
  return out.join('');
}

// ---- the public face ----------------------------------------------------------------------------------------------

function testCondition(c, v) {
  switch (c.op) { case '>': return v > c.v; case '>=': return v >= c.v; case '<': return v < c.v; case '<=': return v <= c.v; case '=': return v === c.v; default: return v !== c.v; }
}

/**
 * @param {{locale?: 'en'|'ru', date1904?: boolean}} [opts]
 * @returns {{show: (value: number|string|boolean|Date|null, code?: string) => string|null, builtin: (id: number) => string|undefined}}
 */
export function createFormatter({ locale = 'en', date1904 = false } = {}) {
  const L = LOCALES[locale] ?? LOCALES.en;
  const toSerial = (d) => (d.getTime() - (date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30))) / 86_400_000;
  function show(value, code = 'General') {
    if (value === null || value === undefined) return null;
    if (typeof value === 'boolean') return value ? L.trueText : L.falseText;
    let src = code.length > 255 ? 'General' : code;
    if (src.includes('[$-F')) src = src.replace(/\[\$-F800\][^;]*/gi, L.longDate).replace(/\[\$-F400\][^;]*/gi, L.longTime);
    const { sections } = parseCode(src);
    if (typeof value === 'string') {
      const sec = sections.length === 4 ? sections[3] : sections.length === 1 && sections[0].hasText ? sections[0] : sections.find((s) => s.hasText && sections.length > 1 && s === sections[sections.length - 1]);
      if (!sec) return value;
      return sec.tokens.map((t) => (t.t === 'text' ? value : t.t === 'lit' ? t.v : '')).join('');
    }
    const num = value instanceof Date ? toSerial(value) : value;
    if (!Number.isFinite(num)) return null;
    // choose the section
    let idx = 0;
    const conditional = sections.some((s) => s.cond);
    if (conditional) {
      idx = -1;
      for (let i = 0; i < Math.min(sections.length, 3); i++) if (sections[i].cond && testCondition(sections[i].cond, num)) { idx = i; break; }
      if (idx < 0) idx = Math.min(sections.length, 3) - 1 >= 0 ? Math.min(sections.length, 3) - 1 : 0;
      if (sections[idx].cond === null && sections.length >= 2 && idx === 0) idx = 0;
    } else if (sections.length === 2) idx = num < 0 ? 1 : 0;
    else if (sections.length >= 3) idx = num > 0 ? 0 : num < 0 ? 1 : 2;
    const sec = sections[idx];
    // a text-only format ("@") shows a number as General does
    if (sec.hasText && !sec.hasNumber && !sec.hasDate) return (num < 0 ? '-' : '') + general(Math.abs(num), L);
    if (sec.general || (!sec.hasNumber && !sec.hasDate && !sec.hasText)) { if (sec.general || sec.tokens.length === 0) return general(num, L); return sec.tokens.map((t) => (t.t === 'lit' ? t.v : '')).join(''); }
    if (sec.hasDate) return renderDate(sec.tokens, num, L, date1904);
    const ownSign = !(sections.length >= 2 && !conditional && idx === 1); // a negative section brings its own minus (or brackets)
    const text = renderNumber(sec.tokens.map((t) => (t.t === 'general' ? { t: 'lit', v: general(Math.abs(num), L) } : t)), num, L, ownSign);
    return text.trim();
  }
  return { show, bool: (b) => (b ? L.trueText : L.falseText), builtin: (id) => builtinCode(id, locale) };
}

const ERRORS = { 0x00: '#NULL!', 0x07: '#DIV/0!', 0x0f: '#VALUE!', 0x17: '#REF!', 0x1d: '#NAME?', 0x24: '#NUM!', 0x2a: '#N/A', 0x2b: '#GETTING_DATA' };
/** The text Excel shows for a binary error code (BIFF8 and XLSB share the codes). */
export function errorText(code) { return ERRORS[code] ?? '#VALUE!'; }

/** The text of a plain value as the cell shows it: strings as they are, booleans, numbers/dates through their format. */
export function showCell(fmt, value, code) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return fmt.bool(value);
  return fmt.show(value, typeof code === 'string' ? code : fmt.builtin(code ?? 0) ?? 'General');
}
