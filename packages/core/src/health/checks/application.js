import net from 'node:net';

/**
 * Tries to bind `port` briefly to see if it's free. Resolves `true` if
 * a listener could be opened (and immediately closes it again), `false`
 * on any bind error or if nothing happens within `timeoutMs`.
 */
function isPortFree(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;

    const finish = (free) => {
      if (settled) return;
      settled = true;
      server.removeAllListeners();
      server.close(() => resolve(free));
    };

    const timer = setTimeout(() => finish(false), timeoutMs);
    server.once('error', () => {
      clearTimeout(timer);
      finish(false);
    });
    server.once('listening', () => {
      clearTimeout(timer);
      finish(true);
    });
    server.listen(port, host);
  });
}

/**
 * Application category: is the configured port free to bind. This is
 * advisory, not a hard failure ('warn', not 'fail').
 *
 * `inProcess` says the check runs inside the server itself (the admin "About" page, the scheduled doctor).
 * There a busy port is the expected state, so it reports ok ("in use by this application"), and a FREE
 * port is the odd one: the server is not listening where the configuration says.
 *
 * @param {object} opts
 * @param {string} [opts.host='127.0.0.1']
 * @param {number} opts.port
 * @param {number} [opts.timeoutMs=500]
 * @param {boolean} [opts.inProcess=false]
 */
export async function applicationChecks({ host = '127.0.0.1', port, timeoutMs = 500, inProcess = false } = {}) {
  if (port == null) return [];

  const free = await isPortFree(host, port, timeoutMs);
  if (inProcess) {
    return [
      {
        name: 'Port availability',
        status: free ? 'warn' : 'ok',
        message: free
          ? `${host}:${port} is free: this application is not listening on its configured port`
          : `${host}:${port} in use by this application`,
      },
    ];
  }
  return [
    {
      name: 'Port availability',
      status: free ? 'ok' : 'warn',
      message: free
        ? `${host}:${port} available`
        : `${host}:${port} already in use (expected if the server is already running)`,
    },
  ];
}
