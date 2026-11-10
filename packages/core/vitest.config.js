// node:sqlite support requires vitest >=3.0.0 (see package.json and
// docs/roadmap.md §12-15) - no special config needed here once that
// version requirement is met; the bug was in vite-node itself, not
// something fixable from a consuming project's config.
export default {
  test: {
    environment: 'node',
    // First use of a lazily imported heavy dependency (jsdom for SVG, sharp)
    // can take several seconds on a cold Windows machine.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
};
