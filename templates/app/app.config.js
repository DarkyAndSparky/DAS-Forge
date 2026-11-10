/**
 * The configuration core/config's loadConfig() reads. Everything has a safe default; this file only says what is
 * specific to the application. Secrets never go here in production: set DAS_SESSION_SECRET (or
 * DAS_SESSION_SECRET_FILE) in the environment instead; see the "Configuration" guide.
 */
export default {
  appName: 'my-app',
  env: 'development',
  server: {
    // Platform convention: HTTPS on 9N02, the plain-HTTP redirect on 9N01. Take the next free hundred
    // after the applications that already exist (workshop 9002, IT Assets 9102, ...).
    port: 9902,
  },
  database: {
    file: 'data/my-app.db',
  },
  backup: {
    schedule: '0 3 * * *',
    destinations: [{ id: 'local-1', type: 'local', path: 'data/backups' }],
    retentionDays: 14,
  },
  auth: {
    // Development only. In production the secret comes from the environment (DAS_SESSION_SECRET).
    sessionSecret: 'development-only-session-secret-change-me-32chars',
  },
};
