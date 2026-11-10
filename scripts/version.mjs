#!/usr/bin/env node
/**
 * One place for the core version.
 *
 *   node scripts/version.mjs get            prints the version
 *   node scripts/version.mjs set 0.1.111    writes it to packages/core/package.json and package-lock.json,
 *                                            then stamps the documentation
 *   node scripts/version.mjs stamp          re-stamps README.md and docs/ from the current version
 *   node scripts/version.mjs check          exits 1 when package.json, the lock file or the documentation disagree
 *
 * The documentation holds the version only between markers, <!--core-version-->0.1.110<!--/core-version-->,
 * so it can be replaced mechanically. Nothing else should repeat the number by hand.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = path.join(root, 'packages/core/package.json');
const lockPath = path.join(root, 'package-lock.json');
const MARK = /(<!--core-version-->)([^<]*)(<!--\/core-version-->)/g;
const SEMVER = /^\d+\.\d+\.\d+$/;

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, v) => writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
const current = () => readJson(pkgPath).version;

function docFiles() {
  const out = [path.join(root, 'README.md')];
  for (const dir of ['docs', 'docs/guide']) {
    const abs = path.join(root, dir);
    if (!existsSync(abs)) continue;
    for (const f of readdirSync(abs)) {
      const p = path.join(abs, f);
      if (statSync(p).isFile() && /\.(md|html)$/.test(f)) out.push(p);
    }
  }
  return out.filter((p) => existsSync(p));
}

function stamp(version) {
  let changed = 0;
  for (const file of docFiles()) {
    const text = readFileSync(file, 'utf8');
    const next = text.replace(MARK, `$1${version}$3`);
    if (next !== text) { writeFileSync(file, next); changed += 1; }
  }
  return changed;
}

function check() {
  const version = current();
  const problems = [];
  const lock = readJson(lockPath);
  if (lock.packages?.['packages/core']?.version !== version) problems.push(`package-lock.json: packages/core is ${lock.packages?.['packages/core']?.version}, expected ${version}`);
  for (const file of docFiles()) {
    for (const m of readFileSync(file, 'utf8').matchAll(MARK)) {
      if (m[2] !== version) problems.push(`${path.relative(root, file)}: marker says ${m[2]}, expected ${version}`);
    }
  }
  return problems;
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'get') {
  console.log(current());
} else if (cmd === 'set') {
  if (!SEMVER.test(arg ?? '')) { console.error('usage: node scripts/version.mjs set X.Y.Z'); process.exit(2); }
  const pkg = readJson(pkgPath); pkg.version = arg; writeJson(pkgPath, pkg);
  const lock = readJson(lockPath);
  if (lock.packages?.['packages/core']) lock.packages['packages/core'].version = arg;
  writeJson(lockPath, lock);
  console.log(`version ${arg}; documentation files updated: ${stamp(arg)}`);
} else if (cmd === 'stamp') {
  console.log(`documentation files updated: ${stamp(current())}`);
} else if (cmd === 'check') {
  const problems = check();
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  console.log(`ok ${current()}`);
} else {
  console.error('usage: node scripts/version.mjs get|set X.Y.Z|stamp|check');
  process.exit(2);
}
