import { test } from '@playwright/test';

// TODO: signed-in coverage is out of scope for the initial suite. It needs:
//   - TEST_EMAIL / TEST_PASSWORD env vars (never a real user's account)
//   - a test-account strategy: dedicated Supabase test user, seeded fixtures,
//     and cleanup so specs stay idempotent against the production project
// Until then this file is a placeholder so the suite shape is visible.

test.skip('signed-in: my-binders lists the account binders', async () => {
  // Sign in via account.html, then assert #bindersWrap renders.
});

test.skip('signed-in: account page shows the profile editor', async () => {
  // Sign in, open account.html, assert profile fields are populated.
});
