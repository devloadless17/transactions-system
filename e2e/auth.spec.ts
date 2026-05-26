import { test, expect } from '@playwright/test';
import { ADMIN_EMAIL } from './helpers';

test.describe('auth', () => {
  test('signed-in admin redirected from /login to /admin', async ({ page }) => {
    // Storage state is already authenticated.
    await page.goto('/login');
    await expect(page).toHaveURL(/\/admin$/);
  });

  // Negative cases need a clean session.
  test.describe('without session', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test('unauthenticated root redirects to /login', async ({ page }) => {
      await page.goto('/');
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    });

    test('wrong password shows an error and stays on /login', async ({ page }) => {
      await page.goto('/login');
      await page.locator('#email').fill(ADMIN_EMAIL);
      await page.locator('#password').fill('not-the-real-password');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByText(/Invalid credentials/i)).toBeVisible({ timeout: 5_000 });
    });
  });
});
