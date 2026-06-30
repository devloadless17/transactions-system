/**
 * Integration tests for the PAYOUT money-out block while the company owes the
 * platform a RECEIVABLE (the clawback shortfall from an under-funded reversal).
 *
 * Mirrors the WITHDRAWAL owes-block tests in money-flows.int-spec.ts but for
 * PayoutsService:
 *   - request() refuses to reserve funds while a RECEIVABLE is outstanding
 *     (payouts.service.ts ~91).
 *   - approve() re-asserts the block so reserved funds can't leave when a
 *     reversal booked a RECEIVABLE *after* the payout reserved (~173).
 *
 * Both paths must leave the ledger balanced and the wallet untouched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money } from '@app/shared';
import {
  addTransactionFee,
  buildHarness,
  cashWithdrawalInput,
  createCompany,
  createEnabledSource,
  ingestInput,
  payoutInput,
  snapshot,
  type Harness,
} from './harness';

/** Money-aware equality so 90 and 90.00000000 compare equal. */
const eq = (a: string, b: string) => Money.of(a).eq(Money.of(b));

let h: Harness;

beforeAll(async () => {
  h = buildHarness();
  await h.prisma.$connect();
});

afterAll(async () => {
  await h.prisma.$disconnect();
});

/**
 * Book an outstanding RECEIVABLE of `net` (the post-fee amount) by ingesting,
 * withdrawing + approving the whole net, then reversing the under-funded
 * deposit so the clawback shortfall lands in RECEIVABLE. Returns nothing; the
 * caller asserts the snapshot.
 */
async function bookReceivable(companyId: string, userId: string, sourceId: string): Promise<void> {
  // Ingest 100 → net 90 to available (10% TRANSACTION fee).
  const txn = await h.transactions.ingest(
    { kind: 'source', sourceId },
    ingestInput(companyId, '100'),
  );
  // Withdraw all 90 and approve → available drains to 0.
  const w = await h.withdrawals.request(companyId, userId, cashWithdrawalInput('90'));
  await h.withdrawals.approve(w.id, userId, { externalReference: 'owes-block-wd' });
  // Reverse the funding ingest: net 90 can't be clawed from available (0) → RECEIVABLE 90.
  await h.transactions.reverse(txn.id, { actorId: userId, reason: 'chargeback' });
}

describe('payout money-out-blocked-while-owing', () => {
  it('Scenario A: request() throws ConflictError while a RECEIVABLE is outstanding', async () => {
    const { companyId, userId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addTransactionFee(h, companyId, '10');

    await bookReceivable(companyId, userId, sourceId);
    const owing = await snapshot(h, companyId);
    expect(owing.balanced).toBe(true);
    expect(eq(owing.receivableLedger, '90')).toBe(true); // company owes 90

    // Top the wallet back up so the refusal is the DEBT block, not insufficiency.
    await h.transactions.ingest({ kind: 'source', sourceId }, ingestInput(companyId, '100'));
    const funded = await snapshot(h, companyId);
    expect(eq(funded.wallet!.available, '90')).toBe(true);

    // A payout request must be refused while the platform is owed.
    await expect(h.payouts.request(companyId, userId, payoutInput('5'))).rejects.toThrow(
      /owed to the platform must be settled before a payout/i,
    );

    // Nothing reserved — wallet untouched, debt unchanged, books still balanced.
    const after = await snapshot(h, companyId);
    expect(after.balanced).toBe(true);
    expect(eq(after.wallet!.available, '90')).toBe(true);
    expect(eq(after.wallet!.reserved, '0')).toBe(true);
    expect(eq(after.receivableLedger, '90')).toBe(true);
  });

  it('Scenario B: approve() rejects when a reversal booked a RECEIVABLE after the payout reserved', async () => {
    const { companyId, userId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addTransactionFee(h, companyId, '10');

    // Ingest 100 → net 90 available.
    const txn = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '100'),
    );

    // Request a payout (debt-free) — reserves 90: available 90→0, reserved 90.
    const p = await h.payouts.request(companyId, userId, payoutInput('90'));
    expect(p.status).toBe('PENDING');
    const reserved = await snapshot(h, companyId);
    expect(reserved.balanced).toBe(true);
    expect(eq(reserved.wallet!.available, '0')).toBe(true);
    expect(eq(reserved.wallet!.reserved, '90')).toBe(true);

    // Reverse the funding ingest WHILE the payout is still PENDING. The clawback
    // claims `available` (now 0), so the full 90 books to RECEIVABLE and the
    // reserved 90 is left intact.
    await h.transactions.reverse(txn.id, { actorId: userId, reason: 'chargeback' });
    const mid = await snapshot(h, companyId);
    expect(mid.balanced).toBe(true);
    expect(eq(mid.receivableLedger, '90')).toBe(true);
    expect(eq(mid.reservedLedger, '90')).toBe(true);

    // Approving now would send 90 out while the company owes 90 (a double loss).
    // Approval must be blocked until the debt is settled.
    await expect(
      h.payouts.approve(p.id, userId, { externalReference: 'should-be-blocked' }),
    ).rejects.toThrow(/owed to the platform must be settled before this payout can be approved/i);

    // The payout stays PENDING; reserved is unchanged; the books remain balanced.
    const fetched = await h.payouts.getById(p.id, companyId);
    expect(fetched.status).toBe('PENDING');
    const after = await snapshot(h, companyId);
    expect(after.balanced).toBe(true);
    expect(eq(after.reservedLedger, '90')).toBe(true);
    expect(eq(after.wallet!.reserved, '90')).toBe(true);
    expect(eq(after.receivableLedger, '90')).toBe(true);
  });
});
