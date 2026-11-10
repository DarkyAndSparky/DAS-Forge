/**
 * `app doctor` - "is the machine/installation configured correctly"
 * (§4.5). Deliberately decoupled from how the result gets shown: the
 * CLI command (cli/commands/doctor.js) and a future admin-panel "Run
 * diagnostics" button both call this exact function and format its
 * return value their own way - one implementation of what a check is
 * and how --fix behaves, not two.
 *
 * @typedef {{name: string, status: 'ok'|'warn'|'fail', message: string, fix?: () => void|Promise<void>}} CheckResult
 * @typedef {{name: string, run: () => CheckResult[]|Promise<CheckResult[]>}} CategoryProvider
 *
 * @param {CategoryProvider[]} categoryProviders - supplied by the app
 *   (examples/workshop, eventually the 4 real apps), not hardcoded here -
 *   this is the extension point the doc describes ("@das-forge/ldap adds
 *   its own check to Integrations without changing the doctor framework")
 * @param {object} [opts]
 * @param {boolean} [opts.fix=false] - call fix() on every failing check
 *   that has one, then re-run that category once so the report reflects
 *   whether the fix actually worked
 */
export async function runDoctor(categoryProviders, { fix = false } = {}) {
  const categories = [];

  for (const { name, run } of categoryProviders) {
    let results = await run();

    if (fix && results.some((r) => r.status === 'fail' && typeof r.fix === 'function')) {
      for (const r of results) {
        if (r.status === 'fail' && typeof r.fix === 'function') {
          try {
            await r.fix();
          } catch {
            // leave it - it'll still show as failing on the re-run below,
            // which is the correct, honest report
          }
        }
      }
      results = await run();
    }

    categories.push({
      name,
      // fix is an internal implementation detail - never serialized out
      // to CLI/JSON/admin-panel callers
      checks: results.map(({ fix: _fix, ...rest }) => rest),
    });
  }

  const flat = categories.flatMap((c) => c.checks);
  const summary = {
    ok: flat.filter((c) => c.status === 'ok').length,
    warn: flat.filter((c) => c.status === 'warn').length,
    fail: flat.filter((c) => c.status === 'fail').length,
  };

  // §4.2 exit code convention: 3 = environment not ready (doctor found
  // critical problems). Warnings alone don't block - they're advisory.
  return { categories, summary, exitCode: summary.fail > 0 ? 3 /* EXIT.CHECK_FAILED */ : 0 };
}
