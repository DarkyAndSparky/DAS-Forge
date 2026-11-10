/**
 * Example app.config.js - this is the file core/config's loadConfig()
 * reads. In this example app it lives at the repo root (the default
 * lookup path); a real app would put its own here with real secrets
 * coming from environment overrides (see core/config/env.js), never
 * committed as plain text for production.
 */
export default {
  appName: 'workshop',
  env: 'development',
  server: {
    port: 9002,        // HTTPS; the plain-HTTP redirect listens on 9001 (port - 1)
  },
  database: {
    file: 'data/workshop.db',
  },
  backup: {
    schedule: '0 3 * * *',
    destinations: [{ id: 'local-1', type: 'local', path: 'data/backups' }],
    retentionDays: 14,
  },
  auth: {
    // In real deployments this MUST come from an environment variable
    // (DAS_SESSION_SECRET, see core/config/env.js) - hardcoded here only
    // because this is a throwaway local example, never for production.
    sessionSecret: 'example-only-session-secret-change-me-32chars',
  },
};
