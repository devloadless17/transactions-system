import {
  Money,
  UserRole,
  type ActivityItem,
  type LoadResponse,
  type PayoutResponse,
  type TransactionDetailResponse,
  type TransactionResponse,
  type WithdrawalResponse,
} from '@app/shared';

/**
 * BACKOFFICE never learns what the platform charges.
 *
 * Back-office operators move money in the physical world, so for every
 * operation they get exactly ONE figure — the money that crosses the platform's
 * boundary — and nothing a fee could be derived from:
 *   - deposit:            what the customer paid (gross; matches the Whish pages);
 *   - withdrawal/payout:  what the recipient is paid (net);
 *   - load:               what is collected from the company (gross).
 * The other side of the split (what the company's wallet was credited or
 * debited), both fees, the fee application, the rounding remainder, ledger legs
 * and running wallet balances are all removed — any one of them, next to the
 * figure above, would reveal the fee by subtraction.
 *
 * Enforced HERE, server-side, on every route back office can reach — not just
 * hidden by the dashboard — so nothing reaches a back-office browser at all.
 * Full admins and companies are untouched.
 */

/** Whether the caller is back office (and so must get the fee-free view). */
export function isBackoffice(principal: { role?: string | null } | undefined): boolean {
  return principal?.role === UserRole.BACKOFFICE;
}

const sum = (...parts: string[]): string =>
  parts.reduce((acc, p) => acc.add(Money.of(p)), Money.zero()).toString();

/** A deposit as back office sees it: `amount` = what the customer paid, nothing else. */
export function backofficeTransaction(t: TransactionResponse) {
  const { commissionAmount, networkFeeAmount, netAmount, amount: _requested, ...rest } = t;
  // net + both fees is the gross for BOTH fee applications (for an ON_TOP
  // deposit the stored `amount` is the net, so it can't be used as is).
  return { ...rest, amount: sum(netAmount, commissionAmount, networkFeeAmount) };
}

/** Transaction detail for back office: the redacted transaction, no payload, no ledger legs. */
export function backofficeTransactionDetail(d: TransactionDetailResponse) {
  return {
    transaction: {
      ...backofficeTransaction(d.transaction),
      // The source's raw payload may carry extra passthrough fields; back office
      // gets only the lifted descriptive fields (customer, phone, note, …).
      payload: null,
      idempotencyKey: d.transaction.idempotencyKey,
    },
    // EXTERNAL next to AVAILABLE would reveal the fee; back office gets no legs.
    ledgerEntries: [],
  };
}

/** A withdrawal or payout as back office sees it: only `netAmount` — what the recipient is paid. */
export function backofficePayOut<T extends WithdrawalResponse | PayoutResponse>(r: T) {
  const {
    amount: _requested,
    feeAmount: _fee,
    networkFeeAmount: _networkFee,
    totalAmount: _total,
    feeApplication: _application,
    ...rest
  } = r;
  // Withdrawals also carry the platform's whole-dollar rounding leftover.
  const { roundingRemainder: _remainder, ...view } = rest as typeof rest & {
    roundingRemainder?: string;
  };
  return view;
}

/** A load as back office sees it: only `totalAmount` — what is collected from the company. */
export function backofficeLoad(r: LoadResponse) {
  const {
    amount: _requested,
    feeAmount: _fee,
    networkFeeAmount: _networkFee,
    netAmount: _net,
    feeApplication: _application,
    ...view
  } = r;
  return view;
}

/**
 * An activity-feed row as back office sees it: `amount` is the one figure of
 * its kind (gross for deposits/loads, net for withdrawals/payouts); no fee,
 * no net/gross split and no running wallet balance (consecutive balances would
 * reveal the net credited per row).
 */
export function backofficeActivityItem(i: ActivityItem) {
  const { fee: _fee, networkFee: _networkFee, net, amount, ...rest } = i;
  const paidOut = i.kind === 'WITHDRAWAL' || i.kind === 'PAYOUT';
  return { ...rest, amount: paidOut ? net : amount, balanceAfter: null };
}

/** Map a paginated list's rows through a back-office view. */
export function backofficeList<T, U, M extends object>(
  list: { data: T[]; meta: M },
  view: (row: T) => U,
): { data: U[]; meta: M } {
  return { ...list, data: list.data.map(view) };
}

/**
 * CSV: blank every fee-revealing cell in a row, keeping the column positions
 * (back-office exports have the same header as everyone else's). `keep` names
 * the one money column whose value back office may see; `overrides` replaces a
 * cell (e.g. a deposit's `amount` with the gross).
 */
export function backofficeCsvCells(
  header: ReadonlyArray<string>,
  cells: Array<string | null>,
  opts: {
    hide: ReadonlyArray<string>;
    overrides?: Readonly<Record<string, string>>;
  },
): Array<string | null> {
  return cells.map((cell, i) => {
    const column = header[i]!;
    if (opts.overrides && column in opts.overrides) return opts.overrides[column]!;
    return opts.hide.includes(column) ? '' : cell;
  });
}
