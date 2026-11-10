import path from 'node:path';
import { health, certs, email, scheduler } from '@das-forge/core';

/**
 * The `doctor` checks of THIS application. Built here, not in the core: the core knows how to check a generic
 * database, directory or configuration, never which directories matter to a particular application. Add your own
 * category (a queue, an integration) as another `{ name, run }`.
 *
 * Takes a `() => db` getter, because `backup restore` replaces the live connection mid-process.
 */
export function buildDoctorCategories(ctx, getDb, { inProcess = false, logger = null } = {}) {
  const localBackupDirs = Object.fromEntries(
    ctx.appConfig.backup.destinations
      .filter((d) => d.type === 'local')
      .map((d) => [`backup:${d.id}`, { path: path.resolve(ctx.repoRoot, d.path), optional: true }]),
  );
  return [
    { name: 'Runtime', run: () => health.runtimeChecks() },
    { name: 'Database', run: () => health.databaseChecks(getDb(), { migrationsDir: ctx.migrationsDir }) },
    { name: 'Storage', run: () => health.storageChecks({ data: path.dirname(path.resolve(ctx.repoRoot, ctx.appConfig.database.file)), ...localBackupDirs }) },
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
    { name: 'Application', run: () => health.applicationChecks({ host: ctx.appConfig.server.host, port: ctx.appConfig.server.port, inProcess }) },
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
    { name: 'Integrations', run: () => email.emailChecks(ctx.appConfig.email, ctx.emailService) },
  ];
}
