import { test, expect } from '@playwright/test';
import {
  adminApiContext,
  createSourceKey,
  enableSourceForCompany,
  findSourceId,
  ingestTransaction,
  loginOwnerApiContext,
  provisionCompanyOwner,
} from './helpers';

// Cross-company isolation through the whole stack (RLS). Company A ingests a
// transaction; company B's owner must never see it — not in its list, and not
// by guessing the id directly (which must 404, not 403, to avoid leaking
// existence).
test.describe('company isolation (RLS end-to-end)', () => {
  test.setTimeout(120_000);

  test("B cannot see A's transactions", async () => {
    const admin = await adminApiContext();
    const { api, csrf } = admin;

    // Provision two companies with owners (reuse the admin context).
    const a = await provisionCompanyOwner(admin);
    const b = await provisionCompanyOwner(admin);

    // Enable omt + mint a key for A, then ingest a transaction into A.
    const omtId = await findSourceId(api, 'omt');
    await enableSourceForCompany(api, csrf, omtId, a.companyId);
    const keyA = await createSourceKey(api, csrf, omtId, `e2e-iso-${Date.now()}`);

    const extId = `e2e-iso-${Date.now()}`;
    const ingest = await ingestTransaction('omt', keyA, {
      companyId: a.companyId,
      externalTransactionId: extId,
      amount: '50',
      currency: 'USD',
    });
    expect(ingest.status, JSON.stringify(ingest.body)).toBe(201);
    const txnIdA = ingest.body.id as string;
    expect(txnIdA).toBeTruthy();

    // B owner gets a real session (clears its temp password first).
    const bOwner = await loginOwnerApiContext(b.ownerEmail, b.tempPassword, 'newpass-123');

    // B's transaction list must NOT contain A's transaction.
    const bList = await bOwner.get('/v1/company/transactions?pageSize=100');
    expect(bList.ok()).toBeTruthy();
    const bRows = (await bList.json()).data as Array<{ id: string; externalTransactionId: string }>;
    expect(bRows.some((t) => t.id === txnIdA)).toBe(false);
    expect(bRows.some((t) => t.externalTransactionId === extId)).toBe(false);

    // Fetching A's transaction by id under B's session must 404 (existence
    // is not leaked across tenants).
    const bGet = await bOwner.get(`/v1/company/transactions/${txnIdA}`);
    expect(bGet.status(), await bGet.text()).toBe(404);

    // Sanity: A's own owner CAN see it (proves the txn really exists and the
    // 404 above is isolation, not a missing row).
    const aOwner = await loginOwnerApiContext(a.ownerEmail, a.tempPassword, 'newpass-123');
    const aGet = await aOwner.get(`/v1/company/transactions/${txnIdA}`);
    expect(aGet.status(), await aGet.text()).toBe(200);

    await aOwner.dispose();
    await bOwner.dispose();
    await api.dispose();
  });
});
