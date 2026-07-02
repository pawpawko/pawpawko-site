// ESLint flat config for the pawpawko-site vanilla-JS browser code.
// The js/ files are classic scripts (no modules): they communicate through
// window.* globals declared below. Rules are tuned so the CURRENT code lints
// clean — tighten them as the code is cleaned up, don't mass-rewrite for lint.

import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/', 'playwright-report/', 'test-results/', 'tests/e2e/'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: {
        ...globals.browser,
        // App globals (window.* assignments; see js/config.js and js/supabase-client.js)
        supabase: 'readonly', // @supabase/supabase-js UMD bundle (CDN)
        sb: 'readonly', // Supabase client instance
        SB_READY: 'readonly',
        PK: 'readonly', // auth + escape helpers namespace
        PKDemo: 'readonly', // js/demos.js
        PKDemoExport: 'readonly', // js/decks.js demo hook
        escapeHtml: 'readonly', // js/escape.js
        PAWPAWKO_CONFIG: 'readonly',
        CITIES: 'readonly',
        BOROUGHS_BY_CITY: 'readonly',
        NYC_BOROUGHS: 'readonly',
        NYC_MAJOR_SUBWAY_STOPS: 'readonly',
        NYC_MAJOR_SUBWAY_STOPS_BY_BOROUGH: 'readonly',
        BINDER_CATEGORIES: 'readonly',
        LISTING_TYPES: 'readonly',
      },
      sourceType: 'script',
    },
    rules: {
      // The codebase leans on try {} catch (e) {} guards (theme/localStorage etc.)
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Loop counters and caught errors are often declared-but-unused today;
      // keep visibility without failing the build.
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      // Flags a couple of build-up-then-reassign spots in existing app code
      // (js/main.js, js/binder-view.js); not worth rewriting live code for.
      'no-useless-assignment': 'off',
    },
  },
  {
    // js/escape.js is dual-environment: browser script + CJS export for Vitest.
    files: ['js/escape.js'],
    languageOptions: {
      globals: { module: 'readonly' },
    },
  },
  {
    // Node-side files (configs, unit tests)
    files: ['*.mjs', 'tests/**/*.js', 'tests/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
];
