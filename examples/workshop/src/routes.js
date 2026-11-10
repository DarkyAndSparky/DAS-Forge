import { z } from 'zod';
import { CORE_VERSION, ldap as ldapModule, accounts as accountsModule, auth, http, files, realtime, ui, qr, audit, scheduler, database, health, branding, cli as cliModule, notifications as notificationsModule, mountNotificationsPage, bellHtml } from '@das-forge/core';
import { translator } from './messages.js';
import { ROLES } from './roles.js';
import { renderRealtimeBody, escapeHtml } from './pages.js';
import { listAssets, getAsset, createAsset, updateAsset, setAssetCost, setAssetLogo, deleteAsset } from './records.js';

const CreateAssetSchema = z.object({
  name: z.string().min(1).max(200),
  org: z.string().min(1).max(100),
});

/** Same shape as create - cost is deliberately NOT here, see
 * records.js's updateAsset() doc comment for why it has its own
 * finance-gated setter instead. */
const UpdateAssetSchema = CreateAssetSchema;

const SetCostSchema = z.object({
  cost: z.number().nonnegative(),
});

const BackupVerifySchema = z.object({
  file: z.string().min(1),
});

const LabMessageSchema = z.object({
  message: z.string().min(1).max(500),
});

export function permissionsForRole(role) {
  if (role === 'auditor') return ['read:basic', 'audit.read', 'audit.export'];
  return role === 'admin' ? ['read:basic', 'read:finance', 'admin:write', 'admin.access'] : ['read:basic'];
}

/**
 * §18's "несколько факторов на пользователя" policy decision, made
 * HERE (the app), not in core/auth - core only enforces an invariant
 * once told whether it applies (see removeAuthenticator()'s
 * `mfaRequired` option). Workshop's own policy: admins must always
 * keep at least one active factor once they've enrolled one; regular
 * operators are never forced to (demonstrates the flag doing
 * something real, not just always `false`).
 */
function mfaRequiredForRole(role) {
  return role === 'admin';
}


/**
 * The start page: a shop window of what the core does. Live figures, then groups of capabilities, each with links to
 * the places where it can be seen (only those this user may open), then a list of things to try.
 * `stats` = { assets, users, sessions, version } - any may be missing.
 */
export function renderHomeBody(user, locale, stats = {}) {
  const t = translator(locale === 'en' ? 'en' : 'ru');
  const can = (perm) => user.permissions.includes(perm);
  const admin = can('admin.access');
  const link = (href, key) => `<a href="${href}">${escapeHtml(t(`home.${key}`))}</a>`;
  const groups = [
    { k: 'account', links: [['/ui/account', 'accountLink']] },
    { k: 'realtime', links: [['/ui/realtime', 'realtimeLink']] },
    { k: 'data', links: can('read:finance') ? [['/ui/reporting', 'dataLink']] : [] },
    { k: 'admin', show: admin, links: [['/admin', 'adminLink'], ['/admin/audit', 'adminAudit'], ['/admin/users', 'adminUsers'], ['/admin/password-policy', 'adminPolicy'], ['/control/backups', 'adminBackups'], ['/control/tasks', 'adminTasks'], ['/admin/about', 'adminAbout']] },
    { k: 'privacy', show: admin, links: [['/admin/registry', 'privacyRegistry'], ['/admin/incidents', 'privacyIncidents']] },
    { k: 'public', links: [['/policy', 'publicPolicy'], ['/policy/cookies', 'publicCookies'], ['/policy/license', 'publicLicense'], ['/policy/components', 'publicComponents']] },
    { k: 'ops', show: admin, links: [['/admin/about', 'adminAbout'], ['/health', 'opsHealth']] },
  ].filter((g) => g.show !== false);
  const figures = [['statAssets', stats.assets], ['statUsers', stats.users], ['statSessions', stats.sessions], ['statVersion', stats.version]].filter(([, v]) => v !== undefined && v !== null);
  const tiles = figures.length
    ? `<h2>${escapeHtml(t('home.statsTitle'))}</h2><div class="adm-grid">${figures.map(([k, v]) => `<div class="adm-card"><h2>${escapeHtml(t(`home.${k}`))}</h2><div class="adm-stat">${escapeHtml(String(v))}</div></div>`).join('')}</div>`
    : '';
  const cards = groups.map((g) => `<div class="adm-card"><h2>${escapeHtml(t(`home.${g.k}Title`))}</h2><p>${escapeHtml(t(`home.${g.k}Text`))}</p>${g.links.length ? `<p style="display:flex;gap:.75rem;flex-wrap:wrap">${g.links.map(([href, key]) => link(href, key)).join('')}</p>` : ''}</div>`).join('');
  const tries = [1, 2, 3, 4, 5, 6].filter((n) => admin || n <= 2).map((n) => `<li>${escapeHtml(t(`home.try${n}`))}</li>`).join('');
  return `<h1>Workshop</h1><p>${escapeHtml(t('home.signedIn'))} <strong>${escapeHtml(user.username)}</strong>.</p><p class="adm-muted">${escapeHtml(t('home.intro'))}</p>${tiles}<div class="adm-grid" style="margin-top:1rem">${cards}</div><div class="adm-card" style="margin-top:1rem"><h2>${escapeHtml(t('home.tryTitle'))}</h2><ul>${tries}</ul></div>`;
}

/** Logo upload: one multipart file, 2 MB hard limit (multer, in memory) - see files.createMultipartUpload. */
const LOGO_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Wires every route that exercises a core module, for workshop.
 * This is the pattern a ported app's own routes.js would follow -
 * session handling, serialize()'d responses, SSE, validated uploads -
 * just with real data models instead of the ASSETS stand-in above.
 */
export function registerRoutes(app, { onLock = null, bans, db, authProvider, eventBus, moduleRegistry, uploadsDir, appConfig, migrationsDir, runBackupJob, emailService = null, logger = null, logDestination = null, vendorIdentity = null }) {
  // Which fields require which permission to see - the actual
  // zero-trust enforcement point, per core/http's serialize(). This
  // used to be a hardcoded ASSET_FIELD_PERMISSIONS constant right here;
  // it now comes from whatever modules context.js registered (§1's
  // Module contract, core/modules) - routes.js has no opinion of its
  // own about what "cost" or "finance" mean.
  const fieldPermissions = moduleRegistry ? moduleRegistry.getFieldPermissions() : {};

  // Sign-in, MFA, password change/reset, own e-mail, TOTP and recovery codes live in the core (`accounts`); the role to
  // permission policy and the pages stay here.
  const bell = notificationsModule.createNotifications({ db });
  // LDAP/AD sign-in (optional `ldap` block of app.config.js): unknown names and directory-managed accounts are checked there; the
  // directory's default/mapped roles must be roles of this app.
  const directory = appConfig?.ldap?.enabled ? { authenticate: ldapModule.createLdapAuthenticator(appConfig.ldap).authenticate, source: 'ldap', allowedRoles: ROLES } : null;
  const accounts = accountsModule.mountAccountRoutes(app, {
    db, authProvider, directory, appConfig, bans, onLock, emailService, logger,
    permissionsForRole, mfaRequiredForRole,
    allowDuringPasswordChange: ['/ui', '/ui/account', '/ui/password'],
    appName: 'Workshop', vendorIdentity,
    // "Account" is the core's body inside this app's own page (menu, language, theme).
    accountShell: (req, res, o) => appShell(req, res, o),
  });


  // Stage D (Audit & Activity, §0.3): thin wrapper around audit.log()
  // that pulls req.id/req.ip out of the request automatically, so
  // every call site below reads as "what happened", not "what happened
  // + the same four lines of request-plumbing boilerplate every time".
  // A logging call that itself throws must never take down the request
  // it was trying to record (same principle as core/audit's log.js
  // doc comment) - wrapped in try/catch, errors are swallowed, not
  // surfaced to the client.
  function logAudit(req, { actor, action, entity = null, entityId = null, result = 'success', meta = {} }) {
    try {
      audit.log(db, { actor, action, entity, entityId, result, meta, requestId: req.id, ip: req.ip });
    } catch {
      // best-effort - never let audit logging break the actual request
    }
  }


  // --- Demo Records (Stage C, §0.3): a real CRUD resource backed by
  // the `assets` table (migrations/002_assets.js), not an in-memory
  // stand-in - this is where database+http+files actually meet.
  // serialize() strips fields the viewer lacks permission for on every
  // read, same fieldPermissions map the old in-memory version used ---
  app.get('/assets', http.requireAuth(), (req, res) => {
    res.json(http.serialize(listAssets(db), { viewerPermissions: req.user.permissions, fieldPermissions }));
  });

  app.get('/assets/:id', http.requireAuth(), (req, res) => {
    const asset = getAsset(db, Number(req.params.id));
    if (!asset) return res.status(404).json({ error: 'NOT_FOUND', fields: [] });
    res.json(http.serialize(asset, { viewerPermissions: req.user.permissions, fieldPermissions }));
  });

  // core/qr (0.1.14): inventory-tag QR, the use case the user asked
  // for by name ("IT Assets needs QR for inventory"). Encodes a plain
  // path, not a full origin+host URL - this example app doesn't know
  // its own deployed origin, and a real app (IT Assets) would want
  // asset:// or its own deployed host here anyway; returns the raw SVG
  // directly (image/svg+xml, not JSON-wrapped) so it can be put
  // straight into an <img src> or opened/printed on its own, which is
  // what a label-printing workflow needs - unlike the TOTP panel,
  // nothing secret is encoded here, so GET is fine.
  app.get('/assets/:id/qr.svg', http.requireAuth(), async (req, res) => {
    const asset = getAsset(db, Number(req.params.id));
    if (!asset) return res.status(404).json({ error: 'NOT_FOUND', fields: [] });
    const svg = await qr.generateQrSvg(`/assets/${asset.id}`);
    res.type('image/svg+xml').send(svg);
  });

  // Any authenticated user can create/rename a record - this is the
  // "ordinary write" baseline; `cost` is deliberately excluded from
  // this schema (see CreateAssetSchema above), so creating a record
  // can never smuggle a cost value past the finance-only endpoint
  // below, even for a viewer who otherwise has read:finance too.
  app.post('/assets', http.requireAuth(), http.validateBody(CreateAssetSchema), (req, res) => {
    const asset = createAsset(db, req.body);
    eventBus.publish('assets', { type: 'asset-created', id: asset.id });
    logAudit(req, { actor: req.user.username, action: 'asset.create', entity: 'asset', entityId: asset.id });
    res.status(201).json(http.serialize(asset, { viewerPermissions: req.user.permissions, fieldPermissions }));
  });

  app.patch('/assets/:id', http.requireAuth(), http.validateBody(UpdateAssetSchema), (req, res) => {
    const asset = updateAsset(db, Number(req.params.id), req.body);
    if (!asset) return res.status(404).json({ error: 'NOT_FOUND', fields: [] });
    eventBus.publish('assets', { type: 'asset-updated', id: asset.id });
    logAudit(req, { actor: req.user.username, action: 'asset.update', entity: 'asset', entityId: asset.id });
    res.json(http.serialize(asset, { viewerPermissions: req.user.permissions, fieldPermissions }));
  });

  // Destructive, so admin-only (§Stage B's same mfaRequired-for-admin
  // spirit: the more an action can't be undone, the higher the bar) -
  // a non-admin gets a real 403 here, not a hidden delete button.
  app.delete('/assets/:id', http.requireAuth(), http.requirePermission('admin:write'), (req, res) => {
    const existed = deleteAsset(db, Number(req.params.id));
    if (!existed) return res.status(404).json({ error: 'NOT_FOUND', fields: [] });
    eventBus.publish('assets', { type: 'asset-deleted', id: Number(req.params.id) });
    logAudit(req, { actor: req.user.username, action: 'asset.delete', entity: 'asset', entityId: Number(req.params.id) });
    res.json({ ok: true });
  });

  // --- Finance-only mutation - requirePermission(), not a body flag -
  app.post('/assets/:id/cost', http.requireAuth(), http.requirePermission('read:finance'), http.validateBody(SetCostSchema), (req, res) => {
    const asset = setAssetCost(db, Number(req.params.id), req.body.cost);
    if (!asset) return res.status(404).json({ error: 'NOT_FOUND', fields: [] });
    eventBus.publish('assets', { type: 'asset-updated', id: asset.id });
    // meta carries the new cost, not the viewer's permission state -
    // the audit log itself is admin-only below, so recording the
    // actual value here doesn't create a NEW leak beyond who can
    // already see it through serialize()'s own fieldPermissions gate.
    logAudit(req, { actor: req.user.username, action: 'asset.cost_set', entity: 'asset', entityId: asset.id, meta: { cost: req.body.cost } });
    res.json(http.serialize(asset, { viewerPermissions: req.user.permissions, fieldPermissions }));
  });

  // Account administration (create, role, password reset, sign-out, removal) is the core admin panel's
  // "Users" section (server.js passes `userManagement`); the workshop keeps no copy of it.

  // --- Stage D (Audit & Activity, §0.3): every write route above now
  // actually calls logAudit() - this is where that record becomes
  // visible. Admin-only, same bar as /admin/users - an audit trail is
  // itself sensitive (who logged in when, whose password changed,
  // every failed login attempt with its reason), not a casual read.
  // Filters are all optional and ANDed, straight through to
  // core/audit's query()/count() - routes.js has no filtering logic of
  // its own, same "thin wiring, no business logic duplicated" rule as
  // everywhere else in this file.
  app.get('/audit', http.requireAuth(), http.requirePermission('admin:write'), (req, res) => {
    const { actor, action, entity, entityId, result, since, until } = req.query;
    const limit = req.query.limit ? Math.min(Number(req.query.limit), 200) : 50;
    const offset = req.query.offset ? Number(req.query.offset) : 0;
    const filters = { actor, action, entity, entityId, result, since, until };
    // audit.query()/count() treat an explicit `undefined` filter as
    // "don't filter on this" (see their own doc comments) - strip keys
    // whose query-string value was simply absent, rather than passing
    // through empty strings that would (wrongly) match nothing.
    for (const key of Object.keys(filters)) {
      if (filters[key] === undefined) delete filters[key];
    }
    const entries = audit.query(db, { ...filters, limit, offset });
    const total = audit.count(db, filters);
    res.json({ entries, total, limit, offset });
  });

  // --- Stage E (System & Maintenance, §0.3): wraps core/scheduler's
  // backup-ops/backup-job and core/health/core/cli's migrationStatus
  // behind an admin-only HTTP surface - same functions the CLI already
  // calls (bin/app.js's `backup run/list/verify`), no logic duplicated.
  // `backup restore` is deliberately NOT exposed here - see the
  // "restore stays CLI-only" callout below GET /system/status.
  function listKnownBackups() {
    return scheduler.listBackups(appConfig.backup.destinations);
  }

  app.get('/system/status', http.requireAuth(), http.requirePermission('admin:write'), (req, res) => {
    res.json({
      health: health.checkHealth(db),
      migrations: migrationsDir ? cliModule.migrationStatus(db, migrationsDir) : [],
      backups: listKnownBackups(),
      retentionDays: appConfig.backup.retentionDays,
      // delivery counters of the configured log sinks (sent / dropped / queued / lastError)
      logSinks: logDestination?.stats() ?? [],
    });
  });

  app.post('/system/backup/run', http.requireAuth(), http.requirePermission('admin:write'), async (req, res) => {
    try {
      const results = await runBackupJob();
      logAudit(req, { actor: req.user.username, action: 'system.backup_run', result: 'success', meta: { destinations: results.length } });
      res.json({ ok: true, results });
    } catch (err) {
      logAudit(req, { actor: req.user.username, action: 'system.backup_run', result: 'failure', meta: { message: err.message } });
      res.status(500).json({ error: 'BACKUP_FAILED', message: err.message, fields: [] });
    }
  });

  // The client only ever sends back a `path` this same route handed it
  // moments earlier (GET /system/status's `backups[].path`) - verified
  // against the CURRENT known-backups list rather than trusted as-is,
  // so this never opens an arbitrary file the caller happens to name
  // (verifyBackupFile() opens its argument as a zip archive - not
  // something to do with unvalidated client input, same "never trust a
  // client-supplied path" rule as files.js's upload storage).
  app.post('/system/backup/verify', http.requireAuth(), http.requirePermission('admin:write'), http.validateBody(BackupVerifySchema), async (req, res) => {
    const known = listKnownBackups().some((b) => b.supported !== false && b.path === req.body.file);
    if (!known) {
      return res.status(404).json({ ok: false, message: 'Not a known backup file.' });
    }
    const result = await scheduler.verifyBackupFile(database.createSqliteAdapter, req.body.file, { encryptionKey: appConfig.backup?.encryptionKey ?? null });
    logAudit(req, {
      actor: req.user.username,
      action: 'system.backup_verify',
      result: result.ok ? 'success' : 'failure',
      meta: { file: req.body.file, message: result.message },
    });
    res.json(result);
  });

  // --- Stage E's Realtime Lab: a second, deliberately generic SSE
  // channel (separate from /events/assets) for trying core/realtime's
  // pub/sub interactively rather than only through Demo Records side
  // effects - any authenticated user can broadcast/listen (not
  // admin-gated, unlike System & Maintenance - this is a shared
  // playground, not a sensitive surface).
  app.post('/events/lab/broadcast', http.requireAuth(), http.validateBody(LabMessageSchema), (req, res) => {
    const event = { type: 'lab-message', from: `user #${req.user.id}`, message: req.body.message, at: new Date().toISOString() };
    const delivered = eventBus.publish('lab', event);
    res.json({ ok: true, delivered });
  });

  // An open stream is re-checked every minute against the database: a revoked/expired session or a disabled
  // user stops receiving events (audit I10).
  const streamStillAllowed = (req) => {
    const row = db.get(
      `SELECT u.disabled FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?`,
      [auth.hashSessionId(req.sessionID), new Date().toISOString()]
    );
    return Boolean(row) && !row.disabled;
  };

  app.get(
    '/events/lab',
    http.requireAuth(),
    realtime.createSseHandler({
      eventBus,
      resolveChannel: () => 'lab',
      reauthorize: streamStillAllowed,
      initialEvent: () => ({ type: 'connected' }),
    })
  );

  // --- SSE: live updates when an asset changes -----------------------
  app.get(
    '/events/assets',
    http.requireAuth(),
    realtime.createSseHandler({
      eventBus,
      resolveChannel: () => 'assets',
      reauthorize: streamStillAllowed,
      initialEvent: () => ({ type: 'connected' }),
    })
  );

  // --- core/ui's AppShell (§5.4): real navigation/i18n/search, built
  // from whatever modules registered (reporting-module.js's `cost`
  // field permission gates its own nav entry here too - a viewer who
  // can't see `cost` above doesn't even get a link to a page about it) -
  // App-level menu next to the modules' own entries; permission-gated like everything else.
  const APP_NAV = [
    { path: '/ui', label: { ru: 'Главная', en: 'Home' } },
    { path: '/ui/account', label: { ru: 'Аккаунт', en: 'Account' } },
    { path: '/ui/realtime', label: { ru: 'Realtime Lab', en: 'Realtime Lab' } },
    { path: '/admin', label: { ru: 'Администрирование', en: 'Admin panel' }, permission: 'admin.access' },
  ];
  const pageT = (req) => translator(req.locale === 'en' ? 'en' : 'ru');
  /** One page in the app shell: menu, language, theme and footer are the same everywhere. */
  // The administrator's company name / logos / accent colors (admin panel -> Appearance), read per request.

  const appShell = (req, res, { activePath, title, bodyHtml }) => {
    const locale = req.locale === 'en' ? 'en' : 'ru';
    return ui.renderAppShell({
      moduleRegistry,
      viewerPermissions: req.user.permissions,
      user: req.user,
      nonce: res.locals?.cspNonce,
      bodyEndHtml: res.locals?.pageEnd?.(locale),
      bannerHtml: res.locals?.banner?.(locale) ?? '',
      locale,
      extraNav: APP_NAV,
      theme: branding.themeWithBranding(db, {}),
      brandHtml: branding.brandBlockHtml(db, vendorIdentity),
      bellHtml: bellHtml({ url: '/ui/notifications', count: bell.unreadCount(req.user.id), locale }),
      userBadge: req.user.role,
      homeUrl: '/ui', // the application name leads home
      accountUrl: '/ui/account', // the user name leads to the account settings
      activePath,
      title,
      bodyHtml,
    });
  };

  /** Live figures for the start page; a missing table just leaves its tile out. */
  const homeStats = () => {
    const n = (sql) => { try { return db.get(sql).n; } catch { return undefined; } };
    return { assets: n('SELECT COUNT(*) AS n FROM assets'), users: n('SELECT COUNT(*) AS n FROM users'), sessions: n('SELECT COUNT(*) AS n FROM sessions'), version: CORE_VERSION };
  };

  if (moduleRegistry) {
    app.get('/ui', http.requireAuth(), (req, res) => {
      res.type('html').send(
        appShell(req, res, {
          activePath: '/ui',
          title: 'Workshop',
          bodyHtml: renderHomeBody(req.user, req.locale === 'en' ? 'en' : 'ru', homeStats()),
        })
      );
    });

    app.get('/ui/search', http.requireAuth(), async (req, res) => {
      const results = await ui.searchModules(moduleRegistry, req.query.q ?? '');
      res.json(results);
    });

    // Reports (the demo module's menu entry): a small real summary over the assets table.
    app.get('/ui/reporting', http.requireAuth(), http.requirePermission('read:finance'), (req, res) => {
      let row = { n: 0, total: 0 };
      try { row = db.get('SELECT COUNT(*) AS n, COALESCE(SUM(cost), 0) AS total FROM assets'); } catch { /* table may be empty/absent */ }
      res.type('html').send(
        appShell(req, res, {
          activePath: '/ui/reporting',
          title: `${pageT(req)('reports.title')} — Workshop`,
          bodyHtml: (() => {
            const t = pageT(req);
            return `<h1>${escapeHtml(t('reports.title'))}</h1><div class="adm-grid"><div class="adm-card"><h2>${escapeHtml(t('reports.assets'))}</h2><div class="adm-stat">${Number(row.n)}</div></div><div class="adm-card"><h2>${escapeHtml(t('reports.totalCost'))}</h2><div class="adm-stat">${Number(row.total)}</div></div></div>`;
          })(),
        })
      );
    });

    // --- Stage E's Realtime Lab UI - open to any authenticated user,
    // same gate as the /events/lab routes themselves.
    app.get('/ui/realtime', http.requireAuth(), (req, res) => {
      res.type('html').send(
        appShell(req, res, {
          activePath: '/ui/realtime',
          title: `${pageT(req)('realtime.title')} — Workshop`,
          bodyHtml: renderRealtimeBody({ nonce: res.locals?.cspNonce, locale: req.locale === 'en' ? 'en' : 'ru' }),
        })
      );
    });
  }

  // --- Upload: magic-bytes checked, never trusts the client's claim -
  // multer (via files.createMultipartUpload) takes the one file from a multipart
  // form into memory under a hard size limit and sets req.upload; the client's
  // file name and mime type are informational only - files.acceptUpload below
  // determines the real type from the bytes.
  const logoUpload = files.createMultipartUpload({ field: 'logo', maxBytes: LOGO_MAX_BYTES });
  app.post('/assets/:id/logo', http.requireAuth(), logoUpload, async (req, res) => {
    const asset = getAsset(db, Number(req.params.id));
    if (!asset) return res.status(404).json({ error: 'NOT_FOUND', fields: [] });

    // acceptUpload = size -> magic bytes -> SVG/zip checks -> mandatory
    // re-encode (drops polyglot tails, strips EXIF) -> atomic write.
    let result;
    try {
      result = await files.acceptUpload(req.upload.buffer, {
        allowedTypes: ['png', 'jpg', 'svg'],
        maxBytes: LOGO_MAX_BYTES,
        storageDir: uploadsDir,
        quota: appConfig?.uploads,
        imageOptions: { maxWidth: 1024, maxHeight: 1024 },
      });
    } catch (err) {
      if (err.code === 'QUOTA_EXCEEDED') return res.status(507).json({ error: 'STORAGE_FULL', fields: [] });
      if (err.code === 'IMAGE_BUSY') {
        res.setHeader('Retry-After', '5');
        return res.status(503).json({ error: 'BUSY', fields: [] });
      }
      return res.status(400).json({ error: 'INVALID_UPLOAD', message: err.message, fields: [] });
    }

    const previousLogo = asset.logo_filename;
    let updated;
    try {
      updated = setAssetLogo(db, asset.id, result.filename);
    } catch {
      // The DB write failed after the file was stored: don't leave an orphan.
      files.removeUpload(uploadsDir, result.filename);
      return res.status(500).json({ error: 'INTERNAL_ERROR', fields: [] });
    }
    // The row now points at the new file; the old one is garbage.
    if (previousLogo && previousLogo !== result.filename) files.removeUpload(uploadsDir, previousLogo);
    eventBus.publish('assets', { type: 'asset-updated', id: asset.id });
    logAudit(req, {
      actor: req.user.username,
      action: 'asset.logo_set',
      entity: 'asset',
      entityId: asset.id,
      meta: { detectedType: result.type },
    });
    res.json({ ok: true, detectedType: result.type, asset: http.serialize(updated, { viewerPermissions: req.user.permissions, fieldPermissions }) });
  });

  mountNotificationsPage(app, {
    notifications: bell, requireAuth: http.requireAuth(), render: (req, res, o) => appShell(req, res, { activePath: '/ui/notifications', ...o }),
    categories: [
      { key: 'security', label: { ru: 'Безопасность (блокировки, подозрительные входы)', en: 'Security (lockouts, suspicious sign-ins)' } },
      { key: 'system', label: { ru: 'Работа системы (сбои задач, почта, диск)', en: 'System (failed jobs, mail, disk)' } },
    ],
  });

  return {
    /** Forgets the failed-login counters of one user (an administrator just reset that password). */
    forgetLoginFailures: accounts.forgetLoginFailures,
    lockouts: accounts.lockouts,
    unlockLockout: accounts.unlockLockout,
  };
}
