/**
 * Minimal argv parser - deliberately not pulling in commander/yargs for
 * the handful of flags the 4 apps' CLIs actually need. Rules:
 *   - a token starting with "--" is a flag
 *   - "--foo=bar" sets flags.foo = "bar"
 *   - "--foo bar" sets flags.foo = "bar" - UNLESS foo is a boolean flag,
 *     which never consumes the next token (audit C09: `--yes file.db`
 *     used to swallow the file name)
 *   - "--foo" with nothing following, or followed by another flag, is a
 *     boolean flag: flags.foo = true
 *   - "--yes=false" (a boolean flag with a value) is parsed, not taken as text
 *   - "-h" is the short form of --help, "-y" of --yes; other single-dash letters
 *     ("-v") are boolean flags named by the letter
 *   - "--" ends flag parsing: everything after it is positional, even if
 *     it starts with a dash (a file literally named "--weird")
 *   - everything else is a positional argument, in order
 *
 * @param {string[]} argv - e.g. process.argv.slice(2)
 * @param {{booleanFlags?: Iterable<string>}} [opts] - flag names that never take a value
 * @returns {{positionals: string[], flags: Record<string, string|boolean>}}
 */
export const DEFAULT_BOOLEAN_FLAGS = ['help', 'h', 'json', 'yes', 'force', 'fix', 'repair', 'verbose', 'quiet', 'hard', 'all', 'changed'];

/** Thrown for a malformed flag value; the CLI prints it as a usage error. */
export class ArgError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArgError';
  }
}

const TRUE_WORDS = new Set(['true', '1', 'yes', 'on']);
const FALSE_WORDS = new Set(['false', '0', 'no', 'off']);

/**
 * `--yes=false` must not mean "yes": the value of a boolean flag is parsed
 * (true/1/yes/on, false/0/no/off) and anything else is refused (audit G01).
 */
function booleanValue(name, raw) {
  const word = raw.toLowerCase();
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  throw new ArgError(`--${name} expects true or false, got "${raw}"`);
}

/** A flag that needs a text value: `--user` with nothing after it is `true`, which is not text. */
export function flagString(flags, name) {
  const v = flags[name];
  if (v === undefined || v === false) return undefined;
  if (typeof v !== 'string' || v === '') throw new ArgError(`--${name} needs a value`);
  return v;
}

/** A flag that needs an integer in [min, max]. */
export function flagInt(flags, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const v = flagString(flags, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new ArgError(`--${name} must be an integer from ${min} to ${max}, got "${v}"`);
  return n;
}

export function parseArgs(argv, { booleanFlags = [] } = {}) {
  const booleans = new Set([...DEFAULT_BOOLEAN_FLAGS, ...booleanFlags]);
  const positionals = [];
  const flags = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (/^-[A-Za-z]$/.test(token)) {
      const letter = token.slice(1);
      if (letter === 'h') flags.help = true;
      if (letter === 'y') flags.yes = true;
      flags[letter] = true;
      continue;
    }

    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const body = token.slice(2);
    const eqIndex = body.indexOf('=');
    if (eqIndex !== -1) {
      const name = body.slice(0, eqIndex);
      const raw = body.slice(eqIndex + 1);
      flags[name] = booleans.has(name) ? booleanValue(name, raw) : raw;
      continue;
    }

    const next = argv[i + 1];
    if (!booleans.has(body) && next !== undefined && !next.startsWith('--')) {
      flags[body] = next;
      i++;
    } else {
      flags[body] = true;
    }
  }

  return { positionals, flags };
}
