/**
 * Integration tests for the two sister money flows that share the ledger with
 * transactions + withdrawals: LOADS (money in — company tops up its wallet)
 * and PAYOUTS (money out — same lifecycle as a withdrawal). Same invariants:
 * the books balance and the wallet stays a faithful projection of the ledger.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money } from '@app/shared';
import {
  addFlowFee,
  addTransactionFee,
  buildHarness,
  createCompany,
  createEnabledSource,
  ingestInput,
  loadInput,
  payoutInput,
  snapshot,
  type Harness,
} from './harness';

const eq = (a: string, b: string) => Money.of(a).eq(Money.of(b));

let h: Harness;

beforeAll(async () => {
  h = buildHarness();
  await h.prisma.$connect();
});

afterAll(async () => {
  await h.prisma.$disconnect();
});

describe('load (money in)', () => {
  it('persists PENDING on request without moving any money', async () => {
    const { companyId, userId } = await createCompany(h);

    const load = await h.loads.request(companyId, userId, loadInput('100'));
    expect(load.status).toBe('PENDING');
    expect(eq(load.netAmount, '100')).toBe(true); // no LOAD fee → net == amount

    // Funds haven't arrived yet — nothing is booked and no wallet exists.
    const snap = await snapshot(h, companyId);
    expect(eq(snap.totalDebit, '0')).toBe(true);
    expect(eq(snap.totalCredit, '0')).toBe(true);
    expect(snap.wallet).toBeNull();
  });

  it('credits the wallet with the net and books the fee on approval', async () => {
    const { companyId, userId } = await createCompany(h);
    await addFlowFee(h, companyId, 'LOAD', '10'); // 10%

    const load = await h.loads.request(companyId, userId, loadInput('100'));
    expect(eq(load.feeAmount, '10')).toBe(true);
    expect(eq(load.netAmount, '90')).toBe(true);

    await h.loads.approve(load.id, userId, { externalReference: 'recv-001' });

    const snap = await snapshot(h, companyId);
    expect(snap.balanced).toBe(true); // EXTERNAL 100 dr == AVAILABLE 90 cr + FEE 10 cr
    expect(eq(snap.availableLedger, '90')).toBe(true);
    expect(eq(snap.wallet!.available, snap.availableLedger)).toBe(true);
  });
});

describe('payout (money out)', () => {
  // Fund the wallet with available balance via an ingest, then pay out.
  async function fundedCompany(available: string) {
    const c = await createCompany(h);
    const sourceId = await createEnabledSource(h, c.companyId);
    await addTransactionFee(h, c.companyId, '0'); // no fee → available == amount
    await h.transactions.ingest({ kind: 'source', sourceId }, ingestInput(c.companyId, available));
    return c;
  }

  it('moves available → reserved on request, reserved → external on approval', async () => {
    const { companyId, userId } = await fundedCompany('100');

    const p = await h.payouts.request(companyId, userId, payoutInput('40'));
    const afterRequest = await snapshot(h, companyId);
    expect(afterRequest.balanced).toBe(true);
    expect(eq(afterRequest.wallet!.available, '60')).toBe(true);
    expect(eq(afterRequest.wallet!.reserved, '40')).toBe(true);

    await h.payouts.approve(p.id, userId, { externalReference: 'pay-ref-100' });
    const afterApprove = await snapshot(h, companyId);
    expect(afterApprove.balanced).toBe(true);
    expect(eq(afterApprove.wallet!.available, '60')).toBe(true);
    expect(eq(afterApprove.wallet!.reserved, '0')).toBe(true);
    expect(eq(afterApprove.wallet!.available, afterApprove.availableLedger)).toBe(true);
  });

  it('releases the reserved funds back to available on cancel', async () => {
    const { companyId, userId } = await fundedCompany('100');

    const p = await h.payouts.request(companyId, userId, payoutInput('40'));
    expect(eq((await snapshot(h, companyId)).wallet!.reserved, '40')).toBe(true);

    const cancelled = await h.payouts.cancel(p.id, companyId, userId, {});
    expect(cancelled.status).toBe('CANCELLED');

    const snap = await snapshot(h, companyId);
    expect(snap.balanced).toBe(true);
    expect(eq(snap.wallet!.available, '100')).toBe(true); // fully restored
    expect(eq(snap.wallet!.reserved, '0')).toBe(true);
  });
});
