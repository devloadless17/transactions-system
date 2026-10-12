import {
  Money,
  feeOnAmount,
  type CommissionType,
  type FeeApplication,
  type FeeOperationType,
} from '@app/shared';
import type { PrismaClient } from '@app/db';

/**
 * The optional per-company NETWORK FEE — a second platform fee charged next to
 * the commission, priced per flow (company_network_fees) and applied only while
 * the company's `networkFeeEnabled` switch is on.
 *
 * Deliberately plain functions, not a service: the money flows read the rate
 * inside their OWN company-scoped serializable transaction (so the fee and the
 * booking come from one snapshot, under RLS), and no constructor or DI wiring
 * changes. There is no cache — a primary-key read is cheap, and a switch flip
 * takes effect on the very next operation.
 *
 * The commission engine is untouched: the network fee is computed beside it,
 * never mixed into it, and frozen onto each money row at request/booking time.
 */

export interface NetworkFeeRate {
  feeType: CommissionType;
  // Dual-typed like a commission value: dollars when FIXED, a percent RATE when
  // PERCENTAGE.
  feeValue: string;
}

/**
 * The company's network-fee rate for one flow, or null when none applies —
 * the switch is off, or that flow has no rate.
 *
 * Runs inside the caller's company-scoped (tenant) transaction: RLS lets a
 * tenant read its own company row and its own rates, never write them.
 *
 * ONE read answers both questions — "is the switch on?" and "what is the
 * rate?" — so they always come from the same snapshot as the booking. Never
 * split them: a switch read at one moment and a rate read at another can
 * combine into a price that was never configured (a rate changed in the same
 * save that turned the switch off).
 */
export async function readNetworkFeeRate(
  tx: PrismaClient,
  companyId: string,
  operationType: FeeOperationType,
): Promise<NetworkFeeRate | null> {
  const row = await tx.companyNetworkFee.findFirst({
    where: { companyId, operationType, company: { networkFeeEnabled: true } },
    select: { feeType: true, feeValue: true },
  });
  return row ? { feeType: row.feeType, feeValue: row.feeValue.toString() } : null;
}

/**
 * The network fee on `amount` — the same base the commission is computed on,
 * and the same formula (see feeOnAmount): a FIXED fee is its dollar value, a
 * PERCENTAGE fee is amount × rate%, quantized ONCE to the money scale
 * (half-even). No rate → 0.
 */
export function computeNetworkFee(amount: Money, rate: NetworkFeeRate | null): Money {
  if (!rate) return Money.zero();
  return feeOnAmount(amount, rate.feeType, rate.feeValue);
}

/**
 * Deposits only. A deposit must ALWAYS book (it already happened upstream), so
 * under a DEDUCTED application the network fee may take only what the
 * commission leaves: net = amount − commission − network never goes below 0.
 * That guarantees switching the network fee on can never turn a deposit that
 * books today into one that fails or parks. ON_TOP fees are added on top of
 * the amount, so nothing needs bounding there.
 *
 * `capped` is true when the configured fee was reduced. It is configured
 * pricing meeting a small deposit, NOT a pricing gap — callers log it, they
 * never flag it as a pricing issue.
 */
export function boundDepositNetworkFee(args: {
  amount: Money;
  commission: Money;
  feeApplication: FeeApplication;
  computed: Money;
}): { network: Money; capped: boolean } {
  const { amount, commission, feeApplication, computed } = args;
  if (feeApplication === 'ON_TOP') return { network: computed, capped: false };
  const room = amount.sub(commission);
  if (!room.isPositive()) return { network: Money.zero(), capped: computed.isPositive() };
  if (computed.gt(room)) return { network: room, capped: true };
  return { network: computed, capped: false };
}
