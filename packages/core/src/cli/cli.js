import { parseArgs } from './arg-parser.js';
import { CLI_TEXT, helpFor, resolveCliLang } from './help.js';

/**
 * Command tree + dispatcher for the `app` CLI each of the 4 apps ships
 * (per architecture doc's CLI section: `app config check`, `app user
 * create-admin`, `app migrate`, `app backup run`, etc.).
 *
 * run() never calls process.exit() itself - it returns a numeric exit
 * code. The app's actual bin script (a few lines, outside core) does
 * `process.exit(await cli.run(process.argv.slice(2)))`. Keeping exit
 * out of this module is what makes run() unit-testable without
 * spawning a subprocess.
 */
export function createCli({ name = 'app' } = {}) {
  const name_ = name;
  /** @type {Map<string, {description:string, usage?:string, flags?:Array<{name:string,description:string}>, examples?:string[], handler:Function}>} */
  const commands = new Map();

  /**
   * @param {string} path - space-separated command path, e.g. "config check"
   * @param {object} opts
   * @param {string} opts.description - one-line summary, shown in the
   *   global command list AND as the first line of per-command help
   * @param {string} [opts.usage] - the args/flags portion after the
   *   command path, e.g. "[--force]" or "<username> [--count n]". Only
   *   used by `app help <command>` / `app <command> --help` - optional,
   *   so existing command() call sites that don't pass it keep working
   *   unchanged (see docs/roadmap.md's backlog note on this being a
   *   gradual fill-in, not a one-shot rewrite of every command)
   * @param {Array<{name:string, description:string}>} [opts.flags] -
   *   per-command help detail, optional for the same reason as `usage`
   * @param {string[]} [opts.examples] - full invocations WITHOUT the
   *   CLI name prefix (printCommandHelp adds it), e.g.
   *   ["user create-admin --force"]
   * @param {string[]} [opts.booleanFlags] - extra flag names that never take a value (the common ones - json, yes, force, fix, repair, verbose, quiet, help - always are)
   * @param {(ctx: {positionals:string[], flags:object}) => Promise<number>|number} opts.handler
   *   returns the process exit code (0 = success)
   */
  const extraBooleans = new Set();
  let lang = resolveCliLang();

  function command(path, { description = '', usage, flags, examples, booleanFlags = [], handler }) {
    if (commands.has(path)) {
      throw new Error(`CLI command "${path}" is already registered`);
    }
    for (const b of booleanFlags) extraBooleans.add(b);
    commands.set(path, { description, usage, flags, examples, handler });
  }

  function printUsage() {
    const tx = CLI_TEXT[lang];
    // eslint-disable-next-line no-console
    console.log(`${tx.usage}: ${name} <${lang === 'ru' ? 'команда' : 'command'}> [${lang === 'ru' ? 'параметры' : 'options'}]\n\n${tx.commands}:`);
    for (const [path, meta] of [...commands.entries()].sort()) {
      // eslint-disable-next-line no-console
      console.log(`  ${path.padEnd(28)} ${helpFor(path, meta, lang).description}`);
    }
    // eslint-disable-next-line no-console
    console.log(`\n${tx.more(name)}`);
  }

  /**
   * man-style detail for ONE command - the piece that used to be
   * entirely missing (docs/roadmap.md's "CLI help в духе man" backlog
   * item): `printUsage()` above only ever listed every command's
   * one-line description, with no way to see a single command's flags
   * or an example invocation without reading the source. Falls back
   * gracefully when a command was registered without `usage`/`flags`/
   * `examples` (most of them still are, as of 0.1.18 - see the
   * roadmap note this closes only the MECHANISM, not every command's
   * content).
   */
  function printCommandHelp(path) {
    const meta = helpFor(path, commands.get(path), lang);
    const tx = CLI_TEXT[lang];
    // eslint-disable-next-line no-console
    console.log(`${name} ${path}`);
    if (meta.description) {
      // eslint-disable-next-line no-console
      console.log(`\n${meta.description}`);
    }
    // usage === '' means "takes no args/flags" (e.g. `migrate`) -
    // deliberately distinct from usage === undefined, "not filled in
    // yet" (falls back to the generic "[options]" placeholder).
    const usageSuffix = meta.usage === undefined ? ' [options]' : meta.usage ? ` ${meta.usage}` : '';
    // eslint-disable-next-line no-console
    console.log(`\n${tx.usage}: ${name} ${path}${usageSuffix}`);
    if (meta.flags?.length) {
      // eslint-disable-next-line no-console
      console.log(`\n${tx.flags}:`);
      for (const f of meta.flags) {
        // eslint-disable-next-line no-console
        console.log(`  ${f.name.padEnd(24)} ${f.description}`);
      }
    }
    if (meta.examples?.length) {
      // eslint-disable-next-line no-console
      console.log(`\n${tx.examples}:`);
      for (const ex of meta.examples) {
        // eslint-disable-next-line no-console
        console.log(`  ${name} ${ex}`);
      }
    }
    if (meta.usage === undefined && !meta.flags?.length && !meta.examples?.length) {
      // Honest about the gap rather than silently showing a thin page -
      // this command just hasn't had its detailed help filled in yet.
      // eslint-disable-next-line no-console
      console.log(`\n${tx.noDetail}`);
    }
  }

  /**
   * Finds the longest registered command path that's a prefix of the
   * given positionals, e.g. positionals ["config","check","extra"]
   * matches "config check" (consuming 2 tokens, leaving ["extra"]).
   */
  function matchCommand(positionals) {
    for (let len = positionals.length; len > 0; len--) {
      const candidate = positionals.slice(0, len).join(' ');
      if (commands.has(candidate)) {
        return { path: candidate, remaining: positionals.slice(len) };
      }
    }
    return null;
  }

  async function run(argv) {
    let parsed;
    try {
      parsed = parseArgs(argv, { booleanFlags: extraBooleans });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[${name}] ${err?.message ?? String(err)}`);
      return 2;
    }
    const { positionals, flags } = parsed;
    lang = resolveCliLang(flags);

    if (positionals.length === 0) {
      printUsage();
      // A bare invocation is a usage error (exit 1); `app --help` with
      // no command is "I asked for help", not an error (exit 0) - this
      // distinction didn't exist before 0.1.18, where `flags.help` was
      // checked in the SAME branch as "no positionals" and always
      // returned exit 1 either way.
      return flags.help || flags.h ? 0 : 1;
    }

    // `app help` / `app help <command...>` - the explicit man-style
    // entry point. `app help` alone (no further positionals) is just
    // the global list, same as `app --help`.
    if (positionals[0] === 'help') {
      const rest = positionals.slice(1);
      if (rest.length === 0) {
        printUsage();
        return 0;
      }
      const match = matchCommand(rest);
      if (!match || match.remaining.length > 0) {
        // eslint-disable-next-line no-console
        console.error(`${CLI_TEXT[lang].unknown(rest.join(' '))}\n`);
        printUsage();
        return 1;
      }
      printCommandHelp(match.path);
      return 0;
    }

    const match = matchCommand(positionals);
    if (!match) {
      // eslint-disable-next-line no-console
      console.error(`${CLI_TEXT[lang].unknown(positionals.join(' '))}\n`);
      printUsage();
      return 1;
    }

    // `app <command> --help` / `-h` - the other entry point into the
    // same per-command help, for whoever reaches for --help out of
    // habit instead of `app help <command>`.
    if (flags.help || flags.h) {
      printCommandHelp(match.path);
      return 0;
    }

    const { handler, flags: declared } = commands.get(match.path);

    // A typo like `--forse` used to be silently ignored. Only commands that
    // DECLARE their flags can be checked; warn (not fail) so scripts that
    // pass extra flags keep working.
    if (declared?.length) {
      const known = new Set(['help', 'h', 'lang', ...declared.map((f) => /--([\w-]+)/.exec(f.name)?.[1]).filter(Boolean)]);
      for (const name of Object.keys(flags)) {
        if (!known.has(name)) {
          // eslint-disable-next-line no-console
          console.error(CLI_TEXT[lang].unknownFlag(name_, name, match.path));
        }
      }
    }

    try {
      const code = await handler({ positionals: match.remaining, flags });
      return code ?? 0;
    } catch (err) {
      if (err?.name === 'ArgError') {
        // eslint-disable-next-line no-console
        console.error(`[${name}] ${err.message}`);
        return 2;
      }
      const detail = err?.message ?? String(err);
      // eslint-disable-next-line no-console
      console.error(`[${name}] command "${match.path}" failed:`, err?.code ? `${detail} (${err.code})` : detail);
      if (flags.verbose && err?.stack) console.error(err.stack); // eslint-disable-line no-console
      return 1;
    }
  }

  return { command, run, printUsage, printCommandHelp };
}
