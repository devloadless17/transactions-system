import { test, expect, request as pwRequest } from '@playwright/test';
import {
  API_BASE,
  adminApiContext,
  createSourceKey,
  enableSourceForCompany,
  findSourceId,
  getCsrf,
  ingestTransaction,
  loginOwnerApiContext,
  provisionCompanyOwner,
  unwrap,
} from './helpers';

// Coverage for the queue UX changes shipped alongside this branch:
//   1. Admin queue rows surface the recipient (name · phone) inline, and the
//      review dialog shows the note the company left.
//   2. A company notification deep-link (?selected=<id>) auto-opens that exact
//      withdrawal's detail panel.
//   3. BACKOFFICE sees a single net "Amount" column — no Fee / gross exposed.
//
// Setup runs through the real API (provision → opt-in → ingest → request a
// withdrawal as the owner). The assertions drive the real UI. To stay fast and
// dodge the auth throttle, browser sessions are built by injecting the cookies
// from an API-authenticated context rather than re-walking the login UI.

const NEW_PASSWORD = 'newpass-123';

/** Provision a company, credit it (ingest 100 → net 99), and request one CASH
 *  withdrawal as the owner. Returns the owner API context + the withdrawal. */
async function seedWithdrawal(
  admin: { api: import('@playwright/test').APIRequestContext; csrf: string },
  opts: { amount: string; recipientName: string; recipientPhone: string; notes: string },
) {
  const { companyId, ownerEmail, tempPassword, slug } = await provisionCompanyOwner(admin);
  const companyName = `E2E Company ${slug}`;

  const omtId = await findSourceId(admin.api, 'omt');
  await enableSourceForCompany(admin.api, admin.csrf, omtId, companyId);
  const key = await createSourceKey(admin.api, admin.csrf, omtId, `e2e-qr-${Date.now()}`);
  const ingest = await ingestTransaction('omt', key, {
    companyId,
    externalTransactionId: `e2e-qr-${Date.now()}`,
    amount: '100',
    currency: 'USD',
  });
  expect(ingest.status, JSON.stringify(ingest.body)).toBe(201);

  const owner = await loginOwnerApiContext(ownerEmail, tempPassword, NEW_PASSWORD);
  const csrf = await getCsrf(owner);
  const create = await owner.post('/v1/company/withdrawals', {
    headers: { 'x-csrf-token': csrf },
    data: {
      amount: opts.amount,
      currency: 'USD',
      notes: opts.notes,
      payout: {
        method: 'CASH',
        recipientName: opts.recipientName,
        recipientPhone: opts.recipientPhone,
      },
    },
  });
  expect(create.ok(), `create withdrawal failed: ${create.status()} ${await create.text()}`).toBe(
    true,
  );
  const withdrawal = unwrap(await create.json()) as { id: string };
  return { owner, withdrawal, companyId, companyName };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test.describe('queue recipient + notes + deep-link', () => {
  test.setTimeout(120_000);

  test('admin queue surfaces the recipient phone and the company note', async ({ page }) => {
    // `page` carries the seeded super-admin storageState (chromium project).
    const admin = await adminApiContext();
    const phone = `+9613${Date.now() % 1_000_000}`;
    const recipientName = 'Jane E2E Cash';
    const note = `Please pay before noon — ref ${Date.now().toString(36)}`;
    const { companyId, companyName } = await seedWithdrawal(admin, {
      amount: '20',
      recipientName,
      recipientPhone: phone,
      notes: note,
    });

    await page.goto('/admin/withdrawals', { waitUntil: 'domcontentloaded' });
    await expect(
      page
        .locator('h1, h2')
        .filter({ hasText: /withdrawals/i })
        .first(),
    ).toBeVisible({ timeout: 30_000 });

    // The brand-new company has exactly one (PENDING) withdrawal — scope to it.
    const row = page
      .locator('table tbody tr')
      .filter({
        hasText: new RegExp(`${escapeRe(companyName)}|${escapeRe(companyId.slice(0, 8))}`),
      })
      .first();
    await expect(row).toBeVisible({ timeout: 30_000 });

    // Recipient name + phone are visible inline — no need to open the request.
    await expect(row).toContainText(recipientName);
    await expect(row).toContainText(phone);

    // Opening the review (Approve) dialog shows the company's note.
    await row.getByRole('button', { name: 'Approve' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Note from company')).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByText(note)).toBeVisible();
    // Close without approving (this spec only asserts visibility).
    await page.keyboard.press('Escape');

    await admin.api.dispose();
  });

  test('company notification deep-link opens the withdrawal detail panel', async ({ browser }) => {
    const admin = await adminApiContext();
    const { owner, withdrawal } = await seedWithdrawal(admin, {
      amount: '15',
      recipientName: 'Deep Link Co',
      recipientPhone: '+9613000111',
      notes: 'deep-link note',
    });

    // Build a company browser session from the owner's API cookies (no UI login)
    // and follow the notification's deep-link straight to the withdrawal.
    const ctx = await browser.newContext({ storageState: await owner.storageState() });
    const opage = await ctx.newPage();
    try {
      await opage.goto(`/app/withdrawals?selected=${withdrawal.id}`, {
        waitUntil: 'domcontentloaded',
      });
      // The detail Sheet auto-opens and shows the withdrawal id.
      const drawer = opage.getByRole('dialog');
      await expect(drawer).toBeVisible({ timeout: 30_000 });
      await expect(drawer.getByText(withdrawal.id)).toBeVisible({ timeout: 10_000 });
    } finally {
      await opage.close();
      await ctx.close();
      await owner.dispose();
      await admin.api.dispose();
    }
  });

  test('back office sees a single net Amount column (no Fee / gross)', async ({ browser }) => {
    const admin = await adminApiContext();
    // Create a BACKOFFICE platform admin, then sign it in (forced change-password
    // first), and inject its cookies into a browser session.
    const boEmail = `e2e-backoffice-${Date.now().toString(36)}@example.com`;
    const create = await admin.api.post('/v1/admin/users', {
      headers: { 'x-csrf-token': admin.csrf },
      data: { email: boEmail, role: 'BACKOFFICE' },
    });
    expect(create.ok(), `create backoffice failed: ${create.status()} ${await create.text()}`).toBe(
      true,
    );
    const tempPassword = unwrap(await create.json()).temporaryPassword as string;
    const bo = await loginOwnerApiContext(boEmail, tempPassword, NEW_PASSWORD);

    const ctx = await browser.newContext({ storageState: await bo.storageState() });
    const bopage = await ctx.newPage();
    try {
      await bopage.goto('/admin/withdrawals', { waitUntil: 'domcontentloaded' });
      await expect(bopage.locator('table thead')).toBeVisible({ timeout: 30_000 });
      const head = bopage.locator('table thead');
      // Single net money column labelled "Amount"; no Fee/Net exposure.
      await expect(head.getByText('Amount', { exact: true })).toBeVisible();
      await expect(head.getByText('Fee', { exact: true })).toHaveCount(0);
      await expect(head.getByText('Net', { exact: true })).toHaveCount(0);
    } finally {
      await bopage.close();
      await ctx.close();
      await bo.dispose();
      await admin.api.dispose();
    }
  });
});
