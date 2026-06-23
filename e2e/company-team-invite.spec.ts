import { test, expect, request as pwRequest } from '@playwright/test';
import { API_BASE, adminApiContext, loginAs, provisionCompanyOwner, unwrap } from './helpers';

/**
 * Company team management through the REAL UI: an owner invites a teammate via the
 * dialog, the temp password is shown once, and the new member appears in the team
 * list (verified through the API too). Scoped to a freshly-provisioned company, so
 * it can't perturb other specs.
 */

test.describe('company team invite (through the UI)', () => {
  test.setTimeout(120_000);
  test.use({ storageState: { cookies: [], origins: [] } });

  test('owner invites a teammate and it appears in the team list', async ({ page }) => {
    // --- Setup (API): fresh company + owner ---
    const { api, csrf } = await adminApiContext();
    const { ownerEmail, tempPassword } = await provisionCompanyOwner({ api, csrf });
    const newPassword = 'team-pass-12345';

    // --- UI: owner onboards (forced password change), lands on /app ---
    await loginAs(page, ownerEmail, tempPassword, '/change-password');
    await page.locator('#currentPassword').fill(tempPassword);
    await page.locator('#newPassword').fill(newPassword);
    await page.locator('#confirmPassword').fill(newPassword);
    await page.getByRole('button', { name: /save and sign in again/i }).click();
    await page.waitForURL(/\/login/, { timeout: 15_000 });
    await loginAs(page, ownerEmail, newPassword, '/app');

    // --- UI: invite a teammate ---
    const inviteeEmail = `member-${Date.now().toString(36)}@example.com`;
    await page.goto('/app/team', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1, h2').filter({ hasText: /team/i }).first()).toBeVisible({
      timeout: 30_000,
    });

    await page.getByRole('button', { name: /invite member/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.locator('#email').fill(inviteeEmail);
    // Default role is MANAGER — accept it. Submit.
    await dialog.getByRole('button', { name: 'Invite', exact: true }).click();

    // Success view shows the one-time temp password, then "Done".
    await expect(dialog.getByText(/invite sent/i)).toBeVisible({ timeout: 15_000 });
    await dialog.getByRole('button', { name: /done/i }).click();
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    // The new member shows in the table.
    await expect(page.locator('table').getByText(inviteeEmail)).toBeVisible({ timeout: 15_000 });

    // --- Assert (API): member exists with the COMPANY_MANAGER role ---
    const owner = await pwRequest.newContext({
      baseURL: API_BASE,
      storageState: await page.context().storageState(),
    });
    try {
      const res = await owner.get('/v1/company/team');
      expect(res.ok()).toBeTruthy();
      const members = unwrap(await res.json()).data as Array<{ email: string; role: string }>;
      const invited = members.find((m) => m.email === inviteeEmail);
      expect(invited, 'invited member is listed').toBeTruthy();
      expect(invited!.role).toBe('COMPANY_MANAGER');
    } finally {
      await owner.dispose();
      await api.dispose();
    }
  });
});
