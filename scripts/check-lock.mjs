#!/usr/bin/env node
/**
 * Is package-lock.json in step with the package.json files? (audit I11)
 *
 *   node scripts/check-lock.mjs
 *
 * `npm ci` (CI, Docker) refuses a lock file that does not match, so a dependency added to a package.json without
 * `npm install` is found here, before the build. For every workspace (root, packages/*, examples/*) and every
 * dependency / devDependency / peerDependency / optionalDependency it checks that the lock holds a version, and that
 * the version satisfies the range (^, ~, exact, >=, x-ranges, `||`; `file:`/`workspace` links only need to exist).
 * Exit 1 lists the problems.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const parse = (v) => { const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v).replace(/^[v=]/, '')); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; };
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** One comparator set (space separated), e.g. "^1.2.3", "~1.2", ">=1 <3", "1.x". */
function satisfiesOne(version, range) {
  const v = parse(version);
  if (!v) return false;
  const r = range.trim();
  if (r === '' || r === '*' || r === 'latest') return true;
  return r.split(/\s+/).every((tok) => {
    let m = /^\^(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/.exec(tok);
    if (m) {
      const maj = Number(m[1]);
      const min = m[2] === undefined || /[x*]/.test(m[2]) ? null : Number(m[2]);
      const pat = m[3] === undefined || /[x*]/.test(m[3]) ? null : Number(m[3]);
      const low = [maj, min ?? 0, pat ?? 0];
      if (cmp(v, low) < 0) return false;
      if (maj > 0) return v[0] === maj;
      if (min === null) return v[0] === 0;
      if (min > 0) return v[0] === 0 && v[1] === min;
      return v[0] === 0 && v[1] === 0 && (pat === null || v[2] === pat);
    }
    m = /^~(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(tok);
    if (m) {
      const low = [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
      return cmp(v, low) >= 0 && v[0] === low[0] && (m[2] === undefined || v[1] === low[1]);
    }
    m = /^(>=|<=|>|<|=)?\s*(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(tok);
    if (m) {
      const op = m[1] ?? '=';
      const wild = (x) => x === undefined || /[x*]/.test(x);
      const t = [Number(m[2]), wild(m[3]) ? 0 : Number(m[3]), wild(m[4]) ? 0 : Number(m[4])];
      if (op === '=') {
        if (wild(m[3])) return v[0] === t[0];
        if (wild(m[4])) return v[0] === t[0] && v[1] === t[1];
        return cmp(v, t) === 0;
      }
      const c = cmp(v, t);
      return op === '>=' ? c >= 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c < 0;
    }
    return true; // a tag, git URL or anything this small checker does not understand is not a verdict
  });
}
export const satisfies = (version, range) => String(range).split('||').some((part) => satisfiesOne(version, part));

function workspaces() {
  const out = [{ dir: '', pkg: readJson(path.join(root, 'package.json')) }];
  for (const group of ['packages', 'examples', 'apps']) {
    const abs = path.join(root, group);
    if (!existsSync(abs)) continue;
    for (const d of readdirSync(abs, { withFileTypes: true })) {
      const f = path.join(abs, d.name, 'package.json');
      if (d.isDirectory() && existsSync(f)) out.push({ dir: `${group}/${d.name}`, pkg: readJson(f) });
    }
  }
  return out;
}

export function checkLock() {
  const lockPath = path.join(root, 'package-lock.json');
  if (!existsSync(lockPath)) return ['package-lock.json is missing (npm ci needs it)'];
  const lock = readJson(lockPath);
  const problems = [];
  for (const { dir, pkg } of workspaces()) {
    const entry = lock.packages?.[dir];
    if (!entry) { problems.push(`${dir || '(root)'}: no entry in the lock file - run npm install`); continue; }
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [name, range] of Object.entries(pkg[field] ?? {})) {
        const locked = lock.packages?.[`${dir ? `${dir}/` : ''}node_modules/${name}`] ?? lock.packages?.[`node_modules/${name}`];
        if (!locked) {
          if (field === 'optionalDependencies' || field === 'peerDependencies') continue;
          problems.push(`${dir || '(root)'}: ${name}@${range} is not in the lock file - run npm install`);
          continue;
        }
        if (/^(file:|workspace:|link:|git|https?:)/.test(range) || locked.link) continue;
        if (locked.version && !satisfies(locked.version, range)) problems.push(`${dir || '(root)'}: ${name} is locked at ${locked.version}, package.json wants ${range}`);
      }
    }
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = checkLock();
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  console.log('lock file is in step with the package.json files');
}
