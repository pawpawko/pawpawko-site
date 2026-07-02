import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // happy-dom gives the classic scripts (js/escape.js, js/config.js) the
    // `window` they attach to. Playwright specs live in tests/e2e and are
    // run by `npm run e2e`, not Vitest.
    environment: 'happy-dom',
    include: ['tests/unit/**/*.test.js'],
  },
});
