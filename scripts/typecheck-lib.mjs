// Разбор вывода tsc для проверки типов: подсчёт замечаний по модулям и сравнение с базой («храповик», E3).
/** Module of a file path: `packages/core/src/<dir>` (or the package/example root for other places). Backslashes are normalised. */
export function moduleOf(file) {
  const p = file.replace(/\\/g, '/').replace(/^\.\//, '');
  const m = /^(packages\/[^/]+\/src\/[^/]+)\//.exec(p) ?? /^(packages\/[^/]+\/src)\/[^/]+$/.exec(p) ?? /^(examples\/[^/]+)\//.exec(p);
  return m ? m[1] : p.split('/').slice(0, 2).join('/');
}

/** @returns {{byModule: Record<string, number>, total: number}} remarks (every `error TSnnnn`) per module */
export function countByModule(output) {
  const byModule = {};
  let total = 0;
  for (const line of output.split('\n')) {
    const m = /^(.+?)\(\d+,\d+\): error TS\d+:/.exec(line);
    if (!m) continue;
    const mod = moduleOf(m[1]);
    byModule[mod] = (byModule[mod] ?? 0) + 1;
    total += 1;
  }
  return { byModule: Object.fromEntries(Object.entries(byModule).sort(([a], [b]) => a.localeCompare(b))), total };
}

/** @returns {{worse: [string, number, number][], better: [string, number, number][]}} modules whose count rose / fell against the baseline */
export function compareToBaseline(now, base) {
  const worse = []; const better = [];
  for (const [m, n] of Object.entries(now)) if (n > (base[m] ?? 0)) worse.push([m, base[m] ?? 0, n]);
  for (const [m, n] of Object.entries(base)) if ((now[m] ?? 0) < n) better.push([m, n, now[m] ?? 0]);
  return { worse, better };
}
