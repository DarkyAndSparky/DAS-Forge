export { assertAuthProvider } from './adapter.js';
export { createAuthProvider } from './auth-provider.js';
export { hashPassword, verifyPassword, pbkdf2Scheme, scryptScheme, scryptSaltColumnScheme, configurePasswordConcurrency, passwordConcurrencyStats, PasswordBusyError } from './password.js';
export { destroyUserSessions, hashSessionId, purgeExpiredSessions } from './sessions.js';
export { createSessionStore, loadExpressSession } from './session-store.js';
export {
  countUsers,
  findUserByUsername,
  findUserById,
  findUserByEmail,
  createUser,
  updatePasswordHash,
  setUserRole,
  setTotpSecret,
  anonymizeUser,
  deleteUser,
} from './users.js';
export { sealSecret, openSecret, isSealed, sealExistingTotpSecrets } from './secret-box.js';
export { createPasswordResetToken, peekPasswordResetToken, consumePasswordResetToken, purgePasswordResetTokens } from './password-reset.js';
export { checkPasswordPolicy, characterClasses, PASSWORD_ABSOLUTE_MAX } from './password-policy.js';
export { createPasswordBlocklist } from './password-blocklist.js';
export { recordPassword, recentPasswordHashes, passwordExpired } from './password-history.js';
export { createPasswordPolicy, PasswordPolicyError, PASSWORD_PROFILES } from './password-policy-store.js';
export { generateTotpSecret, generateTotp, verifyTotp, matchTotpStep, buildTotpUri } from './totp.js';
export {
  listAuthenticators,
  startTotpEnrollment,
  verifyTotpEnrollment,
  verifyTotpLogin,
  removeAuthenticator,
  purgeExpiredPendingAuthenticators,
} from './authenticators.js';
export { generateRecoveryCodes, verifyAndConsumeRecoveryCode, countRemainingRecoveryCodes } from './recovery-codes.js';
export { firstRunBootstrap, writeBootstrapCredentials } from './bootstrap.js';
export { UserSchema, SessionSchema, AuthenticatorSchema, RecoveryCodeSchema, ensureAuthTables } from './schema.js';
export {
  UserAdminError,
  validateUsername,
  isAnonymizedUser,
  generateTempPassword,
  countActiveAdmins,
  listUsers,
  getManagedUser,
  createManagedUser,
  renameUser,
  setUserEmail,
  changeUserRole,
  setUserDisabled,
  resetUserPassword,
  forceUserLogout,
  removeUser,
} from './user-admin.js';
