/**
 * Defaults of the exposure profile (A1). With `server.exposure: 'internet'`, settings the application did not write
 * get the stricter value below; a value the application wrote always wins (and `doctor` complains if it is weaker).
 * Applied to the plain configuration BEFORE validation, so "not written" is still visible.
 *
 * | setting                    | lan (default) | internet                               |
 * |----------------------------|---------------|----------------------------------------|
 * | auth.hostCookiePrefix      | false         | true (`__Host-das_session`)             |
 * | ipBan.maxFailures          | 10 (policy)   | 6, but at least lockout.maxFailures + 1 |
 * | server.outbound.allowPrivate | true        | false (`outboundPolicyFromConfig`)      |
 *
 * Not defaulted here because a value cannot be invented: the administration address (`server.admin.port` and
 * `allowedNets`), the separate TOTP key and HTTPS; `doctor` fails the profile when they are missing.
 * A second factor for administrators is NOT forced by the profile: it stays the application's decision.
 */
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * @param {object} plain - merged configuration, not yet validated
 * @returns {{config: object, applied: string[]}} a copy and the dotted paths that were filled in
 */
export function applyExposureProfile(plain) {
  if (!isObj(plain) || plain.server?.exposure !== 'internet') return { config: plain, applied: [] };
  const config = structuredClone(plain);
  const applied = [];
  const setIfAbsent = (path, value) => {
    const parts = path.split('.');
    let o = config;
    for (const p of parts.slice(0, -1)) {
      if (!isObj(o[p])) { if (o[p] !== undefined) return; o[p] = {}; }
      o = o[p];
    }
    const last = parts.at(-1);
    if (o[last] === undefined) { o[last] = value; applied.push(path); }
  };
  setIfAbsent('auth.hostCookiePrefix', true);
  const lock = config.auth?.lockout?.maxFailures ?? 5; // schema default of lockout.maxFailures
  setIfAbsent('ipBan.maxFailures', Math.min(1000, Math.max(6, lock + 1)));
  return { config, applied };
}
