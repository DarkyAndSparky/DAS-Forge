/**
 * Runtime category: is the Node.js process itself new enough and on an
 * expected platform. Cheap, synchronous, no I/O - safe to run first in
 * every doctor invocation.
 *
 * @param {object} [opts]
 * @param {number} [opts.minNodeMajor=26] - package.json's engines.node
 *   floor (core requires >=26.0.0 for native node:sqlite)
 */
export function runtimeChecks({ minNodeMajor = 26 } = {}) {
  const nodeVersion = process.versions.node;
  const nodeMajor = parseInt(nodeVersion.split('.')[0], 10);

  return [
    {
      name: 'Node.js version',
      status: nodeMajor >= minNodeMajor ? 'ok' : 'fail',
      message:
        nodeMajor >= minNodeMajor
          ? `v${nodeVersion}`
          : `v${nodeVersion} (requires >=${minNodeMajor}.0.0)`,
    },
    {
      name: 'Platform',
      status: 'ok',
      message: `${process.platform}/${process.arch}`,
    },
  ];
}
