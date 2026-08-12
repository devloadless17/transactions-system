import { Money, type FeeApplication } from '@app/shared';
import type { PrismaClient } from '@app/db';
import { InsufficientBalanceError } from '../../common/errors/domain.error';
import type { LedgerEntryInput } from './ledger.service';

/**
 * Shared ledger/wallet helpers for the money flows. The fee split — `reservedTotal`
 * (the gross amount that moves) and `netOfFee` (the recipient's net) — is the
 * single definition reused by money-OUT (withdrawals/payouts reserve+settle) AND
 * money-IN (transaction ingest + load approval debit), so the ON_TOP/DEDUCTED
 * arithmetic can't drift between flows.
 *
 * The reserve/release/settle ENTRY builders below are money-OUT only: withdrawals
 * and payouts share an identical lifecycle — available → reserved on request,
 * reserved → external (+ realized fee) on approval, reserved → available on
 * reject/cancel — and loads (money-IN) build their own entries directly.
 */

/**
 * Gross amount that moves for a row = amount, or amount + fee when the fee is ON_TOP.
 *
 * PRECONDITION: both arguments are already at MONEY_SCALE. This does not round —
 * sums and differences of at-scale values are exact, which is what lets the
 * resulting ledger set balance by construction. Quantize on the way IN
 * (Money.fromDb at the DB read), never on the way out.
 */
export function reservedTotal(amount: Money, fee: Money, feeApplication: FeeApplication): Money {
  return feeApplication === 'ON_TOP' ? amount.add(fee) : amount;
}

/**
 * The recipient's net for a flow:
 *   - ON_TOP:   the fee is charged on top, so the recipient gets the full `amount`.
 *   - DEDUCTED: the fee comes out of the amount, so the recipient gets amount − fee.
 * One definition shared by withdrawals/payouts (the `net` at request, the
 * `external` at approval) and loads (the credited net), so the split can't drift
 * between the sibling flows.
 *
 * PRECONDITION: both arguments are already at MONEY_SCALE — see reservedTotal.
 */
export function netOfFee(amount: Money, fee: Money, feeApplication: FeeApplication): Money {
  return feeApplication === 'ON_TOP' ? amount : amount.sub(fee);
}

/** Read available inside the current tx and throw a clear "top up" error if it can't cover `required`. */
export async function assertSufficient(
  tx: PrismaClient,
  companyId: string,
  currency: string,
  required: Money,
): Promise<void> {
  const wallet = await tx.wallet.findUnique({
    where: { companyId_currency: { companyId, currency } },
  });
  // Money.of + floorToScale, NOT Money.fromDb: fromDb rounds half-even FIRST, so
  // `fromDb(x).floorToScale()` is a no-op that can report a balance ABOVE what the
  // wallet holds (9.999 -> 10.00), letting a flow reserve money that is not there
  // and turning a clean InsufficientBalanceError into a negative-balance 409.
  // Floor the RAW stored value — same as splitClawback does.
  const available = Money.of(wallet?.availableBalance?.toString() ?? '0').floorToScale();
  if (available.lt(required)) {
    throw new InsufficientBalanceError({
      currency,
      required: required.toString(),
      available: available.toString(),
      shortfall: required.sub(available).toString(),
    });
  }
}

/** Ties the ledger entries back to the originating withdrawal or payout row. */
export type FlowRef = Pick<LedgerEntryInput, 'withdrawalId' | 'payoutId'>;

/** Request: move available → reserved (DEBIT AVAILABLE, CREDIT RESERVED). */
export function reserveEntries(
  ref: FlowRef,
  companyId: string,
  currency: string,
  reserved: Money,
): LedgerEntryInput[] {
  return [
    { ...ref, companyId, accountType: 'AVAILABLE', direction: 'DEBIT', amount: reserved, currency },
    { ...ref, companyId, accountType: 'RESERVED', direction: 'CREDIT', amount: reserved, currency },
  ];
}

/** Reject/cancel: return reserved → available (DEBIT RESERVED, CREDIT AVAILABLE). */
export function releaseEntries(
  ref: FlowRef,
  companyId: string,
  currency: string,
  reserved: Money,
): LedgerEntryInput[] {
  return [
    { ...ref, companyId, accountType: 'RESERVED', direction: 'DEBIT', amount: reserved, currency },
    {
      ...ref,
      companyId,
      accountType: 'AVAILABLE',
      direction: 'CREDIT',
      amount: reserved,
      currency,
    },
  ];
}

/**
 * Approve: reserved → external(net) + FEE(fee). Zero lines are skipped because
 * the ledger rejects non-positive amounts; debits still equal credits since the
 * reserved DEBIT equals external + fee.
 */
export function settleEntries(
  ref: FlowRef,
  companyId: string,
  currency: string,
  reserved: Money,
  external: Money,
  fee: Money,
): LedgerEntryInput[] {
  const entries: LedgerEntryInput[] = [
    { ...ref, companyId, accountType: 'RESERVED', direction: 'DEBIT', amount: reserved, currency },
  ];
  if (external.isPositive()) {
    entries.push({
      ...ref,
      companyId,
      accountType: 'EXTERNAL',
      direction: 'CREDIT',
      amount: external,
      currency,
    });
  }
  if (fee.isPositive()) {
    entries.push({
      ...ref,
      companyId,
      accountType: 'FEE',
      direction: 'CREDIT',
      amount: fee,
      currency,
    });
  }
  return entries;
}
