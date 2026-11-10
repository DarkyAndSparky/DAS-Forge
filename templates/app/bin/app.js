#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

import { cli as cliModule, privacy, config, auth, health, scheduler, audit, database, certs } from '@das-forge/core';
import { buildContext } from '../src/context.js';
import { buildDoctorCategories } from '../src/doctor-categories.js';
import { ROLES, ADMIN_ROLE } from '../src/roles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));

/**
 * The command line: the core's ready-made command groups on top of the same `buildContext()` the server uses.
 * Register only the groups you need; add your own with `cli.command('name', { description, usage, handler })`.
 */
async function main() {
  const ctx = await buildContext();
  const cli = cliModule.createCli({ name: PACKAGE.name });

  // `backup restore` closes the connection and opens a new one over the restored file; every command that touches
  // the database goes through this getter instead of closing over `ctx.db` directly.
  let activeDb = ctx.db;
  const getDb = () => activeDb;
  const dbFilePath = path.resolve(ctx.repoRoot, ctx.appConfig.database.file);

  cliModule.registerConfigCheckCommand(cli, { loadConfigFn: config.loadConfig, cwd: ctx.repoRoot });
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
  ctx.moduleRegistry.applyCliCommands(cli); // commands that registered modules bring along
  cliModule.registerVersionCommand(cli, { version: PACKAGE.version });
  cliModule.registerDepsCommands(cli, { lockFile: path.resolve(ctx.repoRoot, 'package-lock.json'), packageJsonPath: path.resolve(ctx.repoRoot, 'package.json'), ignore: ctx.appConfig.security.dependencyAudit.ignore });
  cliModule.registerHealthCommand(cli, { db: ctx.db, version: PACKAGE.version });
  cliModule.registerDoctorCommand(cli, { categoryProviders: buildDoctorCategories(ctx, getDb), title: `${ctx.appConfig.appName} Doctor` });

  const code = await cli.run(process.argv.slice(2));
  try { activeDb.close(); } catch { /* already closed by a restore that could not reopen */ }
  process.exit(code);
}

main().catch((err) => {
  console.error('[app] fatal CLI error:', err); // eslint-disable-line no-console
  process.exit(1);
});
