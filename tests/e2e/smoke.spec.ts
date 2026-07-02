import { test, expect, type Page } from '@playwright/test';

// Anonymous smoke suite: pages render their signed-out UI and throw no
// uncaught errors. Hits production Supabase with the public anon key —
// read-only only; never sign up or write data from these specs.

function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  return errors;
}

test('index.html renders the hero and nav', async ({ page }) => {
  const errors = trackPageErrors(page);
  await page.goto('/index.html');

  await expect(page.locator('.hero-title')).toContainText('Pawpaw');
  await expect(page.locator('nav.nav .nav-links')).toBeVisible();
  await expect(page.locator('.nav-links a[href="trades.html"]')).toBeVisible();

  expect(errors).toEqual([]);
});

test('trades.html shows the category tabs', async ({ page }) => {
  const errors = trackPageErrors(page);
  await page.goto('/trades.html');

  const tabs = page.locator('#categoryTabs .category-tab');
  await expect(tabs.first()).toBeVisible();
  expect(await tabs.count()).toBeGreaterThanOrEqual(2);
  await expect(tabs.filter({ hasText: 'OPTCG' })).toHaveCount(1);

  expect(errors).toEqual([]);
});

test('my-binders.html shows the signed-out demo carousel', async ({ page }) => {
  const errors = trackPageErrors(page);
  await page.goto('/my-binders.html');

  // Hidden until js/my-binders.js confirms there is no session.
  await expect(page.locator('#signedOutPreview')).toBeVisible();
  await expect(page.locator('#signedOutPreview .demo-header')).toContainText('demo binders');
  await expect(page.locator('#binderCarousel')).toBeVisible();

  expect(errors).toEqual([]);
});

test('decks.html shows the signed-out demo deck', async ({ page }) => {
  const errors = trackPageErrors(page);
  await page.goto('/decks.html');

  await expect(page.locator('#signedOutPreview')).toBeVisible();
  await expect(page.locator('#signedOutPreview .demo-header')).toContainText('demo test deck');
  // js/decks.js swaps the [data-pk-demo="deck"] stub for the real editor.
  await expect(page.locator('#signedOutPreview #editorWrap')).toBeVisible();

  expect(errors).toEqual([]);
});
