import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config, ldap, database, branding, auth, scheduler, modules, audit, privacy, certs, email, security, alerts as alertsModule, notifications as notificationsModule } from '@das-forge/core';
import { createReportingModule } from './modules/reporting-module.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.resolve(REPO_ROOT, 'migrations');

/**
 * Alerts for the server process (null when `alerts.enabled` is false): stored in the database, written to the
 * log and mailed to `security.incidentContacts`. Built in server.js once the logger exists.
 */
export function buildAlerts(ctx, logger) {
  const cfg = ctx.appConfig.alerts;
  if (!cfg.enabled) return null;
  const contacts = ctx.appConfig.security.incidentContacts;
  // every new alert also reaches the administrators' bell (each can tune it: account -> notifications)
  const bell = notificationsModule.createNotifications({ db: ctx.db });
  const alerts = alertsModule.createAlerts({
    db: ctx.db,
    onRaised: (a) => bell.notifyRole('admin', { title: a.title, body: a.message, severity: a.severity, link: '/admin/alerts', category: /lock|ban|auth|login|security/i.test(a.key) ? 'security' : 'system' }),
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
 * Builds everything both the HTTP server (server.js) and the CLI
 * (bin/app.js) need, in one place - so "how does an app wire up the
 * core" has exactly one answer, not two slightly-different ones.
 *
 * This is the wiring pattern every real app (procure-it, atlas-ao,
 * net-monitor, it-assets) is expected to follow when porting onto
 * DAS-Forge: config → database → branding → auth, in that order,
 * because each later step needs the config/db the earlier ones produced.
 */
export async function buildContext() {
  // `ldap` is the workshop's own optional setting (the core's LdapConfigSchema); absent = local passwords only.
  const configSources = {};
  const appConfig = await config.loadConfig({ cwd: REPO_ROOT, report: configSources, schema: config.ApplicationConfigSchema.extend({ ldap: ldap.LdapConfigSchema.optional() }) });
  // Browser tests open dozens of pages from one address within seconds; the general request limit would answer 429.
  // Only the throw-away e2e server sets this (e2e/start.js), never a real run.
  if (process.env.DAS_E2E === '1') appConfig.security.rateLimit.max = 100_000;
  // Resolve local backup paths against the app root ONCE, here, so every
  // consumer (server, scheduler, CLI list/restore, doctor) sees the same
  // absolute path no matter which directory the process was started from.
  appConfig.backup.destinations = scheduler.resolveDestinations(appConfig.backup.destinations, REPO_ROOT);

  const db = database.createSqliteAdapter({
    file: path.resolve(REPO_ROOT, appConfig.database.file),
    walMode: appConfig.database.walMode,
    normalizeValues: appConfig.database.normalizeValues,
  });

  const vendorIdentity = branding.defineVendorIdentity({
    name: appConfig.appName,
    repoUrl: null, // this example app has no public repo of its own
    assetsDir: path.join(REPO_ROOT, 'assets/brand'),
  });

  // First-run bootstrap: no-op if a user already exists. The temp password goes to an owner-only
  // file next to the database AND to the start-up banner (server.js, banner.js);
  // DAS_BOOTSTRAP_PRINT=false keeps it out of the console.
  const bootstrapResult = await auth.firstRunBootstrap(db, { argon2Options: appConfig.auth.argon2 });
  const credentialsFile = path.resolve(path.dirname(path.resolve(REPO_ROOT, appConfig.database.file)), 'first-run-admin.txt');
  let credentialsFileWritten = false;
  if (bootstrapResult.created) {
    try {
      auth.writeBootstrapCredentials(credentialsFile, bootstrapResult);
      credentialsFileWritten = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[workshop] first run: admin created but credentials file could not be written (${err.message}); reset with "app user reset-password ${bootstrapResult.username}"`);
    }
  }

  const sessionStore = auth.createSessionStore({
    db,
    ttlMs: appConfig.auth.sessionTtlMs,
    idleTimeoutMs: appConfig.auth.sessionIdleTimeoutMs,
    // K04: a request still in flight cannot re-create the session of a deleted/disabled user
    isUserActive: (id) => {
      const u = auth.findUserById(db, id);
      return Boolean(u) && !u.disabled;
    },
  });

  const authProvider = auth.createAuthProvider({
    db,
    argon2Options: appConfig.auth.argon2,
    // Real apps being ported add their documented legacy scheme(s) here,
    // e.g. legacySchemes: [pbkdf2Scheme({...})] - none needed for a
    // brand-new example app with no existing user base to migrate.
  });

  const uploadsDir = path.join(path.dirname(path.resolve(REPO_ROOT, appConfig.database.file)), 'uploads');
  // Held by the running server; `backup restore` refuses while it is held (audit G02). None for :memory:.
  const serverLockFile = appConfig.database.file === ':memory:' ? null : path.join(path.dirname(path.resolve(REPO_ROOT, appConfig.database.file)), '.server.lock');
  const runBackupJob = scheduler.createBackupJob({
    db,
    uploadsDir,
    dbFilePath: path.resolve(REPO_ROOT, appConfig.database.file),
    destinations: appConfig.backup.destinations,
    retentionDays: appConfig.backup.retentionDays,
    encryptionKey: appConfig.backup.encryptionKey ?? null,
  });

  // The Module contract (§1/§7.5, see core/modules): this is the ONE
  // place in the app that knows both "core" and "which modules this
  // app uses" at once - core/http and core/cli never import
  // reportingModule directly, they only see what the registry exposes
  // after registerModule() runs.
  const moduleRegistry = modules.createModuleRegistry();
  moduleRegistry.registerModule(createReportingModule({ db, findUserByIdFn: auth.findUserById, auditQueryFn: audit.query }));

  // core/privacy (§4.5k): pre-bound to this app's db/moduleRegistry/
  // audit so bin/app.js's CLI commands don't need to know any of that
  // wiring themselves - same "bind once in context.js" pattern as
  // runBackupJob above.
  const exportUserData = (opts) =>
    privacy.exportUserData({ db, findUserByIdFn: auth.findUserById, moduleRegistry, auditLogFn: audit.log, auditQueryFn: audit.query, listAuthenticatorsFn: auth.listAuthenticators, ...opts });
  const erasureLedger = appConfig.database.file === ':memory:' ? null : privacy.createErasureLedger(path.join(path.dirname(path.resolve(REPO_ROOT, appConfig.database.file)), '.erasures.jsonl'));
  // The queue is created below; the closure reads it when an erase actually runs.
  const eraseUserData = async (opts) => {
    // Mail still waiting for this person must not go out after the erase (audit F05).
    const subject = auth.findUserById(db, opts.userId);
    if (subject?.email) emailQueue?.cancelForAddress(subject.email);
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
  // Audit F08: who was erased lives in a small file next to the database, so a restore of an older
  // backup can erase them again (run at server start and by `privacy reapply-erasures`).
  const reapplyErasures = () =>
    erasureLedger
      ? erasureLedger.reapply({ db, findUserByIdFn: auth.findUserById, erase: (o) => eraseUserData({ ...o, actor: 'system', erasureLedger: null }) })
      : Promise.resolve({ checked: 0, reapplied: [], skipped: 0 });

  // System mail: a disabled service (email.enabled=false) is a harmless no-op.
  // With e-mail enabled, mails go through the persistent queue (stored first, sent in the
  // background, retried, survive a restart); server.js runs the queue loop.
  let emailService;
  let emailQueue = null;
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

  // §4.5f: certPath/keyPath default to data/certs/{cert,key}.pem when
  // app.config.js doesn't set server.https.certPath/keyPath explicitly
  // (the config schema's own documented default for 'self-signed' mode).
  const certDir = appConfig.server.https.certPath
    ? path.dirname(path.resolve(REPO_ROOT, appConfig.server.https.certPath))
    : path.join(path.dirname(path.resolve(REPO_ROOT, appConfig.database.file)), 'certs');
  const certPath = appConfig.server.https.certPath
    ? path.resolve(REPO_ROOT, appConfig.server.https.certPath)
    : certs.certFilePaths(certDir).certPath;

  // Stage C (Demo Records, §0.3): where POST /assets/:id/logo stores
  // uploaded files - same "derive from database.file's directory"
  // pattern as certDir above, not a separate config field, since this
  // example has no other reason yet to ask the operator to configure
  // storage locations independently.

  return {
    appConfig,
    configSources,
    db,
    bootstrap: bootstrapResult,
    credentialsFile: credentialsFileWritten || (!bootstrapResult.created && fs.existsSync(credentialsFile)) ? credentialsFile : null,
    bans: security.createBans(db),
    dbFilePath: appConfig.database.file === ':memory:' ? null : path.resolve(REPO_ROOT, appConfig.database.file),
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
    preMigrateDir: appConfig.database.file === ':memory:' ? null : path.join(path.dirname(path.resolve(REPO_ROOT, appConfig.database.file)), 'pre-migrate'),
    repoRoot: REPO_ROOT,
  };
}
