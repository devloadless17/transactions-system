import { test as setup, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'ali@loadless.ai';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'loadless';
const STORAGE_PATH = path.join(__dirname, '.auth', 'admin.json');

setup('admin storage state', async ({ page }) => {
  fs.mkdirSync(path.dirname(STORAGE_PATH), { recursive: true });

  await page.goto('/login');
  await page.locator('#email').fill(ADMIN_EMAIL);
  await page.locator('#password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Generous timeout: first-time Next dev compile of /admin can take 20s+
  // after the initial redirect from /login.
  await page.waitForURL('**/admin', { timeout: 45_000 });
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();

  await page.context().storageState({ path: STORAGE_PATH });
});
