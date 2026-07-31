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

/**
 * End-to-end money correctness through the REAL running stack (HTTP → Nest →
 * Postgres RLS), API-driven so the assertions on net / fee / total / volume can
 * be exact (the UI request+approve click-path is already covered by
 * withdrawal-lifecycle.spec.ts). It exercises every flow and proves the
 * invariants the recent fixes established:
 *
 *  - Each flow's totalAmount = net + fee, for DEDUCTED (= amount) and ON_TOP
 *    (= amount + fee), and the wallet reserves exactly the total on request.
 *  - The full lifecycle (ingest → load → withdrawal → payout) moves the wallet's
 *    available/reserved by the right amounts at every step.
 *  - The super-admin platform rollup counts money in (transactions + loads) and
 *    money out (withdrawals + payouts) at net + fee — including ON_TOP and
 *    payouts, the surfaces the fix had missed — and the daily Flows series
 *    reconciles with it.
 *  - Platform + company revenue accrues a fee from EVERY flow on settlement.
 *  - Reject (admin) / cancel (company) release reserved funds with no fee.
 *  - The company reconciliation cards honour the dashboard date range.
 *  - The ledger reconciles against the wallet projection (no discrepancies).
 */

const money = (s: string | number | undefined) => Number(s ?? 0);
const near = (actual: string | number | undefined, expected: number) =>
  expect(money(actual)).toBeCloseTo(expected, 6);

// CASH payout/source-of-funds details — the simplest valid union member.
function cashBody(amount: string) {
  return {
    amount,
    currency: 'USD',
    payout: {
      method: 'CASH',
      recipientName: 'E2E Payee',
      recipientPhone: '+9610000000',
      pickupLocation: 'E2E Branch',
    },
  };
}

async function post(
  api: APIRequestContext,
  csrf: string,
  path: string,
  body: Record<string, unknown>,
) {
  const res = await api.post(path, { headers: { 'x-csrf-token': csrf }, data: body });
  const text = await res.text();
  if (!res.ok()) throw new Error(`POST ${path} -> ${res.status()} ${text}`);
  return text ? unwrap(JSON.parse(text)) : null;
}

async function expectWallet(api: APIRequestContext, available: number, reserved: number) {
  const res = await api.get('/v1/company/wallets');
  expect(res.ok()).toBeTruthy();
  const w = unwrap(await res.json()).data.find((x: { currency: string }) => x.currency === 'USD');
  expect(w, 'USD wallet exists').toBeTruthy();
  expect(money(w.availableBalance)).toBeCloseTo(available, 6);
  expect(money(w.reservedBalance)).toBeCloseTo(reserved, 6);
}

async function platformUsd(api: APIRequestContext) {
  const res = await api.get('/v1/admin/analytics/platform');
  expect(res.ok()).toBeTruthy();
  const row = unwrap(await res.json()).byCurrency.find(
    (c: { currency: string }) => c.currency.trim() === 'USD',
  ) ?? { volumeIn: '0', volumeOut: '0', feesEarned: '0' };
  return {
    volumeIn: money(row.volumeIn),
    volumeOut: money(row.volumeOut),
    feesEarned: money(row.feesEarned),
  };
}

async function flowsSums(api: APIRequestContext, win: { from: string; to: string }) {
  const p = new URLSearchParams({ currency: 'USD', from: win.from, to: win.to });
  const res = await api.get(`/v1/admin/analytics/flows?${p.toString()}`);
  expect(res.ok()).toBeTruthy();
  const buckets = unwrap(await res.json()).buckets as Array<Record<string, string>>;
  const sum = (k: 'in' | 'out' | 'fees') => buckets.reduce((a, b) => a + money(b[k]), 0);
  return { in: sum('in'), out: sum('out'), fees: sum('fees') };
}

async function walletSummary(api: APIRequestContext, range?: { from: string; to: string }) {
  const p = new URLSearchParams({ currency: 'USD' });
  if (range) {
    p.set('from', range.from);
    p.set('to', range.to);
  }
  const res = await api.get(`/v1/company/analytics/wallet-summary?${p.toString()}`);
  expect(res.ok()).toBeTruthy();
  return unwrap(await res.json());
}

test.describe.serial('money flows end-to-end (API)', () => {
  // Owner change-password walk + several flows; give slow first compiles room.
  test.setTimeout(150_000);
  // This suite owns its own admin + owner sessions (no shared storageState).
  test.use({ storageState: { cookies: [], origins: [] } });

  let admin: APIRequestContext;
  let adminCsrf: string;
  // Company A: all flows priced at a flat 10% DEDUCTED fee.
  let ownerA: APIRequestContext;
  let ownerACsrf: string;
  let companyA: string;
  let sourceKeyA: string;
  // Company B: funded fee-free, with two withdrawal brackets — DEDUCTED (≤150)
  // and ON_TOP (>150) — to contrast the two fee applications.
  let ownerB: APIRequestContext;
  let ownerBCsrf: string;
  let companyB: string;
  let sourceKeyB: string;

  test.beforeAll(async () => {
    // Provisions 2 companies + owner logins; under the auth throttle (esp. when
    // this spec runs late in the full suite) the 429 backoffs can exceed the
    // default 30s hook timeout. Give the hook room.
    test.setTimeout(180_000);
    const ctx = await adminApiContext();
    admin = ctx.api;
    adminCsrf = ctx.csrf;
    const omtId = await findSourceId(admin, 'omt');

    // --- Company A ---
    const a = await provisionCompanyOwner({ api: admin, csrf: adminCsrf });
    companyA = a.companyId;
    ownerA = await loginOwnerApiContext(a.ownerEmail, a.tempPassword, 'newpass-A-12345');
    ownerACsrf = await getCsrf(ownerA);
    await enableSourceForCompany(admin, adminCsrf, omtId, companyA);
    sourceKeyA = await createSourceKey(admin, adminCsrf, omtId, `e2e-A-${Date.now()}`);
    for (const operationType of ['TRANSACTION', 'LOAD', 'WITHDRAWAL', 'PAYOUT']) {
      await createCommissionRule(admin, adminCsrf, {
        companyId: companyA,
        operationType,
        feeApplication: 'DEDUCTED',
        commissionType: 'PERCENTAGE',
        commissionValue: '10',
        minAmount: '0.00000001',
        maxAmount: '100000000',
        priority: 1000,
      });
    }

    // --- Company B ---
    const b = await provisionCompanyOwner({ api: admin, csrf: adminCsrf });
    companyB = b.companyId;
    ownerB = await loginOwnerApiContext(b.ownerEmail, b.tempPassword, 'newpass-B-12345');
    ownerBCsrf = await getCsrf(ownerB);
    await enableSourceForCompany(admin, adminCsrf, omtId, companyB);
    sourceKeyB = await createSourceKey(admin, adminCsrf, omtId, `e2e-B-${Date.now()}`);
    // Fund fee-free so the bracket maths below are exact.
    await createCommissionRule(admin, adminCsrf, {
      companyId: companyB,
      operationType: 'TRANSACTION',
      feeApplication: 'DEDUCTED',
      commissionType: 'FIXED',
      commissionValue: '0',
      minAmount: '0.00000001',
      maxAmount: '100000000',
      priority: 1000,
    });
    await createCommissionRule(admin, adminCsrf, {
      companyId: companyB,
      operationType: 'WITHDRAWAL',
      feeApplication: 'DEDUCTED',
      commissionType: 'FIXED',
      commissionValue: '5',
      minAmount: '0.00000001',
      maxAmount: '150',
      priority: 1000,
    });
    await createCommissionRule(admin, adminCsrf, {
      companyId: companyB,
      operationType: 'WITHDRAWAL',
      feeApplication: 'ON_TOP',
      commissionType: 'FIXED',
      commissionValue: '5',
      minAmount: '150.00000001',
      maxAmount: '100000000',
      priority: 1000,
    });
  });

  test.afterAll(async () => {
    await ownerA?.dispose();
    await ownerB?.dispose();
    await admin?.dispose();
  });

  test('full lifecycle: ingest → load → withdrawal → payout (exact net/fee/total + wallet)', async () => {
    const before = await platformUsd(admin);
    const win = {
      from: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      to: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const flowBefore = await flowsSums(admin, win);

    // 1) Ingest 100 → 10% fee 10, net 90 credited to available.
    const ing = await ingestTransaction('omt', sourceKeyA, {
      companyId: companyA,
      externalTransactionId: `e2e-lc-${Date.now()}`,
      amount: '100',
      currency: 'USD',
    });
    expect(ing.status, JSON.stringify(ing.body)).toBe(201);
    near(ing.body.amount, 100);
    // The source-facing response does NOT expose the fee/net; the wallet
    // assertion below verifies the 90 net credited from the company's view.
    await expectWallet(ownerA, 90, 0);

    // 2) Load 100 → PENDING (no wallet move yet); approve credits net 90.
    const load = await post(ownerA, ownerACsrf, '/v1/company/loads', cashBody('100'));
    expect(load.status).toBe('PENDING');
    expect(load.feeApplication).toBe('DEDUCTED');
    near(load.feeAmount, 10);
    near(load.netAmount, 90);
    near(load.totalAmount, 100); // DEDUCTED → total == amount
    await expectWallet(ownerA, 90, 0);
    await post(admin, adminCsrf, `/v1/admin/loads/${load.id}/approve`, {
      externalReference: 'E2E-LOAD-1',
    });
    await expectWallet(ownerA, 180, 0);

    // 3) Withdrawal 50 → reserves total 50; approve sends net 45 + fee 5 out.
    const wd = await post(ownerA, ownerACsrf, '/v1/company/withdrawals', cashBody('50'));
    expect(wd.feeApplication).toBe('DEDUCTED');
    near(wd.feeAmount, 5);
    near(wd.netAmount, 45);
    near(wd.totalAmount, 50);
    await expectWallet(ownerA, 130, 50); // available 180-50, reserved 50
    await post(admin, adminCsrf, `/v1/admin/withdrawals/${wd.id}/approve`, {
      externalReference: 'E2E-WD-1',
    });
    await expectWallet(ownerA, 130, 0);

    // 4) Payout 50 → reserves 50; approve disburses.
    const po = await post(ownerA, ownerACsrf, '/v1/company/payouts', cashBody('50'));
    near(po.feeAmount, 5);
    near(po.netAmount, 45);
    near(po.totalAmount, 50);
    await expectWallet(ownerA, 80, 50);
    await post(admin, adminCsrf, `/v1/admin/payouts/${po.id}/approve`, {
      externalReference: 'E2E-PO-1',
    });
    await expectWallet(ownerA, 80, 0);

    // Platform rollup (the fixed surface): money in = tx(100) + load(100) = 200;
    // money out = withdrawal(50) + payout(50) = 100; revenue = 10+10+5+5 = 30.
    const after = await platformUsd(admin);
    near(after.volumeIn - before.volumeIn, 200);
    near(after.volumeOut - before.volumeOut, 100);
    near(after.feesEarned - before.feesEarned, 30);

    // The daily Flows series must move by the same deltas (guards the in/out
    // SQL summing all flow types at net+fee).
    const flowAfter = await flowsSums(admin, win);
    near(flowAfter.in - flowBefore.in, 200);
    near(flowAfter.out - flowBefore.out, 100);
    near(flowAfter.fees - flowBefore.fees, 30);

    // Company reconciliation identity (all-time): net in − total out = available.
    const sum = await walletSummary(ownerA);
    near(sum.deposits.gross, 100); // gross = net + fee (the deposits.gross fix)
    near(sum.deposits.net, 90);
    near(sum.loads.net, 90);
    near(sum.withdrawals.total, 50);
    near(sum.payouts.total, 50);
    near(
      money(sum.deposits.net) +
        money(sum.loads.net) -
        money(sum.withdrawals.total) -
        money(sum.payouts.total),
      80,
    );

    // Ledger ↔ wallet projection reconciles with zero discrepancies.
    const recon = await post(admin, adminCsrf, '/v1/admin/reconciliation/run', {});
    expect(recon.divergentCount).toBe(0);
    expect(recon.discrepancies.length).toBe(0);
  });

  test('date range scopes the reconciliation cards (wallet tile stays all-time)', async () => {
    // All-time: company A settled 90 of deposits during the lifecycle test.
    const all = await walletSummary(ownerA);
    near(all.deposits.net, 90);

    // A window entirely in the past has no activity → every card zeroes out.
    const past = await walletSummary(ownerA, {
      from: '2020-01-01T00:00:00.000Z',
      to: '2020-12-31T23:59:59.000Z',
    });
    near(past.deposits.net, 0);
    near(past.loads.net, 0);
    near(past.withdrawals.total, 0);
    near(past.payouts.total, 0);

    // A window covering today matches the all-time figures again.
    const current = await walletSummary(ownerA, {
      from: new Date(Date.now() - 86_400_000).toISOString(),
      to: new Date(Date.now() + 3_600_000).toISOString(),
    });
    near(current.deposits.net, 90);
    near(current.loads.net, 90);
  });

  test('cancel (company) + reject (admin) release reserved funds with no fee', async () => {
    const feesBefore = (await platformUsd(admin)).feesEarned;

    // Company cancels its own PENDING withdrawal → reserved returns to available.
    const w1 = await post(ownerA, ownerACsrf, '/v1/company/withdrawals', cashBody('30'));
    await expectWallet(ownerA, 50, 30); // 80 - 30 reserved
    const c1 = await post(ownerA, ownerACsrf, `/v1/company/withdrawals/${w1.id}/cancel`, {});
    expect(c1.status).toBe('CANCELLED');
    await expectWallet(ownerA, 80, 0);

    // Admin rejects a PENDING withdrawal → same release.
    const w2 = await post(ownerA, ownerACsrf, '/v1/company/withdrawals', cashBody('30'));
    await expectWallet(ownerA, 50, 30);
    const r2 = await post(admin, adminCsrf, `/v1/admin/withdrawals/${w2.id}/reject`, {
      notes: 'e2e reject',
    });
    expect(r2.status).toBe('REJECTED');
    await expectWallet(ownerA, 80, 0);

    // Payout cancel releases the reserved total too.
    const p1 = await post(ownerA, ownerACsrf, '/v1/company/payouts', cashBody('30'));
    await expectWallet(ownerA, 50, 30);
    const pc = await post(ownerA, ownerACsrf, `/v1/company/payouts/${p1.id}/cancel`, {});
    expect(pc.status).toBe('CANCELLED');
    await expectWallet(ownerA, 80, 0);

    // No fee is realized on a released request.
    near((await platformUsd(admin)).feesEarned - feesBefore, 0);
  });

  test('ON_TOP vs DEDUCTED: totalAmount, reserved, and platform volumeOut', async () => {
    // Fund company B fee-free.
    const ing = await ingestTransaction('omt', sourceKeyB, {
      companyId: companyB,
      externalTransactionId: `e2e-fees-${Date.now()}`,
      amount: '1000',
      currency: 'USD',
    });
    expect(ing.status, JSON.stringify(ing.body)).toBe(201);
    // Net is not exposed to sources; the wallet check confirms the 1000 (0 fee).
    await expectWallet(ownerB, 1000, 0);

    // DEDUCTED (amount 100, bracket ≤150): fee taken from the amount.
    const ded = await post(ownerB, ownerBCsrf, '/v1/company/withdrawals', cashBody('100'));
    expect(ded.feeApplication).toBe('DEDUCTED');
    near(ded.feeAmount, 5);
    near(ded.netAmount, 95);
    near(ded.totalAmount, 100); // total == amount
    await expectWallet(ownerB, 900, 100); // reserves exactly the total (100)

    // ON_TOP (amount 200, bracket >150): fee charged on top of the amount.
    const ontop = await post(ownerB, ownerBCsrf, '/v1/company/withdrawals', cashBody('200'));
    expect(ontop.feeApplication).toBe('ON_TOP');
    near(ontop.feeAmount, 5);
    near(ontop.netAmount, 200); // recipient gets the full amount
    near(ontop.totalAmount, 205); // total == amount + fee (exceeds requested 200)
    await expectWallet(ownerB, 695, 305); // available 900-205, reserved 100+205

    // Approving both moves platform volumeOut by net+fee for each: 100 + 205 =
    // 305 (the old rollup would have moved by 100 + 200). Revenue += 5 + 5.
    const before = await platformUsd(admin);
    await post(admin, adminCsrf, `/v1/admin/withdrawals/${ded.id}/approve`, {
      externalReference: 'E2E-DED-1',
    });
    await post(admin, adminCsrf, `/v1/admin/withdrawals/${ontop.id}/approve`, {
      externalReference: 'E2E-ONTOP-1',
    });
    const after = await platformUsd(admin);
    near(after.volumeOut - before.volumeOut, 305);
    near(after.feesEarned - before.feesEarned, 10);

    // The unified activity feed reports the GROSS that moved (net + fee) for
    // both fee modes — not the bare requested amount, which for ON_TOP would
    // silently equal net and hide the fee from the feed/export.
    const activityRow = async (ref: string) => {
      const p = new URLSearchParams({ kind: 'WITHDRAWAL', search: ref });
      const res = await ownerB.get(`/v1/company/activity?${p.toString()}`);
      expect(res.ok()).toBeTruthy();
      const rows = unwrap(await res.json()).data as Array<Record<string, string>>;
      expect(rows, `activity row for ${ref}`).toHaveLength(1);
      return rows[0];
    };
    const ontopRow = await activityRow('E2E-ONTOP-1');
    near(ontopRow.amount, 205); // gross, not the requested 200
    near(ontopRow.fee, 5);
    near(ontopRow.net, 200);
    const dedRow = await activityRow('E2E-DED-1');
    near(dedRow.amount, 100);
    near(dedRow.fee, 5);
    near(dedRow.net, 95);
  });
});
