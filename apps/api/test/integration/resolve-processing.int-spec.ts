/**
 * Integration tests for WithdrawalsService.resolveProcessing — the operator
 * escape hatch for a withdrawal stuck in PROCESSING (an UNKNOWN Whish W2W
 * transfer reconciled by hand). Two invariants are guarded here:
 *
 *  A. The DOUBLE-PAY GUARD. Once the transfer is known to have SUCCEEDED (money
 *     physically left the platform), reverting the row back to PENDING would let
 *     a later cancel/reject release the reserved funds to the company on top of
 *     the cash it already received. resolveProcessing({action:'revert'}) must
 *     therefore THROW ConflictError on such a row.
 *
 *  B. The COMPLETE path. A PROCESSING row that did NOT succeed can be settled by
 *     the operator with {action:'complete', externalReference}. approve() books
 *     the full net (cents included) as having left. The ledger must stay
 *     balanced and the wallet must remain a faithful projection of it.
 *
 * Driven entirely through the real services + the real _test DB.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money } from '@app/shared';
import type { CreateWithdrawalInput } from '@app/shared';
import { ConflictError } from '../../src/common/errors/domain.error';
import {
  addFlowFee,
  buildHarness,
  createCompany,
  createEnabledSource,
  ingestInput,
  snapshot,
  type Harness,
} from './harness';

/** Money-aware equality so 49 and 49.00000000 compare equal. */
const eq = (a: string, b: string) => Money.of(a).eq(Money.of(b));

/** A WISH/USD withdrawal request — the only payout method auto-approval (and so PROCESSING) ever produces. */
function wishWithdrawalInput(amount: string): CreateWithdrawalInput {
  return {
    amount,
    currency: 'USD',
    payout: {
      method: 'WISH',
      recipientName: 'Test Recipient',
      recipientPhone: '+96170000000',
    },
  };
}

let h: Harness;

beforeAll(async () => {
  h = buildHarness();
  await h.prisma.$connect();
});

afterAll(async () => {
  await h.prisma.$disconnect();
});

describe('resolveProcessing double-pay guard', () => {
  it('A: REFUSES to revert a PROCESSING row whose transfer already SUCCEEDED (would double-pay)', async () => {
    const { companyId, userId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    // Fund the wallet: no transaction fee (rule required so ingest prices), so
    // available == amount. Ingest 100 → 100 available.
    await addFlowFee(h, companyId, 'TRANSACTION', '0');
    await h.transactions.ingest({ kind: 'source', sourceId }, ingestInput(companyId, '100'));

    // Request a WISH withdrawal (no WITHDRAWAL fee here → net == amount == 40),
    // reserving 40: available 100→60, reserved 0→40.
    const w = await h.withdrawals.request(companyId, userId, wishWithdrawalInput('40'));
    const afterRequest = await snapshot(h, companyId);
    expect(afterRequest.balanced).toBe(true);
    expect(eq(afterRequest.wallet!.available, '60')).toBe(true);
    expect(eq(afterRequest.wallet!.reserved, '40')).toBe(true);

    // Claim it for auto-processing → PROCESSING (the lock that bars cancel/reject).
    const claimed = await h.withdrawals.claimForProcessing(w.id, companyId);
    expect(claimed).toBe(true);

    // The W2W transfer fired and SUCCEEDED, but settlement hasn't run yet: mark
    // the auto-approval status SUCCESS. The money has physically left.
    await h.withdrawals.setAutoMeta(w.id, companyId, { status: 'SUCCESS' });

    // Reverting now would send the reserved 40 back to available, on top of the
    // 40 the recipient already received off-platform → a double-pay. Refused.
    await expect(
      h.withdrawals.resolveProcessing(w.id, userId, { action: 'revert' }),
    ).rejects.toThrow(ConflictError);

    // Nothing moved: still PROCESSING, reserved intact, books balanced.
    const after = await snapshot(h, companyId);
    expect(after.balanced).toBe(true);
    expect(eq(after.wallet!.available, '60')).toBe(true);
    expect(eq(after.wallet!.reserved, '40')).toBe(true);
    const row = await h.withdrawals.getById(w.id, companyId);
    expect(row.status).toBe('PROCESSING');
  });

  it('B: COMPLETE settles a non-succeeded PROCESSING row at the full net; books stay balanced', async () => {
    const { companyId, userId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addFlowFee(h, companyId, 'TRANSACTION', '0');
    // Ingest 100 → 100 available.
    await h.transactions.ingest({ kind: 'source', sourceId }, ingestInput(companyId, '100'));

    // A 1% DEDUCTED WITHDRAWAL fee makes the net carry cents, which must all be
    // paid. amount 50.40, fee 0.504 → 0.50 at the cent scale (DEDUCTED) →
    // reserved 50.40, net 49.90.
    await addFlowFee(h, companyId, 'WITHDRAWAL', '1');
    const w = await h.withdrawals.request(companyId, userId, wishWithdrawalInput('50.40'));
    expect(eq(w.feeAmount, '0.50')).toBe(true);
    expect(eq(w.netAmount, '49.90')).toBe(true);

    const afterRequest = await snapshot(h, companyId);
    expect(afterRequest.balanced).toBe(true);
    expect(eq(afterRequest.wallet!.reserved, '50.40')).toBe(true); // reserved == amount (DEDUCTED)
    expect(eq(afterRequest.wallet!.available, '49.60')).toBe(true); // 100 − 50.40

    // Claim → PROCESSING. This row did NOT get a SUCCESS / needsAttention flag —
    // it's the UNKNOWN-but-actually-unpaid case the operator confirms by hand.
    expect(await h.withdrawals.claimForProcessing(w.id, companyId)).toBe(true);

    // Operator confirms the money moved → settle. The recipient got the full net
    // 49.90 (cents included); only the original 0.50 fee is realized to FEE.
    const completed = await h.withdrawals.resolveProcessing(w.id, userId, {
      action: 'complete',
      externalReference: 'ext-1',
    });
    expect(completed.status).toBe('COMPLETED');
    expect(completed.externalReference).toBe('ext-1');
    expect(eq(completed.roundingRemainder, '0')).toBe(true);

    // The ledger identity holds: reserved (50.40) → EXTERNAL (49.90) + FEE (0.50).
    // Books balance, reserved is fully drained, and the wallet still mirrors the
    // ledger.
    const after = await snapshot(h, companyId);
    expect(after.balanced).toBe(true);
    expect(eq(after.wallet!.reserved, '0')).toBe(true);
    expect(eq(after.reservedLedger, '0')).toBe(true);
    expect(eq(after.wallet!.available, '49.60')).toBe(true); // untouched by settlement
    expect(eq(after.wallet!.available, after.availableLedger)).toBe(true);
    expect(eq(after.receivableLedger, '0')).toBe(true);
  });
});
