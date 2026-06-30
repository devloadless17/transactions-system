import { test, expect } from '@playwright/test';

// The Whish payer landing pages are PUBLIC: an anonymous payer returns here from
// whish.money after paying. They must render without a session and WITHOUT
// bouncing through /login (the middleware now excludes /pay). Nothing covered
// them before — this pins that the payer's final step is never a redirect, a
// blank, or the generic app error/loading, and that the reference round-trips.
test.describe('whish payer landing pages (public, no session)', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('/pay/success renders the confirmation + reference, with no login redirect', async ({
    page,
  }) => {
    await page.goto('/pay/success?ref=99001');
    await expect(page).toHaveURL(/\/pay\/success/); // not redirected to /login
    await expect(page.getByRole('heading', { name: /Payment successful/i })).toBeVisible();
    await expect(page.getByText('#99001')).toBeVisible();
  });

  test('/pay/failure renders the failure notice + reference, with no login redirect', async ({
    page,
  }) => {
    await page.goto('/pay/failure?ref=99002');
    await expect(page).toHaveURL(/\/pay\/failure/);
    await expect(page.getByRole('heading', { name: /Payment not completed/i })).toBeVisible();
    await expect(page.getByText('#99002')).toBeVisible();
  });
});
