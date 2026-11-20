#!/usr/bin/env node
/**
 * Counter of synchronous database calls (ADR-0010: the synchronous layer goes away at the end of the staged migration).
 *
 *   node scripts/sync-db-report.mjs            count per module and file
 *   node scripts/sync-db-report.mjs --check    fail when a file has MORE calls than scripts/sync-db-baseline.json
 *                                              (a new file with calls counts as more); lower is fine and is reported
 *   node scripts/sync-db-report.mjs --update   write the current numbers as the baseline (run after removing calls)
 *
 * A call is `db.get|all|run|exec|transaction(` on a receiver named `db`, `tx` or `database` (also `this.db.`) in
 * each package's src folder. The async facade is named `adb` in the code, and `.get(` on other receivers (Express `app.get`) is not counted.
 * Comments are skipped. This is a count, not a parser: it is the ratchet that matters, not the exact number.
 */
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = path.join(root, 'scripts', 'sync-db-baseline.json');
const CALL = /\b(?:db|tx|database)\.(?:get|all|run|exec|transaction)\(/g;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (name.endsWith('.js')) yield full;
  }
}

/** Source without `//` and block comments (strings are left: a call inside a string is rare and harmless to the ratchet). */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

export function countSyncCalls() {
  const out = {};
  const pkgs = path.join(root, 'packages');
  for (const p of readdirSync(pkgs)) {
    const src = path.join(pkgs, p, 'src');
    if (!existsSync(src)) continue;
    for (const f of walk(src)) {
      const n = (stripComments(readFileSync(f, 'utf8')).match(CALL) ?? []).length;
      if (n > 0) out[path.relative(root, f).split(path.sep).join('/')] = n;
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

const moduleOf = (file) => file.split('/').slice(0, 4).join('/');

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const now = countSyncCalls();
  const total = Object.values(now).reduce((a, b) => a + b, 0);
  if (process.argv.includes('--update')) {
    writeFileSync(BASELINE, `${JSON.stringify(now, null, 2)}\n`);
    console.log(`baseline written: ${total} call(s) in ${Object.keys(now).length} file(s)`);
  } else if (process.argv.includes('--check')) {
    const base = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {};
    const worse = Object.entries(now).filter(([f, n]) => n > (base[f] ?? 0));
    const better = Object.entries(base).filter(([f, n]) => (now[f] ?? 0) < n);
    for (const [f, n] of better) console.log(`  fewer: ${f} ${n} -> ${now[f] ?? 0}`);
    if (worse.length) {
      for (const [f, n] of worse) console.error(`  MORE: ${f} ${base[f] ?? 0} -> ${n}`);
      console.error('New code uses the async facade: `asyncDb(db).get(...)` (ADR-0010). If the change really removes none, justify it; if calls were removed elsewhere run --update.');
      process.exit(1);
    }
    console.log(`ok: ${total} synchronous call(s), none above the baseline${better.length ? ` (${better.length} file(s) improved: run --update)` : ''}`);
  } else {
    const byModule = {};
    for (const [f, n] of Object.entries(now)) byModule[moduleOf(f)] = (byModule[moduleOf(f)] ?? 0) + n;
    for (const [m, n] of Object.entries(byModule).sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(4)}  ${m}`);
    console.log(`\n${total} synchronous call(s) in ${Object.keys(now).length} file(s)`);
  }
}
