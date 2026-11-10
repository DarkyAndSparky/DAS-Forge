import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config, database, branding, auth, scheduler, modules, audit, privacy, certs, email, security, alerts as alertsModule } from '@das-forge/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.resolve(APP_ROOT, 'migrations');

/**
 * Alerts for the server process (null when `alerts.enabled` is false): stored in the database, written to the
 * log and mailed to `security.incidentContacts`. Built in server.js once the logger exists.
 */
export function buildAlerts(ctx, logger) {
  const cfg = ctx.appConfig.alerts;
  if (!cfg.enabled) return null;
  const contacts = ctx.appConfig.security.incidentContacts;
  const alerts = alertsModule.createAlerts({
    db: ctx.db,
    email: ctx.emailService,
    contacts,
    logger,
    cooldownMs: cfg.cooldownMinutes * 60_000,
    keepDays: cfg.keepDays,
    locale: ctx.appConfig.email.locale,
  });
  return {
    alerts,
    mailConfigured: Boolean(ctx.emailService?.enabled && contacts.length),
    onLock: alerts.lockoutWatcher({ threshold: cfg.lockouts.threshold, windowMs: cfg.lockouts.windowMinutes * 60_000 }),
  };
}

/**
 * Builds everything both the HTTP server (server.js) and the CLI (bin/app.js) need, in one place, so "how does the
 * application wire up the core" has exactly one answer. The order matters: each step needs the result of the one
 * before it (configuration -> database -> branding -> authentication -> backups -> modules -> privacy -> mail).
 */
export async function buildContext() {
  const appConfig = await config.loadConfig({ cwd: APP_ROOT });
  // Local backup paths are resolved against the application root ONCE, so the server, the scheduler, the CLI and
  // `doctor` see the same absolute path whatever directory the process was started from.
  appConfig.backup.destinations = scheduler.resolveDestinations(appConfig.backup.destinations, APP_ROOT);

  const dbFile = path.resolve(APP_ROOT, appConfig.database.file);
  const dataDir = path.dirname(dbFile);
  const inMemory = appConfig.database.file === ':memory:';

  const db = database.createSqliteAdapter({
    file: dbFile,
    walMode: appConfig.database.walMode,
    normalizeValues: appConfig.database.normalizeValues,
  });

  // The immutable identity of the application: name and logos from assets/brand (the administrator's own company
  // branding is a separate layer, edited in the admin panel under "Appearance").
  const vendorIdentity = branding.defineVendorIdentity({
    name: appConfig.appName,
    repoUrl: null,
    assetsDir: path.join(APP_ROOT, 'assets/brand'),
  });

  // First run: when no user exists, create an administrator with a temporary password. It goes to an owner-only
  // file next to the database and to the start banner (DAS_BOOTSTRAP_PRINT=false keeps it out of the console).
  const bootstrap = await auth.firstRunBootstrap(db, { argon2Options: appConfig.auth.argon2 });
  const credentialsFile = path.join(dataDir, 'first-run-admin.txt');
  let credentialsFileWritten = false;
  if (bootstrap.created) {
    try {
      auth.writeBootstrapCredentials(credentialsFile, bootstrap);
      credentialsFileWritten = true;
    } catch (err) {
      console.error(`[app] first run: administrator created but the credentials file could not be written (${err.message}); reset with "user reset-password ${bootstrap.username}"`); // eslint-disable-line no-console
    }
  }

  const sessionStore = auth.createSessionStore({
    db,
    ttlMs: appConfig.auth.sessionTtlMs,
    idleTimeoutMs: appConfig.auth.sessionIdleTimeoutMs,
    // a request still in flight must not re-create the session of a deleted or disabled user
    isUserActive: (id) => {
      const u = auth.findUserById(db, id);
      return Boolean(u) && !u.disabled;
    },
  });

  // Add legacy password schemes here (`legacySchemes: [...]`) when porting an application that already has users.
  const authProvider = auth.createAuthProvider({ db, argon2Options: appConfig.auth.argon2 });

  const uploadsDir = path.join(dataDir, 'uploads');
  // Held by the running server; `backup restore` refuses while it is held. None for an in-memory database.
  const serverLockFile = inMemory ? null : path.join(dataDir, '.server.lock');
  const runBackupJob = scheduler.createBackupJob({
    db,
    uploadsDir,
    dbFilePath: dbFile,
    destinations: appConfig.backup.destinations,
    retentionDays: appConfig.backup.retentionDays,
    encryptionKey: appConfig.backup.encryptionKey ?? null,
  });

  // Modules of the application (core/modules): navigation, field permissions, search, personal-data export.
  // Register your own with `moduleRegistry.registerModule(...)`; this template has none yet.
  const moduleRegistry = modules.createModuleRegistry();

  // Personal data (core/privacy): export and erase one person, bound once here so the CLI does not know the wiring.
  const exportUserData = (opts) =>
    privacy.exportUserData({ db, findUserByIdFn: auth.findUserById, moduleRegistry, auditLogFn: audit.log, auditQueryFn: audit.query, listAuthenticatorsFn: auth.listAuthenticators, ...opts });
  const erasureLedger = inMemory ? null : privacy.createErasureLedger(path.join(dataDir, '.erasures.jsonl'));
  let emailQueue = null; // created below; the closure reads it when an erase actually runs
  const eraseUserData = async (opts) => {
    const subject = auth.findUserById(db, opts.userId);
    if (subject?.email) emailQueue?.cancelForAddress(subject.email); // mail still waiting for this person must not go out
    return privacy.eraseUserData({
      db,
      findUserByIdFn: auth.findUserById,
      anonymizeUserFn: auth.anonymizeUser,
      deleteUserFn: auth.deleteUser,
      moduleRegistry,
      auditLogFn: audit.log,
      eraseAuditSubjectsFn: audit.eraseSubjects,
      erasureLedger,
      ...opts,
    });
  };
  // Who was erased lives in a small file next to the database, so a restore of an older backup erases them again.
  const reapplyErasures = () =>
    erasureLedger
      ? erasureLedger.reapply({ db, findUserByIdFn: auth.findUserById, erase: (o) => eraseUserData({ ...o, actor: 'system', erasureLedger: null }) })
      : Promise.resolve({ checked: 0, reapplied: [], skipped: 0 });

  // System mail: a disabled service (email.enabled = false) is a harmless no-op. When enabled, mail goes through a
  // persistent queue (stored first, sent in the background, retried, survives a restart); server.js runs the loop.
  let emailService;
  if (appConfig.email.enabled && appConfig.email.queue.enabled) {
    emailQueue = email.createEmailQueue({
      db,
      send: (mail) => emailService.sendRaw(mail),
      maxAttempts: appConfig.email.queue.maxAttempts,
      baseDelayMs: appConfig.email.queue.baseDelayMs,
      pendingTtlMs: appConfig.email.queue.pendingTtlHours * 3_600_000,
    });
  }
  emailService = email.createEmailService({ config: appConfig.email, brandName: appConfig.appName, queue: emailQueue });

  // TLS files default to data/certs (the schema's documented default for the 'self-signed' mode).
  const certDir = appConfig.server.https.certPath
    ? path.dirname(path.resolve(APP_ROOT, appConfig.server.https.certPath))
    : path.join(dataDir, 'certs');
  const certPath = appConfig.server.https.certPath
    ? path.resolve(APP_ROOT, appConfig.server.https.certPath)
    : certs.certFilePaths(certDir).certPath;

  return {
    appConfig,
    db,
    bootstrap,
    credentialsFile: credentialsFileWritten || (!bootstrap.created && fs.existsSync(credentialsFile)) ? credentialsFile : null,
    bans: security.createBans(db),
    dbFilePath: inMemory ? null : dbFile,
    vendorIdentity,
    authProvider,
    sessionStore,
    runBackupJob,
    moduleRegistry,
    exportUserData,
    eraseUserData,
    reapplyErasures,
    erasureLedger,
    emailService,
    emailQueue,
    certDir,
    certPath,
    uploadsDir,
    serverLockFile,
    migrationsDir: MIGRATIONS_DIR,
    // A consistent copy of the database is made here before pending migrations run (null for an in-memory database).
    preMigrateDir: appConfig.database.file === ':memory:' ? null : path.join(path.dirname(path.resolve(APP_ROOT, appConfig.database.file)), 'pre-migrate'),
    repoRoot: APP_ROOT,
  };
}
