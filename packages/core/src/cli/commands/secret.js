import { flagInt } from '../arg-parser.js';

/**
 * `app secret generate [--bytes n] [--count n]`: prints random secrets (base64url) for auth.sessionSecret,
 * auth.totpEncryptionKey and backup.encryptionKey. Nothing is written anywhere; the person pastes the value into
 * the secret store or an environment variable.
 * @param {object} cli
 * @param {{generate?: (bytes:number)=>string}} [o] - `generate` is replaceable in tests
 */
export function registerSecretCommands(cli, { generate } = {}) {
  cli.command('secret generate', {
    description: 'Print a new random secret (for sessionSecret, totpEncryptionKey, backup key)',
    usage: '[--bytes n] [--count n]',
    handler({ flags }) {
      const bytes = flagInt(flags, 'bytes', { min: 16, max: 128 }) ?? 32;
      const count = flagInt(flags, 'count', { min: 1, max: 20 }) ?? 1;
      const make = generate ?? (async (n) => (await import('../../config/secrets.js')).generateSecret(n));
      return Promise.resolve().then(async () => {
        for (let i = 0; i < count; i += 1) {
          // eslint-disable-next-line no-console
          console.log(await make(bytes));
        }
        return 0;
      });
    },
  });
}
