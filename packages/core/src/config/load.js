import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

import { ApplicationConfigSchema } from './schema.js';
import { applyEnvOverrides, describeEnv } from './env.js';
import { ConfigValidationError } from './errors.js';
import { isPlaceholderSecret } from './secrets.js';

/**
 * Deep-merges plain objects (arrays are replaced wholesale, not merged
 * element-by-element — safer and less surprising for lists like
 * backup.destinations or modules).
 */
function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) {
    return override !== undefined ? override : base;
  }
  if (isPlainObject(base) && isPlainObject(override)) {
    const result = { ...base };
    for (const key of Object.keys(override)) {
      result[key] = deepMerge(base[key], override[key]);
    }
    return result;
  }
  return override !== undefined ? override : base;
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Loads and validates the application config.
 *
 * @param {object} opts
 * @param {string} [opts.cwd] - directory to look for app.config.js in
 * @param {string} [opts.configPath] - explicit path, overrides cwd lookup
 * @param {object} [opts.overrides] - object merged in last (highest prio,
 *        above even env - mainly useful for tests)
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {object} [opts.report] - filled with `{fileConfig, envPaths}`: what came from the file and which settings an environment variable set (no values)
 * @param {import('zod').ZodType} [opts.schema] - ApplicationConfigSchema extended with the app's own settings
 * @returns {Promise<import('zod').infer<typeof ApplicationConfigSchema>>}
 */
export async function loadConfig({
  cwd = process.cwd(),
  configPath,
  overrides,
  env = process.env,
  schema = ApplicationConfigSchema,
  report,
} = {}) {
  const resolvedPath = configPath
    ? path.resolve(configPath)
    : path.resolve(cwd, 'app.config.js');

  let fileConfig = {};
  if (existsSync(resolvedPath)) {
    const mod = await import(pathToFileURL(resolvedPath).href);
    fileConfig = mod.default ?? mod;
  } else if (configPath) {
    // An explicit path was given but doesn't exist - that's a real error,
    // unlike the default app.config.js-not-found case which just means
    // "use defaults only" (useful for tests / first-run doctor checks).
    throw new Error(`Config file not found: ${resolvedPath}`);
  }

  let merged = deepMerge({}, fileConfig);
  if (overrides) merged = deepMerge(merged, overrides);
  merged = applyEnvOverrides(merged, env);
  if (report) {
    report.fileConfig = fileConfig;
    report.envPaths = describeEnv(env).known.filter((k) => k.source !== 'unset').map((k) => k.path);
  }

  const result = schema.safeParse(merged);
  if (!result.success) {
    throw new ConfigValidationError(result.error, { sourcePath: resolvedPath });
  }

  // Refuse to START production with a placeholder secret (audit C07) - the
  // doctor check only helps if somebody runs it.
  if (result.data.env === 'production' && isPlaceholderSecret(result.data.auth.sessionSecret)) {
    throw new Error('auth.sessionSecret is a known placeholder value - set a real secret before running with env=production');
  }

  return result.data;
}

/**
 * Synchronous validate-only helper - useful for the CLI (`app config check`)
 * and for unit tests that already have a plain object in hand.
 */
export function validateConfig(plainObject, { sourcePath, schema = ApplicationConfigSchema } = {}) {
  const result = schema.safeParse(plainObject);
  if (!result.success) {
    throw new ConfigValidationError(result.error, { sourcePath });
  }
  return result.data;
}
