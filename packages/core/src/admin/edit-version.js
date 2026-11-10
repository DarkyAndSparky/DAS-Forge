/**
 * Protection against a lost update (two administrators edit the same settings page, the second save would silently undo
 * the first). A form carries a fingerprint of the values it was filled from (`_v`); when it is saved, the fingerprint of the
 * CURRENT values must be the same, otherwise the save is refused. A form without `_v` (an old page, a script) is not checked.
 */
import { createHash } from 'node:crypto';

/** Short fingerprint of any JSON-able value. Key order does not matter for plain objects. */
export function fingerprint(value) {
  const norm = (v) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])]))
    : v === undefined ? null : v);
  return createHash('sha256').update(JSON.stringify(norm(value))).digest('hex').slice(0, 16);
}

/** The hidden field to put into a form. */
export const versionField = (value) => `<input type="hidden" name="_v" value="${fingerprint(value)}">`;

/** True when the form was opened on values that have changed since. */
export const isStale = (form, value) => Boolean(form?._v) && String(form._v) !== fingerprint(value);
