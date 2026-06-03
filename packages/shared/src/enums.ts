// Mirrors the DB enums in packages/db/prisma/schema.prisma.
// Kept in sync manually — short enough to be safe; a generator
// could replace this later if drift becomes a risk.

export const UserRole = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN_OPERATOR: 'ADMIN_OPERATOR',
  COMPANY_OWNER: 'COMPANY_OWNER',
  COMPANY_MANAGER: 'COMPANY_MANAGER',
  COMPANY_VIEWER: 'COMPANY_VIEWER',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

export const ADMIN_ROLES: ReadonlyArray<UserRole> = [UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR];
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

// How a fee is taken relative to the requested amount.
//   DEDUCTED — recipient gets amount − fee (platform keeps the fee)
//   ON_TOP   — recipient gets the full amount; the company pays amount + fee
export const FeeApplication = {
  DEDUCTED: 'DEDUCTED',
  ON_TOP: 'ON_TOP',
} as const;
export type FeeApplication = (typeof FeeApplication)[keyof typeof FeeApplication];

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

// ISO 4217 currency codes used by the platform. Expand as needed.
export const SUPPORTED_CURRENCIES = ['USD'] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

// --------------------------- Whish Pay ---------------------------

// Lifecycle of a Whish payment link minted on behalf of a company.
//   PENDING — link created, payer has not completed payment yet
//   PAID    — confirmed via collect/status; a ledger Transaction was written
//   FAILED  — Whish reported failure (or link creation failed)
//   EXPIRED — never paid; closed out by reconciliation
export const WhishPaymentStatus = {
  PENDING: 'PENDING',
  PAID: 'PAID',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
} as const;
export type WhishPaymentStatus = (typeof WhishPaymentStatus)[keyof typeof WhishPaymentStatus];

// Whish can support LBP + USD, but the platform only operates in USD.
export const WHISH_CURRENCIES = ['USD'] as const;
export type WhishCurrency = (typeof WHISH_CURRENCIES)[number];
