import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import semver from 'semver';
import { flagString } from '../arg-parser.js';
import { EXIT } from '../exit-codes.js';
import { lockPackages, findVulnerabilities, findLockFile, fetchErrorText } from '../../health/checks/dependencies.js';
import { checkLatest } from '../../admin/sections-ops.js';

/** Licenses accepted without a second look (permissive); `--allow` adds more. */
export const DEFAULT_ALLOWED_LICENSES = Object.freeze([
  'MIT', 'MIT-0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'Apache-2.0', 'BlueOak-1.0.0', 'CC0-1.0', 'Unlicense', 'Python-2.0', 'CC-BY-3.0', 'CC-BY-4.0', 'Zlib', 'WTFPL',
]);
const COPYLEFT = /^(A?GPL|LGPL|MPL|EPL|EUPL|CDDL|OSL|SSPL|CPAL|CC-BY-(NC|SA)|Sleepycat)/i;

/**
 * Judges an SPDX expression: `ok` when it is satisfied by the allowed licenses (`A OR B`: one is enough, `A AND B`: all),
 * `review` when a copyleft or otherwise unlisted license decides it, `unknown` when nothing usable is stated.
 */
export function judgeLicense(expression, allowed) {
  if (typeof expression !== 'string' || !expression.trim() || /^(UNLICENSED|SEE LICENSE)/i.test(expression)) return 'unknown';
  const tokens = expression.replace(/[()]/g, ' $& ').split(/\s+/).filter(Boolean);
  let i = 0;
  const rank = { ok: 0, review: 1, unknown: 2 };
  const leaf = (id) => (allowed.has(id.replace(/\+$/, '')) ? 'ok' : id.toUpperCase() === 'NONE' ? 'unknown' : 'review');
  function and() {
    let r = or1();
    while (tokens[i]?.toUpperCase() === 'AND') { i++; const x = or1(); r = rank[x] > rank[r] ? x : r; }
    return r;
  }
  function or1() {
    if (tokens[i] === '(') { i++; const r = orExpr(); if (tokens[i] === ')') i++; return r; }
    return leaf(tokens[i++] ?? 'NONE');
  }
  function orExpr() {
    let r = and();
    while (tokens[i]?.toUpperCase() === 'OR') { i++; const x = and(); r = rank[x] < rank[r] ? x : r; }
    return r;
  }
  const result = orExpr();
  return result;
}

function readLock(lockFile) {
  const file = findLockFile(lockFile);
  if (!existsSync(file)) throw new Error(`lock file not found: ${lockFile}`);
  return { file, text: readFileSync(file, 'utf8') };
}

/** Every installed package of the lock with its license: `[{ name, version, license, dev }]`; workspace members and links are left out. */
export function lockLicenses(lockText, { omitDev = true, baseDir = null } = {}) {
  const lock = JSON.parse(lockText);
  const out = [];
  const seen = new Set();
  for (const [key, info] of Object.entries(lock.packages ?? {})) {
    const at = key.lastIndexOf('node_modules/');
    if (at === -1 || info?.link || !info?.version) continue;
    if (omitDev && info.dev) continue;
    const name = key.slice(at + 'node_modules/'.length);
    const id = `${name}@${info.version}`;
    if (seen.has(id)) continue;
    seen.add(id);
    let license = typeof info.license === 'string' ? info.license : info.license?.type ?? null;
    if (!license && baseDir) {
      try {
        const j = JSON.parse(readFileSync(join(baseDir, key, 'package.json'), 'utf8'));
        license = typeof j.license === 'string' ? j.license : j.license?.type ?? null;
      } catch { /* not installed */ }
    }
    out.push({ name, version: info.version, license, dev: Boolean(info.dev) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const say = (s = '') => console.log(s); // eslint-disable-line no-console
const warn = (s = '') => console.error(s); // eslint-disable-line no-console

/**
 * `app deps list | licenses | audit | outdated | check`: the dependencies of the application, read from its lock file and
 * `package.json`. Vulnerabilities come from the registry's advisory service (the same source as the diagnostics, no extra
 * tool needed), licenses from the lock file, newer versions from the registry. Production packages only unless `--dev`.
 *
 * @param {object} cli
 * @param {object} o
 * @param {string} o.lockFile - path of `package-lock.json` (looked up in parent directories too)
 * @param {string} o.packageJsonPath - the application's `package.json`
 * @param {string} [o.nodeModulesDir]
 * @param {Function} [o.fetchFn]
 * @param {string} [o.registry]
 * @param {Array<{id: string, until?: string, reason?: string}>} [o.ignore] - accepted advisories (`security.dependencyAudit.ignore`)
 */
export function registerDepsCommands(cli, { lockFile, packageJsonPath, nodeModulesDir = null, fetchFn = globalThis.fetch, registry, ignore = [] }) {
  const scope = (flags) => ({ omitDev: !flags.dev });

  function licenseReport(flags) {
    const { file, text } = readLock(lockFile);
    const extra = (flagString(flags, 'allow') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const allowed = new Set([...DEFAULT_ALLOWED_LICENSES, ...extra]);
    const rows = lockLicenses(text, { ...scope(flags), baseDir: nodeModulesDir ? dirname(nodeModulesDir) : dirname(file) })
      .map((r) => ({ ...r, verdict: judgeLicense(r.license, allowed) }));
    return { rows, bad: rows.filter((r) => r.verdict !== 'ok') };
  }

  async function auditReport(flags) {
    const { text } = readLock(lockFile);
    const findings = await findVulnerabilities(lockPackages(text, scope(flags)), { fetchFn, ...(registry ? { registry } : {}) });
    const accepted = new Set(ignore.filter((i) => i?.id && (!i.until || Date.parse(i.until) > Date.now())).map((i) => String(i.id).toLowerCase()));
    const open = findings.filter((f) => !accepted.has(f.id.toLowerCase()));
    return { open, ignored: findings.length - open.length };
  }

  function printLicenses({ rows, bad }, flags) {
    if (flags.json) { say(JSON.stringify({ packages: rows.length, problems: bad })); return; }
    const counts = new Map();
    for (const r of rows) counts.set(r.license ?? '(none)', (counts.get(r.license ?? '(none)') ?? 0) + 1);
    for (const [l, n] of [...counts].sort((a, b) => b[1] - a[1])) say(`  ${String(n).padStart(4)}  ${l}`);
    say(bad.length ? `\n${bad.length} package(s) need a look:` : '\nAll licenses are on the allowed list.');
    for (const r of bad) say(`  ${r.verdict === 'unknown' ? 'UNKNOWN' : 'REVIEW '}  ${r.name}@${r.version}  ${r.license ?? '(no license stated)'}${COPYLEFT.test(r.license ?? '') ? '  (copyleft)' : ''}`);
  }

  function printAudit({ open, ignored }, flags) {
    if (flags.json) { say(JSON.stringify({ open, ignored })); return; }
    if (!open.length) { say(`No known vulnerabilities${ignored ? ` (${ignored} accepted)` : ''}.`); return; }
    for (const f of open) say(`  ${f.severity.toUpperCase().padEnd(8)} ${f.name}@${f.version}  ${f.id}  ${f.title}`);
    say(`\n${open.length} open${ignored ? `, ${ignored} accepted` : ''}.`);
  }

  cli.command('deps list', {
    description: 'List the installed packages of the lock file (app deps list [--dev] [--json])',
    handler({ flags }) {
      const { file, text } = readLock(lockFile);
      const rows = lockLicenses(text, { ...scope(flags), baseDir: dirname(file) });
      if (flags.json) say(JSON.stringify(rows));
      else for (const r of rows) say(`  ${r.name}@${r.version}  ${r.license ?? '-'}${r.dev ? '  (dev)' : ''}`);
      return EXIT.OK;
    },
  });

  cli.command('deps licenses', {
    description: 'Check the licenses of the dependencies (app deps licenses [--allow MPL-2.0,...] [--dev] [--json]); exit 3 when one needs a look',
    booleanFlags: ['dev'],
    handler({ flags }) {
      const report = licenseReport(flags);
      printLicenses(report, flags);
      return report.bad.length ? EXIT.CHECK_FAILED : EXIT.OK;
    },
  });

  cli.command('deps audit', {
    description: 'Look for known vulnerabilities in the dependencies (app deps audit [--dev] [--json]); exit 3 when some are open',
    booleanFlags: ['dev'],
    async handler({ flags }) {
      try {
        const report = await auditReport(flags);
        printAudit(report, flags);
        return report.open.length ? EXIT.CHECK_FAILED : EXIT.OK;
      } catch (err) {
        warn(`Could not ask the registry: ${fetchErrorText(err)}`);
        return EXIT.FAILURE;
      }
    },
  });

  cli.command('deps outdated', {
    description: 'Show direct dependencies that have a newer version (app deps outdated [--dev] [--fail] [--json])',
    booleanFlags: ['dev', 'fail'],
    async handler({ flags }) {
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      const bases = [].concat(nodeModulesDir ?? join(dirname(packageJsonPath), 'node_modules'));
      const wanted = { ...(pkg.dependencies ?? {}), ...(flags.dev ? pkg.devDependencies ?? {} : {}) };
      const installed = (name) => {
        const f = bases.map((b) => join(b, name, 'package.json')).find((x) => existsSync(x));
        try { return f ? JSON.parse(readFileSync(f, 'utf8')).version : null; } catch { return null; }
      };
      const errors = {};
      const latest = await checkLatest(Object.keys(wanted), { fetchFn, errors });
      const rows = Object.entries(wanted).map(([name, range]) => {
        const have = installed(name);
        const last = latest[name] ?? null;
        const newer = have && last && semver.valid(have) && semver.gt(last, have);
        return { name, range, installed: have, latest: last, outdated: Boolean(newer), major: Boolean(newer && semver.major(last) > semver.major(have)), error: errors[name] ?? null };
      });
      const out = rows.filter((r) => r.outdated);
      if (flags.json) say(JSON.stringify(rows));
      else {
        for (const r of out) say(`  ${r.name}  ${r.installed} -> ${r.latest}${r.major ? '  (major)' : ''}`);
        const failed = rows.filter((r) => r.error);
        if (failed.length) warn(`\n${failed.length} package(s) could not be checked: ${fetchErrorText({ message: failed[0].error })}`);
        say(out.length ? `\n${out.length} of ${rows.length} outdated.` : `\nEverything is current (${rows.length} checked).`);
      }
      return flags.fail && out.length ? EXIT.CHECK_FAILED : EXIT.OK;
    },
  });

  cli.command('deps check', {
    description: 'Licenses and vulnerabilities in one go, for CI (app deps check [--allow ...] [--dev] [--json]); exit 3 on any problem',
    booleanFlags: ['dev'],
    async handler({ flags }) {
      const licenses = licenseReport(flags);
      let audit;
      try { audit = await auditReport(flags); } catch (err) {
        warn(`Could not ask the registry: ${fetchErrorText(err)}`);
        return EXIT.FAILURE;
      }
      if (flags.json) say(JSON.stringify({ licenses: licenses.bad, vulnerabilities: audit.open, ignored: audit.ignored }));
      else { say('Licenses:'); printLicenses(licenses, flags); say('\nVulnerabilities:'); printAudit(audit, flags); }
      return licenses.bad.length || audit.open.length ? EXIT.CHECK_FAILED : EXIT.OK;
    },
  });
}
