const js = require('@eslint/js');
const globals = require('globals');

/** Globals each extension script defines for the scripts loaded after it. */
const EXTENSION_GLOBALS = {
  NeuroShieldSettings: 'readonly',
  NeuroShieldDetector: 'readonly',
  NeuroShieldSampler: 'readonly',
  NeuroShieldOverlay: 'readonly',
  NeuroShieldGuards: 'readonly',
  NeuroShieldContent: 'readonly',
  NeuroShieldTabs: 'readonly',
};

const SHARED_RULES = {
  'no-unused-vars': ['error', { varsIgnorePattern: '^NeuroShield', caughtErrors: 'none', argsIgnorePattern: '^_' }],
  'no-redeclare': ['error', { builtinGlobals: false }],
  eqeqeq: ['error', 'always'],
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-new-func': 'error',
  'no-throw-literal': 'error',
  'no-var': 'off', // each script exports its module through one top-level var
  'prefer-const': 'error',
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-restricted-properties': [
    'error',
    { property: 'innerHTML', message: 'Build DOM with createElement (see CONTRIBUTING.md).' },
    { property: 'outerHTML', message: 'Build DOM with createElement (see CONTRIBUTING.md).' },
    { property: 'insertAdjacentHTML', message: 'Build DOM with createElement (see CONTRIBUTING.md).' },
  ],
};

module.exports = [
  { ignores: ['node_modules/', 'dist/', 'test-results/', 'playwright-report/'] },
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.webextensions, ...EXTENSION_GLOBALS },
    },
    rules: { ...SHARED_RULES, strict: ['error', 'function'] },
  },
  {
    files: ['src/background/**/*.js'],
    languageOptions: { globals: { ...globals.serviceworker, ...globals.webextensions, ...EXTENSION_GLOBALS } },
  },
  {
    files: ['test/**/*.js', 'scripts/**/*.js', 'playwright.config.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: { ...SHARED_RULES, 'no-restricted-properties': 'off' },
  },
  {
    // Functions passed to page.evaluate() run in the browser.
    files: ['test/e2e/**/*.js', 'scripts/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser, chrome: 'readonly', ...EXTENSION_GLOBALS } },
    // Playwright reads fixture dependencies from the destructuring pattern: `async ({}, use) =>`.
    rules: { 'no-empty-pattern': 'off' },
  },
];
