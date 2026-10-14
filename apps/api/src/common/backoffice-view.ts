import {
  UserRole,
  type ActivityItem,
  type LoadResponse,
  type PayoutResponse,
  type TransactionDetailResponse,
  type TransactionResponse,
  type WhishPaymentResponse,
  type WithdrawalResponse,
} from '@app/shared';

/**
 * BACKOFFICE never learns what the platform charges.
 *
 * Back-office operators move money in the physical world, so for every
 * operation they get exactly ONE figure — the money that crosses the platform's
 * boundary — and nothing a fee could be derived from:
 *   - deposit:            what the customer paid — the stored `amount`, exactly
 *                         as the source reported it and as the Whish pages show;
 *   - withdrawal/payout:  what the recipient is paid (net);
 *   - load:               what is collected from the company (total).
 * The other side of the split (what the company's wallet was credited or
 * debited), both fees, the fee application, the rounding remainder, ledger legs
 * and running wallet balances are all removed — any one of them, next to the
 * figure above, would reveal the fee by subtraction.
 *
 * Enforced HERE, server-side, on every route back office can reach — not just
 * hidden by the dashboard — so nothing reaches a back-office browser at all.
 * Full admins and companies are untouched.
 *
 * FAIL-CLOSED. Every view is an ALLOW-list: it copies the fields back office
 * may see and nothing else, so a field added to a response later is hidden from
 * back office until someone decides otherwise. The `Classified` checks below
 * make that decision unavoidable — a new response field that is in neither the
 * shown nor the hidden list of its view is a compile error. The CSV exports
 * work the same way (BACKOFFICE_CSV_COLUMNS): a column that is not listed is
 * blank. backoffice-routes.spec.ts pins the list of routes back office reaches.
 */

/** Whether the caller is back office (and so must get the fee-free view). */
export function isBackoffice(principal: { role?: string | null } | undefined): boolean {
  return principal?.role === UserRole.BACKOFFICE;
}

/** Copy only `keys` from `row` (an own key that is absent stays absent). */
function pick<T extends object, K extends keyof T>(row: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) {
    if (key in row) out[key] = row[key];
  }
  return out;
}

// Compile-time: every field of T is deliberately shown or deliberately hidden.
// Resolves to `true`, or to the unclassified field names (which `true` is not
// assignable to — the error message names them).
type Classified<T, Shown extends keyof T, Hidden extends keyof T> =
  Exclude<keyof T, Shown | Hidden> extends never ? true : Exclude<keyof T, Shown | Hidden>;

// ---------------------------------------------------------------------------
// Deposit
// ---------------------------------------------------------------------------

const DEPOSIT_SHOWN = [
  'id',
  'companyId',
  'sourceId',
  'sourceCode',
  'externalTransactionId',
  // What the customer paid. NOT net + fees: for a deposit priced ON_TOP that
  // sum is the paid amount PLUS the fees, and back office can read the paid
  // amount on the Whish pages — the difference would be the fee.
  'amount',
  'currency',
  'status',
  // Whether the money went back to the customer — what back office is asked.
  'refunded',
  'refundedAt',
  'customer',
  'target',
  'phone',
  'note',
  'processedAt',
  'createdAt',
] as const satisfies ReadonlyArray<keyof TransactionResponse>;
type DepositHidden = Extract<
  keyof TransactionResponse,
  'commissionAmount' | 'networkFeeAmount' | 'netAmount'
>;
const _depositClassified: Classified<
  TransactionResponse,
  (typeof DEPOSIT_SHOWN)[number],
  DepositHidden
> = true;

/** A deposit as back office sees it: `amount` = what the customer paid, nothing else. */
export function backofficeTransaction(t: TransactionResponse) {
  return pick(t, DEPOSIT_SHOWN);
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

// ---------------------------------------------------------------------------
// Withdrawal / payout
// ---------------------------------------------------------------------------

const PAY_OUT_SHOWN = [
  'id',
  'companyId',
  'currency',
  // What the recipient is paid.
  'netAmount',
  'status',
  'payoutMethod',
  'payoutDetails',
  'externalReference',
  'requestedById',
  'approvedById',
  'notes',
  'adminNotes',
  'processedAt',
  'createdAt',
  'updatedAt',
] as const satisfies ReadonlyArray<keyof PayoutResponse & keyof WithdrawalResponse>;
type PayOutHidden = Extract<
  keyof PayoutResponse & keyof WithdrawalResponse,
  'amount' | 'feeAmount' | 'networkFeeAmount' | 'feeApplication' | 'totalAmount'
>;
// Withdrawal-only fields: the auto-approval summary stays (the queue needs it
// to explain a PENDING/PROCESSING row); the platform's whole-dollar rounding
// leftover is a fee by another name.
const WITHDRAWAL_ONLY_SHOWN = ['autoApproval'] as const satisfies ReadonlyArray<
  keyof WithdrawalResponse
>;
type WithdrawalOnlyHidden = Extract<keyof WithdrawalResponse, 'roundingRemainder'>;
const _payoutClassified: Classified<PayoutResponse, (typeof PAY_OUT_SHOWN)[number], PayOutHidden> =
  true;
const _withdrawalClassified: Classified<
  WithdrawalResponse,
  (typeof PAY_OUT_SHOWN)[number] | (typeof WITHDRAWAL_ONLY_SHOWN)[number],
  PayOutHidden | WithdrawalOnlyHidden
> = true;

type PayOutShown = (typeof PAY_OUT_SHOWN)[number] | (typeof WITHDRAWAL_ONLY_SHOWN)[number];

/** A withdrawal or payout as back office sees it: only `netAmount` — what the recipient is paid. */
export function backofficePayOut<T extends WithdrawalResponse | PayoutResponse>(
  r: T,
): Pick<T, Extract<keyof T, PayOutShown>> {
  const shown: readonly PayOutShown[] = [...PAY_OUT_SHOWN, ...WITHDRAWAL_ONLY_SHOWN];
  return pick(r, shown as ReadonlyArray<Extract<keyof T, PayOutShown>>);
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

const LOAD_SHOWN = [
  'id',
  'companyId',
  'currency',
  // What is collected from the company.
  'totalAmount',
  'status',
  'payoutMethod',
  'payoutDetails',
  'externalReference',
  'requestedById',
  'approvedById',
  'notes',
  'adminNotes',
  'processedAt',
  'createdAt',
  'updatedAt',
] as const satisfies ReadonlyArray<keyof LoadResponse>;
type LoadHidden = Extract<
  keyof LoadResponse,
  'amount' | 'feeAmount' | 'networkFeeAmount' | 'feeApplication' | 'netAmount'
>;
const _loadClassified: Classified<LoadResponse, (typeof LOAD_SHOWN)[number], LoadHidden> = true;

/** A load as back office sees it: only `totalAmount` — what is collected from the company. */
export function backofficeLoad(r: LoadResponse) {
  return pick(r, LOAD_SHOWN);
}

// ---------------------------------------------------------------------------
// Activity feed
// ---------------------------------------------------------------------------

const ACTIVITY_SHOWN = [
  'id',
  'kind',
  'direction',
  'currency',
  'description',
  'details',
  'reference',
  'createdAt',
  'completedAt',
  'companyId',
  'companyName',
] as const satisfies ReadonlyArray<keyof ActivityItem>;
// `amount` and `balanceAfter` are part of the back-office row too, but as
// values this view DERIVES — never copied straight from the item.
type ActivityDerived = Extract<keyof ActivityItem, 'amount' | 'balanceAfter'>;
type ActivityHidden = Extract<keyof ActivityItem, 'fee' | 'networkFee' | 'net'>;
const _activityClassified: Classified<
  ActivityItem,
  (typeof ACTIVITY_SHOWN)[number] | ActivityDerived,
  ActivityHidden
> = true;

/**
 * An activity-feed row as back office sees it: `amount` is the one figure of
 * its kind — money paid out (withdrawals, payouts) shows the net, money in
 * shows the item's amount (which the feed already built for back office: the
 * paid amount for a deposit, the collected total for a load). No fee, no
 * net/gross split and no running wallet balance (consecutive balances would
 * reveal the net credited per row).
 */
export function backofficeActivityItem(i: ActivityItem) {
  return {
    ...pick(i, ACTIVITY_SHOWN),
    amount: i.direction === 'OUT' ? i.net : i.amount,
    balanceAfter: null,
  };
}

// ---------------------------------------------------------------------------
// Whish payment (collect link)
// ---------------------------------------------------------------------------

const WHISH_PAYMENT_SHOWN = [
  'id',
  'companyId',
  'externalId',
  'status',
  // What the payer pays at Whish — the same figure a deposit shows back office.
  'amount',
  'currency',
  'invoice',
  'collectUrl',
  'payerPhoneNumber',
  'transactionId',
  'needsAttention',
  'createdAt',
  'paidAt',
  'refundedAt',
] as const satisfies ReadonlyArray<keyof WhishPaymentResponse>;
// Shown, but never verbatim — see BACKOFFICE_SETTLEMENT_ERROR.
type WhishPaymentDerived = Extract<keyof WhishPaymentResponse, 'settlementError'>;
const _whishPaymentClassified: Classified<
  WhishPaymentResponse,
  (typeof WHISH_PAYMENT_SHOWN)[number] | WhishPaymentDerived,
  never
> = true;

/**
 * What back office reads in place of a settlement failure reason. The real
 * reason is the settlement error itself, and a pricing failure spells the price
 * out ("Resolved commission (5) exceeds the amount (3) …"). Back office cannot
 * act on it anyway — re-settling is a full-admin action — so it only learns
 * THAT the payment needs attention.
 */
export const BACKOFFICE_SETTLEMENT_ERROR =
  'This payment needs attention — a platform admin can see the reason and re-settle it.';

/** A Whish payment as back office sees it: the paid amount, and no settlement detail. */
export function backofficeWhishPayment(p: WhishPaymentResponse) {
  return {
    ...pick(p, WHISH_PAYMENT_SHOWN),
    settlementError: p.settlementError === null ? null : BACKOFFICE_SETTLEMENT_ERROR,
  };
}

/** Map a paginated list's rows through a back-office view. */
export function backofficeList<T, U, M extends object>(
  list: { data: T[]; meta: M },
  view: (row: T) => U,
): { data: U[]; meta: M } {
  return { ...list, data: list.data.map(view) };
}

// ---------------------------------------------------------------------------
// CSV exports
// ---------------------------------------------------------------------------

// Columns the three flow exports (withdrawals / payouts / loads) share.
const FLOW_CSV_COMMON = [
  'id',
  'created_at',
  'processed_at',
  'company_id',
  'status',
  'currency',
  'payout_method',
  'external_reference',
  'recipient_name',
  'recipient_contact',
  'notes',
  'admin_notes',
] as const;

// Columns the unified activity export always shows back office.
const ACTIVITY_CSV_COMMON = [
  'id',
  'kind',
  'direction',
  'created_at',
  'completed_at',
  'company_id',
  'company_name',
  'description',
  'details',
  'reference',
  'currency',
  'recipient_name',
  'recipient_contact',
  'target',
  'notes',
  'admin_notes',
] as const;

/**
 * The CSV columns back office may see, per export. Each list holds exactly ONE
 * money column. Any column that is not listed — every fee, the other side of
 * the split, the fee application, and any column appended in future — is
 * emitted blank, so the header and column positions stay the same as everyone
 * else's export.
 */
export const BACKOFFICE_CSV_COLUMNS = {
  // Deposits: `amount` is what the customer paid.
  deposits: [
    'id',
    'created_at',
    'company_id',
    'source_code',
    'external_transaction_id',
    'amount',
    'currency',
    'status',
    'customer',
    'target',
    'phone',
    'note',
    'processed_at',
  ],
  flow: {
    // Withdrawals, payouts: what the recipient is paid.
    pay: [...FLOW_CSV_COMMON, 'net_amount'],
    // Loads: what is collected from the company.
    collect: [...FLOW_CSV_COMMON, 'gross_amount'],
  },
  activity: {
    // Money in (deposits, loads): the paid / collected amount.
    in: [...ACTIVITY_CSV_COMMON, 'gross_amount'],
    // Money paid out (withdrawals, payouts): the net.
    out: [...ACTIVITY_CSV_COMMON, 'net_amount'],
  },
} as const satisfies Record<string, ReadonlyArray<string> | Record<string, ReadonlyArray<string>>>;

/**
 * CSV: keep the cells of the columns in `show`, blank every other cell. Column
 * positions are untouched (back-office exports carry the same header as
 * everyone else's).
 */
export function backofficeCsvCells(
  header: ReadonlyArray<string>,
  cells: Array<string | null>,
  show: ReadonlyArray<string>,
): Array<string | null> {
  return cells.map((cell, i) => (show.includes(header[i]!) ? cell : ''));
}

// The classification checks are evaluated by the compiler only.
void [
  _depositClassified,
  _payoutClassified,
  _withdrawalClassified,
  _loadClassified,
  _activityClassified,
  _whishPaymentClassified,
];
