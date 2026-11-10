import { ApplicationConfigSchema } from './schema.js';

/** The value at a dotted path with `[i]` indexes, or undefined. */
function at(obj, path) {
  let node = obj;
  for (const part of path.replace(/\[(\d+)\]/g, '.$1').split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return node;
}

/**
 * The defaults of a schema: what a configuration holds when nothing is set. A schema needs a session secret to
 * validate, so a placeholder is supplied and its own path is left out of the comparison. Null when the schema
 * has other required settings.
 */
export function schemaDefaults(schema = ApplicationConfigSchema) {
  const r = schema.safeParse({ auth: { sessionSecret: 'defaults-only-placeholder' } });
  return r.success ? r.data : null;
}

/**
 * For each flattened setting: where its value comes from (`env` - an environment variable, `file` - app.config.js,
 * `default`) and whether it differs from the default. Pure; secrets are already hidden in `rows`.
 * @param {Array<[string, any]>} rows - `flattenConfig(effective)`
 * @param {{fileConfig?: object, envPaths?: string[], defaults?: object|null}} o
 * @returns {Array<{path: string, value: any, source: 'env'|'file'|'default', changed: boolean|null}>}
 */
export function describeSources(rows, { fileConfig = {}, envPaths = [], defaults = null } = {}) {
  const env = new Set(envPaths);
  return rows.map(([path, value]) => {
    const fromEnv = [...env].some((p) => path === p || path.startsWith(`${p}.`) || path.startsWith(`${p}[`));
    const inFile = at(fileConfig, path) !== undefined;
    const source = fromEnv ? 'env' : inFile ? 'file' : 'default';
    // hidden secrets (null) cannot be compared; a value nobody set cannot differ
    let changed = null;
    if (defaults && value !== null) changed = source !== 'default' && JSON.stringify(at(defaults, path) ?? null) !== JSON.stringify(value);
    return { path, value, source, changed };
  });
}
