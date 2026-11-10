/**
 * Dependencies category: known vulnerabilities in the installed packages and security releases of Node itself.
 *
 * The package list comes from `package-lock.json` (what is really installed, not what package.json asks for);
 * the advisories from the npm registry's bulk endpoint (`POST /-/npm/v1/security/advisories/bulk`, the source
 * `npm audit` uses). No process is started and `npm` need not be installed. Version-against-range matching
 * is left to `semver`: hand-written range matching breaks on prereleases and unusual ranges.
 *
 * Without a network the check does not fail: it shows the last successful result with its date (kept in
 * `app_settings`) as a warning, or "not checked" when there is none. The reason is passed to `logger.warn`.
 *
 * Status: critical/high -> fail; moderate -> warn; low -> listed, status ok. Advisories the operator has accepted
 * (`ignore: [{ id, reason, until? }]`, id = GHSA id) are left out until `until` passes.
 */
import { assertOutboundUrl } from '../http/outbound.js';
import { existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { readFileSync } from 'node:fs';
import semver from 'semver';
import { ensureSettingsTable } from '../../branding/company-branding.js';

const CACHE_KEY = 'dependency_audit';
const SEVERITY_RANK = { critical: 4, high: 3, moderate: 2, low: 1 };
const NAME = 'Dependency vulnerabilities';

/** `{ name, version }` for every installed package of a lockfile v2/v3 (workspace members and links excluded). */
export function lockPackages(lockText, { omitDev = true } = {}) {
  const lock = JSON.parse(lockText);
  if (!lock || typeof lock.packages !== 'object') throw new Error('unsupported lockfile (lockfileVersion 2 or 3 needed)');
  const seen = new Set();
  const out = [];
  for (const [key, info] of Object.entries(lock.packages)) {
    const at = key.lastIndexOf('node_modules/');
    if (at === -1 || info?.link || !info?.version) continue;
    if (omitDev && info.dev) continue;
    const name = key.slice(at + 'node_modules/'.length);
    const id = `${name}@${info.version}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ name, version: info.version });
  }
  return out;
}

const ghsaOf = (adv) => /GHSA-[\w-]+/i.exec(String(adv?.url ?? ''))?.[0]?.toLowerCase() ?? (adv?.id != null ? String(adv.id) : 'unknown');

function readCache(db) {
  if (!db) return null;
  try {
    ensureSettingsTable(db);
    const row = db.get('SELECT value FROM app_settings WHERE key = ?', [CACHE_KEY]);
    const v = row ? JSON.parse(row.value) : null;
    return v && typeof v.at === 'string' && Array.isArray(v.findings) ? v : null;
  } catch { return null; }
}

function writeCache(db, value) {
  if (!db) return;
  try {
    ensureSettingsTable(db);
    db.run('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [CACHE_KEY, JSON.stringify(value)]);
  } catch { /* the cache is a convenience */ }
}

/** Advisories that apply to the given packages: `[{ id, name, version, severity, title, url }]`. */
export async function findVulnerabilities(packages, { fetchFn = globalThis.fetch, registry = 'https://registry.npmjs.org', timeoutMs = 20_000 } = {}) {
  const body = {};
  for (const p of packages) (body[p.name] ??= []).push(p.version);
  assertOutboundUrl(registry, { label: 'registry', protocols: ['https:', 'http:'] });
  const res = await fetchFn(`${registry.replace(/\/+$/, '')}/-/npm/v1/security/advisories/bulk`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`registry answered ${res.status}`);
  const data = await res.json();
  const findings = [];
  for (const [name, advisories] of Object.entries(data ?? {})) {
    for (const adv of Array.isArray(advisories) ? advisories : []) {
      for (const version of body[name] ?? []) {
        let hit = false;
        try { hit = semver.satisfies(version, String(adv.vulnerable_versions ?? ''), { includePrerelease: true }); } catch { hit = false; }
        if (hit) findings.push({ id: ghsaOf(adv), name, version, severity: SEVERITY_RANK[adv.severity] ? adv.severity : 'moderate', title: String(adv.title ?? ''), url: String(adv.url ?? '') });
      }
    }
  }
  return findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.name.localeCompare(b.name));
}

function summarise(findings, ignore, now) {
  const accepted = new Map((ignore ?? []).filter((i) => i?.id && (!i.until || Date.parse(i.until) > now)).map((i) => [String(i.id).toLowerCase(), i]));
  const open = findings.filter((f) => !accepted.has(f.id.toLowerCase()));
  const count = (s) => open.filter((f) => f.severity === s).length;
  return { open, ignored: findings.length - open.length, critical: count('critical'), high: count('high'), moderate: count('moderate'), low: count('low') };
}

function resultChecks(sum, { checked, at, stale = null }) {
  const parts = ['critical', 'high', 'moderate', 'low'].filter((s) => sum[s]).map((s) => `${sum[s]} ${s}`);
  const base = parts.length ? parts.join(', ') : 'no known vulnerabilities';
  const worst = sum.critical || sum.high ? 'fail' : sum.moderate ? 'warn' : 'ok';
  const age = stale ? ` (data from ${at}; ${stale})` : '';
  const status = stale && worst === 'ok' ? 'warn' : worst;
  const ignored = sum.ignored ? `, ${sum.ignored} accepted` : '';
  const out = [{ name: NAME, status, message: `${checked} packages checked: ${base}${ignored}${age}` }];
  for (const f of sum.open.filter((x) => SEVERITY_RANK[x.severity] >= SEVERITY_RANK.moderate).slice(0, 10)) {
    out.push({ name: `${f.name}@${f.version}`, status: SEVERITY_RANK[f.severity] >= SEVERITY_RANK.high ? 'fail' : 'warn', message: `${f.severity}: ${f.title} (${f.id})${f.url ? ` ${f.url}` : ''}` });
  }
  return out;
}

/**
 * @param {object} o
 * @param {string} o.lockFile - path to package-lock.json
 * @param {object} [o.db] - keeps the last successful result
 * @param {Function} [o.fetchFn]
 * @param {{id: string, reason?: string, until?: string}[]} [o.ignore]
 * @param {boolean} [o.omitDev=true]
 * @param {{warn?: Function}} [o.logger]
 * @param {() => number} [o.now]
 */
/**
 * Why a request failed, in words that help: Node's `fetch` reports only "fetch failed" and keeps the real cause
 * (ENOTFOUND, ECONNREFUSED, a certificate error...) in `err.cause`. Behind a proxy or TLS inspection a hint is added,
 * because `fetch` does not read the proxy settings `npm` uses.
 */
export function fetchErrorText(err) {
  const cause = err?.cause;
  const code = cause?.code ?? err?.code;
  const base = String(cause?.message ?? err?.message ?? err);
  const text = code && !base.includes(code) ? `${code}: ${base}` : base;
  const tls = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ISSUER/i.test(String(code));
  const timeout = err?.name === 'TimeoutError' || /timeout|ETIMEDOUT|ECONNRESET/i.test(`${code} ${base}`);
  if (tls) return `${text} (a proxy that inspects TLS? set NODE_EXTRA_CA_CERTS to its certificate)`;
  if (timeout || /ENOTFOUND|ECONNREFUSED|EAI_AGAIN|fetch failed/i.test(`${code} ${base}`)) return `${text} (behind a proxy? start the application with NODE_USE_ENV_PROXY=1 and HTTPS_PROXY set)`;
  return text;
}

/** The lockfile at `file`, or the same name in the nearest parent directory (a workspace app keeps it in the repository root). */
export function findLockFile(file) {
  let dir = dirname(file);
  for (let i = 0; i < 6; i++) {
    const cand = join(dir, basename(file));
    if (existsSync(cand)) return cand;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return file;
}

export async function dependencyChecks({ lockFile, db = null, fetchFn = globalThis.fetch, registry, timeoutMs, ignore = [], omitDev = true, logger = null, now = () => Date.now() } = {}) {
  let packages;
  try {
    packages = lockPackages(readFileSync(findLockFile(lockFile), 'utf8'), { omitDev });
  } catch (err) {
    const reason = err?.code === 'ENOENT' ? `${lockFile} not found` : `cannot read ${lockFile}: ${err?.message ?? err}`;
    logger?.warn?.(`dependency check skipped: ${reason}`);
    return [{ name: NAME, status: 'warn', message: `not checked: ${reason}` }];
  }
  try {
    const findings = await findVulnerabilities(packages, { fetchFn, registry, timeoutMs });
    const at = new Date(now()).toISOString();
    writeCache(db, { at, checked: packages.length, findings });
    return resultChecks(summarise(findings, ignore, now()), { checked: packages.length, at });
  } catch (err) {
    const reason = fetchErrorText(err);
    logger?.warn?.(`dependency check could not reach the advisory source: ${reason}`);
    const cached = readCache(db);
    if (!cached) return [{ name: NAME, status: 'warn', message: `not checked: the advisory source is unreachable (${reason}) and there is no earlier result` }];
    return resultChecks(summarise(cached.findings, ignore, now()), { checked: cached.checked ?? packages.length, at: cached.at, stale: `could not refresh: ${reason}` });
  }
}

/**
 * Is there a newer release of this Node line that carries security fixes? Compares `process.version` with
 * nodejs.org's release index. Offline: a warning that says so, never a failure.
 */
export async function nodeVersionChecks({ version = process.version, fetchFn = globalThis.fetch, url = 'https://nodejs.org/dist/index.json', timeoutMs = 10_000, logger = null } = {}) {
  const name = 'Node.js security releases';
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`nodejs.org answered ${res.status}`);
    const index = await res.json();
    const major = semver.major(version);
    const newer = (Array.isArray(index) ? index : [])
      .filter((r) => r?.security === true && semver.valid(r.version) && semver.major(r.version) === major && semver.gt(r.version, version))
      .map((r) => r.version)
      .sort(semver.compare);
    if (newer.length) return [{ name, status: 'warn', message: `${version} is behind ${newer.at(-1)}, a release of the same line with security fixes: update Node.js` }];
    return [{ name, status: 'ok', message: `${version}: no newer security release in line ${major}.x` }];
  } catch (err) {
    const reason = fetchErrorText(err);
    logger?.warn?.(`Node.js version check failed: ${reason}`);
    return [{ name, status: 'warn', message: `not checked: ${reason}` }];
  }
}
