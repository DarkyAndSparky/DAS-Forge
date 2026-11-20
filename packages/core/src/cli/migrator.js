import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { hasColumnAsync } from '../database/helpers-async.js';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { asyncDb } from '../database/async.js';

/**
 * Simple numbered-file migration runner. Migration files live in a
 * directory, named `<number>_<description>.js`, each exporting a
 * SYNCHRONOUS `up(db)` (and optionally `down(db)`, not run by this
 * runner - rollback is a manual/recovery operation, not part of
 * routine `app migrate`). Synchronous is required, not just a style
 * choice: core/database's `transaction()` wraps the call in
 * BEGIN/COMMIT without awaiting it (node:sqlite itself is synchronous),
 * so an async `up()` would have its COMMIT fire before the migration's
 * own work actually finished. Applied versions are tracked in a
 * `schema_migrations` table so re-running is a no-op for already-
 * applied migrations.
 *
 * Deliberately minimal (no external migration framework) - the 4 apps'
 * schemas are small enough that "run numbered files in order, track
 * what's been run" covers the actual need without a DSL to learn.
 */

function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      checksum TEXT
    );
  `);
  // Databases created before checksums existed: add the column in place.
  const cols = db.all('PRAGMA table_info(schema_migrations)').map((c) => c.name);
  if (!cols.includes('checksum')) db.exec('ALTER TABLE schema_migrations ADD COLUMN checksum TEXT');
}

/** sha256 of the migration file's bytes (line endings normalised so a
 * Windows checkout and a Linux checkout agree). */
function fileChecksum(migrationsDir, file) {
  const text = readFileSync(path.join(migrationsDir, file), 'utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(text).digest('hex');
}

function listMigrationFiles(migrationsDir) {
  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d+_.*\.js$/.test(f))
    .map((f) => ({ file: f, version: parseInt(f.split('_')[0], 10) }))
    .sort((a, b) => a.version - b.version);
  for (let i = 1; i < files.length; i++) {
    if (files[i].version === files[i - 1].version) {
      throw new Error(
        `Duplicate migration version ${files[i].version}: "${files[i - 1].file}" and "${files[i].file}"`
      );
    }
  }
  return files;
}

function getAppliedRows(db) {
  ensureMigrationsTable(db);
  return new Map(db.all('SELECT version, checksum FROM schema_migrations').map((r) => [r.version, r.checksum]));
}

/** Applied migrations whose file content changed since they were applied. */
function findModified(appliedRows, files, migrationsDir) {
  const modified = [];
  for (const { file, version } of files) {
    const stored = appliedRows.get(version);
    if (stored && stored !== fileChecksum(migrationsDir, file)) modified.push(file);
  }
  return modified;
}

/**
 * Checks shared by the synchronous and the asynchronous runner: refuses edited or out-of-order migrations and says what is
 * pending and which applied rows still lack a checksum.
 */
function planMigrations(appliedRows, files, migrationsDir) {
  // Editing an already-applied migration is invisible to the database and
  // means other environments diverge silently (audit B05) - refuse.
  const modified = findModified(appliedRows, files, migrationsDir);
  if (modified.length > 0) {
    throw new Error(
      `Applied migration(s) were modified after being applied: ${modified.join(', ')}. ` +
        'Never edit an applied migration - add a new one instead.'
    );
  }
  // Databases from before checksums: record what is on disk now, once.
  const needChecksum = files.filter(({ version }) => appliedRows.has(version) && !appliedRows.get(version));
  // A pending migration numbered BELOW one already applied would run out
  // of order against a schema that has moved on.
  const maxApplied = Math.max(0, ...appliedRows.keys());
  const gap = files.find((f) => !appliedRows.has(f.version) && f.version < maxApplied);
  if (gap) {
    throw new Error(
      `Migration "${gap.file}" is pending but a later version (${maxApplied}) is already applied - ` +
        'renumber it or apply it manually.'
    );
  }
  return { needChecksum, pending: files.filter((f) => !appliedRows.has(f.version)), maxApplied };
}

/** The copy of the database made before the first pending migration (see `runMigrations`); `null` when none is made. */
async function backupBefore(db, { pending, maxApplied, backupDir, keep, skipBackup, onBackup }) {
  if (!(pending.length > 0 && backupDir)) return null;
  if (skipBackup) {
    onBackup({ status: 'skipped', pending: pending.length });
    return null;
  }
  if (typeof db.snapshotToAsync !== 'function' && typeof db.snapshotTo !== 'function') return null;
  try {
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(backupDir, `pre-migrate-${stamp}-v${maxApplied}.db`);
    if (typeof db.snapshotToAsync === 'function') await db.snapshotToAsync(dest, { check: true }).then((r) => { if (r.integrityOk === false) throw new Error('integrity check of the copy failed'); });
    else db.snapshotTo(dest);
    onBackup({ status: 'made', file: dest, pending: pending.length });
    const old = readdirSync(backupDir).filter((f) => /^pre-migrate-.*\.db$/.test(f)).sort();
    for (const f of old.slice(0, Math.max(0, old.length - Math.max(1, keep)))) rmSync(path.join(backupDir, f), { force: true });
    return dest;
  } catch (err) {
    onBackup({ status: 'failed', error: String(err?.message ?? err).slice(0, 200), pending: pending.length });
    throw new Error(`Pre-migration backup failed, nothing was migrated: ${err?.message ?? err}. Fix the cause or run with --no-backup.`, { cause: err });
  }
}

/**
 * Applies all pending migrations in order, each inside its own
 * transaction. Stops at the first failure (does not attempt later
 * migrations out of order) and reports which version failed.
 *
 * @param {object} db
 * @param {string} migrationsDir
 * @param {object} [opts]
 * @param {string} [opts.backupDir] - when set and something is pending, a consistent copy of the database is made there BEFORE the
 *   first migration runs (`pre-migrate-<time>-v<version>.db`); if the copy fails nothing is migrated (audit R-05)
 * @param {number} [opts.keep=5] - how many pre-migration copies to keep
 * @param {boolean} [opts.skipBackup=false] - explicit refusal of the copy; `onBackup` is told, so it can be audited
 * @param {(event: {status: 'made'|'skipped'|'failed', file?: string, error?: string, pending: number}) => void} [opts.onBackup]
 * @returns {Promise<{applied: Array<{version:number,name:string}>, backup?: string|null}>}
 */
export async function runMigrations(db, migrationsDir, { backupDir = null, keep = 5, skipBackup = false, onBackup = () => {} } = {}) {
  const files = listMigrationFiles(migrationsDir);
  const appliedRows = getAppliedRows(db);
  const { needChecksum, pending, maxApplied } = planMigrations(appliedRows, files, migrationsDir);
  for (const { file, version } of needChecksum) {
    db.run('UPDATE schema_migrations SET checksum = ? WHERE version = ?', [fileChecksum(migrationsDir, file), version]);
  }
  const backup = await backupBefore(db, { pending, maxApplied, backupDir, keep, skipBackup, onBackup });

  const results = [];
  for (const { file, version } of files) {
    if (appliedRows.has(version)) continue;

    const modulePath = pathToFileURL(path.join(migrationsDir, file)).href;
    const migration = await import(modulePath);
    if (typeof migration.up !== 'function') {
      throw new Error(`Migration "${file}" does not export an "up(db)" function`);
    }
    const checksum = fileChecksum(migrationsDir, file);

    // IMMEDIATE: take the write lock first, then re-read what is applied,
    // so the server migrating on boot and `app migrate` in a terminal
    // cannot both run the same migration.
    let ran = false;
    db.transaction(
      (tx) => {
        if (tx.get('SELECT 1 AS x FROM schema_migrations WHERE version = ?', [version])) return;
        const upResult = migration.up(tx);
        if (upResult && typeof upResult.then === 'function') {
          upResult.then(undefined, () => {});
          throw new TypeError(
            `Migration "${file}": up() returned a Promise - migrations must be synchronous ` +
              '(the transaction would commit before the async work finished).'
          );
        }
        tx.run('INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)', [version, file, checksum]);
        ran = true;
      },
      { mode: 'immediate' }
    );

    if (ran) results.push({ version, name: file });
  }

  return backup ? { applied: results, backup } : { applied: results };
}

/**
 * Reports current migration status without applying anything - used by
 * `app migrate status`.
 */
export function migrationStatus(db, migrationsDir) {
  const appliedRows = getAppliedRows(db);
  const files = listMigrationFiles(migrationsDir);
  const modified = new Set(findModified(appliedRows, files, migrationsDir));
  return files.map(({ file, version }) => ({
    version,
    name: file,
    applied: appliedRows.has(version),
    modified: modified.has(file),
  }));
}

const TABLE_DDL = {
  sqlite: `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      checksum TEXT
    )`,
  postgres: `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
      checksum TEXT
    )`,
};

async function ensureMigrationsTableAsync(adb) {
  await adb.exec(TABLE_DDL[adb.dialect === 'postgres' ? 'postgres' : 'sqlite']);
  if (!(await hasColumnAsync(adb, 'schema_migrations', 'checksum'))) await adb.exec('ALTER TABLE schema_migrations ADD COLUMN checksum TEXT');
}

async function getAppliedRowsAsync(adb) {
  await ensureMigrationsTableAsync(adb);
  return new Map((await adb.all('SELECT version, checksum FROM schema_migrations')).map((r) => [Number(r.version), r.checksum]));
}

/**
 * `runMigrations` over `asyncDb` (any driver). `up(tx)` may return a Promise and is awaited: on a database that answers
 * asynchronously a migration must `await tx.run(...)` / `await tx.exec(...)`. Migrations written without `await` keep working
 * on SQLite, where each statement runs at once. Placeholders are `?` (the dialect layer rewrites them for PostgreSQL).
 * The pre-migration copy uses `snapshotToAsync` / `snapshotTo` of the object given (a PostgreSQL driver brings `pg_dump`).
 * @returns {Promise<{applied: Array<{version:number,name:string}>, backup?: string|null}>}
 */
export async function runMigrationsAsync(db, migrationsDir, { backupDir = null, keep = 5, skipBackup = false, onBackup = () => {} } = {}) {
  const adb = asyncDb(db);
  const files = listMigrationFiles(migrationsDir);
  const appliedRows = await getAppliedRowsAsync(adb);
  const { needChecksum, pending, maxApplied } = planMigrations(appliedRows, files, migrationsDir);
  for (const { file, version } of needChecksum) {
    await adb.run('UPDATE schema_migrations SET checksum = ? WHERE version = ?', [fileChecksum(migrationsDir, file), version]);
  }
  const backup = await backupBefore(db, { pending, maxApplied, backupDir, keep, skipBackup, onBackup });

  const results = [];
  for (const { file, version } of pending) {
    const migration = await import(pathToFileURL(path.join(migrationsDir, file)).href);
    if (typeof migration.up !== 'function') throw new Error(`Migration "${file}" does not export an "up(db)" function`);
    const checksum = fileChecksum(migrationsDir, file);
    let ran = false;
    // IMMEDIATE: the write lock first, then re-read what is applied, so two processes cannot run the same migration.
    await adb.transaction(async (tx) => {
      if (await tx.get('SELECT 1 AS x FROM schema_migrations WHERE version = ?', [version])) return;
      await migration.up(tx);
      await tx.run('INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)', [version, file, checksum]);
      ran = true;
    }, { mode: 'immediate' });
    if (ran) results.push({ version, name: file });
  }
  return backup ? { applied: results, backup } : { applied: results };
}

/** `migrationStatus` over `asyncDb`. */
export async function migrationStatusAsync(db, migrationsDir) {
  const appliedRows = await getAppliedRowsAsync(asyncDb(db));
  const files = listMigrationFiles(migrationsDir);
  const modified = new Set(findModified(appliedRows, files, migrationsDir));
  return files.map(({ file, version }) => ({ version, name: file, applied: appliedRows.has(version), modified: modified.has(file) }));
}
