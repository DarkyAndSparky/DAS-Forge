import { sendError } from './respond.js';
import { listenServer } from './server.js';

/**
 * Where the administration panel listens. With `server.admin.port` set the panel gets a listener of its own
 * (default address `127.0.0.1`: reachable from this machine, or through an SSH tunnel or a VPN, not from the office
 * network), and the application's ordinary address no longer serves it. Without `server.admin.port` the panel is on
 * the application's address, as before.
 * @returns {{host: string, port: number} | null}
 */
export function resolveAdminListener(serverConfig) {
  const a = serverConfig?.admin;
  if (!a?.port) return null;
  const host = a.host ?? '127.0.0.1';
  const taken = new Set([serverConfig.port, serverConfig.httpRedirectPort].filter((n) => Number.isInteger(n)));
  if (!a.host && taken.has(a.port)) throw new Error(`server.admin.port ${a.port} is already used by the application`);
  if (a.host === serverConfig.host && taken.has(a.port)) throw new Error(`server.admin.port ${a.port} is already used by the application on the same address`);
  return { host, port: a.port };
}

/**
 * The addresses the admin listener binds. The default loopback address is bound in both families, so `localhost`
 * opens the panel whether the system resolves it to 127.0.0.1 or to ::1; any other address is bound as given.
 */
export function adminHosts(host) {
  if (host === '127.0.0.1' || host === 'localhost') return ['127.0.0.1', '::1'];
  if (host === '::1') return ['::1', '127.0.0.1'];
  return [host];
}

/**
 * Starts the admin listener(s). The first address must succeed; the companion loopback address is best effort
 * (a machine without IPv6 simply skips it, `onSkip` is told).
 *
 * @param {object} o
 * @param {() => import('node:net').Server} o.createServer - makes one server for the application (same app and certificate each time)
 * @param {{host: string, port: number}} o.address - from resolveAdminListener
 * @param {(host: string, err: Error) => void} [o.onSkip]
 * @returns {Promise<{servers: import('node:net').Server[], bound: {host: string, port: number}[], close: () => Promise<void>}>}
 */
export async function listenAdmin({ createServer, address, onSkip }) {
  const servers = [];
  const bound = [];
  for (const [i, host] of adminHosts(address.host).entries()) {
    const server = createServer();
    try {
      await listenServer(server, { host, port: address.port });
      servers.push(server);
      bound.push({ host, port: address.port });
    } catch (err) {
      if (i === 0) { for (const s of servers) s.close(); throw err; }
      onSkip?.(host, err);
    }
  }
  const close = () => Promise.all(servers.map((s) => new Promise((resolve) => s.close(() => resolve())))).then(() => undefined);
  return { servers, bound, close };
}

/**
 * Hides the administration panel on every listener except the admin one: a request for `prefixes` that arrives on any other
 * port answers 404, exactly like a page that does not exist (the panel is not announced). Mount it first.
 *
 * @param {object} o
 * @param {number} o.port - the admin listener's port
 * @param {string[]} [o.prefixes=['/admin']]
 */
export function adminGate({ port, prefixes = ['/admin'] } = {}) {
  if (!Number.isInteger(port)) throw new TypeError('adminGate: port is required');
  const hit = (p) => prefixes.some((x) => p === x || p.startsWith(`${x}/`));
  return (req, res, next) => {
    const path = String(req.path ?? req.url ?? '').split('?')[0];
    const local = req.socket?.localPort;
    if (hit(path) && local !== port) return sendError(req, res, 404, { error: 'NOT_FOUND', fields: [] });
    return next();
  };
}
