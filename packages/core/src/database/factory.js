import path from 'node:path';
import { createSqliteAdapter } from './sqlite-adapter.js';

/**
 * The database the config asks for (`database.driver`): the SQLite adapter, or the PostgreSQL driver of
 * `@das-forge/db-postgres`. SQLite stays synchronous (`db.get(...)`), PostgreSQL is asynchronous: wrap either with `asyncDb(db)`
 * to write code that works with both.
 *
 * @param {object} dbConfig - `config.database`
 * @param {object} [o]
 * @param {string} [o.rootDir=process.cwd()] - the SQLite file path is relative to this
 * @param {object} [o.env=process.env] - where `database.url` (`env:NAME`) is read from
 * @param {() => Promise<object>} [o.importDriver] - loads the PostgreSQL driver module (tests; default: `import('@das-forge/db-postgres')`)
 */
export async function createDatabase(dbConfig, { rootDir = process.cwd(), env = process.env, importDriver } = {}) {
  const driver = dbConfig?.driver ?? 'node:sqlite';
  if (driver === 'node:sqlite') {
    return createSqliteAdapter({
      file: path.resolve(rootDir, dbConfig?.file ?? 'data/app.db'),
      walMode: dbConfig?.walMode ?? true,
      normalizeValues: dbConfig?.normalizeValues ?? false,
    });
  }
  if (driver !== 'postgres') throw new Error(`database.driver "${driver}" is not supported`);
  const ref = String(dbConfig.url ?? '');
  const name = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(ref)?.[1];
  if (!name) throw new Error('database.url must be an env:NAME reference when database.driver is "postgres"');
  const connectionString = env[name];
  if (!connectionString) throw new Error(`database.url: the environment variable ${name} is not set`);
  let mod;
  try {
    mod = await (importDriver ? importDriver() : import('@das-forge/db-postgres'));
  } catch (cause) {
    throw new Error('database.driver "postgres" needs the package @das-forge/db-postgres (npm install @das-forge/db-postgres pg)', { cause });
  }
  return mod.createPostgresDatabase({
    connectionString,
    max: dbConfig.poolSize ?? 10,
    ssl: dbConfig.ssl ? { rejectUnauthorized: true } : undefined,
    statementTimeoutMs: dbConfig.statementTimeoutMs,
  });
}
