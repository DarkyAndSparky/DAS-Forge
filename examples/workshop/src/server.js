import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

import express from 'express';
import cookieParser from 'cookie-parser';

import { CORE_VERSION, http, auth, audit, files, realtime, scheduler as schedulerModule, database as databaseModule, health, certs, logs, ui as uiModule, admin as adminModule, branding, maintenance as maintenanceModule, announcement as announcementModule, observability, privacy, policy as policyModule, security as securityModule, cli as cliModule, accounts as accountsModule, about as aboutModule, liveConsole } from '@das-forge/core';
import { buildContext, buildAlerts } from './context.js';
import { formatStartBanner } from './banner.js';
import { buildDoctorCategories } from './doctor-categories.js';
import { registerRoutes, permissionsForRole } from './routes.js';
import { ROLES, ADMIN_ROLE } from './roles.js';
import { seedAssetsIfEmpty } from './records.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_VERSION = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')).version;

/**
 * Builds the Express app from an already-built context - NO listening,
 * no scheduler, no signal handlers. Exported so a test can boot the
 * REAL middleware stack (real Express, real cookie-parser, real body
 * parsing) on an ephemeral port instead of the hand-written fake app in
 * routes.test.js (audit D01).
 *
 * Middleware order matters and is deliberate:
 *   requestId        first, so even a body-parse error carries an id
 *   securityHeaders  CSP nonce + headers on every response, errors included
 *   createCompression gzip/br for compressible bodies; SSE is never compressed
 *   createCors       exact-origin allow-list; preflight answered before CSRF
 *   cookieParser     CSRF's last-resort check reads req.cookies
 *   csrfProtection   before any body parsing / handler can act on a forged request
 *   express.json     honours server.bodyLimit (default was 100kb, ignoring config)
 *   session           express-session (signed cookie, SQLite store) -> req.session
 *   attachUser        the ONLY place req.user is set (from req.session.user)
 *   /health          before the rate limiter: a probe must never be throttled
 *   rate limiter     general per-IP budget for everything after it
 */
export function createApp(ctx) {
  const { appConfig, db, vendorIdentity, authProvider, runBackupJob, moduleRegistry, uploadsDir, migrationsDir } = ctx;
  // Silent unless the caller passes a logger (tests), so the suite stays quiet.
  const logger = ctx.logger ?? logs.createLogger({ level: 'silent' });
  const { server: serverConfig, security } = appConfig;

  const eventBus = realtime.createEventBus();

  const app = express();
  http.applyServerSettings(app, serverConfig);

  app.use(http.requestId());
  // With server.admin.port set, the administration panel is served only on its own listener; elsewhere it answers 404.
  const adminListener = http.resolveAdminListener(serverConfig);
  if (adminListener) app.use(http.adminGate({ port: adminListener.port }));
  // The brand block (the administrator's name and logo, else the app's own) shown on every page, read per request.
  const brand = () => branding.brandBlockHtml(db, vendorIdentity);
  // One interface language everywhere: ?lang=ru|en is remembered in a cookie and read by every page.
  app.use(uiModule.localeMiddleware());
  // Policy pages + cookie notice (texts editable in /admin/policy); the notice/footer are inserted into pages via res.locals.pageEnd.
  const policy = policyModule.createPolicy({
    db,
    appName: 'Workshop',
    dependencySources: [
      { packageJsonPath: path.resolve(__dirname, '../../../packages/core/package.json'), nodeModulesDir: [path.resolve(__dirname, '../../../node_modules'), path.resolve(__dirname, '../../../packages/core/node_modules')] },
      { packageJsonPath: path.resolve(__dirname, '../package.json'), nodeModulesDir: [path.resolve(__dirname, '../node_modules'), path.resolve(__dirname, '../../../node_modules')] },
    ],
  });
  app.use((req, res, next) => { res.locals.pageEnd = (locale) => policy.pageEnd(req, res, locale); next(); });
  // Public "About" page; the "Powered by DAS-Forge" line of every page leads here. The author is taken from the repository owner: change it here.
  aboutModule.mountAboutPage(app, {
    appName: 'Workshop', appVersion: PACKAGE_VERSION, licenseUrl: '/policy/license', author: { name: 'DarkyAndSparky', url: 'https://github.com/DarkyAndSparky' },
    apps: [{ name: 'Workshop', version: PACKAGE_VERSION, description: 'Reference application of the platform' }],
  });
  // The announcement banner (admin panel -> Announcement) is put above the page header by the shell below via res.locals.banner.
  const announcement = announcementModule.createAnnouncement({ db });
  app.use((req, res, next) => { res.locals.banner = (locale) => announcement.bannerHtml(locale, { nonce: res.locals?.cspNonce }); next(); });
  // Guards (auth, CSRF, rate limit, validation, bans) answer browsers with the branded page, API clients with JSON.
  app.use(http.errorResponder(vendorIdentity, { loginUrl: '/login', brand, bodyEnd: (req, res, locale) => policy.pageEnd(req, res, locale) }));
  // Hourly request/error counters for the admin charts (flushed to the DB in batches).
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
  // Allow-list from security.cors.origins; empty list = no CORS headers at all.
  // Before CSRF so a preflight (OPTIONS, no cookies) is answered, not rejected.
  app.use(http.createCors({ origins: security.cors.origins }));
  app.use(cookieParser());
  if (security.csrf) {
    app.use(
      http.csrfProtection({
        trustProxy: serverConfig.trustProxy,
        trustedOrigins: security.cors.origins,
        exemptPaths: [(security.csp?.reportPath ?? '/csp-report')],
        sessionCookieName: http.sessionCookieName({ hostPrefix: appConfig.auth.hostCookiePrefix }),
      })
    );
  }
  // Violation reports of the report-only policy (security.csp?.reportOnly): answered before any body parsing, written to the audit log.
  if (security.csp?.reportOnly) {
    app.post((security.csp?.reportPath ?? '/csp-report'), http.cspReports({ onReport: (r, req) => { try { audit.log(db, { actor: null, action: 'security.csp_violation', entity: 'csp', result: 'failure', meta: r, requestId: req.id, ip: req.ip }); } catch { /* a failing log must not break the report */ } } }));
  }
  // The scrape endpoint answers before sessions and body parsing; 404 for anyone who is not allowed (token or address).
  if (prom) app.get(promConfig.path, prom.handler({ token: promConfig.token, allowIps: promConfig.allowIps }));
  app.use(express.json({ limit: serverConfig.bodyLimit }));
  // The session middleware and attachUser run globally - attachUser is the ONLY
  // place req.user gets set, but it doesn't block unauthenticated requests itself
  // (that's requireAuth()'s job on individual routes), so public routes still work.
  // The cookie is signed with a key derived from auth.sessionSecret; previous
  // secrets only verify, so rotating the secret does not log anyone out.
  const sessionStore =
    ctx.sessionStore ??
    auth.createSessionStore({ db, ttlMs: appConfig.auth.sessionTtlMs, idleTimeoutMs: appConfig.auth.sessionIdleTimeoutMs });
  app.use(
    http.createSessionMiddleware({
      store: sessionStore,
      secret: [appConfig.auth.sessionSecret, ...(appConfig.auth.previousSessionSecrets ?? [])],
      ttlMs: appConfig.auth.sessionTtlMs,
      cookieName: http.sessionCookieName({ hostPrefix: appConfig.auth.hostCookiePrefix }),
    })
  );
  // K05: role and disabled flag are re-read (cached 30 s), so a missed revocation cannot keep old rights
  app.use(
    http.attachUser({
      revalidate: (id, snapshot) => {
        const u = auth.findUserById(db, id);
        if (!u || u.disabled) return null;
        return u.role === snapshot.role ? snapshot : { ...snapshot, role: u.role, permissions: permissionsForRole(u.role) };
      },
    })
  );
  // Banned IPs / users are stopped here, after the session is attached so a banned user is recognised.
  const bans = ctx.bans ?? securityModule.createBans(db);
  app.use(bans.middleware());
  // Maintenance mode (admin panel -> Maintenance): visitors get the 503 page, administrators and sign-in pass.
  const maintenance = maintenanceModule.createMaintenance({ db });
  if (prom) observability.registerCoreGauges(prom, { maintenance }); // only the maintenance gauge: the other sources were registered above
  app.use(maintenance.middleware({ vendorIdentity, brand, bodyEnd: (req, res, locale) => policy.pageEnd(req, res, locale) }));

  // Unauthenticated on purpose (§4.5): a load balancer/monitoring probe
  // has no session, and this must answer even when auth itself is the
  // thing that's broken.
  // minimal: no version/uptime for an unauthenticated caller; isShuttingDown
  // flips the probe to 503 as soon as shutdown starts (readiness).
  app.use(http.securityTxt(security.securityTxt)); // public; nothing is served until a contact is configured
  app.get('/health', health.healthHandler(db, { version: PACKAGE_VERSION, minimal: true, isShuttingDown: ctx.isShuttingDown }));

  app.use(http.createRateLimiter(security.rateLimit));

  const appRoutes = registerRoutes(app, { onLock: ctx.onLock ?? null, bans, db, authProvider, eventBus, moduleRegistry, uploadsDir, appConfig, migrationsDir, runBackupJob, emailService: ctx.emailService, logger, logDestination: ctx.logDestination, vendorIdentity });

  policy.mount(app);

  // Admin section: login + `admin.access` required, theme from the app's own tokens.
  // Fresh confirmation before dangerous administration actions (off unless security.stepUp.enabled).
  const stepUp = appConfig.security.stepUp?.enabled
    ? adminModule.createStepUp({ db, authProvider, totpKey: appConfig.auth.totpEncryptionKey ?? null, maxAgeMs: appConfig.security.stepUp.maxAgeMinutes * 60_000 })
    : null;
  stepUp?.mount(app, { requireAuth: http.requireAuth });
  adminModule.createAdmin({
    stepUp: stepUp ? [stepUp.middleware] : [],
    incidents: privacy.createIncidentRegister(db),
    processingRegistry: () => privacy.buildProcessingRegistry({ moduleRegistry: ctx.moduleRegistry, config: ctx.appConfig }),
    db, metrics, bans, policy, maintenance, announcement, vendorIdentity,
    limits: { db: { max: 1024 ** 3 }, audit: { max: 5_000_000 }, sessions: { max: 10_000 } }, // overview: "of limit" bars; sample values for the demo
    controlPath: '/control', // backups, maintenance, announcement, tasks, mail: application operation, apart from /admin
    scheduler: ctx.schedulerHolder ? { listJobs: () => ctx.schedulerHolder.current?.listJobs() ?? [], runNow: (n) => ctx.schedulerHolder.current.runNow(n) } : null,
    taskSchedules: ctx.schedulerHolder ? { set: (n, v) => ctx.schedulerHolder.taskSchedules.set(n, v), reset: (n) => ctx.schedulerHolder.taskSchedules.reset(n), isOverridden: (n) => ctx.schedulerHolder.taskSchedules?.isOverridden(n) ?? false } : null,
    passwordPolicy: auth.createPasswordPolicy({ db, config: appConfig.auth.passwordPolicy, blocklistFile: appConfig.auth.passwordBlocklistFile, appName: 'Workshop' }),
    managedTasks: { backup: 'backups', 'alerts-doctor': 'about' },
    mail: ctx.emailQueue ? { queue: ctx.emailQueue, service: ctx.emailService } : null,
    config: appConfig,
    auditAccess: { read: 'audit.read', export: 'audit.export' },
    configSources: ctx.configSources ?? null,
    migrations: ctx.migrationsDir ? () => cliModule.migrationStatus(db, ctx.migrationsDir) : null,
    userManagement: { authProvider, roles: ROLES, adminRole: ADMIN_ROLE, allowDelete: true, email: { service: ctx.emailService, baseUrl: appConfig?.email?.baseUrl }, onPasswordReset: (u) => appRoutes.forgetLoginFailures(u.username), onUnlock: (u) => appRoutes.forgetLoginFailures(u.username), lockouts: { list: () => appRoutes.lockouts(), unlock: (k, key) => appRoutes.unlockLockout(k, key) } },
    alerts: ctx.alerts ?? null, alertsMail: ctx.alertsMail ?? false,
    appearance: { uploadsDir: ctx.uploadsDir, fallbackName: 'Workshop' },
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
      nodeModulesDir: [path.resolve(__dirname, '../node_modules'), path.resolve(__dirname, '../../../node_modules')],
      appName: 'workshop', appVersion: PACKAGE_VERSION,
      health: () => health.checkHealth(db, { version: PACKAGE_VERSION }),
      doctor: () => health.runDoctor(buildDoctorCategories(ctx, () => db, { inProcess: true, logger, scheduler: ctx.schedulerHolder?.current ?? null })),
      doctorSchedule: { get: () => ctx.schedulerHolder?.doctorSchedule?.get() ?? { enabled: false, schedule: null, time: null, nextRun: null }, set: (v) => ctx.schedulerHolder.doctorSchedule.set(v) },
    }, dbFilePath: ctx.dbFilePath })
    .mount(app, { requireAuth: http.requireAuth, requirePermission: http.requirePermission });

  // Branded 404/500 - must be registered LAST, after every real route.
  app.use(http.notFoundHandler(vendorIdentity, { loginUrl: '/login', brand, bodyEnd: (req, res, locale) => policy.pageEnd(req, res, locale) }));
  app.use(http.errorPageHandler(vendorIdentity, { logger, loginUrl: '/login', brand, bodyEnd: (req, res, locale) => policy.pageEnd(req, res, locale) }));

  return { app, eventBus, metrics };
}

async function main() {
  const ctx = await buildContext();
  const { appConfig, db, runBackupJob, migrationsDir, certDir } = ctx;

  // One server per database, and `backup restore` refuses while it runs (audit G02).
  // The lock is released on shutdown; a crashed server's lock is recognized as dead by its pid.
  files.configureImageConcurrency(appConfig.uploads.imageProcessing);
  const releaseServerLock = ctx.serverLockFile ? schedulerModule.acquireFileLock(ctx.serverLockFile, { staleMs: Infinity, takeOverSelf: true }) : null;
  if (ctx.serverLockFile && !releaseServerLock) {
    // eslint-disable-next-line no-console
    console.error(`[workshop] another server (or a restore) holds ${ctx.serverLockFile} - not starting`);
    process.exit(1);
  }

  // Migrate-on-boot: `npm start` on a genuinely fresh database must not
  // 500 on the first request to a route backed by a table that only
  // exists after `migrate` has run. Idempotent - already-applied
  // migrations are skipped by runMigrations() itself.
  const migrationResult = await cliModule.runMigrations(db, migrationsDir, { backupDir: ctx.preMigrateDir ?? null, onBackup: (e) => cliModule.auditBackup(db, e) });
  if (migrationResult.applied.length > 0) {
    const names = migrationResult.applied.map((m) => m.name).join(', ');
    // eslint-disable-next-line no-console
    console.log(`[workshop] applied ${migrationResult.applied.length} migration(s): ${names}`);
  }

  // Demo data for a fresh database - no-op once the table already has rows.
  seedAssetsIfEmpty(db);

  // logging.sinks: where lines go (stdout, a file on another disk, syslog, HTTP). Without sinks the
  // default is plain stdout/stderr. Point one sink off this machine so deleted local logs survive.
  const logDestination = appConfig.logging.sinks.length > 0
    ? logs.createLogDestination({
        sinks: appConfig.logging.sinks,
        buffer: appConfig.logging.buffer,
        localFallback: appConfig.logging.localFallback,
        appName: 'workshop',
      })
    : null;
  const logger = logs.createLogger({
    level: appConfig.logLevel ?? 'info',
    base: { app: 'workshop' },
    stream: logDestination ?? undefined,
    // readable lines in an interactive development terminal; JSON everywhere else
    pretty: appConfig.env !== 'production' && Boolean(process.stdout.isTTY),
  });
  // A copy of the audit trail in the log stream: what an intruder deletes from the database still exists remotely.
  const stopAuditMirror = logs.mirrorAuditToLogs(audit.onEntry, logger, { mode: appConfig.logging.auditMirror });
  let lifecycle = null;
  // A restored older backup may contain people who were erased since: erase them again before serving (audit F08).
  const reErased = await ctx.reapplyErasures();
  if (reErased.reapplied.length > 0) logger.warn('re-applied erasures after a restore', { count: reErased.reapplied.length });

  const alertSet = buildAlerts(ctx, logger);
  const schedulerHolder = { current: null }; // the scheduler is created after the app; the admin "Tasks" section reads it through this
  const promSettings = appConfig.observability?.metrics;
  const prom = promSettings?.enabled ? await observability.createPrometheusMetrics({ defaultMetrics: promSettings.defaultMetrics }) : null;
  const { app, metrics } = createApp({ ...ctx, prom, schedulerHolder, logger, logDestination, alerts: alertSet?.alerts ?? null, alertsMail: alertSet?.mailConfigured ?? false, onLock: alertSet?.onLock ?? null, isShuttingDown: () => lifecycle?.isShuttingDown() ?? false });

  // §4.5f: HTTPS-only. 'self-signed' (the schema default) generates a
  // cert into data/certs on first start; 'standalone' reads
  // server.https.certPath/keyPath; 'reverse-proxy' stays plain HTTP and
  // requires server.trustProxy (enforced by applyServerSettings above).
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
      onSkip: (h, err) => console.warn(`[workshop] administration panel: not listening on ${h} (${err.code ?? err.message})`), // eslint-disable-line no-console
    });
    // eslint-disable-next-line no-console
    console.log(`[workshop] administration panel on ${tls ? 'https' : 'http'}://${adminAddress.host}:${adminAddress.port} (${adminListeners.bound.map((b) => b.host).join(', ')}) only; the application's address answers 404 for it`);
  }
  // A renewed certificate (`cert renew`, or an external renewal in standalone mode) is picked up without a restart: SIGHUP, or the
  // files' modification time checked once a minute. A pair that does not match is refused and the old one keeps serving.
  let tlsReloader = null;
  if (tls) {
    const files = appConfig.server.https?.mode === 'standalone' ? { certPath: appConfig.server.https.certPath, keyPath: appConfig.server.https.keyPath } : certs.certFilePaths(certDir);
    tlsReloader = http.createTlsReloader({
      ...files,
      servers: () => [server, ...(adminListeners?.servers ?? [])],
      onReload: (e) => {
        if (e.ok) logger.info('TLS certificate reloaded');
        else logger.warn('TLS certificate NOT reloaded: the old one keeps serving', { reason: e.reason });
        audit.log(db, { actor: 'system', action: 'tls.reload', entity: 'certificate', result: e.ok ? 'success' : 'failure', ...(e.ok ? {} : { meta: { reason: e.reason } }) });
      },
    }).start();
  }
  const scheme = tls ? 'https' : 'http';
  // Platform convention: HTTPS on 9N02 and a plain-HTTP port 9N01 that only redirects to it (workshop 9002 / 9001).
  const redirectPort = tls ? http.resolveRedirectPort(appConfig.server) : false;
  let redirectServer = null;
  if (redirectPort) {
    redirectServer = http.createHttpRedirectServer({
      httpsPort: port,
      canonicalHost: host === '0.0.0.0' || host === '::' ? 'localhost' : host,
      // Repeated hand-typed http:// hits are worth a line in the security stream (address shortened).
      onRedirect: ({ ip, method, path: hitPath, count, refused }) =>
        logger.warn('plain http request redirected to https', { stream: 'security', ip: logs.anonymizeIp(ip, 'truncate'), method, path: hitPath, hits: count, refused }),
      allowedHosts: [...appConfig.server.allowedHosts, ...(appConfig.email.baseUrl ? [new URL(appConfig.email.baseUrl).hostname] : [])],
    });
    await http.listenServer(redirectServer, { host, port: redirectPort });
    // eslint-disable-next-line no-console
    console.log(`[workshop] http://${host}:${redirectPort} redirects to ${scheme}://${host}:${port}`);
  }
  // eslint-disable-next-line no-console
  console.log(`[workshop] listening on ${scheme}://${host}:${port}`);
  const shownHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  const live = liveConsole.liveConsoleSupported(); // a real, big enough terminal: the lettering stays pinned at the bottom instead
  // eslint-disable-next-line no-console
  console.log(`\n${formatStartBanner({ wordmark: !live, name: 'Workshop', appVersion: PACKAGE_VERSION, coreVersion: CORE_VERSION, url: `${scheme}://${shownHost}:${port}`, adminUrls: adminAddress ? [...new Set([`${scheme}://localhost:${adminAddress.port}`, `${scheme}://${adminAddress.host}:${adminAddress.port}`])] : null, bootstrap: ctx.bootstrap, credentialsFile: ctx.credentialsFile, showPassword: process.env.DAS_BOOTSTRAP_PRINT !== 'false' })}\n`);
  if (live) {
    liveConsole.startLiveConsole({
      commands: {
        health: {
          description: 'живость процесса и базы / liveness: process and database',
          run: () => {
            const h = health.checkHealth(db, { version: CORE_VERSION });
            return [`status:   ${h.status}`, `database: ${h.database}`, `version:  ${h.version ?? '-'}`, `uptime:   ${Math.floor(h.uptime / 60)} min (${h.uptime} s)`];
          },
        },
        status: {
          description: 'адреса, память, Node / addresses, memory, Node',
          run: () => [`${scheme}://${shownHost}:${port}`, `admin:  ${scheme}://${shownHost}:${adminAddress ? adminAddress.port : port}/admin`, `memory: ${Math.round(process.memoryUsage().rss / 1048576)} MB`, `node:   ${process.version}, pid ${process.pid}`],
        },
      },
    });
  }

  // Scheduler: the same backup job the CLI's "backup run" command can
  // also trigger on demand (see bin/app.js) - one implementation, two
  // ways to invoke it.
  // lockDir: server job and CLI never overlap; catchUp: a backup missed
  // while the server was down runs once at the next start (B15).
  const jobScheduler = schedulerModule.createScheduler({
    lockDir: path.resolve(path.dirname(path.resolve(__dirname, '..', appConfig.database.file)), '.locks'),
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
  // Weekly sweep of uploads no row refers to (a crash between "file written"
  // and "row written", a deleted asset). Files younger than an hour are left alone.
  jobScheduler.registerJob('uploads-gc', '30 4 * * 0', () => {
    const referenced = db.all(`SELECT logo_filename AS f FROM assets WHERE logo_filename IS NOT NULL`).map((r) => r.f);
    const result = files.removeOrphanUploads(ctx.uploadsDir, referenced);
    if (result.removed > 0) logger.info('uploads-gc removed orphan files', { removed: result.removed, bytes: result.bytes });
  });
  if (appConfig.logging.auditAnchorSchedule && appConfig.logging.auditMirror !== 'off') {
    jobScheduler.registerJob('audit-anchor', appConfig.logging.auditAnchorSchedule, () => {
      logs.logAuditAnchor(audit.anchor, db, logger);
    });
  }
  // Alerts: periodic diagnostics (failed checks) and audit-chain verification, plus the alert table cleanup.
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
  // Standard housekeeping (sessions, audit rows, bans, metrics, spent tokens, finished mail): one call from the core,
  // so a forgotten line can no longer let a table grow without limit. The doctor warns if it is missing.
  schedulerModule.registerStandardJobs(jobScheduler, {
    db, logger, sessionStore: ctx.sessionStore, bans: ctx.bans, metrics, emailQueue: ctx.emailQueue,
    auditRetentionDays: appConfig.audit.retentionDays, auditPurgeBatchSize: appConfig.audit.purgeBatchSize, auditArchiveDir: appConfig.audit.archiveDir,
    mailKeepFinishedDays: appConfig.email.queue.keepFinishedDays,
  });
  ctx.emailQueue?.start({ intervalMs: appConfig.email.queue.intervalMs });
  // Schedules the administrator changed in the "Tasks" section; after every job is registered, before the start.
  schedulerHolder.taskSchedules = schedulerModule.createTaskSchedules({ db, scheduler: jobScheduler });
  schedulerHolder.taskSchedules.apply();
  jobScheduler.start();

  lifecycle = http.registerGracefulShutdown(server, {
    drainTimeoutMs: appConfig.server.shutdownDrainTimeoutMs,
    // End open SSE streams first - they would otherwise keep
    // server.close() waiting until the drain timeout.
    onDrainStart: () => realtime.closeAllSseStreams(),
    onShutdown: async () => {
      await new Promise((resolve) => (redirectServer ? redirectServer.close(() => resolve()) : resolve()));
      await new Promise((resolve) => (adminListeners ? adminListeners.close().then(resolve) : resolve()));
      // Wait for a running backup before the database goes away.
      ctx.emailQueue?.stop();
      tlsReloader?.stop();
      await jobScheduler.stop();
      stopAuditMirror();
      metrics.close();
      db.close();
      releaseServerLock?.();
      await logDestination?.close(); // last chance to deliver buffered log lines
    },
  });
  http.registerFatalHandlers(lifecycle, { logger });
}

// Only start listening when run as the entry point (`npm start`), not
// when a test imports createApp().
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[workshop] fatal startup error:', err);
    process.exit(1);
  });
}
