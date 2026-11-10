// ESLint 10, flat config. Deliberately self-contained: no @eslint/js and no `globals` package, so the only new
// dependency is `eslint` itself. The rule set catches real mistakes (undefined names, unused values, dead code,
// duplicate keys) and leaves style alone.
const nodeGlobals = Object.fromEntries([
  'process', 'console', 'Buffer', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate',
  'queueMicrotask', 'structuredClone', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'AbortController', 'AbortSignal',
  'fetch', 'Headers', 'Request', 'Response', 'FormData', 'Blob', 'performance', 'globalThis', 'atob', 'btoa', 'crypto',
  'WebAssembly', 'Event', 'EventTarget', 'BroadcastChannel', 'MessageChannel', 'DOMException', 'ReadableStream', 'WritableStream',
  'TransformStream', 'CompressionStream', 'DecompressionStream', 'navigator', 'WebSocket',
].map((n) => [n, 'readonly']));

export default [
  { ignores: ['**/node_modules/**', '**/data/**', '**/coverage/**', 'docs/**', '**/public/**', '**/dist/**'] },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: nodeGlobals },
    linterOptions: { reportUnusedDisableDirectives: 'warn' },
    rules: {
      // real bugs
      'no-undef': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-dupe-else-if': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',
      'no-self-assign': 'error',
      'no-self-compare': 'error',
      'no-cond-assign': ['error', 'except-parens'],
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-func-assign': 'error',
      'no-import-assign': 'error',
      'no-const-assign': 'error',
      'no-unsafe-finally': 'error',
      'no-unsafe-negation': 'error',
      'no-sparse-arrays': 'error',
      'no-prototype-builtins': 'error',
      'no-fallthrough': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-implied-eval': 'error',
      // off on purpose: control characters in regular expressions are how the core strips them from input
      'no-control-regex': 'off',
      // untidiness that hides bugs: warnings, they do not fail the build
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // output goes through the logger or the CLI's own helpers; the places that print on purpose carry a directive
      'no-console': 'warn',
      'no-useless-assignment': 'warn',
      'no-unassigned-vars': 'warn',
      'preserve-caught-error': 'warn',
    },
  },
  {
    // tests build functions from page scripts on purpose (to check that they parse)
    files: ['**/test/**/*.js'],
    rules: { 'no-new-func': 'off', 'no-console': 'off' }, // tests spy on console
  },
  {
    files: ['scripts/**/*.mjs'],
    rules: { 'no-console': 'off' }, // command-line scripts print by design
  },
];
