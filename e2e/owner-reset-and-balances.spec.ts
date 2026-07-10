import { test, expect, request as pwRequest } from '@playwright/test';
import {
  API_BASE,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  adminApiContext,
  getCsrf,
  loginAs,
  provisionCompanyOwner,
  unwrap,
} from './helpers';

/**
 * Covers the three features shipped in 840d747 / 7932156 / b91ac07, which the
 * pre-existing suite does not touch:
 *   1. SUPER_ADMIN sees an "Available balance" column + an all-companies total.
 *   2. Balances are withheld from ADMIN_OPERATOR / BACKOFFICE (authorization).
 *   3. A COMPANY_OWNER can reset a teammate's password; the credential really
 *      rotates and the old one dies.
 *   4. Non-owners get no team controls at all.
 */

const cash = () => ({
  method: 'CASH',
  recipientName: 'E2E Payee',
  recipientPhone: '+9610000000',
  pickupLocation: 'E2E Branch',
});

/** Format a decimal string the way the web's `formatMoney` does for < 1000. */
const trim = (s: string) => String(parseFloat(s));

test.describe('super admin: company balances', () => {
  test.setTimeout(120_000);

  test('balance column + all-companies total, matching the wallet', async ({ page }) => {
    const { api, csrf } = await adminApiContext();
    const { companyId } = await provisionCompanyOwner({ api, csrf });

    // Fund the company with a silent admin direct-load.
    const load = await api.post(`${API_BASE}/v1/admin/loads`, {
      headers: { 'x-csrf-token': csrf },
      data: { companyId, amount: '500', currency: 'USD', payout: cash() },
    });
    expect(load.ok()).toBeTruthy();

    // The wallet is the source of truth for what the UI must render.
    const wRes = await api.get(`${API_BASE}/v1/admin/companies/${companyId}/wallets`);
    const wallets = unwrap<{ data: Array<{ currency: string; availableBalance: string }> }>(
      await wRes.json(),
    ).data;
    const usd = wallets.find((w) => w.currency.trim() === 'USD')!;
    expect(parseFloat(usd.availableBalance)).toBeGreaterThan(0);

    // The API only returns balances when explicitly asked (perf opt-in).
    const noFlag = unwrap<{ totals?: unknown }>(
      await (await api.get(`${API_BASE}/v1/admin/companies?page=1&pageSize=5`)).json(),
    );
    expect(noFlag.totals).toBeUndefined();
    const withFlag = unwrap<{ totals?: Array<{ currency: string; availableBalance: string }> }>(
      await (
        await api.get(`${API_BASE}/v1/admin/companies?page=1&pageSize=5&withBalances=true`)
      ).json(),
    );
    expect(withFlag.totals?.length).toBeGreaterThan(0);

    // A stray value must degrade to "no balances", NOT 400 the whole list.
    const odd = await api.get(`${API_BASE}/v1/admin/companies?page=1&pageSize=5&withBalances=1`);
    expect(odd.status()).toBe(200);
    expect(unwrap<{ totals?: unknown }>(await odd.json()).totals).toBeUndefined();

    // --- UI (admin storageState from the setup project) ---
    await page.goto('/admin/companies', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('columnheader', { name: /available balance/i })).toBeVisible({
      timeout: 30_000,
    });

    // The funded company's row shows exactly its wallet balance.
    const row = page.getByRole('row').filter({ hasText: trim(usd.availableBalance) });
    await expect(row.first()).toBeVisible({ timeout: 15_000 });

    // The totals row covers EVERY company, not just this page.
    const footer = page.locator('tfoot');
    await expect(footer).toContainText(/Total available/i);
    await expect(footer).toContainText(/all \d+ compan/i);
    await expect(footer).toContainText('USD');
  });
});

test.describe('balances are SUPER_ADMIN-only', () => {
  test.setTimeout(120_000);
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const role of ['ADMIN_OPERATOR', 'BACKOFFICE'] as const) {
    test(`${role} lists companies but receives no balances or totals`, async () => {
      const { api, csrf } = await adminApiContext();
      const email = `${role.toLowerCase()}-${Date.now().toString(36)}@example.com`;
      const created = unwrap<{ temporaryPassword: string }>(
        await (
          await api.post(`${API_BASE}/v1/admin/users`, {
            headers: { 'x-csrf-token': csrf },
            data: { email, role },
          })
        ).json(),
      );

      // Rotate the forced temp password, then sign in for real.
      const ctx = await pwRequest.newContext({ baseURL: API_BASE });
      await ctx.post('/v1/auth/login', { data: { email, password: created.temporaryPassword } });
      const c1 = await getCsrf(ctx);
      const newPassword = 'role-pass-12345';
      await ctx.post('/v1/auth/change-password', {
        headers: { 'x-csrf-token': c1 },
        data: { currentPassword: created.temporaryPassword, newPassword },
      });
      await ctx.post('/v1/auth/login', { data: { email, password: newPassword } });

      // Even explicitly asking for balances must not yield them.
      const res = await ctx.get('/v1/admin/companies?page=1&pageSize=5&withBalances=true');
      expect(res.status()).toBe(200);
      const body = unwrap<{
        data: Array<{ balances?: unknown }>;
        totals?: unknown;
      }>(await res.json());

      expect(body.data.length).toBeGreaterThan(0); // can still see the tenants
      expect(body.totals).toBeUndefined(); // but never the money
      for (const c of body.data) expect(c.balances).toBeUndefined();
      await ctx.dispose();
    });
  }
});

test.describe('company owner resets a teammate password (through the UI)', () => {
  test.setTimeout(180_000);
  test.use({ storageState: { cookies: [], origins: [] } });

  test('reset rotates the credential, kills the old one, and hides self/non-owner actions', async ({
    page,
  }) => {
    const { api, csrf } = await adminApiContext();
    const { ownerEmail, tempPassword } = await provisionCompanyOwner({ api, csrf });
    const ownerPassword = 'owner-pass-12345';

    // Owner onboards through the forced password change.
    await loginAs(page, ownerEmail, tempPassword, '/change-password');
    await page.locator('#currentPassword').fill(tempPassword);
    await page.locator('#newPassword').fill(ownerPassword);
    await page.locator('#confirmPassword').fill(ownerPassword);
    await page.getByRole('button', { name: /save and sign in again/i }).click();
    await page.waitForURL(/\/login/, { timeout: 15_000 });
    await loginAs(page, ownerEmail, ownerPassword, '/app');

    // Invite a manager and capture the one-time password from the dialog.
    const memberEmail = `member-${Date.now().toString(36)}@example.com`;
    await page.goto('/app/team', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /invite member/i }).click();
    const inviteDialog = page.getByRole('dialog');
    await inviteDialog.locator('#email').fill(memberEmail);
    await inviteDialog.getByRole('button', { name: /^invite$/i }).click();
    const invitePassword = (await inviteDialog.locator('.font-mono').first().innerText()).trim();
    expect(invitePassword.length).toBeGreaterThan(8);
    await inviteDialog.getByRole('button', { name: 'Done', exact: true }).click();

    // Owner may reset the teammate — but NOT themselves: exactly one button.
    await expect(page.getByRole('button', { name: /reset password/i })).toHaveCount(1);
    const ownerRow = page.getByRole('row').filter({ hasText: ownerEmail });
    await expect(ownerRow.getByRole('button', { name: /reset password/i })).toHaveCount(0);

    // Reset the teammate and capture the new one-time password.
    await page.getByRole('button', { name: /reset password/i }).click();
    const resetDialog = page.getByRole('dialog');
    await expect(resetDialog).toContainText(/signed out of all sessions/i);

    // Data-loss guard: while the reset is in flight the dialog must NOT close
    // (ESC / outside-click ignored, Cancel disabled) — otherwise the one-time
    // password would be minted server-side and thrown away, locking the user out.
    await resetDialog.getByRole('button', { name: /^reset password$/i }).click();
    await expect(resetDialog.getByRole('button', { name: /^cancel$/i })).toBeDisabled();
    await expect(resetDialog).toContainText(/temporary password/i, { timeout: 15_000 });
    const newTemp = (await resetDialog.locator('.font-mono').first().innerText()).trim();
    expect(newTemp).not.toBe(invitePassword);

    // The credential really rotated: new one works, old one is dead.
    const ctx = await pwRequest.newContext({ baseURL: API_BASE });
    const okLogin = await ctx.post('/v1/auth/login', {
      data: { email: memberEmail, password: newTemp },
    });
    expect(okLogin.status()).toBe(200);
    const deadLogin = await ctx.post('/v1/auth/login', {
      data: { email: memberEmail, password: invitePassword },
    });
    expect(deadLogin.status()).toBe(401);
    await ctx.dispose();

    // --- The manager (non-owner) gets NO team controls at all ---
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    const managerPassword = 'manager-pass-12345';
    await loginAs(page, memberEmail, newTemp, '/change-password');
    await page.locator('#currentPassword').fill(newTemp);
    await page.locator('#newPassword').fill(managerPassword);
    await page.locator('#confirmPassword').fill(managerPassword);
    await page.getByRole('button', { name: /save and sign in again/i }).click();
    await page.waitForURL(/\/login/, { timeout: 15_000 });
    await loginAs(page, memberEmail, managerPassword, '/app');

    await page.goto('/app/team', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('row').filter({ hasText: memberEmail }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole('button', { name: /invite member/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /reset password/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /disable|reactivate/i })).toHaveCount(0);
    // Role is plain text, not an editable control that would 403.
    await expect(page.locator('select')).toHaveCount(0);
  });
});

test.describe('owner cannot reset their own password via the API', () => {
  test.setTimeout(120_000);
  test.use({ storageState: { cookies: [], origins: [] } });

  test('self-reset is 403; cross-tenant and platform-admin targets are 404', async () => {
    const { api, csrf } = await adminApiContext();
    const a = await provisionCompanyOwner({ api, csrf });
    const b = await provisionCompanyOwner({ api, csrf });

    const login = async (email: string, temp: string, next: string) => {
      const ctx = await pwRequest.newContext({ baseURL: API_BASE });
      await ctx.post('/v1/auth/login', { data: { email, password: temp } });
      const c = await getCsrf(ctx);
      await ctx.post('/v1/auth/change-password', {
        headers: { 'x-csrf-token': c },
        data: { currentPassword: temp, newPassword: next },
      });
      await ctx.post('/v1/auth/login', { data: { email, password: next } });
      return { ctx, csrf: await getCsrf(ctx) };
    };

    const ownerA = await login(a.ownerEmail, a.tempPassword, 'a-pass-12345');
    const ownerB = await login(b.ownerEmail, b.tempPassword, 'b-pass-12345');

    const meA = unwrap<{ id: string }>(await (await ownerA.ctx.get('/v1/auth/me')).json());
    const meB = unwrap<{ id: string }>(await (await ownerB.ctx.get('/v1/auth/me')).json());

    // Self → 403 (must use change-password, which proves the current one).
    const self = await ownerA.ctx.post(`/v1/company/team/${meA.id}/reset-password`, {
      headers: { 'x-csrf-token': ownerA.csrf },
    });
    expect(self.status()).toBe(403);

    // Another company's owner → 404 (no existence oracle).
    const cross = await ownerA.ctx.post(`/v1/company/team/${meB.id}/reset-password`, {
      headers: { 'x-csrf-token': ownerA.csrf },
    });
    expect(cross.status()).toBe(404);

    // A platform admin (companyId NULL) → 404, never an escalation.
    const adminMe = unwrap<{ id: string }>(await (await api.get(`${API_BASE}/v1/auth/me`)).json());
    const esc = await ownerA.ctx.post(`/v1/company/team/${adminMe.id}/reset-password`, {
      headers: { 'x-csrf-token': ownerA.csrf },
    });
    expect(esc.status()).toBe(404);

    // Missing CSRF → 403 even for a legitimate owner.
    const noCsrf = await ownerA.ctx.post(`/v1/company/team/${meB.id}/reset-password`);
    expect(noCsrf.status()).toBe(403);

    await ownerA.ctx.dispose();
    await ownerB.ctx.dispose();
    void ADMIN_EMAIL;
    void ADMIN_PASSWORD;
  });
});
