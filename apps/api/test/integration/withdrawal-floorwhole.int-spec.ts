/**
 * Integration tests for the auto-approved Whish W2W "floorWhole" settlement path
 * in WithdrawalsService.approve (withdrawals.service.ts ~217-260).
 *
 * The auto Whish transfer sends WHOLE dollars only: the recipient gets
 * floor(net) and the sub-dollar remainder stays with the platform, rolled into
 * the realized FEE and recorded on the row as `roundingRemainder`. These tests
 * pin that the EXTERNAL debit is the whole-dollar amount, the remainder lands in
 * the FEE account (so debits still equal credits), the row records it, and the
 * ledger stays balanced. The second scenario pins that an already-succeeded
 * transfer (skipReceivableBlock) still settles past an outstanding RECEIVABLE.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money } from '@app/shared';
import type { CreateWithdrawalInput } from '@app/shared';
import {
  addFlowFee,
  addTransactionFee,
  buildHarness,
  cashWithdrawalInput,
  createCompany,
  createEnabledSource,
  ingestInput,
  snapshot,
  USD,
  type Harness,
} from './harness';

/** Money-aware equality so 18 and 18.00000000 compare equal. */
const eq = (a: string, b: string) => Money.of(a).eq(Money.of(b));

/** A WISH/USD withdrawal — the only method eligible for auto Whish W2W. */
function wishWithdrawalInput(amount: string): CreateWithdrawalInput {
  return {
    amount,
    currency: USD,
    payout: {
      method: 'WISH',
      recipientName: 'Whish Payee',
      recipientPhone: '+96170000000',
    },
  };
}

/**
 * Net realized FEE for a SPECIFIC withdrawal, read straight from the ledger:
 * Σ FEE credit − Σ FEE debit scoped to that withdrawal's entries. Scoped by
 * `withdrawalId` so the funding ingest's own FEE (the 10% txn fee) is excluded.
 */
async function feeRealized(h: Harness, companyId: string, withdrawalId: string): Promise<string> {
  return h.prisma.runAsScoped(companyId, async (tx) => {
    const entries = await tx.ledgerEntry.findMany({
      where: { companyId, withdrawalId, accountType: 'FEE' },
    });
    let credit = Money.zero();
    let debit = Money.zero();
    for (const e of entries) {
      const amt = Money.of(e.amount.toString());
      if (e.direction === 'CREDIT') credit = credit.add(amt);
      else debit = debit.add(amt);
    }
    return credit.sub(debit).toString();
  });
}

/**
 * Money that left the platform for a SPECIFIC withdrawal: Σ EXTERNAL credit − debit
 * scoped to that withdrawal's entries (its EXTERNAL leg is a CREDIT). Scoped by
 * `withdrawalId` so the funding ingest's EXTERNAL debit (100) is excluded.
 */
async function externalDebit(h: Harness, companyId: string, withdrawalId: string): Promise<string> {
  return h.prisma.runAsScoped(companyId, async (tx) => {
    const entries = await tx.ledgerEntry.findMany({
      where: { companyId, withdrawalId, accountType: 'EXTERNAL' },
    });
    let debit = Money.zero();
    let credit = Money.zero();
    for (const e of entries) {
      const amt = Money.of(e.amount.toString());
      if (e.direction === 'DEBIT') debit = debit.add(amt);
      else credit = credit.add(amt);
    }
    return credit.sub(debit).toString();
  });
}

let h: Harness;

beforeAll(async () => {
  h = buildHarness();
  await h.prisma.$connect();
});

afterAll(async () => {
  await h.prisma.$disconnect();
});

describe('withdrawal floorWhole settlement (auto Whish W2W)', () => {
  it('floors the EXTERNAL debit to whole dollars and keeps the cents in the FEE', async () => {
    const { companyId, userId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    // Fund the wallet: ingest 100 at 10% txn fee → net 90 available.
    await addTransactionFee(h, companyId, '10');
    await h.transactions.ingest({ kind: 'source', sourceId }, ingestInput(companyId, '100'));

    // A 6.65% DEDUCTED WITHDRAWAL fee on amount 20 → fee 1.33, net 18.67.
    // (DEDUCTED reserves `amount` = 20; recipient net = amount − fee = 18.67.)
    await addFlowFee(h, companyId, 'WITHDRAWAL', '6.65');
    const w = await h.withdrawals.request(companyId, userId, wishWithdrawalInput('20'));
    expect(eq(w.feeAmount, '1.33')).toBe(true);
    expect(eq(w.netAmount, '18.67')).toBe(true);

    // Auto-approve the fractional-net WISH withdrawal with whole-dollar flooring.
    const approved = await h.withdrawals.approve(
      w.id,
      userId,
      { externalReference: 'ext-1' },
      { floorWhole: true },
    );
    expect(approved.status).toBe('COMPLETED');
    expect(approved.externalReference).toBe('ext-1');
    // The sub-dollar remainder kept by the platform is recorded on the row.
    expect(eq(approved.roundingRemainder, '0.67')).toBe(true);

    // The money that actually left the platform is the WHOLE-dollar amount: 18.
    expect(eq(await externalDebit(h, companyId, w.id), '18')).toBe(true);
    // The realized FEE = original fee 1.33 + floored remainder 0.67 = 2.00.
    expect(eq(await feeRealized(h, companyId, w.id), '2')).toBe(true);

    // Books balance: RESERVED 20 dr == EXTERNAL 18 cr + FEE 2 cr; reserved drained.
    const snap = await snapshot(h, companyId);
    expect(snap.balanced).toBe(true);
    expect(eq(snap.wallet!.reserved, '0')).toBe(true);
    // Wallet identity: available unchanged at 70 (90 − 20 reserved), mirrors ledger.
    expect(eq(snap.wallet!.available, '70')).toBe(true);
    expect(eq(snap.wallet!.available, snap.availableLedger)).toBe(true);
    expect(eq(snap.wallet!.reserved, snap.reservedLedger)).toBe(true);
  });

  it('settles past an outstanding RECEIVABLE when skipReceivableBlock is set (transfer already left)', async () => {
    const { companyId, userId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addTransactionFee(h, companyId, '10');
    await addFlowFee(h, companyId, 'WITHDRAWAL', '6.65');

    // Fund with two ingests of 100 → net 90 each, available 180.
    const fund1 = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '100'),
    );
    await h.transactions.ingest({ kind: 'source', sourceId }, ingestInput(companyId, '100'));

    // Request the WISH withdrawal (net 18.67) FIRST, while no debt exists — this
    // reserves 20 (available 180 → 160). request() blocks on an outstanding
    // receivable, so it must precede the reversal below.
    const w = await h.withdrawals.request(companyId, userId, wishWithdrawalInput('20'));
    expect(eq(w.netAmount, '18.67')).toBe(true);

    // Now book a RECEIVABLE: withdraw+approve the remaining cash, then reverse
    // fund1. Drain the 160 still available via a CASH withdrawal so the 90
    // clawback can't be covered and books a debt the company owes the platform.
    const drain = await h.withdrawals.request(companyId, userId, cashWithdrawalInput('160'));
    await h.withdrawals.approve(drain.id, userId, { externalReference: 'drain-1' });
    const reversed = await h.transactions.reverse(fund1.id, {
      actorId: userId,
      reason: 'chargeback',
    });
    expect(reversed.status).toBe('REVERSED');

    // The company now owes the platform; a plain approve would be blocked.
    const owing = await snapshot(h, companyId);
    expect(owing.balanced).toBe(true);
    expect(Money.of(owing.receivableLedger).isPositive()).toBe(true);
    await expect(
      h.withdrawals.approve(w.id, userId, { externalReference: 'should-block' }),
    ).rejects.toThrow(/owed to the platform/i);

    // The transfer already SUCCEEDED off-platform, so the ledger MUST record it:
    // approve with skipReceivableBlock + floorWhole settles WITHOUT throwing.
    const approved = await h.withdrawals.approve(
      w.id,
      userId,
      { externalReference: 'ext-2' },
      { floorWhole: true, skipReceivableBlock: true },
    );
    expect(approved.status).toBe('COMPLETED');
    expect(eq(approved.roundingRemainder, '0.67')).toBe(true);

    // Settlement floored to whole dollars even past the debt; books stay balanced
    // and the receivable remains outstanding (still owed).
    const after = await snapshot(h, companyId);
    expect(after.balanced).toBe(true);
    expect(eq(after.wallet!.reserved, '0')).toBe(true);
    expect(eq(after.wallet!.reserved, after.reservedLedger)).toBe(true);
    expect(Money.of(after.receivableLedger).isPositive()).toBe(true);
  });
});
