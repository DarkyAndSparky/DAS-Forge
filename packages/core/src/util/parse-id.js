/**
 * A record number from a URL or a form: a positive whole number, or null.
 * `Number()` alone lets through "", " ", "1.5", "1e3", "0x10" and "Infinity"; here only plain digits count.
 * @param {unknown} value
 * @returns {number|null}
 */
export function parseId(value) {
  const s = typeof value === 'number' ? String(value) : value;
  if (typeof s !== 'string' || !/^[0-9]{1,15}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 ? n : null;
}
