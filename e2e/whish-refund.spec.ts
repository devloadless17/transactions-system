import { test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import {
  adminApiContext,
  createCommissionRule,
  createSourceKey,
  expect,
  findSourceId,
  getCsrf,
  getJson,
  ingestTransaction,
  loginAs,
  loginOwnerApiContext,
  mutate,
  provisionCompanyOwner,
  provisionPlatformUser,
} from './helpers';

/**
 * Refunding a paid Whish Pay payment, end to end in the browser, against the
 * fake Whish server (scripts/fake-whish.cjs — no real money, no sandbox). Every
 * outcome Whish can give a refund is driven through its control endpoints:
 * refunded, refused, "not authorized", a lost reply, no answer at all, a
 * double click, and a payment refunded in Whish's own portal.
 *
 * Needs the API pointed at the fake (WHISH_BASE_URL=http://localhost:4100/
 * itel-service/api) — the whole group skips when the fake is not reachable.
 */

const FAKE = process.env.E2E_FAKE_WHISH_URL ?? 'http://localhost:4100';
// Same base URL as playwright.config.ts — a hand-made context does not inherit `use`.
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${process.env.WEB_PORT ?? '3000'}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fake(path: string): Promise<any> {
  const res = await fetch(`${FAKE}${path}`);
  return res.json();
}
async function refundCallsFor(externalId: string): Promise<number> {
  const { refundCalls } = await fake('/__received');
  return (refundCalls as Array<{ externalId: string }>).filter((c) => c.externalId === externalId)
    .length;
}

type Admin = Awaited<ReturnType<typeof adminApiContext>>;
interface Paid {
  id: string;
  externalId: string;
  transactionId: string;
}

async function whishRow(page: Page, externalId: string) {
  await page.goto('/admin/whish');
  await page.getByPlaceholder(/Search invoice/i).fill(externalId);
  const row = page.locator('tr', { hasText: `#${externalId}` });
  await expect(row).toBeVisible({ timeout: 20_000 });
  return row;
}

async function refundFromWhishPage(page: Page, externalId: string, reason = 'Customer cancelled') {
  const row = await whishRow(page, externalId);
  await row.getByRole('button', { name: 'Refund', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('#refund-reason').fill(reason);
  await dialog.getByRole('button', { name: /^Refund / }).click();
  return { row, dialog };
}

async function signInAs(
  browser: Browser,
  email: string,
  password: string,
  landing: '/admin' | '/app' = '/admin',
): Promise<Page> {
  const ctx = await browser.newContext({
    baseURL: BASE_URL,
    storageState: { cookies: [], origins: [] },
  });
  const page = await ctx.newPage();
  await loginAs(page, email, password, landing);
  return page;
}

const OWNER_PASSWORD = 'E2e!owner-refund-123';

test.describe.serial('Whish refunds — every answer Whish can give', () => {
  test.setTimeout(120_000);

  let admin: Admin;
  let owner: APIRequestContext;
  let ownerCsrf: string;
  let companyId: string;
  let slug: string;
  let ownerEmail: string;

  /** A Whish Pay link the customer paid, settled into the company's wallet. */
  async function paidPayment(amount = '40.00'): Promise<Paid> {
    await fake('/__set-status?s=success');
    const created = await mutate(owner, ownerCsrf, 'post', '/v1/company/whish/payments', {
      amount,
      currency: 'USD',
      invoice: `e2e-refund-${Date.now().toString(36)}`,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const settled = await mutate(
      admin.api,
      admin.csrf,
      'post',
      `/v1/admin/whish/payments/${created.body.id}/refresh-status`,
    );
    expect(settled.body.status).toBe('PAID');
    return {
      id: created.body.id,
      externalId: created.body.externalId,
      transactionId: settled.body.transactionId,
    };
  }

  const payment = (id: string) => getJson(admin.api, `/v1/admin/whish/payments/${id}`);
  const deposit = (id: string) => getJson(admin.api, `/v1/admin/transactions/${id}`);
  const available = async () =>
    Number(
      (await getJson(admin.api, `/v1/admin/companies/${companyId}/wallets`)).data[0]
        .availableBalance,
    );

  test.beforeAll(async () => {
    try {
      await fake('/__reset');
    } catch {
      test.skip(true, `fake Whish not reachable at ${FAKE} — start scripts/fake-whish.cjs`);
    }
    admin = await adminApiContext();
    const co = await provisionCompanyOwner(admin);
    companyId = co.companyId;
    slug = co.slug;
    await createCommissionRule(admin.api, admin.csrf, {
      companyId,
      operationType: 'TRANSACTION',
      feeApplication: 'DEDUCTED',
      minAmount: '0',
      maxAmount: null,
      commissionType: 'PERCENTAGE',
      commissionValue: '2',
    });
    ownerEmail = co.ownerEmail;
    owner = await loginOwnerApiContext(co.ownerEmail, co.tempPassword, OWNER_PASSWORD);
    ownerCsrf = await getCsrf(owner);
  });
  test.beforeEach(async () => {
    await fake('/__set-refund?mode=ok');
    await fake('/__set-status?s=success');
  });
  test.afterAll(async () => {
    await owner?.dispose();
    await admin?.api.dispose();
  });

  test('only a PAID payment offers Refund', async ({ page }) => {
    await fake('/__set-status?s=pending');
    const pending = await mutate(owner, ownerCsrf, 'post', '/v1/company/whish/payments', {
      amount: '15.00',
      currency: 'USD',
      invoice: 'e2e-pending',
    });
    expect(pending.status).toBe(201);
    const row = await whishRow(page, pending.body.externalId);
    await expect(row.getByRole('button', { name: 'Refresh' })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Refund', exact: true })).toHaveCount(0);
  });

  test('a refund returns the money through Whish and reverses the deposit', async ({
    page,
    browser,
  }) => {
    const p = await paidPayment('40.00');
    const before = await available();

    const { row } = await refundFromWhishPage(page, p.externalId, 'Customer cancelled the order');
    await expect(page.getByText(/refunded — 40.00 USD sent back to the payer/)).toBeVisible();
    await expect(row.getByText('REFUNDED')).toBeVisible();

    expect(await refundCallsFor(p.externalId)).toBe(1);
    expect((await payment(p.id)).status).toBe('REFUNDED');
    expect((await deposit(p.transactionId)).status).toBe('REVERSED');
    expect(before - (await available())).toBeCloseTo(39.2, 6); // the net it credited (40 − 2%)

    // The super-admin log has the call, with what left the platform account.
    const logs = await getJson(
      admin.api,
      `/v1/admin/transaction-logs?kind=WHISH_REFUND&search=${p.externalId}`,
    );
    expect(logs.data[0]).toMatchObject({ success: true, reference: p.externalId });
    expect(logs.data[0].response.platformBalance).toHaveProperty('change');

    // The Deposits page says what happened to the money.
    await page.goto(`/admin/deposits?search=${p.externalId}`);
    const depositRow = page.locator('tr', { hasText: p.externalId });
    await expect(depositRow.getByText('REFUNDED')).toBeVisible();
    await expect(depositRow.getByRole('button')).toHaveCount(0);

    // The company sees it too — through its API and on its own Deposits page:
    // REVERSED, and refunded to its customer.
    const own = await getJson(owner, `/v1/company/transactions/${p.transactionId}`);
    expect(own).toMatchObject({ status: 'REVERSED', refunded: true });
    expect(own.refundedAt).toBeTruthy();
    const ownerPage = await signInAs(browser, ownerEmail, OWNER_PASSWORD, '/app');
    await ownerPage.goto(`/app/deposits?search=${p.externalId}`);
    await expect(
      ownerPage.locator('tr', { hasText: p.externalId }).getByText('REFUNDED'),
    ).toBeVisible();
    await ownerPage.context().close();
  });

  test('a reason of fewer than 3 characters cannot be sent', async ({ page }) => {
    const p = await paidPayment();
    const row = await whishRow(page, p.externalId);
    await row.getByRole('button', { name: 'Refund', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('#refund-reason').fill('ab');
    await expect(dialog.getByRole('button', { name: /^Refund / })).toBeDisabled();
    await dialog.locator('#refund-reason').fill('abc');
    await expect(dialog.getByRole('button', { name: /^Refund / })).toBeEnabled();
  });

  test('Whish refusing shows its reason, changes nothing, and can be retried', async ({ page }) => {
    const p = await paidPayment();
    await fake('/__set-refund?mode=refuse');
    const { dialog } = await refundFromWhishPage(page, p.externalId);
    await expect(page.getByText('This payment cannot be refunded')).toBeVisible();
    await expect(dialog).toBeVisible(); // stays open for a retry
    expect((await payment(p.id)).status).toBe('PAID');
    expect((await deposit(p.transactionId)).status).toBe('COMPLETED');

    await fake('/__set-refund?mode=ok');
    await dialog.getByRole('button', { name: /^Refund / }).click();
    await expect(page.getByText(/sent back to the payer/)).toBeVisible();
    expect((await payment(p.id)).status).toBe('REFUNDED');
  });

  test('Whish not allowing refunds is explained — never a bare "failed"', async ({ page }) => {
    const p = await paidPayment();
    await fake('/__set-refund?mode=auth');
    await refundFromWhishPage(page, p.externalId);
    await expect(page.getByText(/refused the refund as not authorized/)).toBeVisible();
    await expect(page.getByText(/failed \(HTTP/)).toHaveCount(0);
    expect((await payment(p.id)).status).toBe('PAID');
  });

  test("Whish's lost reply: it did refund, so the refund is booked", async ({ page }) => {
    const p = await paidPayment();
    await fake('/__set-refund?mode=lost');
    const { row } = await refundFromWhishPage(page, p.externalId);
    await expect(page.getByText(/sent back to the payer/)).toBeVisible();
    await expect(row.getByText('REFUNDED')).toBeVisible();
    expect(await refundCallsFor(p.externalId)).toBe(1);
  });

  test('no answer from Whish: flagged, a second refund is refused, Refresh books it once Whish confirms', async ({
    page,
  }) => {
    const p = await paidPayment();
    await fake('/__set-refund?mode=unknown');
    const { dialog } = await refundFromWhishPage(page, p.externalId);
    await expect(page.getByText(/could not confirm the refund/)).toBeVisible();
    expect((await payment(p.id)).status).toBe('PAID');
    expect((await payment(p.id)).needsAttention).toBe(true);

    // Trying again must not send Whish a second refund on a guess.
    await fake('/__set-refund?mode=ok');
    await dialog.getByRole('button', { name: /^Refund / }).click();
    await expect(page.getByText(/already sent to Whish/)).toBeVisible();
    expect(await refundCallsFor(p.externalId)).toBe(1);

    // Whish did process it after all → Refresh books it.
    await fake(`/__mark-refunded?externalId=${p.externalId}`);
    await page.keyboard.press('Escape');
    const row = await whishRow(page, p.externalId);
    await row.getByRole('button', { name: 'Refresh' }).click();
    await expect(row.getByText('REFUNDED')).toBeVisible();
    expect((await deposit(p.transactionId)).status).toBe('REVERSED');
  });

  test('a double click sends Whish one refund', async ({ page }) => {
    const p = await paidPayment();
    const row = await whishRow(page, p.externalId);
    await row.getByRole('button', { name: 'Refund', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('#refund-reason').fill('Double click');
    await dialog.getByRole('button', { name: /^Refund / }).dblclick();
    await expect(page.getByText(/sent back to the payer/).first()).toBeVisible();
    expect(await refundCallsFor(p.externalId)).toBe(1);
  });

  test("refunded in Whish's own portal: Refresh flags it, Refund records it without paying again", async ({
    page,
  }) => {
    const p = await paidPayment();
    await fake(`/__mark-refunded?externalId=${p.externalId}`);
    const row = await whishRow(page, p.externalId);
    await row.getByRole('button', { name: 'Refresh' }).click();
    await expect(row.getByText('Needs attention')).toBeVisible();

    await row.getByRole('button', { name: 'Refund', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('#refund-reason').fill('Refunded in the Whish portal');
    await dialog.getByRole('button', { name: /^Refund / }).click();
    await expect(row.getByText('REFUNDED')).toBeVisible();
    expect(await refundCallsFor(p.externalId)).toBe(0); // recorded, never paid twice
  });

  test('a deposit reversed first is refunded without a second clawback', async ({ page }) => {
    const p = await paidPayment();
    const rev = await mutate(
      admin.api,
      admin.csrf,
      'post',
      `/v1/admin/transactions/${p.transactionId}/reverse`,
      {
        reason: 'reversed before the refund',
      },
    );
    expect(rev.status).toBeLessThan(300);
    const afterReverse = await available();

    await refundFromWhishPage(page, p.externalId);
    await expect(page.getByText(/sent back to the payer/)).toBeVisible();
    expect((await payment(p.id)).status).toBe('REFUNDED');
    expect(await available()).toBeCloseTo(afterReverse, 6);
  });

  test('the Deposits page offers Reverse and Refund together — a direct deposit has Reverse only', async ({
    page,
  }) => {
    const p = await paidPayment();
    await page.goto(`/admin/deposits?search=${p.externalId}`);
    const whishDeposit = page.locator('tr', { hasText: p.externalId });
    await expect(whishDeposit.getByRole('button')).toHaveText(['Reverse', 'Refund']);

    const whishId = await findSourceId(admin.api, 'whish');
    const key = await createSourceKey(admin.api, admin.csrf, whishId, `e2e-direct-${p.externalId}`);
    const ref = `DIRECT-${Date.now().toString(36)}`;
    const direct = await ingestTransaction('whish', key, {
      companySlug: slug,
      externalTransactionId: ref,
      amount: '12.00',
      currency: 'USD',
    });
    expect(direct.status).toBe(201);
    await page.goto(`/admin/deposits?search=${ref}`);
    const directRow = page.locator('tr', { hasText: ref });
    await expect(directRow.getByRole('button')).toHaveText(['Reverse']);
  });

  test('operators can Refresh but not Refund; back office can do neither; the API refuses both', async ({
    browser,
  }) => {
    const p = await paidPayment();
    for (const role of ['ADMIN_OPERATOR', 'BACKOFFICE'] as const) {
      const user = await provisionPlatformUser(admin, role, `E2e!${role}-refund-123`);
      const page = await signInAs(browser, user.email, user.password);

      const row = await whishRow(page, p.externalId);
      await expect(row.getByRole('button', { name: 'Refund', exact: true })).toHaveCount(0);
      await expect(row.getByRole('button', { name: 'Refresh' })).toHaveCount(
        role === 'ADMIN_OPERATOR' ? 1 : 0,
      );
      await page.goto(`/admin/deposits?search=${p.externalId}`);
      const depositRow = page.locator('tr', { hasText: p.externalId });
      await expect(depositRow).toBeVisible();
      await expect(depositRow.getByRole('button', { name: 'Refund', exact: true })).toHaveCount(0);

      const attempt = await mutate(
        user.api,
        await getCsrf(user.api),
        'post',
        `/v1/admin/whish/payments/${p.id}/refund`,
        { reason: `${role} attempt` },
      );
      expect(attempt.status, role).toBe(403);
      await user.api.dispose();
      await page.context().close();
    }
    expect(await refundCallsFor(p.externalId)).toBe(0);
    expect((await payment(p.id)).status).toBe('PAID');
  });
});
