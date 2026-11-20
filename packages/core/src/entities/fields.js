/**
 * Field types of an entity descriptor (ADR-0012). A type is plain data plus pure functions: no database, no Express, no Zod.
 *
 * A type definition:
 *   column   'TEXT' | 'INTEGER'                  storage type in the common (SQLite-flavoured) DDL; `translate()` maps it for PostgreSQL
 *   validate (value, opts) -> {ok:true, value} | {ok:false, code, params?}   value is already known to be neither undefined nor null
 *   toStorage / fromStorage                      optional conversions between the API value and the stored value
 *   format   (value, opts) -> string             text for lists and exports (optional; default String)
 *   listable / sortable / filterable / searchable   defaults for the flags of a field of this type
 *   secret   true: never listed, exported, searched or put into history in clear; the application encrypts it on write
 *
 * Money and decimals are integers (minor units / scaled), time is UTC, nothing is a float.
 */
import net from 'node:net';

const ok = (value) => ({ ok: true, value });
const bad = (code, params) => ({ ok: false, code, ...(params ? { params } : {}) });
const isInt = (v) => typeof v === 'number' && Number.isSafeInteger(v);

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAC_RE = /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i;

function validDate(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function textLike(defaultMax) {
  return (v, o) => {
    if (typeof v !== 'string') return bad('type', { expected: 'string' });
    const s = o.trim === false ? v : v.trim();
    const max = o.max ?? defaultMax;
    if (s.length > max) return bad('too_long', { max });
    if (o.min !== undefined && s.length < o.min) return bad('too_short', { min: o.min });
    if (o.pattern && !o.pattern.test(s)) return bad('pattern');
    return ok(s);
  };
}

/** The built-in types. */
export const BUILT_IN_TYPES = {
  text: { column: 'TEXT', validate: textLike(255), listable: true, sortable: true, filterable: true, searchable: true },
  longText: { column: 'TEXT', validate: textLike(20_000), listable: false, sortable: false, filterable: false, searchable: true },
  int: {
    column: 'INTEGER',
    validate: (v, o) => {
      if (!isInt(v)) return bad('type', { expected: 'integer' });
      if (o.min !== undefined && v < o.min) return bad('too_small', { min: o.min });
      if (o.max !== undefined && v > o.max) return bad('too_big', { max: o.max });
      return ok(v);
    },
    listable: true, sortable: true, filterable: true, searchable: false,
  },
  // A decimal is stored as an integer count of 10^-scale units; the API value is a string "12.50" (or an integer).
  decimal: {
    column: 'INTEGER',
    validate: (v, o) => {
      const scale = o.scale ?? 2;
      const m = typeof v === 'string' ? /^(-?)(\d+)(?:\.(\d+))?$/.exec(v.trim()) : typeof v === 'number' && Number.isSafeInteger(v) ? /^(-?)(\d+)()$/.exec(String(v)) : null;
      if (!m) return bad('type', { expected: 'decimal' });
      if ((m[3] ?? '').length > scale) return bad('too_many_decimals', { scale });
      const units = Number(`${m[1]}${m[2]}${(m[3] ?? '').padEnd(scale, '0')}`);
      if (!Number.isSafeInteger(units)) return bad('too_big');
      if (o.min !== undefined && units < Math.round(o.min * 10 ** scale)) return bad('too_small', { min: o.min });
      if (o.max !== undefined && units > Math.round(o.max * 10 ** scale)) return bad('too_big', { max: o.max });
      return ok(units);
    },
    fromStorage: (n, o) => { const scale = o.scale ?? 2; const s = String(Math.abs(n)).padStart(scale + 1, '0'); return `${n < 0 ? '-' : ''}${s.slice(0, s.length - scale)}${scale ? `.${s.slice(-scale)}` : ''}`; },
    format: (n, o) => BUILT_IN_TYPES.decimal.fromStorage(n, o),
    listable: true, sortable: true, filterable: true, searchable: false,
  },
  // Money: an integer count of minor units (kopecks, cents). Never a float.
  money: {
    column: 'INTEGER',
    validate: (v, o) => {
      if (!isInt(v)) return bad('type', { expected: 'integer minor units' });
      if (o.min !== undefined && v < o.min) return bad('too_small', { min: o.min });
      if (o.max !== undefined && v > o.max) return bad('too_big', { max: o.max });
      return ok(v);
    },
    format: (v, o) => `${(v / 100).toFixed(2)} ${o.currency ?? ''}`.trim(),
    listable: true, sortable: true, filterable: true, searchable: false,
  },
  bool: {
    column: 'INTEGER',
    validate: (v) => (typeof v === 'boolean' ? ok(v) : bad('type', { expected: 'boolean' })),
    toStorage: (v) => (v ? 1 : 0),
    fromStorage: (n) => Number(n) === 1,
    format: (v) => (v ? 'yes' : 'no'),
    listable: true, sortable: true, filterable: true, searchable: false,
  },
  date: {
    column: 'TEXT',
    validate: (v) => {
      const m = typeof v === 'string' ? DATE_RE.exec(v) : null;
      return m && validDate(Number(m[1]), Number(m[2]), Number(m[3])) ? ok(v) : bad('type', { expected: 'date YYYY-MM-DD' });
    },
    listable: true, sortable: true, filterable: true, searchable: false,
  },
  // A moment, stored as ISO-8601 UTC with milliseconds ("2026-11-20T08:00:00.000Z"). Input: an ISO string with an offset or Z.
  datetime: {
    column: 'TEXT',
    validate: (v) => {
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(v)) return bad('type', { expected: 'ISO-8601 date-time with Z or an offset' });
      const t = Date.parse(v);
      return Number.isNaN(t) ? bad('type', { expected: 'valid date-time' }) : ok(new Date(t).toISOString());
    },
    listable: true, sortable: true, filterable: true, searchable: false,
  },
  enum: {
    column: 'TEXT',
    validate: (v, o) => (typeof v === 'string' && o.values.includes(v) ? ok(v) : bad('not_in_list', { values: o.values })),
    listable: true, sortable: true, filterable: true, searchable: false,
  },
  // A reference to a record of another entity. `idType` 'int' (default) or 'text' (UUIDs).
  ref: {
    column: (o) => (o.idType === 'text' ? 'TEXT' : 'INTEGER'),
    validate: (v, o) => {
      if (o.idType === 'text') return typeof v === 'string' && v.length > 0 && v.length <= 64 ? ok(v) : bad('type', { expected: 'text id' });
      return isInt(v) && v > 0 ? ok(v) : bad('type', { expected: 'positive integer id' });
    },
    listable: true, sortable: false, filterable: true, searchable: false,
  },
  // Free-form structure, stored as JSON text. Not searched, sorted or filtered.
  json: {
    column: 'TEXT',
    validate: (v, o) => {
      let s;
      try { s = JSON.stringify(v); } catch { return bad('type', { expected: 'JSON value' }); }
      if (s === undefined) return bad('type', { expected: 'JSON value' });
      if (s.length > (o.maxBytes ?? 65_536)) return bad('too_long', { max: o.maxBytes ?? 65_536 });
      return ok(v);
    },
    toStorage: (v) => JSON.stringify(v),
    fromStorage: (s) => JSON.parse(s),
    format: (v) => JSON.stringify(v),
    listable: false, sortable: false, filterable: false, searchable: false,
  },
  // An uploaded file, by the id the file store gave it (files/upload-storage.js). The bytes live in the file store.
  file: {
    column: 'TEXT',
    validate: (v) => (typeof v === 'string' && v.length > 0 && v.length <= 64 ? ok(v) : bad('type', { expected: 'file id' })),
    listable: true, sortable: false, filterable: false, searchable: false,
  },
  // A password, key or token kept for the user. The application encrypts the value on write (AES-GCM with a core key);
  // the descriptor only guarantees it is never listed, exported, searched, sorted or written to history in clear.
  secret: {
    column: 'TEXT',
    validate: (v, o) => (typeof v === 'string' && v.length > 0 && v.length <= (o.max ?? 1024) ? ok(v) : bad('type', { expected: 'non-empty string' })),
    secret: true,
    listable: false, sortable: false, filterable: false, searchable: false,
  },
  ip: {
    column: 'TEXT',
    validate: (v, o) => {
      const s = typeof v === 'string' ? v.trim() : '';
      const family = net.isIP(s);
      if (!family) return bad('type', { expected: 'IP address' });
      if (o.version && o.version !== family) return bad('type', { expected: `IPv${o.version}` });
      return ok(s.toLowerCase());
    },
    listable: true, sortable: true, filterable: true, searchable: true,
  },
  mac: {
    column: 'TEXT',
    validate: (v) => (typeof v === 'string' && MAC_RE.test(v.trim()) ? ok(v.trim().toLowerCase().replace(/-/g, ':')) : bad('type', { expected: 'MAC address' })),
    listable: true, sortable: true, filterable: true, searchable: true,
  },
};

/** Storage type of a field (the type's `column` may depend on the options). */
export const columnOf = (def, opts) => (typeof def.column === 'function' ? def.column(opts) : def.column);

/** Checks a type definition handed to `registerFieldType`. */
export function assertFieldTypeDefinition(name, def) {
  if (!/^[a-z][a-zA-Z0-9]*$/.test(name)) throw new TypeError(`field type name must be camelCase letters: ${JSON.stringify(name)}`);
  if (!def || typeof def !== 'object') throw new TypeError(`field type ${name}: a definition object is required`);
  const col = typeof def.column === 'function' ? def.column({}) : def.column;
  if (!['TEXT', 'INTEGER'].includes(col)) throw new TypeError(`field type ${name}: column must be 'TEXT' or 'INTEGER'`);
  if (typeof def.validate !== 'function') throw new TypeError(`field type ${name}: validate(value, opts) is required`);
  for (const k of ['listable', 'sortable', 'filterable', 'searchable']) {
    if (typeof def[k] !== 'boolean') throw new TypeError(`field type ${name}: ${k} must be set to true or false`);
  }
}
