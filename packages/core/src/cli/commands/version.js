/**
 * `app version [--json]`. Deliberately takes a plain version string
 * rather than reading package.json itself - core doesn't know which
 * package.json belongs to the app embedding it (examples/workshop vs.
 * a real ported app), so the caller (bin/app.js) reads its own
 * package.json and passes the string in, same pattern as `health`'s
 * `version` option.
 *
 * `[sync]` from §4.1 (checking the running server's reported version
 * against this build) is NOT implemented - that needs the running
 * server to be reachable over HTTP, which is `health`'s job, not a
 * static CLI print; a real `version sync` would call `GET /health` and
 * diff versions, which is reasonable future work once there's an actual
 * use case driving it, rather than guessed at now.
 */
export function registerVersionCommand(cli, { version }) {
  cli.command('version', {
    description: 'Print the installed version',
    handler({ flags }) {
      // eslint-disable-next-line no-console
      console.log(flags.json ? JSON.stringify({ version }) : version);
      return 0;
    },
  });
}
