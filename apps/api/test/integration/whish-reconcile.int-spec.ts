import { beforeAll, describe, expect, it } from 'vitest';
import { WhishPaymentStatus } from '@app/shared';
import {
  addTransactionFee,
  buildHarness,
  createCompany,
  snapshot,
  USD,
  type Harness,
} from './harness';

/**
 * Regression cover for the Whish settlement edge case (#3): a Whish `success`
 * arriving for a link whose local row already reached a TERMINAL state
 * (EXPIRED/FAILED) must NOT silently credit the wallet against a record that
 * says it never collected. Before the fix, reconcile() only short-circuited on
 * PAID, so a late success ran ingest (booking money) while the PENDING-guarded
 * settle matched 0 rows — orphaning the credit. These tests pin the corrected
 * behaviour against the real DB + ledger.
 */

let tok = 0;
const callbackToken = () => `it-tok-${Date.now().toString(36)}-${tok++}`;

async function provisionWhishSource(h: Harness): Promise<void> {
  await h.prisma.runAsAdmin(async (tx) => {
    const existing = await tx.source.findUnique({ where: { code: 'whish' } });
    if (!existing) await tx.source.create({ data: { name: 'Whish', code: 'whish' } });
  });
}

async function insertPayment(
  h: Harness,
  companyId: string,
  status: WhishPaymentStatus,
): Promise<{ id: string }> {
  return h.prisma.runAsAdmin((tx) =>
    tx.whishPayment.create({
      data: {
        companyId,
        callbackToken: callbackToken(),
        amount: '50.00',
        currency: USD,
        invoice: 'inv-test',
        status,
      },
      select: { id: true },
    }),
  );
}

describe('Whish reconcile — late success on a terminal link (#3)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = buildHarness();
    await provisionWhishSource(h);
  });

  it('settles + credits a still-PENDING link when Whish reports success', async () => {
    const { companyId } = await createCompany(h);
    await addTransactionFee(h, companyId, '0'); // ingest must be able to price the settlement
    const p = await insertPayment(h, companyId, WhishPaymentStatus.PENDING);
    h.whishClient.status = 'success';

    const res = await h.whish.refreshStatus(companyId, p.id);

    expect(res.status).toBe('PAID');
    expect(res.transactionId).toBeTruthy();
    const snap = await snapshot(h, companyId);
    expect(snap.balanced).toBe(true);
    expect(Number(snap.wallet?.available)).toBe(50); // 0% fee → full credit
  });

  it('does NOT credit an already-EXPIRED link on a late success — flags it for an operator', async () => {
    const { companyId } = await createCompany(h);
    await addTransactionFee(h, companyId, '0');
    const p = await insertPayment(h, companyId, WhishPaymentStatus.EXPIRED);
    h.whishClient.status = 'success'; // customer "paid" after the link had expired

    const res = await h.whish.refreshStatus(companyId, p.id);

    // The money must NOT be booked; the record stays terminal, unlinked, flagged.
    expect(res.status).toBe('EXPIRED');
    expect(res.transactionId).toBeNull();
    expect(res.needsAttention).toBe(true);
    const snap = await snapshot(h, companyId);
    expect(Number(snap.totalCredit)).toBe(0); // no ledger entries booked at all
    expect(Number(snap.wallet?.available ?? '0')).toBe(0); // wallet never credited
  });

  it('is idempotent when the link is already PAID — no double credit', async () => {
    const { companyId } = await createCompany(h);
    await addTransactionFee(h, companyId, '0');
    const p = await insertPayment(h, companyId, WhishPaymentStatus.PENDING);
    h.whishClient.status = 'success';
    await h.whish.refreshStatus(companyId, p.id); // first settle → credited 50
    const res = await h.whish.refreshStatus(companyId, p.id); // refresh again

    expect(res.status).toBe('PAID');
    const snap = await snapshot(h, companyId);
    expect(Number(snap.wallet?.available)).toBe(50); // still 50, not 100
    expect(snap.balanced).toBe(true);
  });
});
