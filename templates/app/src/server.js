import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

import express from 'express';
import cookieParser from 'cookie-parser';

import { CORE_VERSION, http, auth, audit, scheduler as schedulerModule, database as databaseModule, health, certs, logs, ui as uiModule, admin as adminModule, branding, maintenance as maintenanceModule, announcement as announcementModule, observability, privacy, policy as policyModule, security as securityModule, cli as cliModule } from '@das-forge/core';
import { buildContext, buildAlerts } from './context.js';
import { formatStartBanner } from './banner.js';
import { buildDoctorCategories } from './doctor-categories.js';
import { registerRoutes } from './routes.js';
import { permissionsForRole } from './roles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
const APP_NAME = 'My App';


/**
 * Builds the Express application from an already built context: no listening, no scheduler, no signal handlers.
 * Exported so a test can run the REAL middleware stack on an ephemeral port.
 *
 * The order of the middleware is deliberate:
 *   requestId        first, so even a body-parse error carries an id
 *   locale           ?lang=ru|en, remembered in a cookie, read by every page
 *   errorResponder   guards answer browsers with a branded page and API clients with JSON
 *   securityHeaders  CSP nonce and headers on every response, errors included
 *   cors, cookies, CSRF   before any body parsing or handler can act on a forged request
 *   json             honours server.bodyLimit
 *   session, attachUser   the ONLY place req.user is set (requireAuth() blocks on individual routes)
 *   bans             after the session is attached, so a banned user is recognised
 *   /health          before the rate limiter: a probe must never be throttled
 *   rate limiter     general per-address budget for everything after it
 *   routes, policies, admin panel, 404 and error pages LAST
 */
export function createApp(ctx) {
  const { appConfig, db, vendorIdentity, authProvider, runBackupJob, moduleRegistry } = ctx;
  const logger = ctx.logger ?? logs.createLogger({ level: 'silent' }); // silent unless the caller passes one (tests)
  const { server: serverConfig, security } = appConfig;

  const app = express();
  http.applyServerSettings(app, serverConfig);

  app.use(http.requestId());
  // With server.admin.port set, the administration panel is served only on its own listener; elsewhere it answers 404.
  const adminListener = http.resolveAdminListener(serverConfig);
  if (adminListener) app.use(http.adminGate({ port: adminListener.port }));
  // The brand block (the administrator's name and logo, else the app's own) shown on every page, read per request.
  const brand = () => branding.brandBlockHtml(db, vendorIdentity);
  app.use(uiModule.localeMiddleware());
  // Policy pages and the cookie notice (texts editable in /admin/policy); inserted into pages via res.locals.pageEnd.
  const policy = policyModule.createPolicy({
    db,
    appName: APP_NAME,
    dependencySources: [
      { packageJsonPath: path.resolve(__dirname, '../package.json'), nodeModulesDir: [path.resolve(__dirname, '../node_modules')] },
    ],
  });
  app.use((req, res, next) => { res.locals.pageEnd = (locale) => policy.pageEnd(req, res, locale); next(); });
  // The announcement banner (admin panel -> Announcement) is put above the page header by the shell below via res.locals.banner.
  const announcement = announcementModule.createAnnouncement({ db });
  app.use((req, res, next) => { res.locals.banner = (locale) => announcement.bannerHtml(locale, { nonce: res.locals?.cspNonce }); next(); });
  app.use(http.errorResponder(vendorIdentity, { loginUrl: '/login', brand, bodyEnd: (req, res, locale) => policy.pageEnd(req, res, locale) }));
  // Hourly request and error counters for the admin charts, flushed to the database in batches.
  // Prometheus metrics (observability.metrics.enabled): needs the package "@prometheus-io/client"; off by default.
  const promConfig = appConfig.observability?.metrics;
  const prom = ctx.prom ?? null; // made by the entry point (it needs an await), null when metrics are off
  if (prom) {
    observability.registerCoreGauges(prom, {
      db, mailQueue: ctx.emailQueue,
      lastBackupAt: () => schedulerModule.listBackups(appConfig.backup.destinations ?? []).filter((b) => b.createdAt).map((b) => new Date(b.createdAt).getTime()).sort((a, b) => b - a)[0] ?? null,
    });
    app.use(prom.middleware());
  }
  const metrics = adminModule.createMetrics(db);
  app.use(metrics.middleware());
  app.use(logs.accessLog(logger, { skip: (req) => req.path === '/health', ipMode: 'truncate' }));
  app.use(http.securityHeaders({ reportOnly: security.csp?.reportOnly ? { reportUri: (security.csp?.reportPath ?? '/csp-report') } : false }));
  app.use(http.createCompression());
  app.use(http.createCors({ origins: security.cors.origins })); // empty list = no CORS headers at all
  app.use(cookieParser());
  if (security.csrf) app.use(http.csrfProtection({ trustProxy: serverConfig.trustProxy, trustedOrigins: security.cors.origins, exemptPaths: [(security.csp?.reportPath ?? '/csp-report')], sessionCookieName: http.sessionCookieName({ hostPrefix: appConfig.auth.hostCookiePrefix }) }));
  // Violation reports of the report-only policy (security.csp?.reportOnly): answered before any body parsing, written to the audit log.
  if (security.csp?.reportOnly) {
    app.post((security.csp?.reportPath ?? '/csp-report'), http.cspReports({ onReport: (r, req) => { try { audit.log(db, { actor: null, action: 'security.csp_violation', entity: 'csp', result: 'failure', meta: r, requestId: req.id, ip: req.ip }); } catch { /* a failing log must not break the report */ } } }));
  }
  // The scrape endpoint answers before sessions and body parsing; 404 for anyone who is not allowed (token or address).
  if (prom) app.get(promConfig.path, prom.handler({ token: promConfig.token, allowIps: promConfig.allowIps }));
  app.use(express.json({ limit: serverConfig.bodyLimit }));

  const sessionStore = ctx.sessionStore ?? auth.createSessionStore({ db, ttlMs: appConfig.auth.sessionTtlMs, idleTimeoutMs: appConfig.auth.sessionIdleTimeoutMs });
  app.use(http.createSessionMiddleware({
    store: sessionStore,
    // previous secrets only verify, so rotating the secret does not sign everyone out
    secret: [appConfig.auth.sessionSecret, ...(appConfig.auth.previousSessionSecrets ?? [])],
    ttlMs: appConfig.auth.sessionTtlMs,
    cookieName: http.sessionCookieName({ hostPrefix: appConfig.auth.hostCookiePrefix }),
  }));
  // The role and the disabled flag are re-read (cached 30 s), so a missed revocation cannot keep old rights alive.
  app.use(http.attachUser({
    revalidate: (id, snapshot) => {
      const u = auth.findUserById(db, id);
      if (!u || u.disabled) return null;
      return u.role === snapshot.role ? snapshot : { ...snapshot, role: u.role, permissions: permissionsForRole(u.role) };
    },
  }));
  const bans = ctx.bans ?? securityModule.createBans(db);
  app.use(bans.middleware());
  // Maintenance mode (admin panel -> Maintenance): visitors get the 503 page, administrators and sign-in pass.
  const maintenance = maintenanceModule.createMaintenance({ db });
  app.use(maintenance.middleware({ vendorIdentity, brand, bodyEnd: (req, res, locale) => policy.pageEnd(req, res, locale) }));

  // Unauthenticated on purpose: a load balancer has no session, and this must answer even when authentication is
  // the thing that is broken. `isShuttingDown` flips the probe to 503 as soon as the shutdown starts.
  app.use(http.securityTxt(security.securityTxt)); // public; nothing is served until a contact is configured
  app.get('/health', health.healthHandler(db, { version: PACKAGE.version, minimal: true, isShuttingDown: ctx.isShuttingDown }));
  app.use(http.createRateLimiter(security.rateLimit));

  registerRoutes(app, { db, authProvider, bans, appConfig, moduleRegistry, onLock: ctx.onLock ?? null, vendorIdentity, emailService: ctx.emailService, logger });
  policy.mount(app);

  // The admin panel: sign-in and the `admin.access` permission are required. Which sections it has, and which you
  // switch off or add, is described in the "Administration" guide.
  adminModule.createAdmin({
    incidents: privacy.createIncidentRegister(db),
    processingRegistry: () => privacy.buildProcessingRegistry({ moduleRegistry: ctx.moduleRegistry, config: ctx.appConfig }),
    maintenance, announcement, vendorIdentity,
    db, metrics, bans, policy,
    scheduler: ctx.schedulerHolder ? { listJobs: () => ctx.schedulerHolder.current?.listJobs() ?? [], runNow: (n) => ctx.schedulerHolder.current.runNow(n) } : null,
    taskSchedules: ctx.schedulerHolder ? { set: (n, v) => ctx.schedulerHolder.taskSchedules.set(n, v), reset: (n) => ctx.schedulerHolder.taskSchedules.reset(n), isOverridden: (n) => ctx.schedulerHolder.taskSchedules?.isOverridden(n) ?? false } : null,
    passwordPolicy: auth.createPasswordPolicy({ db, config: appConfig.auth.passwordPolicy, blocklistFile: appConfig.auth.passwordBlocklistFile, appName: APP_NAME }),
    managedTasks: { backup: 'backups', 'alerts-doctor': 'about' },
    mail: ctx.emailQueue ? { queue: ctx.emailQueue, service: ctx.emailService } : null,
    config: appConfig,
    migrations: ctx.migrationsDir ? () => cliModule.migrationStatus(db, ctx.migrationsDir) : null,
    alerts: ctx.alerts ?? null, alertsMail: ctx.alertsMail ?? false,
    appearance: { uploadsDir: ctx.uploadsDir, fallbackName: APP_NAME },
    logDestination: ctx.logDestination,
    backups: {
      list: () => schedulerModule.listBackups(appConfig.backup.destinations ?? []),
      run: runBackupJob,
      verify: (file) => schedulerModule.verifyBackupFile(databaseModule.createSqliteAdapter, file, { encryptionKey: appConfig.backup?.encryptionKey ?? null }),
      schedule: { get: () => ctx.schedulerHolder?.backupSchedule?.get() ?? { enabled: false, schedule: null, time: null, nextRun: null }, set: (v) => ctx.schedulerHolder.backupSchedule.set(v) },
      info: { retentionDays: appConfig.backup.retentionDays, destinations: (appConfig.backup.destinations ?? []).map((d) => d.id) },
    },
    about: {
      packageJsonPath: path.resolve(__dirname, '../package.json'),
      nodeModulesDir: [path.resolve(__dirname, '../node_modules')],
      appName: PACKAGE.name, appVersion: PACKAGE.version,
      health: () => health.checkHealth(db, { version: PACKAGE.version }),
      doctor: () => health.runDoctor(buildDoctorCategories(ctx, () => db, { inProcess: true, logger })),
      doctorSchedule: { get: () => ctx.schedulerHolder?.doctorSchedule?.get() ?? { enabled: false, schedule: null, time: null, nextRun: null }, set: (v) => ctx.schedulerHolder.doctorSchedule.set(v) },
    },
    dbFilePath: ctx.dbFilePath,
  }).mount(app, { requireAuth: http.requireAuth, requirePermission: http.requirePermission });

  // Branded 404 and 500: registered LAST, after every real route.
  app.use(http.notFoundHandler(vendorIdentity, { loginUrl: '/login', brand, bodyEnd: (req, res, locale) => policy.pageEnd(req, res, locale) }));
  app.use(http.errorPageHandler(vendorIdentity, { logger, loginUrl: '/login', brand, bodyEnd: (req, res, locale) => policy.pageEnd(req, res, locale) }));

  return { app, metrics };
}

async function main() {
  const ctx = await buildContext();
  const { appConfig, db, runBackupJob, migrationsDir, certDir } = ctx;

  // One server per database; `backup restore` refuses while it runs. A crashed server's lock is recognised as dead.
  const releaseServerLock = ctx.serverLockFile ? schedulerModule.acquireFileLock(ctx.serverLockFile, { staleMs: Infinity, takeOverSelf: true }) : null;
  if (ctx.serverLockFile && !releaseServerLock) {
    console.error(`[app] another server (or a restore) holds ${ctx.serverLockFile} - not starting`); // eslint-disable-line no-console
    process.exit(1);
  }

  // Migrate on boot: a fresh database must not answer 500 for a table that only exists after `migrate`.
  const migrationResult = await cliModule.runMigrations(db, migrationsDir);
  if (migrationResult.applied.length > 0) console.log(`[app] applied ${migrationResult.applied.length} migration(s): ${migrationResult.applied.map((m) => m.name).join(', ')}`); // eslint-disable-line no-console

  // logging.sinks: where log lines go (stdout, a file on another disk, syslog, HTTP). Point one sink off this machine.
  const logDestination = appConfig.logging.sinks.length > 0
    ? logs.createLogDestination({ sinks: appConfig.logging.sinks, buffer: appConfig.logging.buffer, localFallback: appConfig.logging.localFallback, appName: PACKAGE.name })
    : null;
  const logger = logs.createLogger({
    level: appConfig.logLevel ?? 'info',
    base: { app: PACKAGE.name },
    stream: logDestination ?? undefined,
    pretty: appConfig.env !== 'production' && Boolean(process.stdout.isTTY),
  });
  // A copy of the audit trail in the log stream: what an intruder deletes from the database still exists remotely.
  const stopAuditMirror = logs.mirrorAuditToLogs(audit.onEntry, logger, { mode: appConfig.logging.auditMirror });
  let lifecycle = null;
  // A restored older backup may hold people who were erased since: erase them again before serving.
  const reErased = await ctx.reapplyErasures();
  if (reErased.reapplied.length > 0) logger.warn('re-applied erasures after a restore', { count: reErased.reapplied.length });

  const alertSet = buildAlerts(ctx, logger);
  const schedulerHolder = { current: null }; // the scheduler is created after the app; the admin "Tasks" section reads it through this
  const promSettings = appConfig.observability?.metrics;
  const prom = promSettings?.enabled ? await observability.createPrometheusMetrics({ defaultMetrics: promSettings.defaultMetrics }) : null;
  const { app, metrics } = createApp({
    prom,
    ...ctx, schedulerHolder, logger, logDestination,
    alerts: alertSet?.alerts ?? null, alertsMail: alertSet?.mailConfigured ?? false, onLock: alertSet?.onLock ?? null,
    isShuttingDown: () => lifecycle?.isShuttingDown() ?? false,
  });

  // HTTPS only. 'self-signed' (the default) creates a certificate in data/certs on first start; 'standalone' reads
  // server.https.certPath/keyPath; 'reverse-proxy' stays plain HTTP behind your TLS proxy (needs server.trustProxy).
  const tls = await http.loadOrCreateTls({ serverConfig: appConfig.server, certDir, certs });
  const server = http.createHttpServer(app, { serverConfig: appConfig.server, tls });
  const { host, port } = appConfig.server;
  await http.listenServer(server, { host, port });
  // The administration panel's own listener (server.admin.port): the same application and certificate on another address and port.
  const adminAddress = http.resolveAdminListener(appConfig.server);
  let adminListeners = null;
  if (adminAddress) {
    adminListeners = await http.listenAdmin({
      createServer: () => http.createHttpServer(app, { serverConfig: appConfig.server, tls }),
      address: adminAddress,
      onSkip: (h, err) => console.warn(`[app] administration panel: not listening on ${h} (${err.code ?? err.message})`), // eslint-disable-line no-console
    });
    // eslint-disable-next-line no-console
    console.log(`[app] administration panel on ${tls ? 'https' : 'http'}://${adminAddress.host}:${adminAddress.port} (${adminListeners.bound.map((b) => b.host).join(', ')}) only; the application's address answers 404 for it`);
  }
  const scheme = tls ? 'https' : 'http';
  // Platform convention: HTTPS on 9N02 and a plain-HTTP port 9N01 that only redirects to it.
  const redirectPort = tls ? http.resolveRedirectPort(appConfig.server) : false;
  let redirectServer = null;
  if (redirectPort) {
    redirectServer = http.createHttpRedirectServer({
      httpsPort: port,
      canonicalHost: host === '0.0.0.0' || host === '::' ? 'localhost' : host,
      onRedirect: ({ ip, method, path: hitPath, count, refused }) =>
        logger.warn('plain http request redirected to https', { stream: 'security', ip: logs.anonymizeIp(ip, 'truncate'), method, path: hitPath, hits: count, refused }),
      allowedHosts: [...appConfig.server.allowedHosts, ...(appConfig.email.baseUrl ? [new URL(appConfig.email.baseUrl).hostname] : [])],
    });
    await http.listenServer(redirectServer, { host, port: redirectPort });
    console.log(`[app] http://${host}:${redirectPort} redirects to ${scheme}://${host}:${port}`); // eslint-disable-line no-console
  }
  const shownHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  console.log(`\n${formatStartBanner({ name: APP_NAME, appVersion: PACKAGE.version, coreVersion: CORE_VERSION, url: `${scheme}://${shownHost}:${port}`, adminUrls: adminAddress ? [...new Set([`${scheme}://localhost:${adminAddress.port}`, `${scheme}://${adminAddress.host}:${adminAddress.port}`])] : null, bootstrap: ctx.bootstrap, credentialsFile: ctx.credentialsFile, showPassword: process.env.DAS_BOOTSTRAP_PRINT !== 'false' })}\n`); // eslint-disable-line no-console

  // Scheduled jobs. lockDir: the server and the CLI never run the same job at once; catchUp: a backup missed while
  // the server was down runs once at the next start.
  const jobScheduler = schedulerModule.createScheduler({
    lockDir: path.resolve(path.dirname(path.resolve(ctx.repoRoot, appConfig.database.file)), '.locks'),
    lastRunStore: schedulerModule.createDbLastRunStore(db),
    onError: alertSet?.alerts.onJobError,
  });
  schedulerHolder.current = jobScheduler;
  // The backup job: switched on/off and moved in the admin panel (Backups); until then the configuration decides.
  schedulerHolder.backupSchedule = schedulerModule.createScheduleSetting({
    db, scheduler: jobScheduler, key: 'backup', jobName: 'backup', handler: runBackupJob,
    defaults: { enabled: appConfig.backup.enabled, schedule: appConfig.backup.schedule },
    registerOptions: { catchUp: true },
  });
  schedulerHolder.backupSchedule.apply();
  if (appConfig.logging.auditAnchorSchedule && appConfig.logging.auditMirror !== 'off') {
    jobScheduler.registerJob('audit-anchor', appConfig.logging.auditAnchorSchedule, () => { logs.logAuditAnchor(audit.anchor, db, logger); });
  }
  // Periodic diagnostics (failed checks) and audit-chain verification raise alerts; old alerts are purged.
  const doctorRun = () => health.runDoctor(buildDoctorCategories(ctx, () => db, { inProcess: true, logger }));
  alertSet?.alerts.watch(jobScheduler, {
    doctor: doctorRun,
    doctorSchedule: false, // registered below, so that the administrator can switch it off or move it
    auditSchedule: appConfig.alerts.auditSchedule,
  });
  if (alertSet) {
    schedulerHolder.doctorSchedule = schedulerModule.createScheduleSetting({
      db, scheduler: jobScheduler, key: 'doctor', jobName: 'alerts-doctor',
      handler: () => alertSet.alerts.checkDoctor(doctorRun),
      defaults: { enabled: appConfig.alerts.doctorSchedule !== false, schedule: appConfig.alerts.doctorSchedule || null },
    });
    schedulerHolder.doctorSchedule.apply();
  }
  // Standard housekeeping in one call: sessions, audit rows, bans, metrics, spent tokens, finished mail.
  schedulerModule.registerStandardJobs(jobScheduler, {
    db, logger, sessionStore: ctx.sessionStore, bans: ctx.bans, metrics, emailQueue: ctx.emailQueue,
    auditRetentionDays: appConfig.audit.retentionDays, auditPurgeBatchSize: appConfig.audit.purgeBatchSize,
    mailKeepFinishedDays: appConfig.email.queue.keepFinishedDays,
  });
  ctx.emailQueue?.start({ intervalMs: appConfig.email.queue.intervalMs });
  // Schedules the administrator changed in the "Tasks" section; after every job is registered, before the start.
  schedulerHolder.taskSchedules = schedulerModule.createTaskSchedules({ db, scheduler: jobScheduler });
  schedulerHolder.taskSchedules.apply();
  jobScheduler.start();

  lifecycle = http.registerGracefulShutdown(server, {
    drainTimeoutMs: appConfig.server.shutdownDrainTimeoutMs,
    // add `onDrainStart: () => realtime.closeAllSseStreams()` when the application opens event streams
    onShutdown: async () => {
      await new Promise((resolve) => (redirectServer ? redirectServer.close(() => resolve()) : resolve()));
      await new Promise((resolve) => (adminListeners ? adminListeners.close().then(resolve) : resolve()));
      ctx.emailQueue?.stop();
      await jobScheduler.stop(); // waits for a running backup before the database goes away
      stopAuditMirror();
      metrics.close();
      db.close();
      releaseServerLock?.();
      await logDestination?.close(); // last chance to deliver buffered log lines
    },
  });
  http.registerFatalHandlers(lifecycle, { logger });
}

// Start listening only when run as the entry point (`npm start`), not when a test imports createApp().
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error('[app] fatal startup error:', err); // eslint-disable-line no-console
    process.exit(1);
  });
}
