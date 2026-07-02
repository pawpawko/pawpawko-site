import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';

// Local dev credentials for the signed-in suite (tests/e2e/signed-in.spec.ts).
// Untracked (.gitignore covers .env.*.local); CI injects TEST_EMAIL /
// TEST_PASSWORD from repo secrets instead. dotenv never overrides variables
// that are already set, so CI wins.
dotenv.config({ path: path.resolve(__dirname, '.env.e2e.local'), quiet: true });

// Serves the static site the same way local dev does (README: python -m
// http.server). Port 8010 so it never collides with the manual :8000 server.
// NOTE: pages talk to the production Supabase project with the public anon
// key — anon specs must stay read-only. The signed-in suite writes only under
// its dedicated test account and cleans up after itself.
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
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
