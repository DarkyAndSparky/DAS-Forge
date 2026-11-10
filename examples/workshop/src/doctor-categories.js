import path from 'node:path';
import { health, certs, email, scheduler } from '@das-forge/core';

/**
 * The doctor category list for THIS app. Deliberately built here, not
 * inside core/health - core only knows how to check a generic
 * DatabaseAdapter/directory/config shape, never which directories or
 * config fields matter to a specific app. A ported real app
 * (procure-it, atlas-ao, ...) builds its own list the same way,
 * optionally adding categories core doesn't know about yet (e.g. an
 * "Integrations" category once @das-forge/ldap exists).
 *
 * Takes a () => db getter rather than a db value directly, because
 * `backup restore` replaces the live connection mid-process (see
 * main() below) - a category built with a stale closed-over db would
 * silently check the wrong (closed) connection after a restore.
 */
export function buildDoctorCategories(ctx, getDb, { inProcess = false, logger = null, scheduler: liveScheduler = null } = {}) {
  const localBackupDirs = Object.fromEntries(
    ctx.appConfig.backup.destinations
      .filter((d) => d.type === 'local')
      .map((d) => [`backup:${d.id}`, { path: path.resolve(ctx.repoRoot, d.path), optional: true }])
  );

  return [
    { name: 'Runtime', run: () => health.runtimeChecks() },
    { name: 'Database', run: () => health.databaseChecks(getDb(), { migrationsDir: ctx.migrationsDir }) },
    {
      name: 'Storage',
      run: () =>
        health.storageChecks({
          data: path.dirname(path.resolve(ctx.repoRoot, ctx.appConfig.database.file)),
          ...localBackupDirs,
        }),
    },
    { name: 'Security', run: () => health.securityChecks(ctx.appConfig) },
    {
      name: 'Hardening',
      run: () => {
        const dbFile = path.resolve(ctx.repoRoot, ctx.appConfig.database.file);
        return health.hardeningChecks({
          appConfig: ctx.appConfig,
          db: getDb(),
          lastBackupAt: () => {
            const t = scheduler.listBackups(ctx.appConfig.backup.destinations ?? []).map((b) => Date.parse(b.createdAt)).filter(Number.isFinite).sort((a, b) => b - a)[0];
            return t ? new Date(t).toISOString() : null;
          },
          secretFiles: { database: dbFile, ...(ctx.certDir ? { 'certificate key': certs.certFilePaths(ctx.certDir).keyPath } : {}) },
          secretDirs: { data: path.dirname(dbFile) },
        });
      },
    },
    {
      name: 'Application',
      run: async () => [...(await health.applicationChecks({ host: ctx.appConfig.server.host, port: ctx.appConfig.server.port, inProcess })), ...(inProcess ? scheduler.standardJobsChecks(liveScheduler) : [])],
    },
    // Closes the gap core/health §11b explicitly left open ("ждут
    // несуществующих пока core/certs") - now that core/certs exists,
    // its certChecks() slots in as an ordinary doctor category, same
    // shape as the built-in ones above.
    ...(ctx.appConfig.security.dependencyAudit.enabled
      ? [{
          name: 'Dependencies',
          run: async () => [
            ...(await health.dependencyChecks({ lockFile: path.resolve(ctx.repoRoot, 'package-lock.json'), db: getDb(), ignore: ctx.appConfig.security.dependencyAudit.ignore, logger })),
            ...(ctx.appConfig.security.dependencyAudit.checkNode ? await health.nodeVersionChecks({ logger }) : []),
          ],
        }]
      : []),
    { name: 'Certificate', run: () => certs.certChecks(ctx.certPath) },
    // Mail: SMTP login/reachability and the sender domain's SPF/DMARC records.
    { name: 'Integrations', run: () => email.emailChecks(ctx.appConfig.email, ctx.emailService) },
  ];
}
