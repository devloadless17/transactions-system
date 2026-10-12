import { Money, type FeeApplication } from '@app/shared';
import type { PrismaClient } from '@app/db';
import { InsufficientBalanceError, ValidationError } from '../../common/errors/domain.error';
import type { LedgerEntryInput } from './ledger.service';

/**
 * Shared ledger/wallet helpers for the money flows. The fee split — `reservedTotal`
 * (the gross amount that moves) and `netOfFee` (the recipient's net) — is the
 * single definition reused by money-OUT (withdrawals/payouts reserve+settle) AND
 * money-IN (transaction ingest + load approval debit), so the ON_TOP/DEDUCTED
 * arithmetic can't drift between flows.
 *
 * Every ledger set a money flow books is built here, so each one carries BOTH
 * fees the same way: reserve/release/settle for money-OUT (withdrawals and
 * payouts share an identical lifecycle — available → reserved on request,
 * reserved → external (+ realized fees) on approval, reserved → available on
 * reject/cancel), `moneyInEntries` for money-IN (deposit ingest + load approval),
 * and `reversalEntries` for a deposit reversal.
 */

/**
 * Every fee taken on one row, both already at MONEY_SCALE:
 *   - `commission` — the commission-rule fee (commission_amount / fee_amount);
 *   - `network`    — the optional per-company network fee (network_fee_amount).
 *     It is 0 whenever the company's switch is off, and then every helper below
 *     behaves exactly as it did with a single fee.
 * One object rather than two arguments so a call site cannot forget the network
 * fee: the compiler rejects a lone commission figure.
 */
export interface FeeParts {
  readonly commission: Money;
  readonly network: Money;
}

/** Both fees together — the full amount the platform takes on the row. */
export function totalFee(fees: FeeParts): Money {
  return fees.commission.add(fees.network);
}

/**
 * The fees frozen on a stored row, quantized ONCE on the way in (Money.fromDb)
 * so everything derived from them is at scale. `commission` is the row's
 * commission column — `commission_amount` on a deposit, `fee_amount` on a
 * withdrawal, payout or load.
 */
export function storedFees(
  commission: { toString(): string } | null | undefined,
  network: { toString(): string } | null | undefined,
): FeeParts {
  return { commission: Money.fromDb(commission), network: Money.fromDb(network) };
}

/**
 * The gross that actually moved for a row: net + both fees. True under BOTH fee
 * applications (DEDUCTED: amount = net + fees; ON_TOP: amount + fees = net +
 * fees), which the requested `amount` alone is not. This is the API's
 * `totalAmount`, the exports' `gross_amount` and the operator's "to collect".
 */
export function grossOf(net: Money, fees: FeeParts): Money {
  return net.add(totalFee(fees));
}

/**
 * Gross amount that moves for a row = amount, or amount + both fees when the
 * fees are ON_TOP.
 *
 * PRECONDITION: every argument is already at MONEY_SCALE. This does not round —
 * sums and differences of at-scale values are exact, which is what lets the
 * resulting ledger set balance by construction. Quantize on the way IN
 * (Money.fromDb at the DB read), never on the way out.
 */
export function reservedTotal(
  amount: Money,
  fees: FeeParts,
  feeApplication: FeeApplication,
): Money {
  return feeApplication === 'ON_TOP' ? amount.add(totalFee(fees)) : amount;
}

/**
 * The recipient's net for a flow:
 *   - ON_TOP:   the fees are charged on top, so the recipient gets the full `amount`.
 *   - DEDUCTED: the fees come out of the amount, so the recipient gets
 *               amount − commission − network.
 * One definition shared by withdrawals/payouts (the `net` at request, the
 * `external` at approval) and loads (the credited net), so the split can't drift
 * between the sibling flows.
 *
 * PRECONDITION: every argument is already at MONEY_SCALE — see reservedTotal.
 */
export function netOfFee(amount: Money, fees: FeeParts, feeApplication: FeeApplication): Money {
  return feeApplication === 'ON_TOP' ? amount : amount.sub(totalFee(fees));
}

/**
 * The request-time rejection when DEDUCTED fees leave nothing for the recipient
 * (withdrawals, payouts) or nothing to credit (loads) — a surely-misconfigured
 * price, refused before anything is reserved. `consequence` completes the
 * sentence ("the recipient would receive 0" / "nothing would be credited").
 * With no network fee, the message and details are exactly what they always were.
 */
export function feesConsumeAmountError(
  amount: Money,
  fees: FeeParts,
  currency: string,
  consequence: string,
): ValidationError {
  const fee = fees.commission.toString();
  if (!fees.network.isPositive()) {
    return new ValidationError(
      `The ${fee} ${currency} fee consumes the entire amount — ${consequence}. Increase the amount or fix the fee rule.`,
      { amount: amount.toString(), fee },
    );
  }
  const networkFee = fees.network.toString();
  const what = fees.commission.isPositive()
    ? `The ${fee} ${currency} fee and the ${networkFee} ${currency} network fee consume`
    : `The ${networkFee} ${currency} network fee consumes`;
  return new ValidationError(
    `${what} the entire amount — ${consequence}. Increase the amount or adjust the fees.`,
    { amount: amount.toString(), fee, networkFee },
  );
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

/**
 * The two revenue legs of a ledger set — FEE for the commission, NETWORK_FEE
 * for the network fee — built in ONE place, in that order, for every builder
 * below. A zero fee books no line (the ledger rejects non-positive amounts), so
 * a row without a network fee books exactly the single FEE leg it always did.
 * CREDIT realizes the fees; DEBIT gives them back (a deposit reversal).
 */
function feeLegs(
  ref: Pick<LedgerEntryInput, 'transactionId' | 'withdrawalId' | 'payoutId' | 'loadId'>,
  companyId: string,
  currency: string,
  fees: FeeParts,
  direction: 'CREDIT' | 'DEBIT',
  metadata?: LedgerEntryInput['metadata'],
): LedgerEntryInput[] {
  const legs: LedgerEntryInput[] = [];
  const leg = (accountType: 'FEE' | 'NETWORK_FEE', amount: Money) => {
    if (!amount.isPositive()) return;
    legs.push({
      ...ref,
      companyId,
      accountType,
      direction,
      amount,
      currency,
      ...(metadata ? { metadata } : {}),
    });
  };
  leg('FEE', fees.commission);
  leg('NETWORK_FEE', fees.network);
  return legs;
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
 * Approve: reserved → external(net) + FEE(commission) + NETWORK_FEE(network).
 * Zero lines are skipped because the ledger rejects non-positive amounts; debits
 * still equal credits since the reserved DEBIT equals external + both fees.
 * `realized.commission` may exceed the stored fee by a whole-dollar rounding
 * remainder (auto Whish transfers) — that remainder stays on FEE.
 */
export function settleEntries(
  ref: FlowRef,
  companyId: string,
  currency: string,
  reserved: Money,
  external: Money,
  realized: FeeParts,
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
  entries.push(...feeLegs(ref, companyId, currency, realized, 'CREDIT'));
  return entries;
}

/** Ties money-IN ledger entries back to the deposit or load row. */
export type MoneyInRef = Pick<LedgerEntryInput, 'transactionId' | 'loadId'>;

/**
 * Money in (deposit ingest, load approval): DEBIT EXTERNAL the gross that
 * arrived; CREDIT RECEIVABLE whatever settles an outstanding company debt
 * (loads only), AVAILABLE the remainder of the net, FEE the commission and
 * NETWORK_FEE the network fee. Zero lines are skipped; the set balances because
 * externalDebit = receivableSettle + availableCredit + commission + network.
 */
export function moneyInEntries(
  ref: MoneyInRef,
  companyId: string,
  currency: string,
  legs: {
    externalDebit: Money;
    receivableSettle: Money;
    availableCredit: Money;
    fees: FeeParts;
  },
): LedgerEntryInput[] {
  const entries: LedgerEntryInput[] = [
    {
      ...ref,
      companyId,
      accountType: 'EXTERNAL',
      direction: 'DEBIT',
      amount: legs.externalDebit,
      currency,
    },
  ];
  if (legs.receivableSettle.isPositive()) {
    entries.push({
      ...ref,
      companyId,
      accountType: 'RECEIVABLE',
      direction: 'CREDIT',
      amount: legs.receivableSettle,
      currency,
      metadata: { kind: 'receivable_settlement' },
    });
  }
  if (legs.availableCredit.isPositive()) {
    entries.push({
      ...ref,
      companyId,
      accountType: 'AVAILABLE',
      direction: 'CREDIT',
      amount: legs.availableCredit,
      currency,
    });
  }
  entries.push(...feeLegs(ref, companyId, currency, legs.fees, 'CREDIT'));
  return entries;
}

/**
 * Deposit reversal — the mirror of the original booking. CREDIT EXTERNAL the
 * original external debit (net + commission + network, true for BOTH fee
 * applications); DEBIT AVAILABLE what the wallet can cover and RECEIVABLE the
 * uncovered rest of the net; DEBIT FEE and NETWORK_FEE to refund both fees.
 * Balanced: fromAvailable + receivable = net, so debits = net + both fees.
 */
export function reversalEntries(
  ref: { transactionId: string },
  companyId: string,
  currency: string,
  legs: {
    net: Money;
    fees: FeeParts;
    fromAvailable: Money;
    receivable: Money;
    reason: string;
  },
): LedgerEntryInput[] {
  const entries: LedgerEntryInput[] = [
    {
      ...ref,
      companyId,
      accountType: 'EXTERNAL',
      direction: 'CREDIT',
      amount: grossOf(legs.net, legs.fees),
      currency,
      metadata: { kind: 'reversal', reason: legs.reason },
    },
  ];
  if (legs.fromAvailable.isPositive()) {
    entries.push({
      ...ref,
      companyId,
      accountType: 'AVAILABLE',
      direction: 'DEBIT',
      amount: legs.fromAvailable,
      currency,
      metadata: { kind: 'reversal' },
    });
  }
  if (legs.receivable.isPositive()) {
    entries.push({
      ...ref,
      companyId,
      accountType: 'RECEIVABLE',
      direction: 'DEBIT',
      amount: legs.receivable,
      currency,
      metadata: { kind: 'reversal', shortfall: true },
    });
  }
  entries.push(...feeLegs(ref, companyId, currency, legs.fees, 'DEBIT', { kind: 'reversal' }));
  return entries;
}
