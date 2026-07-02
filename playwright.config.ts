import { defineConfig, devices } from '@playwright/test';

// Serves the static site the same way local dev does (README: python -m
// http.server). Port 8010 so it never collides with the manual :8000 server.
// NOTE: pages talk to the production Supabase project with the public anon
// key — specs must stay read-only (no sign-ups, no writes).
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:8010',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'python -m http.server 8010',
    url: 'http://localhost:8010/index.html',
    reuseExistingServer: !process.env.CI,
  },
});
