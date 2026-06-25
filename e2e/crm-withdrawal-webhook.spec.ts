import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  adminApiContext,
  createCommissionRule,
  createSourceKey,
  enableSourceForCompany,
  findSourceId,
  getCsrf,
  ingestTransaction,
  loginOwnerApiContext,
  provisionCompanyOwner,
  unwrap,
} from './helpers';

// Verify the withdrawal CRM webhooks end-to-end against the built-in demo CRM
// inbox (the same in-process capture a real CRM would receive). For a company
// with the demo CRM enabled:
//   request  → withdrawal.pending lands, carrying total/fee/net + recipient
//   approve  → the SAME reference flips to withdrawal.completed + externalReference
//   reject   → a second withdrawal lands withdrawal.rejected carrying adminNote
// and, crucially, a payout + a load requested on the same company emit NOTHING
// (those flows are API-only). Nothing here is stubbed — it drives the real
// dispatch → delivery → demo-inbox path.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type DemoEvent = {
  reference: string;
  event: string;
  status: string;
  transaction: unknown | null;
  withdrawal: {
    id: string;
    status: string;
    amount: string;
    totalAmount: string;
    feeAmount: string;
    netAmount: string;
    feeApplication: string;
    currency: string;
    payoutMethod: string;
    payoutDetails: {
      method: string;
      recipientName?: string;
      recipientPhone?: string;
      pickupLocation?: string;
      instructions?: string;
    } | null;
    note: string | null;
    adminNote: string | null;
    externalReference: string | null;
    createdAt: string;
    processedAt: string | null;
  } | null;
};

async function inbox(owner: APIRequestContext): Promise<DemoEvent[]> {
  const res = await owner.get('/v1/company/crm/demo/inbox');
  expect(res.ok(), `inbox GET: ${res.status()}`).toBeTruthy();
  return unwrap(await res.json()) as DemoEvent[];
}

// Poll the demo inbox until an event for `reference` reaches `event`, or time out.
async function waitForDemoEvent(
  owner: APIRequestContext,
  reference: string,
  event: string,
  timeoutMs = 15_000,
): Promise<DemoEvent> {
  const deadline = Date.now() + timeoutMs;
  let last: DemoEvent[] = [];
  while (Date.now() < deadline) {
    last = await inbox(owner);
    const hit = last.find((e) => e.reference === reference && e.event === event);
    if (hit) return hit;
    await sleep(500);
  }
  throw new Error(
    `demo event ${event} for ${reference} not seen in ${timeoutMs}ms; inbox=${JSON.stringify(last)}`,
  );
}

test.describe('withdrawal CRM webhooks (demo inbox)', () => {
  test.setTimeout(120_000);
  test.use({ storageState: { cookies: [], origins: [] } });

  test('pushes pending → completed (+ rejected); payouts/loads emit nothing', async () => {
    const { api, csrf } = await adminApiContext();
    const { companyId, ownerEmail, tempPassword } = await provisionCompanyOwner({ api, csrf });

    // Fund the wallet via ingest: 300 → omt's $1 fixed fee → ~299 available.
    const omtId = await findSourceId(api, 'omt');
    await enableSourceForCompany(api, csrf, omtId, companyId);
    const sourceKey = await createSourceKey(api, csrf, omtId, `e2e-crmwd-${Date.now()}`);
    const ingest = await ingestTransaction('omt', sourceKey, {
      companyId,
      externalTransactionId: `e2e-crmwd-${Date.now()}`,
      amount: '300',
      currency: 'USD',
    });
    expect(ingest.status, JSON.stringify(ingest.body)).toBe(201);

    // A WITHDRAWAL commission rule so the events carry a non-zero fee: 2%
    // DEDUCTED on [1, ∞). 100 → fee 2, net 98, total 100.
    await createCommissionRule(api, csrf, {
      companyId,
      operationType: 'WITHDRAWAL',
      feeApplication: 'DEDUCTED',
      minAmount: '1',
      maxAmount: null,
      commissionType: 'PERCENTAGE',
      commissionValue: '2',
    });

    // Owner cookie session + csrf for mutations.
    const owner = await loginOwnerApiContext(ownerEmail, tempPassword, 'newpass-123');
    const ownerCsrf = await getCsrf(owner);

    // Enable the built-in demo CRM — events are captured in-process from here on.
    // (Enabled AFTER the ingest, so the deposit's transaction.completed is NOT in
    // the inbox: every event we then see must be a withdrawal.)
    const demo = await owner.post('/v1/company/crm/demo/enable', {
      headers: { 'x-csrf-token': ownerCsrf },
    });
    expect(demo.ok(), `enable demo: ${demo.status()} ${await demo.text()}`).toBeTruthy();

    // --- Request a withdrawal (100 CASH) → withdrawal.pending ---
    const reqRes = await owner.post('/v1/company/withdrawals', {
      headers: { 'x-csrf-token': ownerCsrf },
      data: {
        amount: '100',
        currency: 'USD',
        notes: 'CRM webhook e2e',
        payout: {
          method: 'CASH',
          recipientName: 'Acme Ltd',
          recipientPhone: '+961-3-000-000',
          pickupLocation: 'Beirut – Hamra',
          instructions: 'Call on arrival',
        },
      },
    });
    expect(reqRes.status(), await reqRes.text()).toBe(201);
    const wd = unwrap(await reqRes.json());
    const reference = `withdrawal:${wd.id}`;

    const pending = await waitForDemoEvent(owner, reference, 'withdrawal.pending');
    expect(pending.status).toBe('PENDING');
    expect(pending.withdrawal, 'withdrawal body present').toBeTruthy();
    expect(pending.transaction, 'no transaction body on a withdrawal event').toBeFalsy();
    // Money breakdown (100 DEDUCTED 2% → fee 2, net 98, total 100).
    expect(Number(pending.withdrawal!.amount)).toBeCloseTo(100, 2);
    expect(Number(pending.withdrawal!.totalAmount)).toBeCloseTo(100, 2);
    expect(Number(pending.withdrawal!.feeAmount)).toBeCloseTo(2, 2);
    expect(Number(pending.withdrawal!.netAmount)).toBeCloseTo(98, 2);
    expect(pending.withdrawal!.feeApplication).toBe('DEDUCTED');
    expect(pending.withdrawal!.payoutMethod).toBe('CASH');
    // The COMPLETE payout instructions — the single source for the destination.
    expect(pending.withdrawal!.payoutDetails?.recipientName).toBe('Acme Ltd');
    expect(pending.withdrawal!.payoutDetails?.recipientPhone).toBe('+961-3-000-000');
    expect(pending.withdrawal!.payoutDetails?.pickupLocation).toBe('Beirut – Hamra');
    expect(pending.withdrawal!.payoutDetails?.instructions).toBe('Call on arrival');
    expect(pending.withdrawal!.note).toBe('CRM webhook e2e');
    // Decision state: still pending → no decision yet, no proof yet.
    expect(pending.withdrawal!.externalReference).toBeNull();
    expect(pending.withdrawal!.processedAt, 'processedAt is null while PENDING').toBeNull();
    expect(pending.withdrawal!.createdAt, 'createdAt is always set').toBeTruthy();

    // --- Approve (admin) → SAME reference flips to withdrawal.completed ---
    const extRef = `E2E-CRM-REF-${Date.now()}`;
    const approve = await api.post(`/v1/admin/withdrawals/${wd.id}/approve`, {
      headers: { 'x-csrf-token': csrf },
      data: { externalReference: extRef },
    });
    expect(approve.ok(), `approve: ${approve.status()} ${await approve.text()}`).toBeTruthy();

    const completed = await waitForDemoEvent(owner, reference, 'withdrawal.completed');
    // Approved & paid: status COMPLETED, the decision timestamp + proof are set.
    expect(completed.status).toBe('COMPLETED');
    expect(completed.withdrawal!.externalReference).toBe(extRef);
    expect(completed.withdrawal!.processedAt, 'processedAt set once approved').toBeTruthy();
    expect(Number(completed.withdrawal!.feeAmount)).toBeCloseTo(2, 2);
    expect(Number(completed.withdrawal!.netAmount)).toBeCloseTo(98, 2);

    // --- A second withdrawal, rejected → withdrawal.rejected with adminNote ---
    const req2 = await owner.post('/v1/company/withdrawals', {
      headers: { 'x-csrf-token': ownerCsrf },
      data: {
        amount: '50',
        currency: 'USD',
        payout: { method: 'CASH', recipientName: 'Beta LLC', recipientPhone: '+961-3-111-111' },
      },
    });
    expect(req2.status(), await req2.text()).toBe(201);
    const wd2 = unwrap(await req2.json());
    const reference2 = `withdrawal:${wd2.id}`;
    await waitForDemoEvent(owner, reference2, 'withdrawal.pending');

    const reject = await api.post(`/v1/admin/withdrawals/${wd2.id}/reject`, {
      headers: { 'x-csrf-token': csrf },
      data: { notes: 'Beneficiary name mismatch' },
    });
    expect(reject.ok(), `reject: ${reject.status()} ${await reject.text()}`).toBeTruthy();

    const rejected = await waitForDemoEvent(owner, reference2, 'withdrawal.rejected');
    // Rejected: status REJECTED, the reason in adminNote, decision timestamp set.
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.withdrawal!.adminNote).toBe('Beneficiary name mismatch');
    expect(rejected.withdrawal!.processedAt, 'processedAt set on rejection').toBeTruthy();

    // --- Payout + load on the SAME company must emit NOTHING (API-only) ---
    const payoutRes = await owner.post('/v1/company/payouts', {
      headers: { 'x-csrf-token': ownerCsrf },
      data: {
        amount: '30',
        currency: 'USD',
        payout: { method: 'CASH', recipientName: 'Gamma Co', recipientPhone: '+961-3-222-222' },
      },
    });
    expect(payoutRes.status(), await payoutRes.text()).toBe(201);
    const payout = unwrap(await payoutRes.json());

    const loadRes = await owner.post('/v1/company/loads', {
      headers: { 'x-csrf-token': ownerCsrf },
      data: {
        amount: '40',
        currency: 'USD',
        payout: { method: 'CASH', recipientName: 'Delta Inc', recipientPhone: '+961-3-333-333' },
      },
    });
    expect(loadRes.status(), await loadRes.text()).toBe(201);
    const load = unwrap(await loadRes.json());

    // Give any (erroneous) emit time to land, then assert the inbox holds ONLY
    // withdrawal events — no payout/load reference ever appears.
    await sleep(2500);
    const finalInbox = await inbox(owner);
    expect(finalInbox.length).toBeGreaterThanOrEqual(2);
    for (const e of finalInbox) {
      expect(e.event.startsWith('withdrawal.'), `unexpected CRM event ${e.event}`).toBeTruthy();
    }
    expect(
      finalInbox.some((e) => e.reference === `payout:${payout.id}`),
      'payout must not be pushed to the CRM',
    ).toBe(false);
    expect(
      finalInbox.some((e) => e.reference === `load:${load.id}`),
      'load must not be pushed to the CRM',
    ).toBe(false);

    await owner.dispose();
    await api.dispose();
  });
});
