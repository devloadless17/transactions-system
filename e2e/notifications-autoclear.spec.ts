import { test, expect, type APIRequestContext } from '@playwright/test';
import {
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

// Notifications should only persist for things still un-handled / un-seen:
//   • ADMIN: handling a request (approve/reject) clears its "new request"
//     notification for every admin.
//   • COMPANY: opening a notification (which deep-links to the item's detail)
//     clears it — the user has now seen it.
//
// Setup + the admin-side assertions run through the API; the company-side test
// drives the real notifications UI. Notification creation and the admin auto-
// clear are best-effort/post-commit (fire-and-forget), so reads use expect.poll.

const NEW_PASSWORD = 'newpass-123';

async function hasRequested(api: APIRequestContext, entityId: string): Promise<boolean> {
  const res = await api.get('/v1/notifications?filter=active&pageSize=50');
  if (!res.ok()) return false;
  const list = unwrap(await res.json()) as { data: Array<Record<string, unknown>> };
  return list.data.some(
    (n) => n.flow === 'WITHDRAWAL' && n.event === 'REQUESTED' && n.entityId === entityId,
  );
}

async function hasResolved(api: APIRequestContext, entityId: string): Promise<boolean> {
  const res = await api.get('/v1/notifications?filter=active&pageSize=50');
  if (!res.ok()) return false;
  const list = unwrap(await res.json()) as { data: Array<Record<string, unknown>> };
  return list.data.some((n) => n.event === 'APPROVED' && n.entityId === entityId);
}

/** Provision → credit (ingest 100) → owner requests one CASH withdrawal.
 *  Returns the owner ctx + withdrawal id. */
async function seedWithdrawal(admin: { api: APIRequestContext; csrf: string }) {
  const { companyId, ownerEmail, tempPassword, slug } = await provisionCompanyOwner(admin);
  const omtId = await findSourceId(admin.api, 'omt');
  await enableSourceForCompany(admin.api, admin.csrf, omtId, companyId);
  const key = await createSourceKey(admin.api, admin.csrf, omtId, `nac-${Date.now()}`);
  const ingest = await ingestTransaction('omt', key, {
    companySlug: slug,
    externalTransactionId: `nac-${Date.now()}`,
    amount: '100',
    currency: 'USD',
  });
  expect(ingest.status, JSON.stringify(ingest.body)).toBe(201);

  const owner = await loginOwnerApiContext(ownerEmail, tempPassword, NEW_PASSWORD);
  const csrf = await getCsrf(owner);
  const create = await owner.post('/v1/company/withdrawals', {
    headers: { 'x-csrf-token': csrf },
    data: {
      amount: '25',
      currency: 'USD',
      payout: { method: 'CASH', recipientName: 'Auto Clear', recipientPhone: '+9613222333' },
    },
  });
  expect(create.ok(), `create withdrawal: ${create.status()} ${await create.text()}`).toBe(true);
  const id = (unwrap(await create.json()) as { id: string }).id;
  return { owner, withdrawalId: id };
}

test.describe('notification auto-clear', () => {
  test.setTimeout(120_000);

  test('approving a request clears the admin "new request" notification (all admins)', async () => {
    const admin = await adminApiContext();
    const { owner, withdrawalId } = await seedWithdrawal(admin);

    // The admin queue notification appears (post-commit, async).
    await expect.poll(() => hasRequested(admin.api, withdrawalId), { timeout: 15_000 }).toBe(true);

    // Admin handles it.
    const approve = await admin.api.post(`/v1/admin/withdrawals/${withdrawalId}/approve`, {
      headers: { 'x-csrf-token': admin.csrf },
      data: { externalReference: `E2E-AC-${Date.now()}` },
    });
    expect(approve.ok(), `approve: ${approve.status()} ${await approve.text()}`).toBe(true);

    // It leaves the active list (auto-cleared on handle)…
    await expect.poll(() => hasRequested(admin.api, withdrawalId), { timeout: 15_000 }).toBe(false);

    // …and is still reviewable under the Cleared filter.
    const cleared = await admin.api.get('/v1/notifications?filter=cleared&pageSize=50');
    const clist = unwrap(await cleared.json()) as { data: Array<Record<string, unknown>> };
    expect(
      clist.data.some(
        (n) => n.flow === 'WITHDRAWAL' && n.event === 'REQUESTED' && n.entityId === withdrawalId,
      ),
    ).toBe(true);

    await owner.dispose();
    await admin.api.dispose();
  });

  test('a company opening a notification clears it from active', async ({ browser }) => {
    const admin = await adminApiContext();
    const { owner, withdrawalId } = await seedWithdrawal(admin);

    // Approve so the company receives a "Withdrawal approved" notification.
    const approve = await admin.api.post(`/v1/admin/withdrawals/${withdrawalId}/approve`, {
      headers: { 'x-csrf-token': admin.csrf },
      data: { externalReference: `E2E-AC-${Date.now()}` },
    });
    expect(approve.ok(), `approve: ${approve.status()} ${await approve.text()}`).toBe(true);

    await expect.poll(() => hasResolved(owner, withdrawalId), { timeout: 15_000 }).toBe(true);

    const ctx = await browser.newContext({ storageState: await owner.storageState() });
    const page = await ctx.newPage();
    try {
      await page.goto('/app/notifications', { waitUntil: 'domcontentloaded' });
      const item = page
        .getByRole('button')
        .filter({ hasText: /withdrawal approved/i })
        .first();
      await expect(item).toBeVisible({ timeout: 30_000 });
      await item.click();
      // Opening deep-links to the withdrawal's detail panel.
      await page.waitForURL(/\/app\/withdrawals\?selected=/, { timeout: 15_000 });

      // The notification is now cleared from active for the company…
      await expect.poll(() => hasResolved(owner, withdrawalId), { timeout: 15_000 }).toBe(false);
      // …and reviewable under Cleared.
      const cleared = await owner.get('/v1/notifications?filter=cleared&pageSize=50');
      const clist = unwrap(await cleared.json()) as { data: Array<Record<string, unknown>> };
      expect(clist.data.some((n) => n.event === 'APPROVED' && n.entityId === withdrawalId)).toBe(
        true,
      );
    } finally {
      await page.close();
      await ctx.close();
      await owner.dispose();
      await admin.api.dispose();
    }
  });
});
