#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

import { cli as cliModule, privacy, config, auth, health, scheduler, audit, database, certs, email } from '@das-forge/core';
import { buildContext } from '../src/context.js';
import { buildDoctorCategories } from '../src/doctor-categories.js';
import { registerAlertsCommands } from '../src/alerts-commands.js';
import { ROLES, ADMIN_ROLE } from '../src/roles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read directly rather than `import ... with { type: 'json' }` - keeps
// this bin script's syntax requirements minimal, and the version only
// needs to be a plain string for `app health`/`app version`'s output.
const PACKAGE_VERSION = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')).version;

async function main() {
  const ctx = await buildContext();
  const cli = cliModule.createCli({ name: 'workshop' });

  // `backup restore` closes the current connection and opens a fresh
  // one over the just-restored file - every command registered below
  // that touches the database goes through this getter/setter pair
  // instead of closing over `ctx.db` directly, so a restore mid-process
  // (there is only ever one command per CLI invocation, but several
  // commands are REGISTERED against the same mutable slot) never ends
  // up operating on an already-closed connection.
  let activeDb = ctx.db;
  const getDb = () => activeDb;

  const dbFilePath = path.resolve(ctx.repoRoot, ctx.appConfig.database.file);

  cliModule.registerConfigCheckCommand(cli, {
    loadConfigFn: config.loadConfig,
    cwd: ctx.repoRoot,
  });

  cliModule.registerUserCommands(cli, {
    db: ctx.db,
    hashPassword: ctx.authProvider.hashPassword,
    createUser: auth.createUser,
    findUserByUsername: auth.findUserByUsername,
    updatePasswordHash: auth.updatePasswordHash,
    countUsers: auth.countUsers,
    listAuthenticators: auth.listAuthenticators,
    removeAuthenticator: auth.removeAuthenticator,
    generateRecoveryCodes: auth.generateRecoveryCodes,
    userAdmin: auth,
    roles: ROLES,
    adminRole: ADMIN_ROLE,
    auditLog: (entry) => audit.log(ctx.db, entry),
  });

  cliModule.registerMigrateCommands(cli, { db: ctx.db, migrationsDir: ctx.migrationsDir, backupDir: ctx.preMigrateDir });

  cliModule.registerDbCommands(cli, { db: ctx.db, migrationsDir: ctx.migrationsDir, dbFilePath });

  cliModule.registerBackupCommands(cli, {
    runBackupFn: ctx.runBackupJob,
    listBackupsFn: async () => [
      ...scheduler.listBackups(ctx.appConfig.backup.destinations),
      ...(await scheduler.listRemoteBackups(ctx.appConfig.backup.destinations)),
    ],
    verifyBackupFn: (file) => scheduler.verifyBackupFile(database.createSqliteAdapter, file, { encryptionKey: ctx.appConfig.backup.encryptionKey ?? null }),
    restoreBackupFn: async (file) => {
      activeDb.close();
      const result = await scheduler.restoreBackup({
        dbFilePath,
        backupFilePath: file,
        migrationsDir: ctx.migrationsDir,
        createAdapterFn: database.createSqliteAdapter,
        auditLogFn: audit.log,
        actor: cliModule.cliActor(),
        uploadsDir: ctx.uploadsDir,
        serverLockFile: ctx.serverLockFile,
        encryptionKey: ctx.appConfig.backup.encryptionKey ?? null,
      });
      if (result.db) activeDb = result.db;
      return result;
    },
  });

  registerAlertsCommands(cli, { ctx, getDb });

  cliModule.registerBanCommands(cli, { bans: ctx.bans });
  cliModule.registerOpsCommands(cli, { db: ctx.db });
  cliModule.registerAuditCommands(cli, { db: ctx.db, tailFn: audit.tail, queryFn: audit.query, verifyFn: audit.verifyChain, anchorFn: audit.anchor });

  cliModule.registerPrivacyCommands(cli, {
    findUserByUsernameFn: (username) => auth.findUserByUsername(ctx.db, username),
    exportUserDataFn: ctx.exportUserData,
    eraseUserDataFn: ctx.eraseUserData,
    reapplyErasuresFn: ctx.reapplyErasures,
    incidents: privacy.createIncidentRegister(ctx.db),
    registryFn: () => privacy.buildProcessingRegistry({ moduleRegistry: ctx.moduleRegistry, config: ctx.appConfig }),
    formatRegistryFn: privacy.formatProcessingRegistry,
  });

  cliModule.registerCertCommands(cli, {
    certPath: ctx.certPath,
    certDir: ctx.certDir,
    readCertInfoFn: certs.readCertInfo,
    generateCertFn: certs.generateSelfSignedCert,
    writeCertFilesFn: certs.writeCertFiles,
    defaultCommonName: ctx.appConfig.server.host,
  });

  // §1's Module contract made concrete: this wires every registered
  // module's cliCommands (just `report summary` for now, see
  // src/modules/reporting-module.js) onto the SAME `cli` instance as
  // core's own built-in commands - core/cli itself never heard of
  // "reporting", it only ever saw the registry's generic interface.
  ctx.moduleRegistry.applyCliCommands(cli);

  cliModule.registerVersionCommand(cli, { version: PACKAGE_VERSION });
  cliModule.registerDepsCommands(cli, { lockFile: path.resolve(ctx.repoRoot, 'package-lock.json'), packageJsonPath: path.resolve(__dirname, '../package.json'), ignore: ctx.appConfig.security.dependencyAudit.ignore });

  cliModule.registerHealthCommand(cli, { db: ctx.db, version: PACKAGE_VERSION });
  cliModule.registerDoctorCommand(cli, {
    categoryProviders: buildDoctorCategories(ctx, getDb),
    title: `${ctx.appConfig.appName} Doctor`,
  });

  const code = await cli.run(process.argv.slice(2));
  try {
    activeDb.close();
  } catch {
    // already closed (e.g. a failed `backup restore` that closed the
    // original connection but didn't successfully reopen a new one)
  }
  process.exit(code);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[workshop] fatal CLI error:', err);
  process.exit(1);
});
