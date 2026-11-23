/** Cuts the slashes at the end of a string. A loop, not `replace(/\/+$/, '')`: that pattern is quadratic on a long run of slashes. */
export function trimTrailingSlashes(value) {
  const s = String(value);
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--;
  return end === s.length ? s : s.slice(0, end);
}
