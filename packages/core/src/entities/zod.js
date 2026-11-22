/**
 * The second validation of an entity's input: a Zod schema built from the same descriptor (ADR-0012).
 *
 * VALIDATION IS IN TWO PLACES ON PURPOSE (defence in depth, owner's decision 2026-11-21):
 *   1. the gate (this file): a strict Zod schema, run FIRST and on the raw input, before any hook, lock or database work. It rejects
 *      unknown fields, wrong types, oversized strings and numbers cheaply, so flooding or crafted bodies cost almost nothing;
 *   2. the descriptor (`entity.validate`): the full rules, defaults and conversions, run after the gate.
 * A body must pass both. The gate is built from the descriptor, so it follows every change of it; it is never STRICTER than
 * `entity.validate` about a value that is valid (a test checks that), only equal or looser on the finer rules.
 * Do not remove either layer: the two are meant to catch each other's mistakes.
 */

const MAX_KEY_LENGTH = 64;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const MAC_RE = /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i;
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

function fieldZod(z, f) {
  let s;
  switch (f.type) {
    case 'text': case 'longText': {
      const max = f.max ?? (f.type === 'text' ? 255 : 20_000);
      // the descriptor trims before it measures; the gate measures the trimmed text the same way and caps the raw text
      s = z.string().max(max + 1024).refine((v) => (f.trim === false ? v : v.trim()).length <= max, { message: 'too_long' });
      if (f.min !== undefined) s = s.refine((v) => (f.trim === false ? v : v.trim()).length >= f.min, { message: 'too_short' });
      break;
    }
    case 'int': case 'money': s = z.number().int().safe(); break;
    case 'decimal': s = z.union([z.string().max(64).regex(DECIMAL_RE), z.number().int().safe()]); break;
    case 'bool': s = z.boolean(); break;
    case 'date': s = z.string().max(10).regex(DATE_RE); break;
    case 'datetime': s = z.string().max(40).regex(DATETIME_RE); break;
    case 'enum': s = z.enum([...f.values]); break;
    case 'ref': s = f.idType === 'text' ? z.string().min(1).max(64) : z.number().int().safe().min(1); break;
    case 'file': s = z.string().min(1).max(64); break;
    case 'secret': s = z.string().min(1).max(f.max ?? 1024); break;
    case 'ip': s = z.string().max(64); break;
    case 'mac': s = z.string().max(17).regex(MAC_RE); break;
    case 'json': s = z.unknown(); break; // the size and shape are the descriptor's (it measures the JSON text)
    default: s = z.unknown(); // a custom type: only the descriptor knows its rules
  }
  return f.nullable ? s.nullable() : s;
}

/**
 * @param {object} z the `zod` module's `z` (v4)
 * @param {object} entity from defineEntity
 * @param {'create'|'update'} shape
 */
export function zodSchemaOf(z, entity, shape) {
  const writable = (f) => f.readOnly !== true;
  const shapeOf = (list) => Object.fromEntries(list.filter(writable).map((f) => {
    const s = fieldZod(z, f);
    // on create a field may be left out when it is not required or has a default; on update every field is optional
    return [f.name, shape === 'update' || !f.required || f.default !== undefined ? s.optional() : s];
  }));
  const baseList = Object.values(entity.fields);
  const base = shapeOf(baseList);
  if (!entity.variants) return z.strictObject(base);

  const { by, cases } = entity.variants;
  // own-property lookups only: a key such as `constructor` or `toString` must never resolve to something inherited
  const caseShapes = Object.assign(Object.create(null), Object.fromEntries(Object.entries(cases).map(([k, c]) => [k, Object.assign(Object.create(null), shapeOf(Object.values(c.fields)))])));
  const baseKeys = new Set(Object.keys(base));
  return z.looseObject(base).superRefine((value, ctx) => {
    if (Object.hasOwn(value, '__proto__')) ctx.addIssue({ code: 'unrecognized_keys', keys: ['__proto__'], message: 'unknown_field' });
    const extra = Object.keys(value).filter((k) => !baseKeys.has(k));
    if (extra.length === 0) return;
    const key = value[by];
    const own = typeof key === 'string' && Object.hasOwn(caseShapes, key) ? caseShapes[key] : undefined;
    for (const k of extra) {
      if (k.length > MAX_KEY_LENGTH) { ctx.addIssue({ code: 'unrecognized_keys', keys: [k.slice(0, 16)], message: 'unknown_field' }); continue; }
      // with the kind given: the field must belong to it; without it (an update) any kind's field is allowed here,
      // the descriptor decides with the stored record in hand
      const def = own ? (Object.hasOwn(own, k) ? own[k] : undefined) : Object.values(caseShapes).map((s) => (Object.hasOwn(s, k) ? s[k] : undefined)).find(Boolean);
      if (!def) { ctx.addIssue({ code: 'unrecognized_keys', keys: [k], message: own ? 'not_for_this_case' : 'unknown_field' }); continue; }
      const r = def.safeParse(value[k]);
      if (!r.success) for (const i of r.error.issues) ctx.addIssue({ ...i, path: [k, ...i.path] });
    }
  });
}

const CODE = { invalid_type: 'type', too_big: 'too_big', too_small: 'too_small', invalid_value: 'not_in_list', invalid_format: 'pattern', unrecognized_keys: 'unknown_field', invalid_union: 'type', custom: 'type' };

/** Zod issues -> the `{ path, code, params? }` list of the descriptor (code `too_long` / `too_short` come from the refinements). */
export function zodIssuesToErrors(issues) {
  const out = [];
  for (const i of issues) {
    if (i.code === 'unrecognized_keys') { for (const k of i.keys) out.push({ path: String(k), code: i.message === 'not_for_this_case' ? 'not_for_this_case' : 'unknown_field' }); continue; }
    if (i.code === 'invalid_type' && /received undefined/.test(i.message ?? '')) { out.push({ path: i.path.join('.'), code: 'required' }); continue; }
    const code = i.message === 'too_long' || i.message === 'too_short' ? i.message : (CODE[i.code] ?? 'type');
    out.push({ path: i.path.join('.'), code });
  }
  return out;
}
