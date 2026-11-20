import { createPostgresDatabase } from '../../src/index.js';

/**
 * A clean PostgreSQL database for the tests, or `null` when none is configured (the suite then skips itself).
 *  - DAS_TEST_POSTGRES_URL=postgres://user:pass@host/db  uses the real `pg` package (install it first);
 *  - DAS_TEST_PG_SOCKET_DIR=/tmp DAS_TEST_PG_PORT=5432 [DAS_TEST_PG_DATABASE=dastest]  uses the tiny client in `mini-pg.js` (no `pg` needed).
 * Every call drops and recreates the `public` schema, so point it at a throw-away database.
 */
export const pgConfigured = Boolean(process.env.DAS_TEST_POSTGRES_URL || process.env.DAS_TEST_PG_SOCKET_DIR);

export async function openTestDb() {
  if (!pgConfigured) return null;
  let db;
  if (process.env.DAS_TEST_POSTGRES_URL) {
    db = await createPostgresDatabase({ connectionString: process.env.DAS_TEST_POSTGRES_URL, max: 4 });
  } else {
    const { Pool } = await import('./mini-pg.js');
    const pool = new Pool({ dir: process.env.DAS_TEST_PG_SOCKET_DIR, port: process.env.DAS_TEST_PG_PORT ?? 5432, database: process.env.DAS_TEST_PG_DATABASE ?? 'dastest' });
    db = await createPostgresDatabase({ pool, ownsPool: true });
  }
  await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  return db;
}
