import { z } from 'zod';

/**
 * §7.5 ApplicationConfigSchema and sub-schemas.
 *
 * IMPORTANT (per architecture doc §7.5):
 * Zod validates DATA (this file). Behavioral interfaces such as
 * DatabaseAdapter / AuthProvider / SessionStore are NOT validated here —
 * they get lightweight duck-typing assert functions elsewhere
 * (core/database, core/auth), called once at startup. Do not be tempted
 * to "schema-ify" those; that was explicitly flagged as a false sense
 * of safety.
 *
 * STRICT: every object is `z.strictObject`, so a mistyped or obsolete key
 * (`sever.port`, `auth.sessionTtl`) is a startup error instead of being silently
 * ignored (audit C07). An app with its own settings extends the schema
 * (`ApplicationConfigSchema.extend({ myApp: z.strictObject({...}) })`) and passes it
 * to loadConfig/validateConfig as `schema`.
 *
 * ZOD 4 NOTE: every nested-object default below uses `.prefault({})`,
 * not `.default({})`. In Zod 3, `.default(value)` would re-parse `value`
 * through the schema when a key was missing, which is how an omitted
 * `server` key ended up with `port: 3000` filled in from
 * ServerConfigSchema's own field defaults. Zod 4 changed `.default()`
 * to short-circuit - it returns the literal value as-is, with no
 * re-parsing - so `server: ServerConfigSchema.default({})` would leave
 * `port`/`host`/etc. completely undefined instead of defaulted. Zod 4's
 * `.prefault()` ("pre-parse default") is the direct replacement that
 * preserves the old, desired behavior. This bit us for real: it only
 * surfaced once a user ran tests against actual zod 4.6.5 (this module
 * could never be live-tested in the development container itself,
 * which had no network access to install zod at all).
 */

export const ServerConfigSchema = z.strictObject({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(3000),
  // Plain-HTTP port that only redirects to HTTPS. Unset: `port - 1` when this process terminates TLS (convention: an app
  // takes 9N02 for HTTPS and 9N01 for the redirect), none behind a reverse proxy. `false` turns the listener off.
  httpRedirectPort: z.union([z.number().int().min(1).max(65535), z.literal(false)]).optional(),
  // Extra host names the redirect may send a browser to (the Host header is trusted only for these, plus the
  // listen host, localhost and loopback): stops a forged Host header from making the listener an open redirect.
  allowedHosts: z.array(z.string().min(1)).default([]),
  // false | true (one proxy hop) | number of hops (2+ for CDN + nginx) | list of trusted proxy addresses/subnets
  // ('10.0.0.0/8', '::1', 'loopback', ...). Only what you list is trusted for X-Forwarded-* (audit L04).
  trustProxy: z
    .union([
      z.boolean(),
      z.number().int().min(1).max(10),
      z.array(z.string().regex(/^([0-9a-fA-F:.]+(\/\d{1,3})?|loopback|linklocal|uniquelocal)$/, 'address, subnet (CIDR) or loopback|linklocal|uniquelocal')).min(1).max(32),
    ])
    .default(false),
  https: z
    .strictObject({
      mode: z.enum(['standalone', 'reverse-proxy', 'self-signed']).default('self-signed'),
      certPath: z.string().optional(),
      keyPath: z.string().optional(),
    })
    .prefault({}),
  bodyLimit: z.string().default('1mb'),
  requestTimeoutMs: z.number().int().positive().default(30_000),
  shutdownDrainTimeoutMs: z.number().int().positive().default(10_000),
  // A listener of its own for the administration panel. With a port set, the panel answers only there (404 on the application's
  // address); `host` defaults to 127.0.0.1, so it is reachable from the machine itself or through a tunnel or VPN, not from the LAN.
  admin: z
    .strictObject({
      host: z.string().optional(),
      port: z.number().int().min(1).max(65535).optional(),
    })
    .prefault({}),
});

export const DatabaseConfigSchema = z.strictObject({
  driver: z.literal('node:sqlite').default('node:sqlite'),
  file: z.string().default('data/app.db'),
  walMode: z.boolean().default(true),
  // Opt-in: Date/boolean written as ISO string/1-0, BOOLEAN/DATE/DATETIME/TIMESTAMP columns read back as boolean/Date (see createSqliteAdapter).
  normalizeValues: z.boolean().default(false),
});

// Secrets in a backup destination are never literals in the config file: `env:NAME` only.
const EnvRef = z.string().regex(/^env:[A-Za-z_][A-Za-z0-9_]*$/, 'must be an env:NAME reference, not the secret itself');

/** `type: 'sftp'` destination options (scheduler/backup-remote.js). Needs the `ssh2` package. */
export const SftpDestinationConfigSchema = z
  .strictObject({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(22),
    username: z.string().min(1),
    // The server's host key fingerprint ("SHA256:..." as printed by ssh-keygen -lf / ssh-keyscan, or hex). Mandatory: no trust-on-first-use.
    hostKeySha256: z.string().min(20),
    remotePath: z.string().min(1),
    privateKey: EnvRef.optional(),
    privateKeyFile: z.string().min(1).optional(),
    passphrase: EnvRef.optional(),
    password: EnvRef.optional(),
    verify: z.enum(['hash', 'size']).default('hash'),
    allowUnencrypted: z.boolean().default(false),
    readyTimeoutMs: z.number().int().positive().default(20_000),
    keepaliveMs: z.number().int().positive().default(15_000),
  })
  .refine((c) => c.privateKey || c.privateKeyFile || c.password, { message: 'one of privateKey (env:), privateKeyFile or password (env:) is required' });

/** `type: 'mount'` destination options: a directory on a mounted network share (NFS/SMB/...). */
export const MountDestinationConfigSchema = z.strictObject({
  // A file that must exist in the share's root - proves it is really mounted.
  markerFile: z.string().min(1).optional(),
  // Refuse a path on the same device as the data directory unless true (tests only).
  allowSameDevice: z.boolean().default(false),
  verify: z.enum(['hash', 'size']).default('hash'),
  allowUnencrypted: z.boolean().default(false),
});

export const BackupDestinationSchema = z
  .strictObject({
    id: z.string(),
    type: z.enum(['local', 'mount', 's3', 'sftp', 'webdav']),
    path: z.string().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((d, ctx) => {
    // Declared in the enum for compatibility, but no code writes to them: refuse at `config check`, not at every backup run.
    if (d.type === 's3' || d.type === 'webdav') ctx.addIssue({ code: 'custom', path: ['type'], message: `backup type "${d.type}" is not supported yet: use "local", "mount" or "sftp"` });
    if (d.type === 'mount' && !d.path) ctx.addIssue({ code: 'custom', path: ['path'], message: 'mount destination needs "path"' });
    const schema = d.type === 'sftp' ? SftpDestinationConfigSchema : d.type === 'mount' ? MountDestinationConfigSchema : null;
    if (!schema) return;
    const r = schema.safeParse(d.config ?? {});
    if (!r.success) for (const i of r.error.issues) ctx.addIssue({ code: 'custom', path: ['config', ...i.path], message: i.message });
  });

export const BackupConfigSchema = z.strictObject({
  enabled: z.boolean().default(true),
  schedule: z.string().default('0 3 * * *'),
  destinations: z.array(BackupDestinationSchema).default([]),
  retentionDays: z.number().int().positive().default(30),
  // Passphrase (>= 16 chars) that seals every backup as `.zip.enc` (AES-256-GCM). Prefer DAS_BACKUP_KEY / DAS_BACKUP_KEY_FILE.
  encryptionKey: z.string().min(16).optional(),
});

/** Metrics for monitoring systems (Prometheus). Off by default; the endpoint is open only to `allowIps` or to the holder of the token. */
export const ObservabilityConfigSchema = z.strictObject({
  metrics: z
    .strictObject({
      enabled: z.boolean().default(false),
      path: z.string().regex(/^\/[A-Za-z0-9._\/-]*$/).default('/metrics'),
      // Bearer token for scrapers on other machines (16+ characters). Without it only `allowIps` can read the endpoint.
      token: z.string().min(16).optional(),
      allowIps: z.array(z.string().min(1)).default(['127.0.0.1', '::1', '::ffff:127.0.0.1']),
      defaultMetrics: z.boolean().default(true),
    })
    .prefault({}),
});

/** System e-mail (core/email). Off by default; when enabled, `from` and `smtp.host` are required. */
export const EmailConfigSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    from: z.string().optional(),
    // Public address of the app, used to build links in mails (https://app.example.com).
    baseUrl: z.string().url().optional(),
    replyTo: z.string().optional(),
    locale: z.enum(['ru', 'en']).default('ru'),
    smtp: z
      .strictObject({
        host: z.string().optional(),
        port: z.number().int().min(1).max(65535).default(587),
        // true = TLS from the first byte (port 465); false = STARTTLS, which `requireTLS` makes mandatory.
        secure: z.boolean().default(false),
        requireTLS: z.boolean().default(true),
        rejectUnauthorized: z.boolean().default(true),
        auth: z.strictObject({ user: z.string().min(1), pass: z.string().min(1) }).optional(),
        connectionTimeoutMs: z.number().int().positive().default(10_000),
        socketTimeoutMs: z.number().int().positive().default(30_000),
      })
      .prefault({}),
    dkim: z
      .strictObject({
        domainName: z.string().min(1),
        keySelector: z.string().min(1),
        privateKey: z.string().optional(),
        privateKeyFile: z.string().optional(),
      })
      .refine((d) => Boolean(d.privateKey) !== Boolean(d.privateKeyFile), { message: 'set exactly one of privateKey / privateKeyFile' })
      .optional(),
    // Temporary SMTP trouble (network, 4xx answers) is retried with doubling pauses; auth/recipient errors never are.
    retry: z
      .strictObject({
        attempts: z.number().int().min(1).max(10).default(3),
        baseDelayMs: z.number().int().min(0).default(500),
      })
      .prefault({}),
    // Persistent outgoing queue (email/queue.js): mails are stored in the database and sent in the background,
    // retried with doubling pauses, and survive a restart. An app opts in by passing the queue to createEmailService.
    queue: z
      .strictObject({
        enabled: z.boolean().default(true),
        maxAttempts: z.number().int().min(1).max(20).default(6),
        baseDelayMs: z.number().int().min(0).default(60_000),
        intervalMs: z.number().int().min(1000).default(15_000),
        keepFinishedDays: z.number().int().min(1).default(7),
        // A mail still waiting after this long is dropped (and its body wiped): an old reset link is useless and is personal data.
        pendingTtlHours: z.number().int().min(1).default(72),
      })
      .prefault({}),
    // Per recipient and scenario, so a brute-force run cannot flood a mailbox with "password changed".
    rateLimit: z
      .strictObject({
        perRecipientMax: z.number().int().positive().default(5),
        windowMs: z.number().int().positive().default(3_600_000),
      })
      .prefault({}),
  })
  .superRefine((cfg, ctx) => {
    if (!cfg.enabled) return;
    if (!cfg.from) ctx.addIssue({ code: 'custom', path: ['from'], message: 'email.from is required when email is enabled' });
    if (!cfg.baseUrl) ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: 'email.baseUrl is required when email is enabled (links in mails are built from it)' });
    if (!cfg.smtp.host) ctx.addIssue({ code: 'custom', path: ['smtp', 'host'], message: 'email.smtp.host is required when email is enabled' });
  });

const SinkCommon = { streams: z.array(z.enum(['app', 'access', 'audit', 'security'])).optional(), minLevel: z.enum(['debug', 'info', 'warn', 'error']).optional() };

/**
 * Where log lines go (audit 0.1.81). Without `sinks` the app keeps its own default (stdout).
 * Point at least one sink OFF the application host: whoever takes the host over can delete local files.
 */
export const LogSinkSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('stdout'), ...SinkCommon }),
  z.strictObject({
    type: z.literal('file'),
    path: z.string().min(1),
    maxBytes: z.number().int().nonnegative().default(0),
    keep: z.number().int().min(0).max(100).default(5),
    ...SinkCommon,
  }),
  z.strictObject({
    type: z.literal('syslog'),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).optional(),
    protocol: z.enum(['udp', 'tcp', 'tls']).default('udp'),
    caFile: z.string().optional(),
    rejectUnauthorized: z.boolean().default(true),
    facility: z.number().int().min(0).max(23).default(16),
    ...SinkCommon,
  }),
  z.strictObject({
    type: z.literal('http'),
    url: z
      .string()
      .url()
      .refine((u) => u.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(u), {
        message: 'log sink url must be https:// (plain http only for localhost)',
      }),
    format: z.enum(['ndjson', 'loki', 'elastic-bulk', 'splunk-hec']).default('ndjson'),
    // values may be "env:NAME" so tokens stay out of the config file
    headers: z.record(z.string(), z.string()).default({}),
    labels: z.record(z.string(), z.string()).optional(),
    index: z.string().optional(),
    source: z.string().optional(),
    timeoutMs: z.number().int().min(100).default(5000),
    ...SinkCommon,
  }),
]);

export const LoggingConfigSchema = z.strictObject({
  sinks: z.array(LogSinkSchema).default([]),
  // Every file/network sink queues lines in memory up to maxLines; beyond that the oldest (or newest) are
  // dropped - counted, and written to localFallback when set. Logging never blocks a request.
  buffer: z
    .strictObject({
      maxLines: z.number().int().min(100).default(10_000),
      batchSize: z.number().int().min(1).max(5000).default(100),
      flushIntervalMs: z.number().int().min(50).default(1000),
      retryBaseMs: z.number().int().min(50).default(1000),
      retryMaxMs: z.number().int().min(1000).default(60_000),
      onFull: z.enum(['drop-oldest', 'drop-newest']).default('drop-oldest'),
    })
    .prefault({}),
  localFallback: z.strictObject({ path: z.string().min(1), maxBytes: z.number().int().positive().default(50 * 1024 * 1024) }).optional(),
  // What the audit trail sends to the log stream `audit`: nothing, only id/hash/action (no personal data), or whole entries.
  auditMirror: z.enum(['off', 'minimal', 'full']).default('minimal'),
  // How often the audit chain head is written to the log (cron; '' = never). `audit verify --anchor-*` checks against it.
  auditAnchorSchedule: z.string().default('5 * * * *'),
});

/** The audit log holds logins, IP addresses and old/new names, so it must not grow and keep personal data forever. */
export const AuditConfigSchema = z.strictObject({
  // Rows older than this many days are deleted by the daily `audit-gc` job (0 = keep forever; then document the legal basis).
  retentionDays: z.number().int().nonnegative().default(365),
  // Personal details (the real login/IP behind each pseudonym) are erased once they have not been seen for this many days; the row
  // itself stays (who-what-when-result) and reads "[erased]" for those fields, the hash chain stays valid. 0 = keep as long as the row.
  personalDataDays: z.number().int().nonnegative().default(0),
  // Deleted in batches of this size so one run never holds the write lock for long.
  purgeBatchSize: z.number().int().min(100).max(100_000).default(5000),
  // A folder for the archive: before `audit-gc` deletes old rows they are written there (audit-<from>-<to>.ndjson.gz + .sha256). Empty = no archive.
  archiveDir: z.string().default(''),
});

/** Alerts: what is watched and how often the same alert may be mailed (`alerts` module). Recipients: `security.incidentContacts`. */
export const AlertsConfigSchema = z.strictObject({
  enabled: z.boolean().default(true),
  // The same alert is announced at most once per this many minutes; repeats only raise a counter.
  cooldownMinutes: z.number().int().positive().default(60),
  keepDays: z.number().int().positive().default(90),
  // Diagnostics (doctor) and audit-chain verification run on these schedules; false = off. The administrator can switch the
  // diagnostics off or move them to another time of day in the admin panel (About); that choice then replaces this value.
  doctorSchedule: z.union([z.string(), z.literal(false)]).default('5 3 * * *'),
  auditSchedule: z.union([z.string(), z.literal(false)]).default('15 3 * * *'),
  // Many lock-outs in a short time are reported as probable password guessing.
  lockouts: z.strictObject({
    threshold: z.number().int().positive().default(10),
    windowMinutes: z.number().int().positive().default(10),
  }).prefault({}),
});

/** Limits for the uploads directory; 0 = unlimited. */
export const UploadsConfigSchema = z.strictObject({
  maxTotalBytes: z.number().int().nonnegative().default(1024 * 1024 * 1024),
  maxFiles: z.number().int().nonnegative().default(20_000),
  // How many images are decoded/re-encoded at once; more wait in a queue, beyond it the upload gets 503 (audit I07).
  imageProcessing: z
    .strictObject({
      maxConcurrent: z.number().int().min(1).max(32).default(2),
      maxQueue: z.number().int().min(0).max(1000).default(16),
    })
    .prefault({}),
});

export const UiConfigSchema = z.strictObject({
  theme: z.string().default('default'),
  title: z.string().optional(),
  locale: z.enum(['ru', 'en']).default('ru'),
});

export const ModuleEntrySchema = z.strictObject({
  name: z.string(),
  enabled: z.boolean().default(true),
  options: z.record(z.string(), z.unknown()).optional(),
});

/** Dependency vulnerability check of the diagnostics (doctor): which advisories the operator has accepted, and the Node.js release check. */
export const DependencyAuditConfigSchema = z.strictObject({
  enabled: z.boolean().default(true),
  // Advisories accepted for now: `{ id: 'GHSA-xxxx-xxxx-xxxx', reason: '...', until: '2026-12-31' }`; after `until` they count again.
  ignore: z.array(z.strictObject({ id: z.string().min(1), reason: z.string().default(''), until: z.string().optional() })).default([]),
  // Compare the running Node.js with the release index of nodejs.org (needs the network; offline it only warns).
  checkNode: z.boolean().default(true),
});

export const SecurityConfigSchema = z.strictObject({
  // Fresh confirmation (password, plus the authenticator code when enrolled) before dangerous administration actions: see admin.createStepUp.
  stepUp: z
    .strictObject({
      enabled: z.boolean().default(false),
      maxAgeMinutes: z.number().int().min(1).max(120).default(10),
    })
    .prefault({}),
  // Secret rotation: when each key was created (ISO date). The doctor warns when a configured key is older than `maxAgeDays`.
  secretsRotation: z
    .strictObject({
      maxAgeDays: z.number().int().min(30).max(3650).default(365),
      sessionSecretCreatedAt: z.string().date().optional(),
      totpKeyCreatedAt: z.string().date().optional(),
      backupKeyCreatedAt: z.string().date().optional(),
    })
    .prefault({}),
  dependencyAudit: DependencyAuditConfigSchema.prefault({}),
  // /.well-known/security.txt (RFC 9116): where a researcher should report a vulnerability. Served only when `contact` is set.
  securityTxt: z
    .strictObject({
      contact: z.array(z.string().min(3)).max(5).default([]), // mailto:, https:// or tel: ; a bare address becomes mailto:
      policy: z.string().url().optional(),                    // link to the disclosure policy (e.g. SECURITY.md in the repository)
      expires: z.string().datetime().optional(),              // ISO date-time; unset = 180 days from the request
      preferredLanguages: z.array(z.string().min(2).max(8)).max(5).default(['ru', 'en']),
      canonical: z.string().url().optional(),
    })
    .prefault({}),
  // Stricter Content-Security-Policy sent next to the real one in report-only mode (nothing is blocked); violations go to the audit log.
  csp: z
    .strictObject({
      reportOnly: z.boolean().default(false),
      reportPath: z.string().regex(/^\/[\w\-./]*$/).default('/csp-report'),
    })
    .prefault({}),
  cors: z.strictObject({ origins: z.array(z.string()).default([]) }).prefault({}),
  csrf: z.boolean().default(true),
  rateLimit: z
    .strictObject({
      windowMs: z.number().int().positive().default(60_000),
      max: z.number().int().positive().default(300),
    })
    .prefault({}),
  // Stricter budget for credential endpoints (/login, /login/totp,
  // /login/recovery) on top of the general one above.
  loginRateLimit: z
    .strictObject({
      windowMs: z.number().int().positive().default(60_000),
      max: z.number().int().positive().default(10),
    })
    .prefault({}),
  // Exponential lockout after repeated credential failures: the
  // `maxFailures`-th miss locks for baseLockMs (5 min), every further miss
  // doubles it up to maxLockMs (24 h) (see core/http createFailureTracker).
  lockout: z
    .strictObject({
      maxFailures: z.number().int().positive().default(5),
      baseLockMs: z.number().int().positive().default(5 * 60_000),
      maxLockMs: z.number().int().positive().default(24 * 3_600_000),
      // quiet time after which the miss counter starts again from zero
      resetAfterMs: z.number().int().positive().default(24 * 3_600_000),
    })
    .prefault({}),
  incidentContacts: z.array(z.string().email()).default([]),
});

export const AuthConfigSchema = z.strictObject({
  sessionSecret: z.string().min(16, 'sessionSecret must be at least 16 characters'),
  // After rotating sessionSecret keep the old value here: cookies signed with it still verify
  // (and are re-signed with the new one), so nobody is logged out by the rotation.
  previousSessionSecrets: z.array(z.string().min(16)).default([]),
  // Key that encrypts TOTP secrets in the database. Unset = derived from sessionSecret (older behaviour:
  // rotating sessionSecret then breaks every TOTP login - set a dedicated key and keep old ones below).
  totpEncryptionKey: z.string().min(16).optional(),
  previousTotpEncryptionKeys: z.array(z.string().min(16)).default([]),
  sessionTtlMs: z.number().int().positive().default(1000 * 60 * 60 * 8),
  // Self-registration (off by default). With `requireEmailConfirmation` (default) an account exists only after the
  // mailed link is opened, which is what keeps bots out; switching it off creates accounts at once, for closed networks.
  registration: z
    .strictObject({
      enabled: z.boolean().default(false),
      requireEmailConfirmation: z.boolean().default(true),
      role: z.string().min(1).default('operator'),
      ttlHours: z.number().int().positive().default(24),
      minFillMs: z.number().int().nonnegative().default(2000),
    })
    .prefault({}),
  // Name the session cookie `__Host-das_session`: browsers then refuse to set or overwrite it from a sibling
  // sub-domain or over plain HTTP. Needs HTTPS (reverse-proxy or self-signed); sign-in over plain HTTP stops working.
  hostCookiePrefix: z.boolean().default(false),
  // On sign-out tell the browser to drop its cached pages and site storage (`Clear-Site-Data: "cache", "storage"`; the cookies stay, the device mark among them).
  clearSiteDataOnLogout: z.boolean().default(false),
  // E-mail the account owner when a sign-in comes from a browser not seen before (only when e-mail is enabled and the account has an address).
  newDeviceNotice: z.boolean().default(true),
  // Session dies after this long without a request (0 = off). Absolute TTL above still applies.
  // Password rules for apps that call auth.checkPasswordPolicy (lengths are in characters).
  // Leaked-password list on disk ("Pwned Passwords" format `SHA1:count`, sorted by hash); a password found in it is refused. Nothing is sent anywhere.
  passwordBlocklistFile: z.string().min(1).optional(),
  passwordPolicy: z
    .strictObject({
      // Used until an administrator saves the policy in the admin panel; 12 characters is the default for everyone.
      minLength: z.number().int().min(8).default(12),
      adminMinLength: z.number().int().min(8).default(12),
      requireClasses: z.number().int().min(0).max(4).default(0),
      // Days a password may live (0 = unlimited) and how many previous passwords may not come back (0 = none, at most 24).
      maxAgeDays: z.number().int().min(0).max(3650).default(0),
      historyCount: z.number().int().min(0).max(24).default(0),
      maxLength: z.number().int().min(8).max(1024).default(128),
    })
    .prefault({}),
  sessionIdleTimeoutMs: z.number().int().nonnegative().default(1000 * 60 * 60),
  argon2: z
    .strictObject({
      memoryCost: z.number().int().positive().default(19456),
      timeCost: z.number().int().positive().default(2),
      parallelism: z.number().int().positive().default(1),
      // Password hashes/checks running at once; the rest wait (up to maxQueue), more are refused with 503.
      // argon2 runs on libuv's thread pool (UV_THREADPOOL_SIZE, 4 by default): keep this below it.
      maxConcurrent: z.number().int().min(1).max(64).default(2),
      maxQueue: z.number().int().min(0).max(10_000).default(64),
    })
    .prefault({}),
  totp: z.strictObject({ enabled: z.boolean().default(false) }).prefault({}),
});

export const PerformanceConfigSchema = z.strictObject({
  budgets: z
    .strictObject({
      p95HealthMs: z.number().positive().default(20),
      p95ApiMs: z.number().positive().default(150),
    })
    .prefault({}),
});

export const ApplicationConfigSchema = z.strictObject({
  appName: z.string(),
  env: z.enum(['development', 'test', 'production']).default('development'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  server: ServerConfigSchema.prefault({}),
  database: DatabaseConfigSchema.prefault({}),
  backup: BackupConfigSchema.prefault({}),
  uploads: UploadsConfigSchema.prefault({}),
  email: EmailConfigSchema.prefault({}),
  observability: ObservabilityConfigSchema.prefault({}),
  audit: AuditConfigSchema.prefault({}),
  alerts: AlertsConfigSchema.prefault({}),
  logging: LoggingConfigSchema.prefault({}),
  ui: UiConfigSchema.prefault({}),
  modules: z.array(ModuleEntrySchema).default([]),
  security: SecurityConfigSchema.prefault({}),
  auth: AuthConfigSchema,
  performance: PerformanceConfigSchema.prefault({}),
});
