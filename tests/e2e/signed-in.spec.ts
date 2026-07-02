import { test, expect, type BrowserContext, type Page } from '@playwright/test';

// Signed-in e2e suite. Drives the real pages against the PRODUCTION Supabase
// project under a dedicated test account (TEST_EMAIL / TEST_PASSWORD), so:
//   - flows create only the rows they need, tagged with a unique run suffix
//   - afterAll deletes every binder + deck the account owns via authed REST
//     (the account exists solely for this suite, so that is always safe)
//   - the auth user itself is persistent and never deleted
// Skips cleanly when the credentials are absent (e.g. a fork without secrets).
//
// The whole file is one serial group sharing a single page, so the Supabase
// session from the sign-in test carries through the later flows — exactly how
// a real user moves through the site.

// Mirrors js/config.js — the anon key is public by design (RLS gates access).
const SUPABASE_URL = 'https://cligjmfhxvazjarbvexp.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_MbXa-DQ33D9VSMHhHho0Xg_kZ65QHtt';

const EMAIL = process.env.TEST_EMAIL;
const PASSWORD = process.env.TEST_PASSWORD;

const SUFFIX = Date.now().toString(36);
const BINDER_NAME = `e2e-${SUFFIX}`;
// Stable code that is both a searchable card and a One Piece leader.
const CARD_CODE = 'OP01-001';

let token = '';
let userId = '';
let deckId: string | null = null;
let context: BrowserContext;
let page: Page;

// Authed PostgREST/GoTrue helper for setup + cleanup — more robust than
// driving the UI for teardown.
async function rest(
  pathname: string,
  init: { method?: string; body?: unknown; prefer?: string } = {},
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${SUPABASE_URL}${pathname}`, {
    method: init.method ?? 'GET',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.prefer ? { Prefer: init.prefer } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function deleteAllTestRows() {
  // Decks first, then binders (listings cascade with their binder).
  await rest(`/rest/v1/decks?user_id=eq.${userId}`, { method: 'DELETE' });
  await rest(`/rest/v1/binders?user_id=eq.${userId}`, { method: 'DELETE' });
}

test.describe('signed-in flows', () => {
  test.describe.configure({ mode: 'serial', timeout: 60_000 });
  test.skip(!EMAIL || !PASSWORD, 'TEST_EMAIL / TEST_PASSWORD not set');

  test.beforeAll(async ({ browser }) => {
    // REST sign-in: fail fast with a useful message, and keep the token for
    // setup + cleanup.
    const { status, json } = await rest('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: { email: EMAIL, password: PASSWORD },
    });
    if (status !== 200 || !json?.access_token) {
      const code = json?.error_code || json?.msg || `HTTP ${status}`;
      throw new Error(
        code === 'email_not_confirmed'
          ? `Test account ${EMAIL} has not confirmed its email yet — open the ` +
            'Supabase confirmation email sent to that address, click the link, then re-run.'
          : `Could not sign in the test account via REST (${code}).`,
      );
    }
    token = json.access_token;
    userId = json.user.id;

    // Profile-setup gate (js/main.js enforceProfileSetup): every page redirects
    // to account.html until profiles.display_name_set is true. Idempotent
    // self-heal so a freshly confirmed account passes without manual setup.
    const patch = await rest(`/rest/v1/profiles?user_id=eq.${userId}`, {
      method: 'PATCH',
      body: { display_name_set: true, display_name: 'E2E Tester' },
      prefer: 'return=representation',
    });
    expect(patch.status, 'profile-setup gate PATCH should succeed').toBe(200);

    // Pre-clean leftovers from a previous crashed run so the one-trade-binder-
    // per-game and one-deck-per-leader uniques can never block this run.
    await deleteAllTestRows();

    context = await browser.newContext();
    page = await context.newPage();
  });

  test.afterAll(async () => {
    if (token && userId) {
      await deleteAllTestRows();
      // Verify nothing was left behind (the account should own zero rows).
      const decks = await rest(`/rest/v1/decks?user_id=eq.${userId}&select=id`);
      const binders = await rest(`/rest/v1/binders?user_id=eq.${userId}&select=id`);
      expect(decks.json, 'cleanup should leave no decks').toEqual([]);
      expect(binders.json, 'cleanup should leave no binders').toEqual([]);
    }
    await context?.close();
  });

  test('signs in via the account page and the nav flips to signed-in', async () => {
    await page.goto('/account.html');
    await page.locator('.auth-tab[data-tab="login"]').click();
    await page.locator('#loginEmail').fill(EMAIL!);
    await page.locator('#loginPassword').fill(PASSWORD!);
    await page.locator('#loginForm button[type="submit"]').click();

    // account.js sends set-up profiles straight to trades.html after sign-in.
    await page.waitForURL('**/trades.html', { timeout: 20_000 });
    // html.is-signed-in is the source of truth for the nav's auth state; the
    // toHaveClass poll rides out the one-frame renderAuthButton reconciliation.
    await expect(page.locator('html')).toHaveClass(/is-signed-in/, { timeout: 15_000 });
    await expect(page.locator('.nav-profile-icon')).toBeVisible();
    await expect(page.locator('.nav-auth-btn')).toBeHidden();
  });

  test('creates a binder on my-binders', async () => {
    await page.goto('/my-binders.html');
    await expect(page.locator('#bindersWrap')).toBeVisible({ timeout: 20_000 });

    await page.locator('#newBinderBtn').click();
    await page.locator('#newBinderName').fill(BINDER_NAME);
    await page.locator('#newBinderCategory .pill-choice-btn[data-value="optcg"]').click();
    // Flair stays on the default (Trade Binder).
    await page.locator('#newBinderForm button[type="submit"]').click();

    await expect(
      page.locator('.binder-card-name').filter({ hasText: BINDER_NAME }),
    ).toBeVisible({ timeout: 20_000 });
  });

  test('adds a card to the binder via the card browser', async () => {
    await page.locator('.binder-card-link').filter({ hasText: BINDER_NAME }).click();
    await page.waitForURL('**/binder.html?id=*', { timeout: 20_000 });
    await expect(page.locator('#binderTitle')).toContainText(BINDER_NAME, { timeout: 20_000 });

    await page.locator('#editBtn').click(); // "Edit Binder" → card browser
    await page.locator('#cbName').fill(CARD_CODE);
    await page
      .locator('#cbGrid .cb-tile')
      .filter({ hasText: CARD_CODE })
      .first()
      .click();

    await expect(page.locator('#addListingModal')).toBeVisible();
    await page.locator('#alSave').click(); // "Add to Binder"

    // The listing insert refreshes the binder grid; the new tile renders there.
    await expect(
      page.locator('#cardGrid .card-tile .card-tile-code').filter({ hasText: CARD_CODE }),
    ).toBeVisible({ timeout: 20_000 });
  });

  test('creates a One Piece deck and the editor opens with validity', async () => {
    await page.goto('/decks.html');
    await expect(page.locator('#decksWrap')).toBeVisible({ timeout: 20_000 });

    await page.locator('.add-deck-tile').click();
    await expect(page.locator('#ndOverlay')).toBeVisible();
    // Eternal keeps the picked leader searchable regardless of Standard
    // rotation, so the spec never goes stale when sets rotate out.
    await page.locator('#ndFormat .pill-choice-btn[data-value="eternal"]').click();
    await page.locator('#leaderSearch').fill(CARD_CODE);
    await page.locator('#leaderResults li').filter({ hasText: CARD_CODE }).first().click();

    // createDeck() runs the decks .insert().select() RLS path (silently broken
    // 06-14 → 07-01) and then opens the editor at decks.html?deck=<id>.
    await page.waitForURL(/decks\.html\?deck=/, { timeout: 20_000 });
    deckId = new URL(page.url()).searchParams.get('deck');
    expect(deckId, 'deck id should be in the editor URL').toBeTruthy();

    await expect(page.locator('#editorWrap')).toBeVisible();
    // Validity indicator (deck_validity RPC → "N/50 cards · N owned · N missing").
    await expect(page.locator('#edCounts')).toContainText('/50 cards', { timeout: 20_000 });
  });
});
