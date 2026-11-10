import { readFileSync } from 'node:fs';

/**
 * Explicit env-var -> config-path overrides (12-factor style).
 *
 * Deliberately NOT a generic "every FOO_BAR env var maps to foo.bar"
 * mechanism — that kind of magic makes it hard to know what actually
 * affects the running app. Only the keys listed here are honored.
 */
const ENV_MAP = [
  ['DAS_HOST', 'server.host', String],
  ['DAS_PORT', 'server.port', Number],
  ['DAS_TRUST_PROXY', 'server.trustProxy', toTrustProxy],
  ['DAS_DB_FILE', 'database.file', String],
  ['DAS_SESSION_SECRET', 'auth.sessionSecret', String],
  ['DAS_ENV', 'env', String],
  ['DAS_HTTPS_MODE', 'server.https.mode', String],
  ['DAS_LOG_LEVEL', 'logLevel', String],
  ['DAS_SMTP_PASSWORD', 'email.smtp.auth.pass', String],
  ['DAS_BACKUP_KEY', 'backup.encryptionKey', String],
  ['DAS_TOTP_KEY', 'auth.totpEncryptionKey', String],
];

/**
 * DAS_TRUST_PROXY: a boolean (true = one hop), a hop count of 2 or more ("2" for CDN + nginx), or a comma-separated
 * list of proxy addresses/subnets/keywords ("10.0.0.0/8,loopback") - audit L04.
 */
function toTrustProxy(v) {
  const s = String(v).trim();
  if (/^\d+$/.test(s) && Number(s) >= 2) return Number(s);
  if (s.includes(',') || /[./:]/.test(s) || ['loopback', 'linklocal', 'uniquelocal'].includes(s.toLowerCase())) {
    return s.split(',').map((x) => x.trim()).filter(Boolean);
  }
  return toBool(v);
}

/** Strict boolean: `DAS_TRUST_PROXY=yes` used to become false without a word (audit C07). */
function toBool(v) {
  const s = String(v).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'off'].includes(s)) return false;
  throw new Error(`Invalid boolean value "${v}" in an environment variable (use true/false, 1/0, yes/no, on/off)`);
}

function setPath(target, path, value) {
  const parts = path.split('.');
  let node = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (typeof node[key] !== 'object' || node[key] === null) {
      node[key] = {};
    }
    node = node[key];
  }
  node[parts[parts.length - 1]] = value;
}

/**
 * Applies known env-var overrides onto a plain config object (mutates and
 * returns it). Call this AFTER merging file config + defaults, BEFORE
 * Zod validation, so env wins but still goes through the same schema.
 */
export function applyEnvOverrides(configObject, env = process.env, { readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  for (const [envKey, path, cast] of ENV_MAP) {
    let raw = env[envKey];
    // Docker/Kubernetes secrets: `<NAME>_FILE=/run/secrets/x` reads the value
    // from a file (trailing newline trimmed). The plain variable wins if both are set.
    if ((raw === undefined || raw === '') && env[`${envKey}_FILE`]) {
      const file = env[`${envKey}_FILE`];
      try {
        raw = readFile(file).replace(/\r?\n$/, '');
      } catch (err) {
        throw new Error(`${envKey}_FILE points at "${file}" which could not be read: ${err.message}`);
      }
    }
    if (raw !== undefined && raw !== '') {
      setPath(configObject, path, cast(raw));
    }
  }
  return configObject;
}

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

/**
 * What the environment does to the configuration, for the administration page: every honoured variable with its target
 * setting and where it came from, plus `DAS_*` variables that nothing reads (a typo is otherwise silently ignored).
 * VALUES ARE NEVER RETURNED - only names and whether a variable is set.
 * @param {Record<string, string|undefined>} [env]
 * @returns {{known: Array<{name: string, path: string, source: 'env'|'file'|'unset', note?: string}>, unknown: Array<{name: string, didYouMean: string|null}>}}
 */
export function describeEnv(env = process.env) {
  const names = ENV_MAP.map(([k]) => k);
  const known = ENV_MAP.map(([name, path]) => {
    const direct = env[name] !== undefined && env[name] !== '';
    const file = Boolean(env[`${name}_FILE`]);
    if (direct) return { name, path, source: 'env', ...(file ? { note: 'both' } : {}) };
    if (file) return { name, path, source: 'file' };
    return { name, path, source: 'unset' };
  });
  const honoured = new Set([...names, ...names.map((n) => `${n}_FILE`)]);
  const unknown = Object.keys(env).filter((k) => /^DAS_/i.test(k) && !honoured.has(k)).sort().map((name) => {
    const best = names.map((n) => [n, distance(name.toUpperCase(), n)]).sort((a, b) => a[1] - b[1])[0];
    return { name, didYouMean: best && best[1] <= 3 ? best[0] : null };
  });
  return { known, unknown };
}
