// Mirrors the DB enums in packages/db/prisma/schema.prisma.
// Kept in sync manually — short enough to be safe; a generator
// could replace this later if drift becomes a risk.

export const UserRole = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN_OPERATOR: 'ADMIN_OPERATOR',
  // Operational back-office staff: handle the money-movement queues
  // (withdrawals/payouts/loads) and view companies, transactions & Whish —
  // but cannot reach platform configuration (sources, commissions, audit,
  // platform admins) or company detail/analytics.
  BACKOFFICE: 'BACKOFFICE',
  COMPANY_OWNER: 'COMPANY_OWNER',
  COMPANY_MANAGER: 'COMPANY_MANAGER',
  COMPANY_VIEWER: 'COMPANY_VIEWER',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

// Platform-level (no company) roles. BACKOFFICE is an admin so it lands in the
// /admin area and is managed via the platform-admins flow; its narrower page
// access is enforced per-endpoint (it is never spread into a guard).
export const ADMIN_ROLES: ReadonlyArray<UserRole> = [
  UserRole.SUPER_ADMIN,
  UserRole.ADMIN_OPERATOR,
  UserRole.BACKOFFICE,
];
export const COMPANY_ROLES: ReadonlyArray<UserRole> = [
  UserRole.COMPANY_OWNER,
  UserRole.COMPANY_MANAGER,
  UserRole.COMPANY_VIEWER,
];

export function isAdminRole(role: UserRole): boolean {
  return ADMIN_ROLES.includes(role);
}

export const UserStatus = {
  ACTIVE: 'ACTIVE',
  DISABLED: 'DISABLED',
  PENDING: 'PENDING',
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export const CompanyStatus = {
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  DISABLED: 'DISABLED',
} as const;
export type CompanyStatus = (typeof CompanyStatus)[keyof typeof CompanyStatus];

export const SourceStatus = {
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
} as const;
export type SourceStatus = (typeof SourceStatus)[keyof typeof SourceStatus];

export const CommissionType = {
  FIXED: 'FIXED',
  PERCENTAGE: 'PERCENTAGE',
} as const;
export type CommissionType = (typeof CommissionType)[keyof typeof CommissionType];

// Which deposit product of a source a source-fee rule applies to (what the
// source charges the PLATFORM, per transaction). It is the SAME source either
// way — only the per-transaction channel differs:
//   INGEST    — a direct ingest-API deposit
//   WHISH_PAY — a deposit settled from a Whish collect link the company generated
// System/admin-only; never surfaced to companies.
export const SourceFeeChannel = {
  INGEST: 'INGEST',
  WHISH_PAY: 'WHISH_PAY',
} as const;
export type SourceFeeChannel = (typeof SourceFeeChannel)[keyof typeof SourceFeeChannel];

// Which operation a fee (commission) rule applies to. TRANSACTION is the
// original behaviour (source ingestion); the others fee the money-movement
// flows. Existing rules default to TRANSACTION.
export const FeeOperationType = {
  TRANSACTION: 'TRANSACTION',
  WITHDRAWAL: 'WITHDRAWAL',
  PAYOUT: 'PAYOUT',
  LOAD: 'LOAD',
} as const;
export type FeeOperationType = (typeof FeeOperationType)[keyof typeof FeeOperationType];

// User-facing labels for fee operation types. `TRANSACTION` is the deposit/ingest
// operation everywhere else in the product, so it reads as "Deposits". One source
// of truth so the commissions UI, company onboarding, and any other surface stay
// consistent.
export const FEE_OPERATION_LABEL: Record<FeeOperationType, string> = {
  TRANSACTION: 'Deposits',
  WITHDRAWAL: 'Withdrawals',
  PAYOUT: 'Payouts',
  LOAD: 'Loads',
};

// How a fee is taken relative to the requested amount.
//   DEDUCTED — recipient gets amount − fee (platform keeps the fee)
//   ON_TOP   — recipient gets the full amount; the company pays amount + fee
export const FeeApplication = {
  DEDUCTED: 'DEDUCTED',
  ON_TOP: 'ON_TOP',
} as const;
export type FeeApplication = (typeof FeeApplication)[keyof typeof FeeApplication];

/**
 * The conventional fee application per flow: withdrawals ON_TOP (the company
 * pays the fee on top, so the withdrawal pays out in full), everything else
 * DEDUCTED. The admin rule editor uses it as the default when an operation is
 * first added, and the network fee falls back to it for a flow that carries a
 * network fee but no matching commission rule (keeping "withdrawals are ON_TOP").
 */
export function defaultFeeApplicationFor(op: FeeOperationType): FeeApplication {
  return op === FeeOperationType.WITHDRAWAL ? FeeApplication.ON_TOP : FeeApplication.DEDUCTED;
}

// The four money flows that carry a fee + reserved-balance lifecycle.
export const FEE_OPERATION_TYPES = [
  FeeOperationType.TRANSACTION,
  FeeOperationType.WITHDRAWAL,
  FeeOperationType.PAYOUT,
  FeeOperationType.LOAD,
] as const;

export const TransactionStatus = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  REVERSED: 'REVERSED',
  REFUNDED: 'REFUNDED',
} as const;
export type TransactionStatus = (typeof TransactionStatus)[keyof typeof TransactionStatus];

export const LedgerAccountType = {
  AVAILABLE: 'AVAILABLE',
  PENDING: 'PENDING',
  RESERVED: 'RESERVED',
  FEE: 'FEE',
  EXTERNAL: 'EXTERNAL',
  // A debt owed by the company to the platform — e.g. the uncovered remainder
  // of a reversal/clawback after the company's available balance was drained.
  // Has no wallet projection (like FEE/EXTERNAL), so the wallet stays >= 0.
  RECEIVABLE: 'RECEIVABLE',
  // Platform revenue from the optional per-company network fee — booked apart
  // from FEE so FEE-based figures keep their meaning. No wallet projection.
  NETWORK_FEE: 'NETWORK_FEE',
} as const;
export type LedgerAccountType = (typeof LedgerAccountType)[keyof typeof LedgerAccountType];

export const LedgerDirection = {
  DEBIT: 'DEBIT',
  CREDIT: 'CREDIT',
} as const;
export type LedgerDirection = (typeof LedgerDirection)[keyof typeof LedgerDirection];

export const PayoutMethod = {
  BANK_TRANSFER: 'BANK_TRANSFER',
  CRYPTO: 'CRYPTO',
  CASH: 'CASH',
  WISH: 'WISH',
  OTHER: 'OTHER',
} as const;
export type PayoutMethod = (typeof PayoutMethod)[keyof typeof PayoutMethod];

// Methods offered to companies for withdrawal/payout/load flows, in display
// order (cash is the default). Bank transfer and "other" remain in the enum
// for legacy rows but are not selectable.
export const SUPPORTED_PAYOUT_METHODS: ReadonlyArray<PayoutMethod> = [
  PayoutMethod.CASH,
  PayoutMethod.WISH,
  PayoutMethod.CRYPTO,
];

// Status is shared across all three processes (withdrawal/payout/load).
export const WithdrawalStatus = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
} as const;
export type WithdrawalStatus = (typeof WithdrawalStatus)[keyof typeof WithdrawalStatus];

// --------------------------- Activity feed -----------------------
// The unified "all money operations" feed. Direction is derived, not stored:
// deposits + loads are money IN; withdrawals + payouts are money OUT.
export const ActivityKind = {
  DEPOSIT: 'DEPOSIT',
  LOAD: 'LOAD',
  WITHDRAWAL: 'WITHDRAWAL',
  PAYOUT: 'PAYOUT',
} as const;
export type ActivityKind = (typeof ActivityKind)[keyof typeof ActivityKind];

export const ActivityDirection = {
  IN: 'IN',
  OUT: 'OUT',
} as const;
export type ActivityDirection = (typeof ActivityDirection)[keyof typeof ActivityDirection];

/** IN = deposit + load, OUT = withdrawal + payout. */
export const ACTIVITY_DIRECTION: Record<ActivityKind, ActivityDirection> = {
  DEPOSIT: 'IN',
  LOAD: 'IN',
  WITHDRAWAL: 'OUT',
  PAYOUT: 'OUT',
};

// --------------------------- Notifications -----------------------
// Who a notification is for. ADMIN rows are visible only to platform admins
// (persisted with company_id = NULL so RLS can never expose them to a tenant);
// COMPANY rows belong to exactly one company.
export const NotificationScope = {
  ADMIN: 'ADMIN',
  COMPANY: 'COMPANY',
} as const;
export type NotificationScope = (typeof NotificationScope)[keyof typeof NotificationScope];

// The money flow a notification is about. WITHDRAWAL/PAYOUT/LOAD are the
// approvable requests; DEPOSIT carries admin alerts about deposits (a source
// re-sent a recorded deposit with a different amount — see ATTENTION).
export const NotificationFlow = {
  WITHDRAWAL: 'WITHDRAWAL',
  PAYOUT: 'PAYOUT',
  LOAD: 'LOAD',
  DEPOSIT: 'DEPOSIT',
} as const;
export type NotificationFlow = (typeof NotificationFlow)[keyof typeof NotificationFlow];

// What happened. REQUESTED → admins must action it; APPROVED…CANCELLED are
// resolutions the requesting company sees on its own request; ATTENTION → an
// admin alert about something that needs reconciling (no request behind it).
export const NotificationEvent = {
  REQUESTED: 'REQUESTED',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  ATTENTION: 'ATTENTION',
} as const;
export type NotificationEvent = (typeof NotificationEvent)[keyof typeof NotificationEvent];

// ISO 4217 currency codes used by the platform. Expand as needed.
export const SUPPORTED_CURRENCIES = ['USD'] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

// --------------------------- Whish Pay ---------------------------

// Lifecycle of a Whish payment link minted on behalf of a company.
//   PENDING — link created, payer has not completed payment yet
//   PAID    — confirmed via collect/status; a ledger Transaction was written
//   FAILED  — Whish reported failure (or link creation failed)
//   EXPIRED — never paid; closed out by reconciliation
//   REFUNDED — was PAID, then an operator refunded it to the payer through
//              Whish; the settled deposit was reversed in the ledger. Terminal.
export const WhishPaymentStatus = {
  PENDING: 'PENDING',
  PAID: 'PAID',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
  REFUNDED: 'REFUNDED',
} as const;
export type WhishPaymentStatus = (typeof WhishPaymentStatus)[keyof typeof WhishPaymentStatus];

// Whish can support LBP + USD, but the platform only operates in USD.
export const WHISH_CURRENCIES = ['USD'] as const;
export type WhishCurrency = (typeof WHISH_CURRENCIES)[number];

/** Per-currency amount rules Whish enforces upstream (Whish Pay v1.4.4). */
export interface WhishAmountRule {
  /** Smallest amount Whish will mint a link for, as a decimal string. */
  minAmount: string;
  /** Fraction digits Whish accepts for this currency. */
  maxDecimals: number;
}

/**
 * Whish Pay v1.4.4 amount rules. Enforced at create time so an integrator gets
 * a clean 400 naming the real limit instead of an opaque 502 relayed from Whish.
 *
 * Enabling a currency means uncommenting its rule here AND adding it to
 * WHISH_CURRENCIES + WHISH_ENABLED_CURRENCIES — the `satisfies` below fails to
 * typecheck until every enabled currency has a rule, so the two cannot drift.
 */
export const WHISH_AMOUNT_RULES = {
  USD: { minAmount: '1', maxDecimals: 2 },
  // LBP: { minAmount: '1000', maxDecimals: 0 },
} as const satisfies Record<WhishCurrency, WhishAmountRule>;

// Lifecycle of an outbound whish-to-whish (W2W) transfer. Whish returns no
// transfer id, so we record every attempt and reconcile by our own reference.
//   PENDING — row committed, the upstream call hasn't resolved yet
//   SUCCESS — Whish answered status:true (money moved)
//   FAILED  — definite business/validation/auth failure (money did NOT move)
//   UNKNOWN — network/timeout/5xx: money MAY have moved; needs operator reconcile
export const WhishTransferStatus = {
  PENDING: 'PENDING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  UNKNOWN: 'UNKNOWN',
} as const;
export type WhishTransferStatus = (typeof WhishTransferStatus)[keyof typeof WhishTransferStatus];
