import { test, expect } from '@playwright/test';

// PhoneInput on the admin Transfer Money send form (admin storage state is a
// SUPER_ADMIN, which the page requires). Locators use `.first()` throughout: the
// app renders a single PhoneInput, but under full-suite load Playwright can catch
// a transient render frame with two, and `.first()` keeps the test deterministic.
test.describe('phone input (admin Transfer Money)', () => {
  test('country selector sticks with an empty number (no snap back to Lebanon)', async ({
    page,
  }) => {
    await page.goto('/admin/transfer-money');

    const country = page.getByLabel('Country code').first();
    await expect(country).toBeVisible();
    await expect(country).toHaveValue('LB'); // default Lebanon +961

    // Picking a country while the number field is empty used to reset to Lebanon
    // (empty number → '' carries no dial code); it must now stick.
    await country.selectOption('FR');
    await expect(country).toHaveValue('FR');

    await country.selectOption('GB');
    await expect(country).toHaveValue('GB');

    // Typing a national number keeps the chosen country.
    await page.getByPlaceholder('71 505 894').first().fill('7700900123');
    await expect(country).toHaveValue('GB');
  });

  test('Lebanon accepts 7–8 digits — caps overflow, flags too-short', async ({ page }) => {
    await page.goto('/admin/transfer-money');

    const number = page.getByPlaceholder('71 505 894').first();
    await expect(number).toBeVisible();
    await expect(page.getByLabel('Country code').first()).toHaveValue('LB');

    // More than 8 digits is capped to 8 — a wrong-length number can't be entered.
    await number.fill('71505894999');
    await expect(number).toHaveValue('71505894');
    await expect(number).not.toHaveAttribute('aria-invalid', 'true');

    // Too short (< 7) is flagged before it can be submitted.
    await number.fill('715');
    await expect(number).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText('Lebanon numbers are 7 or 8 digits').first()).toBeVisible();

    // A valid 7-digit number (the older 03-prefix case → +961 3 XXXXXX) is accepted.
    await number.fill('3123456');
    await expect(number).not.toHaveAttribute('aria-invalid', 'true');

    // A valid 8-digit number is also accepted.
    await number.fill('71505894');
    await expect(number).not.toHaveAttribute('aria-invalid', 'true');
  });
});
