import { Money, type FeeApplication } from '@app/shared';
import type { PrismaClient } from '@app/db';
import { InsufficientBalanceError } from '../../common/errors/domain.error';
import type { LedgerEntryInput } from './ledger.service';

/**
 * Shared ledger/wallet helpers for the money-OUT flows (withdrawals + payouts),
 * which have an identical lifecycle: available → reserved on request, reserved
 * → external (+ realized fee) on approval, reserved → available on reject/cancel.
 * Loads are money-IN and deliberately do NOT use these. Extracted so the
 * reserve/release/settle rules live in one place instead of being copy-pasted
 * into both services.
 */

/** Reserved total for a row = amount, or amount + fee when the fee is ON_TOP. */
export function reservedTotal(amount: Money, fee: Money, feeApplication: FeeApplication): Money {
  return feeApplication === 'ON_TOP' ? amount.add(fee) : amount;
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
  const available = Money.of(wallet?.availableBalance.toString() ?? '0');
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
