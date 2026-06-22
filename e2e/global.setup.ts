import { test as setup, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com';
// Prefer an explicit e2e override; otherwise reuse the seeded admin password
// (loaded from .env by playwright.config.ts) so the harness matches whatever
// `db:seed` created. Final fallback keeps CI defaults working.
const ADMIN_PASSWORD =
  process.env.E2E_ADMIN_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD ?? 'loadless';
const STORAGE_PATH = path.join(__dirname, '.auth', 'admin.json');

setup('admin storage state', async ({ page }) => {
  // A cold Next dev server must compile /login then /admin on first hit, which
  // can take well over the default 30s — give the whole setup room.
  setup.setTimeout(120_000);
  fs.mkdirSync(path.dirname(STORAGE_PATH), { recursive: true });

  // Retry the sign-in: on a cold/slow dev server the form can be clicked before
  // React hydrates, which submits it natively (no SPA navigation, creds land in
  // the query string) and never reaches /admin. Wait for the page to settle,
  // submit, and re-try if we didn't navigate.
  for (let attempt = 0; ; attempt++) {
    await page.goto('/login', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000); // let hydration attach the submit handler
    await page.locator('#email').fill(ADMIN_EMAIL);
    await page.locator('#password').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    try {
      // 'commit' (not the default 'load'): sign-in is a client-side router.push,
      // so no fresh page-load event fires — waiting for 'load' would hang.
      await page.waitForURL('**/admin**', { timeout: 25_000, waitUntil: 'commit' });
      break;
    } catch (err) {
      if (attempt >= 2) throw err;
    }
  }
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();

  await page.context().storageState({ path: STORAGE_PATH });
});
