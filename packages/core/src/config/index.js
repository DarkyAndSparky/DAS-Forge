export { loadConfig, validateConfig } from './load.js';
export { ConfigValidationError } from './errors.js';
export { applyExposureProfile } from './profile.js';
export {
  ApplicationConfigSchema,
  ServerConfigSchema,
  DatabaseConfigSchema,
  BackupConfigSchema,
  BackupDestinationSchema,
  UiConfigSchema,
  ModuleEntrySchema,
  SecurityConfigSchema,
  AuthConfigSchema,
  PerformanceConfigSchema,
  UploadsConfigSchema,
  EmailConfigSchema,
} from './schema.js';
export { describeSources, schemaDefaults } from './sources.js';
