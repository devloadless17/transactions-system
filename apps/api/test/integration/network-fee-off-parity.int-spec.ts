/**
 * The switch-OFF guarantee, end to end on the real database: a company whose
 * network fee is OFF is indistinguishable from a company that never had one.
 *
 * Twin companies run the SAME sequence of money operations — deposits (incl. a
 * reversal into a receivable), withdrawals (manual, whole-dollar auto, reject),
 * payouts, loads (incl. receivable settlement):
 *   A — never configured (the state of every company after the deploy);
 *   B — network-fee rates saved on every flow, but the switch OFF.
 * Every response money field, every ledger leg and the final balances must be
 * identical. (The pre-network-fee code is pinned against the new code in the
 * unit-level network-fee-parity.spec.ts; this proves the stored config of a
 * switched-off company can never leak into a booking.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreateWithdrawalInput } from '@app/shared';
import {
  addFixedFlowFee,
  addFlowFee,
  buildHarness,
  cashWithdrawalInput,
  createCompany,
  createEnabledSource,
  ingestInput,
  legsFor,
  loadInput,
  payoutInput,
  setNetworkFee,
  snapshot,
  USD,
  type Harness,
} from './harness';

let h: Harness;

beforeAll(async () => {
  h = buildHarness();
  await h.prisma.$connect();
});

afterAll(async () => {
  await h.prisma.$disconnect();
});

function wishWithdrawalInput(amount: string): CreateWithdrawalInput {
  return {
    amount,
    currency: USD,
    payout: { method: 'WISH', recipientName: 'Whish Payee', recipientPhone: '+96170000000' },
  };
}

/** The money fields of a response — everything but ids and timestamps. */
function money(r: {
  amount: string;
  netAmount: string;
  networkFeeAmount: string;
  commissionAmount?: string;
  feeAmount?: string;
  feeApplication?: string;
  totalAmount?: string;
  roundingRemainder?: string;
  status: string;
}) {
  return {
    amount: r.amount,
    netAmount: r.netAmount,
    networkFeeAmount: r.networkFeeAmount,
    commissionAmount: r.commissionAmount,
    feeAmount: r.feeAmount,
    feeApplication: r.feeApplication,
    totalAmount: r.totalAmount,
    roundingRemainder: r.roundingRemainder,
    status: r.status,
  };
}

/** One full sequence of money operations; returns everything observable about it. */
async function scenario(companyId: string, userId: string) {
  const steps: unknown[] = [];
  const sourceId = await createEnabledSource(h, companyId);
  await addFlowFee(h, companyId, 'TRANSACTION', '2');
  await addFlowFee(h, companyId, 'WITHDRAWAL', '6.65');
  await addFixedFlowFee(h, companyId, 'PAYOUT', '1', 'ON_TOP');
  await addFlowFee(h, companyId, 'LOAD', '1');

  // Deposits.
  const d1 = await h.transactions.ingest(
    { kind: 'source', sourceId },
    ingestInput(companyId, '100'),
  );
  steps.push(money(d1), await legsFor(h, companyId, { transactionId: d1.id }));
  const d2 = await h.transactions.ingest(
    { kind: 'source', sourceId },
    ingestInput(companyId, '33.33'),
  );
  steps.push(money(d2), await legsFor(h, companyId, { transactionId: d2.id }));

  // Withdrawal: whole-dollar auto settlement.
  const w1 = await h.withdrawals.request(companyId, userId, wishWithdrawalInput('20'));
  const w1done = await h.withdrawals.approve(
    w1.id,
    userId,
    { externalReference: 'a' },
    { floorWhole: true },
  );
  steps.push(money(w1), money(w1done), await legsFor(h, companyId, { withdrawalId: w1.id }));

  // Withdrawal: rejected.
  const w2 = await h.withdrawals.request(companyId, userId, cashWithdrawalInput('10'));
  await h.withdrawals.reject(w2.id, userId, { notes: 'no' });
  steps.push(money(w2), await legsFor(h, companyId, { withdrawalId: w2.id }));

  // Payout (ON_TOP).
  const p1 = await h.payouts.request(companyId, userId, payoutInput('15'));
  const p1done = await h.payouts.approve(p1.id, userId, { externalReference: 'b' });
  steps.push(money(p1), money(p1done), await legsFor(h, companyId, { payoutId: p1.id }));

  // Spend the rest, then reverse a deposit → the company owes a receivable.
  const before = await snapshot(h, companyId);
  const w3 = await h.withdrawals.request(
    companyId,
    userId,
    cashWithdrawalInput(before.availableLedger),
  );
  await h.withdrawals.approve(w3.id, userId, { externalReference: 'c' });
  await h.transactions.reverse(d1.id, { actorId: userId, reason: 'chargeback' });
  steps.push(money(w3), await legsFor(h, companyId, { transactionId: d1.id }));

  // A load settles the receivable first.
  const l1 = await h.loads.request(companyId, userId, loadInput('150'));
  const l1done = await h.loads.approve(l1.id, userId, { externalReference: 'd' });
  steps.push(money(l1), money(l1done), await legsFor(h, companyId, { loadId: l1.id }));

  const final = await snapshot(h, companyId);
  return { steps, final };
}

describe('network fee OFF: a switched-off company books exactly like one that never had it', () => {
  it('identical responses, ledger legs and balances across every flow', async () => {
    const a = await createCompany(h);
    const b = await createCompany(h);
    // B has rates on every flow — but the switch is OFF.
    await setNetworkFee(h, b.companyId, {
      enabled: false,
      rates: [
        { operationType: 'TRANSACTION', feeType: 'PERCENTAGE', feeValue: '1' },
        { operationType: 'WITHDRAWAL', feeType: 'FIXED', feeValue: '2' },
        { operationType: 'PAYOUT', feeType: 'PERCENTAGE', feeValue: '3.333333' },
        { operationType: 'LOAD', feeType: 'FIXED', feeValue: '0.50' },
      ],
    });

    const ra = await scenario(a.companyId, a.userId);
    const rb = await scenario(b.companyId, b.userId);

    expect(rb.steps).toEqual(ra.steps);
    expect(rb.final).toEqual(ra.final);

    // And neither booked a single network-fee cent.
    expect(ra.final.networkFeeLedger).toBe('0');
    expect(rb.final.networkFeeLedger).toBe('0');
    expect(ra.final.balanced).toBe(true);
  });
});
